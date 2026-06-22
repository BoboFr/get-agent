import { z } from "zod";
import { Agent } from "./agent.js";
import { Tool } from "./types.js";

export interface AgentToolOptions {
  /** Tool name exposed to the parent agent's LLM. */
  name: string;
  /** Description of what this sub-agent does — used by the LLM to decide when to call it. */
  description: string;
  /** If true, the sub-agent's message history is preserved between calls. Default: false. */
  keepHistory?: boolean;
}

/**
 * Wraps an Agent as a Tool so it can be called by another agent.
 * The parent LLM receives a single `input` parameter and the sub-agent returns its response as the tool result.
 */
export function createAgentTool(agent: Agent, options: AgentToolOptions): Tool {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.name)) {
    throw new Error(`Invalid agent tool name '${options.name}'. Must be alphanumeric with dashes or underscores.`);
  }

  const schema = z.object({
    input: z.string().describe("The message or task to send to the agent."),
  });

  return {
    name: options.name,
    description: options.description,
    schema,
    execute: async ({ input }: { input: string }) => {
      if (!options.keepHistory) {
        agent.clearHistory();
      }
      return await agent.run(input);
    },
  };
}
