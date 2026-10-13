import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient, LLMError } from "../src/llm.js";
import { mockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ok = { kind: "json" as const, body: { choices: [{ message: { content: "ok" } }] } };

describe("LLMClient", () => {
  it("sends the auth header only with a real key", async () => {
    const http = mockFetch([ok, ok]);
    await new LLMClient("http://x/v1/", "sk-1").chatCompletion({ model: "m", messages: [] });
    await new LLMClient("http://x/v1").chatCompletion({ model: "m", messages: [] });
    expect(http.fetchMock.mock.calls[0][0]).toBe("http://x/v1/chat/completions");
    expect((http.fetchMock.mock.calls[0][1].headers as any).Authorization).toBe("Bearer sk-1");
    expect((http.fetchMock.mock.calls[1][1].headers as any).Authorization).toBeUndefined();
  });

  it("retries retryable statuses and honours Retry-After", async () => {
    const http = mockFetch([
      { kind: "json", status: 429, body: {}, headers: { "retry-after": "0" } },
      { kind: "json", status: 503, body: {} },
      ok,
    ]);
    const client = new LLMClient("http://x", "k", { initialDelayMs: 1 });
    const res = await client.chatCompletion({ model: "m", messages: [] });
    expect(res.choices[0].message.content).toBe("ok");
    expect(http.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable statuses", async () => {
    mockFetch([{ kind: "json", status: 400, body: { error: "bad" } }]);
    const err = await new LLMClient("http://x").chatCompletion({ model: "m", messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(400);
  });

  it("does not retry after the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const http = mockFetch([ok, ok]);
    await expect(
      new LLMClient("http://x", "k", { initialDelayMs: 1 }).chatCompletion({ model: "m", messages: [], signal: controller.signal })
    ).rejects.toBeDefined();
    expect(http.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hanging attempt and retries it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      return Promise.resolve(new Response(JSON.stringify(ok.body)));
    }));
    const client = new LLMClient("http://x", "k", { timeoutMs: 20, initialDelayMs: 1 });
    const res = await client.chatCompletion({ model: "m", messages: [] });
    expect(res.choices[0].message.content).toBe("ok");
    expect(calls).toBe(2);
  });

  it("parses SSE events split across chunks and stops at [DONE]", async () => {
    mockFetch([{ kind: "sse", events: [{ a: 1 }, { b: 2 }] }]);
    const events: any[] = [];
    for await (const e of new LLMClient("http://x").chatCompletionStream({ model: "m", messages: [] })) events.push(e);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
