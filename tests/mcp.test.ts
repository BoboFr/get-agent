import { describe, expect, it } from "vitest";
import { Logger, McpManager } from "../src/index.js";
import type { LogEntry } from "../src/index.js";

const missing = { name: "absent", command: "get-agent-command-that-does-not-exist" };

describe("McpManager.connectAll", () => {
  it("logs a warning and continues when a server cannot start", async () => {
    const entries: LogEntry[] = [];
    const manager = new McpManager(false, new Logger("mcp", { level: "warn", transport: (e) => entries.push(e) }));
    expect(await manager.connectAll([missing])).toEqual([]);
    expect(entries[0]).toMatchObject({ level: "warn" });
    expect(entries[0].message).toContain("absent");
  });

  it("throws in strict mode", async () => {
    const manager = new McpManager(false, new Logger("mcp", { transport: () => {} }));
    await expect(manager.connectAll([missing], true)).rejects.toThrow(/MCP server 'absent'/);
  });
});
