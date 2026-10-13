import { describe, expect, it } from "vitest";
import { StreamTagParser } from "../src/stream-parser.js";

function feed(parser: StreamTagParser, chunks: string[]): string {
  const out: string[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.flush());
  return out.join("");
}

describe("StreamTagParser", () => {
  it("passes plain text through", () => {
    expect(feed(new StreamTagParser(), ["Bon", "jour"])).toBe("Bonjour");
  });

  it("holds back a tag split across chunks", () => {
    const parser = new StreamTagParser();
    expect(parser.push("Salut <thi")).toEqual(["Salut "]);
    expect(parser.push("nk>réflexion</th")).toEqual(["<think>", "réflexion"]);
    expect(parser.push("ink> fin")).toEqual(["</think>", " fin"]);
  });

  it("hides thinking when showThinking is false and reports it", () => {
    const thoughts: string[] = [];
    const parser = new StreamTagParser({ showThinking: false, onThinking: (t) => thoughts.push(t) });
    expect(feed(parser, ["<think>se", "cret</think>", "visible"])).toBe("visible");
    expect(thoughts).toEqual(["secret"]);
  });

  it("extracts LFM and <tool_call> blocks and hides them", () => {
    const parser = new StreamTagParser();
    const text = feed(parser, [
      "Je calcule <|tool_call_",
      "start|>[add(a=1, b=2)]<|tool_call_end|> puis <tool_call>{\"name\":\"mul\",",
      "\"arguments\":{\"a\":3}}</tool_call>.",
    ]);
    expect(text).toBe("Je calcule  puis .");
    expect(parser.toolCalls.map((t) => t.function.name)).toEqual(["add", "mul"]);
    expect(JSON.parse(parser.toolCalls[0].function.arguments)).toEqual({ a: 1, b: 2 });
  });

  it("drops an unfinished tool block at flush", () => {
    const parser = new StreamTagParser();
    expect(feed(parser, ["ok <tool_call>{\"name\":"])).toBe("ok ");
    expect(parser.toolCalls).toHaveLength(0);
  });

  it("flushes a pending partial prefix that never became a tag", () => {
    expect(feed(new StreamTagParser(), ["a < b", " et c <"])).toBe("a < b et c <");
  });
});
