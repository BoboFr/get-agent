import { Tool } from "./types.js";

/**
 * Configuration for creating a Skill.
 */
export interface SkillConfig {
  /** Unique name for the skill (alphanumeric + underscores/dashes). */
  name: string;
  /** Human-readable description of what the skill provides. */
  description: string;
  /** Array of tools that this skill provides. */
  tools: Tool[];
  /** Additional system prompt instructions injected when this skill is active. */
  systemPrompt?: string;
  /**
   * If true (default), tool names are prefixed with the skill name (e.g. `web_fetch_url`)
   * to avoid naming collisions. Set to false to keep original tool names.
   */
  prefixToolNames?: boolean;
  /** Optional async hook called when the agent initializes. Use for setup (connections, cache, etc.). */
  initialize?: () => Promise<void> | void;
  /** Optional async hook called when the agent shuts down. Use for cleanup. */
  shutdown?: () => Promise<void> | void;
}

/**
 * A Skill is a reusable module that bundles a set of tools,
 * optional system prompt instructions, and lifecycle hooks.
 *
 * Skills allow you to package related capabilities together
 * and easily share them across multiple agents.
 *
 * @example
 * ```ts
 * const webSkill = createSkill({
 *   name: "web",
 *   description: "Web browsing capabilities",
 *   tools: [fetchUrlTool, searchTool],
 *   systemPrompt: "You can browse the web using the provided tools.",
 *   initialize: async () => { console.log("Web skill ready"); },
 *   shutdown: async () => { console.log("Web skill cleaned up"); },
 * });
 * ```
 */
export class Skill {
  private config: SkillConfig;
  private initialized = false;

  constructor(config: SkillConfig) {
    if (!/^[a-zA-Z0-9_-]+$/.test(config.name)) {
      throw new Error(
        `Invalid skill name '${config.name}'. Skill names must be alphanumeric with dashes or underscores.`
      );
    }
    if (!config.tools || config.tools.length === 0) {
      throw new Error(
        `Skill '${config.name}' must provide at least one tool.`
      );
    }
    this.config = {
      ...config,
      prefixToolNames: config.prefixToolNames !== undefined ? config.prefixToolNames : true,
    };
  }

  /** Returns the skill's unique name. */
  getName(): string {
    return this.config.name;
  }

  /** Returns the skill's description. */
  getDescription(): string {
    return this.config.description;
  }

  /** Returns the skill's additional system prompt, or undefined if none. */
  getSystemPrompt(): string | undefined {
    return this.config.systemPrompt;
  }

  /** Returns whether tool names should be prefixed with the skill name. */
  shouldPrefixToolNames(): boolean {
    return this.config.prefixToolNames !== false;
  }

  /**
   * Returns the skill's tools.
   * If `prefixToolNames` is true, tool names are prefixed with `skillName_`.
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

  /** Returns whether this skill has been initialized. */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Runs the skill's initialize hook if defined. No-op if already initialized.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.config.initialize) {
      await this.config.initialize();
    }
    this.initialized = true;
  }

  /**
   * Runs the skill's shutdown hook if defined. No-op if not initialized.
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
 * Factory function to create a Skill instance.
 * Consistent with `createTool()` API style.
 *
 * @param config The skill configuration.
 * @returns A new Skill instance.
 *
 * @example
 * ```ts
 * const mathSkill = createSkill({
 *   name: "math",
 *   description: "Mathematical computation tools",
 *   tools: [calculatorTool, graphTool],
 *   systemPrompt: "Use the math tools for any numerical computation.",
 * });
 *
 * const agent = new Agent({
 *   name: "assistant",
 *   skills: [mathSkill],
 * });
 * ```
 */
export function createSkill(config: SkillConfig): Skill {
  return new Skill(config);
}
