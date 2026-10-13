import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Logger } from "./logger.js";
import { McpServerConfig, Tool } from "./types.js";

/**
 * Converts an MCP CallToolResult into a tool result suited to the LLM:
 * text-only content is joined into a plain string, `isError` becomes a thrown error,
 * and anything else (images, resources, structured content) is returned as-is.
 */
function toToolResult(result: any): any {
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const allText = content.length > 0 && content.every((c) => c?.type === "text");
  const text = allText ? content.map((c) => c.text).join("\n") : undefined;

  if (result?.isError) {
    throw new Error(text ?? JSON.stringify(content));
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  if (text !== undefined) return text;
  return result;
}

export class McpManager {
  private clients: Map<string, Client> = new Map();
  private tools: Tool[] = [];
  private logger: Logger;

  constructor(verbose = false, logger?: Logger) {
    this.logger = logger ?? new Logger("MCP", { level: verbose ? "debug" : "warn" });
  }

  /**
   * Connects to all configured MCP servers in parallel and fetches their tools.
   * Failed connections are logged; with `strict`, the first failure is thrown
   * after all attempts have settled.
   */
  async connectAll(configs: McpServerConfig[], strict = false): Promise<Tool[]> {
    const results = await Promise.allSettled(configs.map((config) => this.connectServer(config)));
    const failures: Error[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        const message = result.reason?.message ?? String(result.reason);
        this.logger.warn(`Failed to connect to MCP server '${configs[i].name}': ${message}`);
        failures.push(new Error(`MCP server '${configs[i].name}': ${message}`));
      }
    });
    if (strict && failures.length > 0) throw failures[0];
    return this.tools;
  }

  /**
   * Connects to a single MCP server.
   * Tool names already exposed by another server are prefixed with `<server>_`.
   * @param config The MCP server configuration.
   */
  async connectServer(config: McpServerConfig): Promise<Tool[]> {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP Server '${config.name}' is already connected.`);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: {
        ...process.env,
        ...(config.env || {}),
      } as Record<string, string>,
    });

    const client = new Client(
      { name: `get-agent-client-${config.name}`, version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    this.clients.set(config.name, client);

    const response = await client.listTools();
    const taken = new Set(this.tools.map((t) => t.name));
    const serverTools: Tool[] = response.tools.map((mcpTool) => {
      const name = taken.has(mcpTool.name) ? `${config.name}_${mcpTool.name}` : mcpTool.name;
      if (name !== mcpTool.name) {
        this.logger.warn(`MCP tool '${mcpTool.name}' from '${config.name}' collides with another server; exposed as '${name}'.`);
      }
      taken.add(name);
      return {
        name,
        description: mcpTool.description || "",
        schema: mcpTool.inputSchema || { type: "object", properties: {} },
        execute: async (args) => toToolResult(await client.callTool({ name: mcpTool.name, arguments: args })),
      };
    });

    this.tools.push(...serverTools);
    return serverTools;
  }

  /**
   * Get all registered MCP tools.
   */
  getTools(): Tool[] {
    return this.tools;
  }

  /**
   * Disconnects and stops all MCP servers cleanly.
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.clients.entries()].map(async ([name, client]) => {
        try {
          await client.close();
        } catch (error: any) {
          this.logger.warn(`Error closing MCP client '${name}': ${error.message}`);
        }
      })
    );

    this.clients.clear();
    this.tools = [];
  }
}
