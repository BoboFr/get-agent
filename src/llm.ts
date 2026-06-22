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
}

export class LLMError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "LLMError";
  }
}

const DEFAULT_RETRYABLE = [429, 500, 502, 503, 504];

export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private retry: Required<RetryConfig>;

  constructor(baseUrl: string, apiKey = "no-key", retry: RetryConfig = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.retry = {
      maxRetries:       retry.maxRetries       ?? 3,
      initialDelayMs:   retry.initialDelayMs   ?? 500,
      maxDelayMs:       retry.maxDelayMs        ?? 10_000,
      retryableStatuses: retry.retryableStatuses ?? DEFAULT_RETRYABLE,
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey && this.apiKey !== "no-key") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error("Unknown error");
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const isRetryable =
          err instanceof LLMError
            ? this.retry.retryableStatuses.includes(err.status)
            : true; // network errors are always retried
        if (!isRetryable || attempt === this.retry.maxRetries) throw err;
        const jitter = Math.random() * 200;
        const delay = Math.min(this.retry.initialDelayMs * 2 ** attempt + jitter, this.retry.maxDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async chatCompletion(options: LLMRequestOptions): Promise<any> {
    return this.withRetry(async () => {
      const url = `${this.baseUrl}/chat/completions`;
      const body: Record<string, any> = { model: options.model, messages: options.messages };
      if (options.tools?.length)       { body.tools = options.tools; body.tool_choice = options.tool_choice ?? "auto"; }
      if (options.response_format)     body.response_format = options.response_format;
      if (options.temperature !== undefined) body.temperature = options.temperature;

      const response = await fetch(url, { method: "POST", headers: this.buildHeaders(), body: JSON.stringify(body) });
      if (!response.ok) {
        const errorText = await response.text();
        throw new LLMError(`LLM call failed (${response.status}): ${errorText}`, response.status);
      }
      return response.json();
    });
  }

  async *chatCompletionStream(options: LLMRequestOptions): AsyncGenerator<any, void, unknown> {
    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, any> = {
      model: options.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.tools?.length)       { body.tools = options.tools; body.tool_choice = options.tool_choice ?? "auto"; }
    if (options.response_format)     body.response_format = options.response_format;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    // Retry only applies to the initial connection, not mid-stream
    const response = await this.withRetry(async () => {
      const r = await fetch(url, { method: "POST", headers: this.buildHeaders(), body: JSON.stringify(body) });
      if (!r.ok) {
        const errorText = await r.text();
        throw new LLMError(`LLM stream call failed (${r.status}): ${errorText}`, r.status);
      }
      return r;
    });

    if (!response.body) throw new Error("No response body received for streaming.");

    const decoder = new TextDecoder();
    let buffer = "";

    const processLines = function* (lines: string[]) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === "[DONE]") return;
        try { yield JSON.parse(dataStr); } catch {}
      }
    };

    if (typeof (response.body as any).getReader === "function") {
      const reader = (response.body as any).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          yield* processLines(lines);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      for await (const chunk of response.body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        yield* processLines(lines);
      }
    }
  }
}
