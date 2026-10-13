import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, Skill, Toolkit, createAgentTool, createSkill, createTool, createToolkit, maxLength, redactPII } from "../src/index.js";
import type { HistoryAdapter, Message } from "../src/index.js";
import { collect, completion, mockFetch, streamOf } from "./helpers.js";

const usage = (total: number) => ({ prompt_tokens: total / 2, completion_tokens: total / 2, total_tokens: total });

const addTool = createTool(
  "add",
  "Adds two numbers",
  z.object({ a: z.number(), b: z.number() }),
  ({ a, b }) => a + b
);

function newAgent(extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  return new Agent({ name: "test", model: "test-model", retry: { maxRetries: 0 }, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agent.run", () => {
  it("runs the tool loop and returns the final text", async () => {
    const http = mockFetch([
      completion(null, [{ name: "add", args: { a: 2, b: "3" } }]),
      completion("Le résultat est 5."),
    ]);
    const agent = newAgent({ tools: [addTool] });

    expect(await agent.run("2+3 ?")).toBe("Le résultat est 5.");

    const history = agent.getHistory();
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(history[3]).toMatchObject({ role: "tool", name: "add", tool_call_id: "call_0", content: "5" });
    expect(http.body(0).tools[0].function.name).toBe("add");
    expect(http.body(0).tools[0].function.parameters.$schema).toBeUndefined();
  });

  it("recovers tool calls embedded in text content", async () => {
    mockFetch([
      completion(`<tool_call>{"name":"add","arguments":{"a":1,"b":1}}</tool_call>`),
      completion("2"),
    ]);
    const agent = newAgent({ tools: [addTool] });
    expect(await agent.run("1+1")).toBe("2");
    expect(agent.getHistory()[3].content).toBe("2");
  });

  it("does not mistake a bare JSON answer for an unknown tool call", async () => {
    mockFetch([completion(`{"name":"Alice","arguments":"aucun"}`)]);
    const agent = newAgent({ tools: [addTool] });
    expect(await agent.run("Qui ?")).toBe(`{"name":"Alice","arguments":"aucun"}`);
  });

  it("throws when maxIterations is exceeded", async () => {
    mockFetch([
      completion(null, [{ name: "add", args: { a: 1, b: 1 } }]),
      completion(null, [{ name: "add", args: { a: 1, b: 1 } }]),
    ]);
    await expect(newAgent({ tools: [addTool], maxIterations: 2 }).run("boucle")).rejects.toThrow(/max iterations \(2\)/);
  });

  it("strips <think> blocks when showThinking is false", async () => {
    mockFetch([completion("<think>raisonnement</think>Réponse")]);
    expect(await newAgent({ showThinking: false }).run("q")).toBe("Réponse");
  });

  it("serializes concurrent runs on the same instance", async () => {
    mockFetch([completion("un"), completion("deux")]);
    const agent = newAgent();
    const [a, b] = await Promise.all([agent.run("premier"), agent.run("second")]);
    expect([a, b]).toEqual(["un", "deux"]);
    expect(agent.getHistory().map((m) => [m.role, m.content])).toEqual([
      ["system", "You are a helpful AI assistant."],
      ["user", "premier"],
      ["assistant", "un"],
      ["user", "second"],
      ["assistant", "deux"],
    ]);
  });

  it("initializes toolkits only once under concurrent runs", async () => {
    const init = vi.fn();
    const toolkit = createToolkit({ name: "math", description: "", tools: [addTool], initialize: init, systemPrompt: "Use math." });
    mockFetch([completion("a"), completion("b")]);
    const agent = newAgent({ toolkits: [toolkit] });
    await Promise.all([agent.run("1"), agent.run("2")]);
    expect(init).toHaveBeenCalledTimes(1);
    expect(agent.getHistory()[0].content).toBe("You are a helpful AI assistant.\n\nUse math.");
    expect(agent.getRegisteredTools().map((t) => t.name)).toEqual(["math_add"]);
  });

  it("invalidates the tools payload when toolkits change", async () => {
    const http = mockFetch([completion("a"), completion("b"), completion("c")]);
    const agent = newAgent({ tools: [addTool] });
    await agent.run("1");
    await agent.addToolkit(createToolkit({ name: "s", description: "", tools: [addTool] }));
    await agent.run("2");
    await agent.removeToolkit("s");
    await agent.run("3");
    expect(http.body(0).tools.map((t: any) => t.function.name)).toEqual(["add"]);
    expect(http.body(1).tools.map((t: any) => t.function.name)).toEqual(["add", "s_add"]);
    expect(http.body(2).tools.map((t: any) => t.function.name)).toEqual(["add"]);
  });

  it("keeps the deprecated Skill aliases working", async () => {
    mockFetch([completion("ok")]);
    const legacy = createSkill({ name: "legacy", description: "", tools: [addTool], systemPrompt: "Legacy." });
    expect(legacy).toBeInstanceOf(Toolkit);
    expect(Skill).toBe(Toolkit);

    const agent = newAgent({ skills: [legacy] });
    await agent.addSkill(createSkill({ name: "extra", description: "", tools: [addTool] }));
    expect(agent.getRegisteredSkills().map((t) => t.getName())).toEqual(["legacy", "extra"]);
    await agent.run("q");
    expect(agent.getHistory()[0].content).toBe("You are a helpful AI assistant.\n\nLegacy.");
    await agent.removeSkill("extra");
    expect(agent.getRegisteredToolkits().map((t) => t.getName())).toEqual(["legacy"]);
  });

  it("passes an AbortSignal through to fetch", async () => {
    const http = mockFetch([completion("ok")]);
    const controller = new AbortController();
    await newAgent().run("q", { signal: controller.signal });
    expect(http.fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe("structured output", () => {
  const schema = z.object({ city: z.string(), temp: z.number() });

  it("returns validated data", async () => {
    const http = mockFetch([completion(`{"city":"Paris","temp":21}`)]);
    expect(await newAgent().run("météo", { schema })).toEqual({ city: "Paris", temp: 21 });
    expect(http.body(0).response_format).toEqual({ type: "json_object" });
    expect(http.body(0).messages.at(-1).content).toContain("CRITICAL");
  });

  it("corrects invalid output and keeps only the valid answer in history", async () => {
    mockFetch([
      completion(`{"city":"Paris"}`, undefined, usage(10)),
      completion(`{"city":"Paris","temp":"chaud"}`, undefined, usage(10)),
      completion(`{"city":"Paris","temp":21}`, undefined, usage(10)),
    ]);
    const agent = newAgent();
    expect(await agent.run("météo", { schema })).toEqual({ city: "Paris", temp: 21 });

    const history = agent.getHistory();
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(history[2].content).toBe(`{"city":"Paris","temp":21}`);
    expect(agent.getUsage()).toMatchObject({ llmCallCount: 3, totalTokens: 30 });
  });

  it("enforces the budget during correction retries", async () => {
    mockFetch([
      completion(`invalide`, undefined, usage(60)),
      completion(`toujours invalide`, undefined, usage(60)),
    ]);
    const agent = newAgent({ budget: { maxTokens: 100 } });
    await expect(agent.run("x", { schema })).rejects.toThrow(/\[Budget\] Token limit reached: 120\/100/);
  });

  it("throws after maxRetries and cleans the correction exchange", async () => {
    mockFetch([completion("nope"), completion("nope encore")]);
    const agent = newAgent();
    await expect(agent.run("x", { schema, maxRetries: 1 })).rejects.toThrow(/after 1 correction retries/);
    expect(agent.getHistory().map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });
});

describe("hooks, guardrails and approval", () => {
  it("applies input and output guardrails", async () => {
    const http = mockFetch([completion("Écrivez à bob@example.com")]);
    const agent = newAgent({ guardrails: { input: [redactPII()], output: [redactPII()] } });
    expect(await agent.run("mon mail est alice@example.com")).toBe("Écrivez à [EMAIL]");
    expect(http.body(0).messages[1].content).toBe("mon mail est [EMAIL]");
  });

  it("blocks input before any LLM call", async () => {
    const http = mockFetch([]);
    await expect(newAgent({ guardrails: { input: [maxLength(3)] } }).run("trop long")).rejects.toThrow(/\[Guardrail\]/);
    expect(http.fetchMock).not.toHaveBeenCalled();
  });

  it("lets beforeToolCall replace arguments and afterToolCall replace results", async () => {
    mockFetch([completion(null, [{ name: "add", args: { a: 1, b: 1 } }]), completion("ok")]);
    const agent = newAgent({
      tools: [addTool],
      hooks: {
        beforeToolCall: (_name, args) => ({ ...args, a: 10 }),
        afterToolCall: (_name, _args, result) => `résultat=${result}`,
      },
    });
    await agent.run("go");
    expect(agent.getHistory()[3].content).toBe("résultat=11");
  });

  it("cancels a tool when approval is refused", async () => {
    mockFetch([completion(null, [{ name: "danger", args: {} }]), completion("annulé")]);
    const execute = vi.fn();
    const agent = newAgent({
      tools: [{ name: "danger", description: "", schema: { type: "object", properties: {} }, execute, requiresApproval: true }],
      onApprovalRequired: async () => false,
    });
    await agent.run("go");
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(agent.getHistory()[3].content as string)).toMatchObject({ cancelled: true });
  });

  it("calls beforeLLMCall with the windowed messages", async () => {
    const seen: number[] = [];
    mockFetch([completion("1"), completion("2"), completion("3")]);
    const agent = newAgent({
      context: { maxMessages: 2 },
      hooks: { beforeLLMCall: (messages) => { seen.push(messages.length); } },
    });
    await agent.run("a");
    await agent.run("b");
    await agent.run("c");
    // system + at most 2 other messages
    expect(seen).toEqual([2, 3, 3]);
    expect(agent.getHistory()).toHaveLength(7); // the stored history is untouched
  });
});

describe("context window", () => {
  it("never starts the window with an orphan tool result", async () => {
    const http = mockFetch([
      completion(null, [{ name: "add", args: { a: 1, b: 1 } }]),
      completion("fini"),
    ]);
    const agent = newAgent({ tools: [addTool], context: { maxMessages: 1 } });
    await agent.run("go");
    // Second call: history is [system, user, assistant(tool_calls), tool]; the last
    // message is a tool result whose call was cut, so it is dropped too.
    expect(http.body(1).messages.map((m: Message) => m.role)).toEqual(["system"]);
  });

  it("truncates long tool results", async () => {
    mockFetch([completion(null, [{ name: "big", args: {} }]), completion("ok")]);
    const agent = newAgent({
      tools: [{ name: "big", description: "", schema: {}, execute: () => "x".repeat(50) }],
      context: { maxToolResultChars: 10 },
    });
    await agent.run("go");
    expect(agent.getHistory()[3].content).toBe(`${"x".repeat(10)}\n…[truncated 40 characters]`);
  });
});

describe("Agent.runStream", () => {
  it("streams text, hides tool blocks, runs tools and saves history", async () => {
    const saved: Message[][] = [];
    const adapter: HistoryAdapter = {
      load: async () => [],
      save: async (_id, messages) => { saved.push(messages.map((m) => ({ ...m }))); },
      clear: async () => {},
    };
    mockFetch([
      streamOf(["Je calc", "ule <tool_", "call>{\"name\":\"add\",\"arguments\":{\"a\":2,\"b\":2}}</tool_call>"], usage(10)),
      streamOf(["<thi", "nk>ok</think>", "Ça fait 4."], usage(10)),
    ]);
    const afterLLMCall = vi.fn();
    const agent = newAgent({ tools: [addTool], historyAdapter: adapter, sessionId: "s1", hooks: { afterLLMCall } });

    const text = (await collect(agent.runStream("2+2"))).join("");
    expect(text).toBe("Je calcule <think>ok</think>Ça fait 4.");
    expect(agent.getHistory()[3]).toMatchObject({ role: "tool", content: "4" });
    expect(afterLLMCall).toHaveBeenCalledTimes(2);
    expect(saved).toHaveLength(1);
    expect(agent.getUsage()).toMatchObject({ llmCallCount: 2, totalTokens: 20 });
  });

  it("accumulates native streamed tool calls", async () => {
    mockFetch([
      {
        kind: "sse",
        events: [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "add", arguments: "{\"a\":1," } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"b\":4}" } }] } }] },
        ],
      },
      streamOf(["5"]),
    ]);
    const agent = newAgent({ tools: [addTool] });
    expect((await collect(agent.runStream("q"))).join("")).toBe("5");
    expect(agent.getHistory()[3]).toMatchObject({ tool_call_id: "c1", content: "5" });
  });

  it("surfaces reasoning_content as a think block", async () => {
    mockFetch([{
      kind: "sse",
      events: [
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "Oui" } }] },
      ],
    }]);
    expect((await collect(newAgent().runStream("q"))).join("")).toBe("<think>hmm</think>Oui");
  });

  it("applies input and output guardrails", async () => {
    mockFetch([streamOf(["mot interdit"])]);
    const agent = newAgent({
      guardrails: {
        input: [redactPII()],
        output: [(t) => ({ allowed: !t.includes("interdit"), reason: "interdit" })],
      },
    });
    await expect(collect(agent.runStream("a@b.fr"))).rejects.toThrow(/\[Guardrail\] interdit/);
    expect(agent.getHistory()[1].content).toBe("[EMAIL]");
  });

  it("parses a final SSE event without trailing newline", async () => {
    mockFetch([{ kind: "sse", events: [{ choices: [{ delta: { content: "fin" } }] }], done: false, trailingNewline: false }]);
    expect((await collect(newAgent().runStream("q"))).join("")).toBe("fin");
  });

  it("releases the run lock when the consumer stops early", async () => {
    mockFetch([streamOf(["a", "b", "c"]), completion("suivant")]);
    const agent = newAgent();
    for await (const _ of agent.runStream("q")) break;
    expect(await agent.run("encore")).toBe("suivant");
  });
});

describe("runStreamStructured", () => {
  it("streams and resolves the validated object", async () => {
    mockFetch([streamOf(['{"n":', "1}"])]);
    const { stream, result } = newAgent().runStreamStructured("q", { schema: z.object({ n: z.number() }) });
    expect((await collect(stream)).join("")).toBe('{"n":1}');
    expect(await result).toEqual({ n: 1 });
  });

  it("falls back to a correction call when the stream is invalid", async () => {
    mockFetch([streamOf(["pas json"]), completion('{"n":2}')]);
    const { stream, result } = newAgent().runStreamStructured("q", { schema: z.object({ n: z.number() }) });
    await collect(stream);
    expect(await result).toEqual({ n: 2 });
  });
});

describe("createAgentTool", () => {
  it("delegates to a sub-agent", async () => {
    mockFetch([
      completion(null, [{ name: "traducteur", args: { input: "bonjour" } }]),
      completion("hello"),
      completion("Traduction : hello"),
    ]);
    const sub = newAgent({ name: "sub" });
    const parent = newAgent({ tools: [createAgentTool(sub, { name: "traducteur", description: "Traduit" })] });
    expect(await parent.run("traduis bonjour")).toBe("Traduction : hello");
    expect(parent.getHistory()[3].content).toBe("hello");
  });
});
