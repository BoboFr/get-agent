import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractToolCalls,
  getPrefixMatchLen,
  parsePythonicCall,
  parsePythonLikeLiteral,
  processThinking,
  toJsonSchema,
  validateStructuredOutput,
} from "../src/parsing.js";

const args = (s: string) => JSON.parse(s);

describe("extractToolCalls", () => {
  it("returns nothing for plain text", () => {
    expect(extractToolCalls("Bonjour")).toEqual({ toolCalls: [], cleanContent: "Bonjour" });
    expect(extractToolCalls(null)).toEqual({ toolCalls: [], cleanContent: "" });
  });

  it("parses LFM markers with a pythonic body", () => {
    const { toolCalls, cleanContent } = extractToolCalls(
      `Je regarde.<|tool_call_start|>[get_weather(city="Paris", days=3)]<|tool_call_end|>`
    );
    expect(cleanContent).toBe("Je regarde.");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("get_weather");
    expect(args(toolCalls[0].function.arguments)).toEqual({ city: "Paris", days: 3 });
    expect(toolCalls[0].id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it("parses Qwen/Hermes <tool_call> tags with a JSON body", () => {
    const { toolCalls } = extractToolCalls(
      `<tool_call>{"name": "add", "arguments": {"a": 1, "b": 2}}</tool_call><tool_call>{"name":"sub","arguments":{"a":3}}</tool_call>`
    );
    expect(toolCalls.map((t) => t.function.name)).toEqual(["add", "sub"]);
    expect(args(toolCalls[0].function.arguments)).toEqual({ a: 1, b: 2 });
  });

  it("parses bare JSON objects and arrays", () => {
    expect(extractToolCalls(`{"name":"ping","arguments":{}}`).toolCalls[0].function.name).toBe("ping");
    const arr = extractToolCalls(`[{"name":"a","arguments":{"x":1}},{"name":"b","arguments":"{\\"y\\":2}"}]`);
    expect(arr.toolCalls.map((t) => t.function.name)).toEqual(["a", "b"]);
    expect(arr.toolCalls[1].function.arguments).toBe(`{"y":2}`);
    expect(arr.cleanContent).toBe("");
  });

  it("only accepts bare JSON naming a known tool when knownTools is given", () => {
    const answer = `{"name":"Alice","arguments":"none"}`;
    expect(extractToolCalls(answer, { knownTools: new Set(["ping"]) }).toolCalls).toHaveLength(0);
    expect(extractToolCalls(answer, { knownTools: new Set(["Alice"]) }).toolCalls).toHaveLength(1);
  });

  it("parses <tool name=… arguments={…}> with Python literals", () => {
    const { toolCalls, cleanContent } = extractToolCalls(
      `Avant <tool name="search" arguments={'q': 'chat d\\'or', 'safe': True, 'n': None}> après`
    );
    expect(toolCalls[0].function.name).toBe("search");
    expect(args(toolCalls[0].function.arguments)).toEqual({ q: "chat d'or", safe: true, n: null });
    expect(cleanContent).toBe("Avant  après");
  });
});

describe("parsePythonicCall", () => {
  it("parses typed keyword arguments", () => {
    expect(parsePythonicCall(`f(a=1, b=True, c=None, d='x', e=[1, 2], f={"k": 1})`)).toEqual({
      name: "f",
      arguments: { a: 1, b: true, c: null, d: "x", e: [1, 2], f: { k: 1 } },
    });
  });

  it("handles calls without arguments and rejects non-calls", () => {
    expect(parsePythonicCall("now()")).toEqual({ name: "now", arguments: {} });
    expect(parsePythonicCall("hello world")).toBeNull();
  });
});

describe("parsePythonLikeLiteral", () => {
  it("accepts JSON and Python dicts", () => {
    expect(parsePythonLikeLiteral(`{"a": 1}`)).toEqual({ a: 1 });
    expect(parsePythonLikeLiteral(`{'a': 'say "hi"', 'b': False}`)).toEqual({ a: `say "hi"`, b: false });
    expect(parsePythonLikeLiteral(`{oops`)).toBeNull();
  });
});

describe("processThinking", () => {
  it("splits the first think block", () => {
    expect(processThinking("<think> hmm </think>Réponse")).toEqual({ thinking: "hmm", cleanContent: "Réponse" });
    expect(processThinking("<think>only</think>")).toEqual({ thinking: "only", cleanContent: null });
    expect(processThinking("plain")).toEqual({ thinking: "", cleanContent: "plain" });
    expect(processThinking(null)).toEqual({ thinking: "", cleanContent: null });
  });
});

describe("getPrefixMatchLen", () => {
  it("finds the partial tag at the end", () => {
    expect(getPrefixMatchLen("abc<thi", "<think>")).toBe(4);
    expect(getPrefixMatchLen("abc", "<think>")).toBe(0);
    expect(getPrefixMatchLen("<think>", "<think>")).toBe(0); // full tag is not a partial match
  });
});

describe("toJsonSchema", () => {
  it("converts Zod schemas without $schema and caches the result", () => {
    const schema = z.object({ city: z.string() });
    const a = toJsonSchema(schema);
    expect(a.$schema).toBeUndefined();
    expect(a.properties.city.type).toBe("string");
    expect(toJsonSchema(schema)).toBe(a);
  });

  it("returns non-Zod schemas unchanged", () => {
    const raw = { type: "object", properties: {} };
    expect(toJsonSchema(raw)).toBe(raw);
  });
});

describe("validateStructuredOutput", () => {
  const schema = z.object({ n: z.number() });

  it("accepts raw JSON, fenced JSON and JSON after a think block", () => {
    expect(validateStructuredOutput(`{"n":1}`, schema)).toEqual({ success: true, data: { n: 1 } });
    expect(validateStructuredOutput("```json\n{\"n\":2}\n```", schema)).toEqual({ success: true, data: { n: 2 } });
    expect(validateStructuredOutput("```\n{\"n\":3}\n```", schema)).toEqual({ success: true, data: { n: 3 } });
    expect(validateStructuredOutput(`<think>x</think>{"n":4}`, schema)).toEqual({ success: true, data: { n: 4 } });
  });

  it("reports JSON and schema errors", () => {
    const bad = validateStructuredOutput("pas du json", schema);
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toContain("Invalid JSON format");
    expect(validateStructuredOutput(`{"n":"x"}`, schema).success).toBe(false);
  });
});
