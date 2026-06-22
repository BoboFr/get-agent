import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServerConfig, Tool } from "./types.js";

export class McpManager {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();
  private tools: Tool[] = [];
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /**
   * Connects to all configured MCP servers and fetches their tools.
   * @param configs Array of MCP server configurations.
   */
  async connectAll(configs: McpServerConfig[]): Promise<Tool[]> {
    for (const config of configs) {
      try {
        await this.connectServer(config);
      } catch (error: any) {
        if (this.verbose) {
          console.error(`Failed to connect to MCP server '${config.name}':`, error.message);
        }
      }
    }
    return this.tools;
  }

  /**
   * Connects to a single MCP server.
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
      } as any,
    });

    const client = new Client(
      {
        name: `get-agent-client-${config.name}`,
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    this.clients.set(config.name, client);
    this.transports.set(config.name, transport);

    // Fetch tools supported by this server
    const response = await client.listTools();
    const serverTools: Tool[] = response.tools.map((mcpTool) => {
      // Create a unified Tool interface wrapper
      const tool: Tool = {
        // We namespace or keep the original name. Let's use the original name
        // but verify later that there are no duplicates.
        name: mcpTool.name,
        description: mcpTool.description || "",
        schema: mcpTool.inputSchema || { type: "object", properties: {} },
        execute: async (args) => {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args,
          });
          return result;
        },
      };
      return tool;
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
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
      } catch (error: any) {
        if (this.verbose) {
          console.error(`Error closing MCP client '${name}':`, error.message);
        }
      }
    }

    this.clients.clear();
    this.transports.clear();
    this.tools = [];
  }
}
