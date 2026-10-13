import { Tool } from "./types.js";

/**
 * Configuration for creating a Toolkit.
 */
export interface ToolkitConfig {
  /** Unique name for the toolkit (alphanumeric + underscores/dashes). */
  name: string;
  /** Human-readable description of what the toolkit provides. */
  description: string;
  /** Array of tools that this toolkit provides. */
  tools: Tool[];
  /** Additional system prompt instructions added to the agent's system prompt. */
  systemPrompt?: string;
  /**
   * If true (default), tool names are prefixed with the toolkit name (e.g. `web_fetch_url`)
   * to avoid naming collisions. Set to false to keep original tool names.
   */
  prefixToolNames?: boolean;
  /** Optional async hook called when the agent initializes. Use for setup (connections, cache, etc.). */
  initialize?: () => Promise<void> | void;
  /** Optional async hook called when the agent shuts down. Use for cleanup. */
  shutdown?: () => Promise<void> | void;
}

/**
 * A Toolkit is a reusable module that bundles a set of tools,
 * optional system prompt instructions, and lifecycle hooks.
 *
 * Toolkits package related capabilities together so they can be shared
 * across agents. Not to be confused with Agent Skills (SKILL.md folders,
 * see `loadAgentSkills`), which are instructions loaded on demand.
 *
 * @example
 * ```ts
 * const web = createToolkit({
 *   name: "web",
 *   description: "Web browsing capabilities",
 *   tools: [fetchUrlTool, searchTool],
 *   systemPrompt: "You can browse the web using the provided tools.",
 *   initialize: async () => { console.log("Web toolkit ready"); },
 *   shutdown: async () => { console.log("Web toolkit cleaned up"); },
 * });
 * ```
 */
export class Toolkit {
  private config: ToolkitConfig;
  private initialized = false;

  constructor(config: ToolkitConfig) {
    if (!/^[a-zA-Z0-9_-]+$/.test(config.name)) {
      throw new Error(
        `Invalid toolkit name '${config.name}'. Toolkit names must be alphanumeric with dashes or underscores.`
      );
    }
    if (!config.tools || config.tools.length === 0) {
      throw new Error(
        `Toolkit '${config.name}' must provide at least one tool.`
      );
    }
    this.config = {
      ...config,
      prefixToolNames: config.prefixToolNames !== undefined ? config.prefixToolNames : true,
    };
  }

  /** Returns the toolkit's unique name. */
  getName(): string {
    return this.config.name;
  }

  /** Returns the toolkit's description. */
  getDescription(): string {
    return this.config.description;
  }

  /** Returns the toolkit's additional system prompt, or undefined if none. */
  getSystemPrompt(): string | undefined {
    return this.config.systemPrompt;
  }

  /** Returns whether tool names should be prefixed with the toolkit name. */
  shouldPrefixToolNames(): boolean {
    return this.config.prefixToolNames !== false;
  }

  /**
   * Returns the toolkit's tools.
   * If `prefixToolNames` is true, tool names are prefixed with `toolkitName_`.
   */
  getTools(): Tool[] {
    if (!this.shouldPrefixToolNames()) {
      return this.config.tools;
    }

    return this.config.tools.map((tool) => ({
      ...tool,
      name: `${this.config.name}_${tool.name}`,
    }));
  }

  /**
   * Returns the original (unprefixed) tools as configured.
   */
  getRawTools(): Tool[] {
    return this.config.tools;
  }

  /** Returns whether this toolkit has been initialized. */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Runs the toolkit's initialize hook if defined. No-op if already initialized.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.initialize) {
      await this.config.initialize();
    }
    this.initialized = true;
  }

  /**
   * Runs the toolkit's shutdown hook if defined. No-op if not initialized.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    if (this.config.shutdown) {
      await this.config.shutdown();
    }
    this.initialized = false;
  }
}

/**
 * Factory function to create a Toolkit instance.
 * Consistent with `createTool()` API style.
 *
 * @param config The toolkit configuration.
 * @returns A new Toolkit instance.
 *
 * @example
 * ```ts
 * const math = createToolkit({
 *   name: "math",
 *   description: "Mathematical computation tools",
 *   tools: [calculatorTool, graphTool],
 *   systemPrompt: "Use the math tools for any numerical computation.",
 * });
 *
 * const agent = new Agent({
 *   name: "assistant",
 *   toolkits: [math],
 * });
 * ```
 */
export function createToolkit(config: ToolkitConfig): Toolkit {
  return new Toolkit(config);
}
