import { Message } from "./types.js";
import type { RetryConfig } from "./types.js";

export interface LLMRequestOptions {
  model: string;
  messages: Message[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  response_format?: { type: "json_object" } | { type: "json_schema"; json_schema: any };
  temperature?: number;
  /** Aborts the request (and any pending retry) when signalled. */
  signal?: AbortSignal;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Delay requested by the server via the Retry-After header, in ms. */
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "LLMError";
  }
}

const DEFAULT_RETRYABLE = [429, 500, 502, 503, 504];

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private retry: Required<Omit<RetryConfig, "timeoutMs">> & { timeoutMs?: number };

  constructor(baseUrl: string, apiKey = "no-key", retry: RetryConfig = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.retry = {
      maxRetries:        retry.maxRetries        ?? 3,
      initialDelayMs:    retry.initialDelayMs    ?? 500,
      maxDelayMs:        retry.maxDelayMs        ?? 10_000,
      retryableStatuses: retry.retryableStatuses ?? DEFAULT_RETRYABLE,
      timeoutMs:         retry.timeoutMs,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey && this.apiKey !== "no-key") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildBody(options: LLMRequestOptions, stream: boolean): string {
    const body: Record<string, any> = { model: options.model, messages: options.messages };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (options.tools?.length) { body.tools = options.tools; body.tool_choice = options.tool_choice ?? "auto"; }
    if (options.response_format) body.response_format = options.response_format;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    return JSON.stringify(body);
  }

  /**
   * Builds the signal for one attempt: the caller's signal combined with the
   * per-attempt timeout. Call `clear()` once the attempt has finished reading.
   */
  private attemptSignal(signal?: AbortSignal): { signal?: AbortSignal; clear: () => void } {
    const timeoutMs = this.retry.timeoutMs;
    if (!timeoutMs) return { signal, clear: () => {} };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`LLM request timed out after ${timeoutMs}ms`, "TimeoutError")),
      timeoutMs
    );
    return {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      clear: () => clearTimeout(timer),
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: Error = new Error("Unknown error");
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        // Never retry a caller-initiated abort; a per-attempt timeout is retried.
        if (signal?.aborted) throw err;
        const isRetryable =
          err instanceof LLMError
            ? this.retry.retryableStatuses.includes(err.status)
            : true; // network errors and timeouts are retried
        if (!isRetryable || attempt === this.retry.maxRetries) throw err;
        const jitter = Math.random() * 200;
        const backoff = Math.min(this.retry.initialDelayMs * 2 ** attempt + jitter, this.retry.maxDelayMs);
        const delay = err instanceof LLMError && err.retryAfterMs !== undefined
          ? Math.min(err.retryAfterMs, this.retry.maxDelayMs)
          : backoff;
        await sleep(delay, signal);
      }
    }
    throw lastError;
  }

  /**
   * Sends a chat completion request with retries. `read` consumes the successful
   * response inside the attempt, so a body that fails to parse is retried too.
   * The per-attempt timeout covers `read`; for streams it therefore only bounds
   * the time until the response headers arrive.
   */
  private request<T>(options: LLMRequestOptions, stream: boolean, read: (r: Response) => Promise<T>): Promise<T> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = this.buildBody(options, stream);
    return this.withRetry(async () => {
      const attempt = this.attemptSignal(options.signal);
      try {
        const response = await fetch(url, { method: "POST", headers: this.buildHeaders(), body, signal: attempt.signal });
        if (!response.ok) {
          const errorText = await response.text();
          throw new LLMError(
            `LLM ${stream ? "stream " : ""}call failed (${response.status}): ${errorText}`,
            response.status,
            parseRetryAfter(response.headers.get("retry-after"))
          );
        }
        return await read(response);
      } finally {
        attempt.clear();
      }
    }, options.signal);
  }

  async chatCompletion(options: LLMRequestOptions): Promise<any> {
    return this.request(options, false, (r) => r.json());
  }

  async *chatCompletionStream(options: LLMRequestOptions): AsyncGenerator<any, void, unknown> {
    // Retry only applies to the initial connection, not mid-stream.
    const response = await this.request(options, true, async (r) => r);
    if (!response.body) throw new Error("No response body received for streaming.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;

    /** Parses complete SSE lines; returns true when the [DONE] sentinel is reached. */
    const parseLine = (line: string): { done: boolean; data?: any } => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return { done: false };
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") return { done: true };
      try { return { done: false, data: JSON.parse(dataStr) }; } catch { return { done: false }; }
    };

    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          buffer += decoder.decode();
          // Process a trailing event that was not newline-terminated.
          if (buffer) {
            const parsed = parseLine(buffer);
            if (parsed.data !== undefined) yield parsed.data;
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseLine(line);
          if (parsed.done) { done = true; break; }
          if (parsed.data !== undefined) yield parsed.data;
        }
      }
    } finally {
      // cancel() (unlike releaseLock()) closes the underlying connection when the
      // consumer stops early or the stream ended with [DONE] before EOF.
      await reader.cancel().catch(() => {});
    }
  }
}
