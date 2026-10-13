import { vi } from "vitest";

export type MockReply =
  | { kind: "json"; body: any; status?: number; headers?: Record<string, string> }
  | { kind: "sse"; events: any[]; done?: boolean; trailingNewline?: boolean }
  | { kind: "error"; error: Error };

/** A chat completion response with text content and optional tool calls. */
export function completion(
  content: string | null,
  toolCalls?: Array<{ name: string; args: any; id?: string }>,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): MockReply {
  return {
    kind: "json",
    body: {
      choices: [{
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls?.map((tc, i) => ({
            id: tc.id ?? `call_${i}`,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        },
      }],
      usage,
    },
  };
}

/** A streamed response made of content deltas. */
export function streamOf(chunks: string[], usage?: any): MockReply {
  const events: any[] = chunks.map((c) => ({ choices: [{ delta: { content: c } }] }));
  if (usage) events.push({ choices: [], usage });
  return { kind: "sse", events };
}

/**
 * Replaces global fetch with a queue of canned replies.
 * Returns the mock so tests can inspect the request bodies.
 */
export function mockFetch(replies: MockReply[]) {
  const queue = [...replies];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const reply = queue.shift();
    if (!reply) throw new Error("mockFetch: no reply left in the queue");
    if (init.signal?.aborted) throw init.signal.reason;
    if (reply.kind === "error") throw reply.error;
    if (reply.kind === "json") {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
      });
    }
    const lines = reply.events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
    if (reply.done !== false) lines.push("data: [DONE]\n\n");
    let text = lines.join("");
    if (reply.trailingNewline === false) text = text.replace(/\n+$/, "");
    const encoder = new TextEncoder();
    // Split into small pieces to exercise the SSE line buffering.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    /** Parsed JSON body of the n-th request. */
    body: (n: number) => JSON.parse(fetchMock.mock.calls[n][1].body as string),
    remaining: () => queue.length,
  };
}

export async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}
