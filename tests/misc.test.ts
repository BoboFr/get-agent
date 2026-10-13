import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FileHistoryAdapter, createTool } from "../src/index.js";

describe("createTool", () => {
  const tool = createTool("t", "", z.object({ n: z.number(), ok: z.boolean().optional() }), (a) => a);

  it("coerces string primitives before validation", async () => {
    expect(await tool.execute({ n: "4", ok: "TRUE" } as any)).toEqual({ n: 4, ok: true });
  });

  it("rejects invalid arguments and names", async () => {
    await expect(tool.execute({ n: "abc" } as any)).rejects.toThrow(/Validation failed for tool 't'/);
    expect(() => createTool("bad name", "", z.object({}), () => 0)).toThrow(/Invalid tool name/);
  });
});

describe("FileHistoryAdapter", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "get-agent-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("saves, loads and clears a session", async () => {
    const adapter = new FileHistoryAdapter(dir);
    expect(await adapter.load("s1")).toEqual([]);
    await adapter.save("s1", [{ role: "user", content: "salut" }]);
    expect(await adapter.load("s1")).toEqual([{ role: "user", content: "salut" }]);
    await adapter.clear("s1");
    expect(await readFile(join(dir, "s1.json"), "utf-8")).toBe("[]");
    await adapter.clear("absent"); // no-op
  });

  it("rejects session ids that could escape the directory", async () => {
    const adapter = new FileHistoryAdapter(dir);
    await expect(adapter.save("../evil", [])).rejects.toThrow(/Invalid session id/);
    await expect(adapter.load("a/b")).rejects.toThrow(/Invalid session id/);
  });
});
