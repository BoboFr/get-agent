import { z } from "zod";
import { LLMClient } from "./llm.js";
import { McpManager } from "./mcp.js";
import { Skill } from "./skill.js";
import { Logger } from "./logger.js";
import type { LoggerConfig } from "./logger.js";
import type { HistoryAdapter } from "./history.js";
import type { Guardrails, GuardrailFn } from "./guardrails.js";
import { AgentConfig, AgentHooks, BudgetConfig, RetryConfig, UsageSummary, Message, Tool, StructuredOutputConfig, ToolCall } from "./types.js";

export class Agent {
  private config: Required<Omit<AgentConfig,
    'skills' | 'hooks' | 'onApprovalRequired' | 'budget' |
    'logger' | 'retry' | 'parallelTools' | 'historyAdapter' | 'sessionId' | 'guardrails'
  >> & {
    verbose: boolean;
    hooks: AgentHooks;
    onApprovalRequired?: (toolName: string, args: any) => Promise<boolean>;
    budget?: BudgetConfig;
    logger?: LoggerConfig;
    retry?: RetryConfig;
    parallelTools: boolean;
    historyAdapter?: HistoryAdapter;
    sessionId?: string;
    guardrails?: Guardrails;
  };

  private sessionUsage = { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, llmCallCount: 0 };
  private logger: Logger;
  private llmClient: LLMClient;
  private mcpManager: McpManager;
  private localTools: Map<string, Tool> = new Map();
  private mcpTools: Map<string, Tool> = new Map();
  private skills: Map<string, Skill> = new Map();
  private isInitialized = false;
  private messageHistory: Message[] = [];

  constructor(config: AgentConfig & { verbose?: boolean }) {
    const verbose = config.verbose ?? false;
    this.config = {
      name: config.name,
      systemPrompt: config.systemPrompt || "You are a helpful AI assistant.",
      model: config.model || "",
      baseUrl: config.baseUrl || "http://127.0.0.1:8080/v1",
      apiKey: config.apiKey || "no-key",
      tools: config.tools || [],
      mcpServers: config.mcpServers || [],
      maxIterations: config.maxIterations || 10,
      temperature: config.temperature !== undefined ? config.temperature : 0.2,
      verbose,
      showThinking: config.showThinking !== undefined ? config.showThinking : true,
      hooks: config.hooks || {},
      onApprovalRequired: config.onApprovalRequired,
      budget: config.budget,
      logger: config.logger,
      retry: config.retry,
      parallelTools: config.parallelTools ?? false,
      historyAdapter: config.historyAdapter,
      sessionId: config.sessionId,
      guardrails: config.guardrails,
    };

    this.logger = new Logger(`Agent: ${config.name}`, {
      level: config.logger?.level ?? (verbose ? "debug" : "error"),
      format: config.logger?.format,
      transport: config.logger?.transport,
    });

    this.llmClient = new LLMClient(this.config.baseUrl, this.config.apiKey, this.config.retry);
    this.mcpManager = new McpManager(this.config.verbose);

    // Register local tools
    for (const tool of this.config.tools) {
      this.localTools.set(tool.name, tool);
    }

    // Register skills
    if (config.skills) {
      for (const skill of config.skills) {
        this.registerSkill(skill);
      }
    }
  }

  /**
   * Initializes the agent by connecting to configured MCP servers and caching their tools.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Initialize skills
    if (this.skills.size > 0) {
      this.log(`Initializing ${this.skills.size} skill(s): ${[...this.skills.keys()].join(", ")}...`);
      for (const [name, skill] of this.skills) {
        try {
          await skill.initialize();
          this.log(`Skill '${name}' initialized.`);
        } catch (err: any) {
          this.log(`[Error] Failed to initialize skill '${name}': ${err.message}`);
          throw err;
        }
      }
    }

    if (this.config.mcpServers.length > 0) {
      this.log(`Initializing MCP connections for: ${this.config.mcpServers.map(s => s.name).join(", ")}...`);
      const mcpToolsList = await this.mcpManager.connectAll(this.config.mcpServers);
      for (const tool of mcpToolsList) {
        // Handle name collision by appending _mcp if tool name already exists locally
        let name = tool.name;
        if (this.localTools.has(name)) {
          name = `${name}_mcp`;
          tool.name = name;
        }
        this.mcpTools.set(name, tool);
        this.log(`Exposing MCP tool: ${name}`);
      }
    }

    if (this.config.historyAdapter && this.config.sessionId) {
      const saved = await this.config.historyAdapter.load(this.config.sessionId);
      if (saved.length > 0) {
        this.messageHistory = saved;
        this.log(`Loaded ${saved.length} message(s) from history (session: ${this.config.sessionId}).`);
      }
    }

    this.isInitialized = true;
    this.log("Agent initialized successfully.");
  }

  /**
   * Returns a list of all currently registered tools (local, skills, and MCP).
   */
  getRegisteredTools(): Tool[] {
    return [...this.localTools.values(), ...this.mcpTools.values()];
  }

  /**
   * Returns a list of all registered skills.
   */
  getRegisteredSkills(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * Adds a skill dynamically to the agent.
   * If the agent is already initialized, the skill's initialize() hook is called immediately.
   * @param skill The Skill instance to add.
   */
  async addSkill(skill: Skill): Promise<void> {
    this.registerSkill(skill);
    if (this.isInitialized && !skill.isReady()) {
      await skill.initialize();
      this.log(`Skill '${skill.getName()}' dynamically initialized.`);
    }
  }

  /**
   * Removes a skill and all its associated tools from the agent.
   * If the skill is initialized, its shutdown() hook is called.
   * @param skillName The name of the skill to remove.
   */
  async removeSkill(skillName: string): Promise<void> {
    const skill = this.skills.get(skillName);
    if (!skill) {
      this.log(`Skill '${skillName}' not found, nothing to remove.`);
      return;
    }

    // Shutdown the skill if initialized
    if (skill.isReady()) {
      await skill.shutdown();
    }

    // Remove the skill's tools from localTools
    const skillTools = skill.getTools();
    for (const tool of skillTools) {
      this.localTools.delete(tool.name);
      this.log(`Removed skill tool: ${tool.name}`);
    }

    this.skills.delete(skillName);
    this.log(`Skill '${skillName}' removed.`);
  }

  /**
   * Clears the agent's message history.
   */
  clearHistory(): void {
    this.messageHistory = [];
  }

  /**
   * Returns the agent's current message history.
   */
  getHistory(): Message[] {
    return [...this.messageHistory];
  }

  /**
   * Executes the agent loop and returns the assistant's text response.
   * @param input A prompt string or a list of messages.
   */
  async run(input: string | Message[]): Promise<string>;
  /**
   * Executes the agent loop and returns an object validated against the provided schema.
   * @param input A prompt string or a list of messages.
   * @param structuredConfig Configuration for validating and structuring the output.
   */
  async run<T extends z.ZodType>(
    input: string | Message[],
    structuredConfig: StructuredOutputConfig<T>
  ): Promise<z.infer<T>>;
  async run<T extends z.ZodType>(
    input: string | Message[],
    structuredConfig?: StructuredOutputConfig<T>
  ): Promise<z.infer<T> | string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isLfm = this.config.model.toLowerCase().includes("lfm");

    // Build the full system prompt including skill prompts
    const fullSystemPrompt = this.buildSystemPrompt();

    // Apply input guardrails then build message history
    if (typeof input === "string") {
      const sanitized = this.config.guardrails?.input?.length
        ? await this.runGuardrails(input, this.config.guardrails.input)
        : input;
      if (this.messageHistory.length === 0) {
        this.messageHistory.push({ role: "system", content: fullSystemPrompt });
      }
      this.messageHistory.push({ role: "user", content: sanitized });
    } else {
      this.messageHistory = [...input];
      if (!this.messageHistory.find(m => m.role === "system")) {
        this.messageHistory.unshift({ role: "system", content: fullSystemPrompt });
      }
    }

    // Dynamic injection of LFM tools list in system prompt
    const allTools = this.getRegisteredTools();
    if (isLfm && allTools.length > 0) {
      const systemMessage = this.messageHistory.find(m => m.role === "system");
      if (systemMessage) {
        const cleanTools = allTools.map((tool) => {
          const parameters = this.getSchemaJson(tool.schema);

          return {
            name: tool.name,
            description: tool.description,
            parameters: parameters as Record<string, any>,
          };
        });

        const toolsInstruction = `\n\nList of tools: ${JSON.stringify(cleanTools)}\nOutput function calls as JSON.`;
        const contentStr = typeof systemMessage.content === "string" ? systemMessage.content : "";
        if (!contentStr.includes("List of tools:")) {
          systemMessage.content = contentStr + toolsInstruction;
        }
      }
    }

    let iteration = 0;
    while (iteration < this.config.maxIterations) {
      iteration++;
      this.log(`--- Iteration ${iteration} ---`);

      // Prepare LLM request options
      const toolsPayload = allTools.map((tool) => {
        const parameters = this.getSchemaJson(tool.schema);

        return {
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: parameters as Record<string, any>,
          },
        };
      });

      // If structured output is requested and we are on the final step (no tools or tools optional),
      // we inject the JSON schema requirements.
      let responseFormat: any = undefined;
      let promptSchemaInstructions = "";

      if (structuredConfig) {
        const jsonSchema = this.getSchemaJson(structuredConfig.schema);
        promptSchemaInstructions = `\n\nCRITICAL: You MUST respond with a single valid JSON object that strictly conforms to the following JSON Schema:\n${JSON.stringify(jsonSchema, null, 2)}\nDo not include any normal conversation or markdown blocks like \`\`\`json. Return only the raw JSON.`;

        // Use JSON Object response format constraint if the LLM backend supports it
        responseFormat = { type: "json_object" };
      }

      // We clone messages and append structured output instructions if present
      const activeMessages = [...this.messageHistory];
      if (promptSchemaInstructions && activeMessages.length > 0) {
        const lastMessage = activeMessages[activeMessages.length - 1];
        if (lastMessage.role === "user" || lastMessage.role === "tool") {
          // Temporarily append schema instructions to the last user/tool response message
          // so the LLM keeps it in immediate context. Multimodal bodies (content arrays)
          // get the instructions as an extra text part instead of string concatenation.
          activeMessages[activeMessages.length - 1] = {
            ...lastMessage,
            content: Array.isArray(lastMessage.content)
              ? [...lastMessage.content, { type: "text" as const, text: promptSchemaInstructions }]
              : (lastMessage.content || "") + promptSchemaInstructions,
          };
        }
      }

      // beforeLLMCall hook
      let messagesToSend = activeMessages;
      if (this.config.hooks.beforeLLMCall) {
        messagesToSend = (await this.config.hooks.beforeLLMCall(activeMessages)) ?? activeMessages;
      }

      this.log(`Calling LLM (${this.config.model})...`);
      const response = await this.llmClient.chatCompletion({
        model: this.config.model,
        messages: messagesToSend,
        tools: toolsPayload.length > 0 ? toolsPayload : undefined,
        response_format: responseFormat,
        temperature: this.config.temperature,
      });

      if (response.usage) {
        this.accumulateUsage(response.usage);
        this.checkBudget();
      }

      const choice = response.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error("Invalid or empty response received from the LLM.");
      }

      let content = choice.message.content;
      let toolCalls = choice.message.tool_calls;

      // afterLLMCall hook
      if (this.config.hooks.afterLLMCall) {
        await this.config.hooks.afterLLMCall(content, toolCalls);
      }

      // Parse embedded tool calls when the model doesn't use the standard tool_calls API
      if ((!toolCalls || toolCalls.length === 0) && content) {
        const { toolCalls: parsedToolCalls } = this.extractToolCalls(content);
        if (parsedToolCalls.length > 0) {
          toolCalls = parsedToolCalls;
        }
      }

      const assistantMessage: Message = {
        role: "assistant",
        content: choice.message.content,
        tool_calls: toolCalls,
      };

      const { thinking, cleanContent } = this.processThinking(content);
      const cleanContentWithoutTools = isLfm && cleanContent ? this.extractToolCalls(cleanContent).cleanContent : cleanContent;

      if (thinking && this.config.showThinking) {
        if (this.config.verbose) {
          console.log(`\x1b[36m[Agent: ${this.config.name}] [Thinking]\n${thinking}\x1b[0m`);
        }
      }

      this.log(`Received LLM Response: ${cleanContentWithoutTools || "[No text content]"}`);
      if (assistantMessage.tool_calls) {
        this.log(`Tool Calls requested: ${assistantMessage.tool_calls.map(tc => tc.function.name).join(", ")}`);
      }

      // Add assistant response to history
      this.messageHistory.push(assistantMessage);

      // Handle tool calls if requested
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        const tcs = assistantMessage.tool_calls;
        const results = this.config.parallelTools && tcs.length > 1
          ? await this.executeToolsParallel(tcs)
          : await this.executeToolsSequential(tcs);
        tcs.forEach((tc, i) => {
          this.messageHistory.push({ role: "tool", name: tc.function.name, tool_call_id: tc.id, content: results[i] });
        });
        continue;
      }

      // No tool calls — final response
      if (structuredConfig) {
        const textContent = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
        const validationResult = this.validateStructuredOutput(textContent, structuredConfig.schema);
        if (validationResult.success) {
          await this.saveHistory();
          return validationResult.data;
        }
        this.log(`Zod validation failed: ${validationResult.error}. Starting retry correction...`);
        const validatedData = await this.retryStructuredOutputCorrection(structuredConfig, validationResult.error, iteration);
        await this.saveHistory();
        return validatedData;
      }

      let finalText = this.config.showThinking
        ? (typeof assistantMessage.content === "string" ? assistantMessage.content : "")
        : (cleanContentWithoutTools || "");

      if (this.config.guardrails?.output?.length) {
        finalText = await this.runGuardrails(finalText, this.config.guardrails.output);
      }

      await this.saveHistory();
      return finalText;
    }

    throw new Error(`Agent run exceeded max iterations (${this.config.maxIterations}) without returning a final response.`);
  }

  /**
   * Executes the agent loop and yields chunks of the final text response in real-time.
   * Tool calls are handled transparently behind the scenes.
   */
  async *runStream(
    input: string | Message[]
  ): AsyncGenerator<string, void, unknown> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const isLfm = this.config.model.toLowerCase().includes("lfm");

    // Build the full system prompt including skill prompts
    const fullSystemPrompt = this.buildSystemPrompt();

    // Prepare message history
    if (typeof input === "string") {
      if (this.messageHistory.length === 0) {
        this.messageHistory.push({ role: "system", content: fullSystemPrompt });
      }
      this.messageHistory.push({ role: "user", content: input });
    } else {
      this.messageHistory = [...input];
      if (!this.messageHistory.find(m => m.role === "system")) {
        this.messageHistory.unshift({ role: "system", content: fullSystemPrompt });
      }
    }

    // Dynamic injection of LFM tools list in system prompt
    const allTools = this.getRegisteredTools();
    if (isLfm && allTools.length > 0) {
      const systemMessage = this.messageHistory.find(m => m.role === "system");
      if (systemMessage) {
        const cleanTools = allTools.map((tool) => {
          const parameters = this.getSchemaJson(tool.schema);

          return {
            name: tool.name,
            description: tool.description,
            parameters: parameters as Record<string, any>,
          };
        });

        const toolsInstruction = `\n\nList of tools: ${JSON.stringify(cleanTools)}\nOutput function calls as JSON.`;
        const contentStr = typeof systemMessage.content === "string" ? systemMessage.content : "";
        if (!contentStr.includes("List of tools:")) {
          systemMessage.content = contentStr + toolsInstruction;
        }
      }
    }

    let iteration = 0;
    while (iteration < this.config.maxIterations) {
      iteration++;
      this.log(`--- Iteration ${iteration} (Streaming) ---`);

      const toolsPayload = allTools.map((tool) => {
        const parameters = this.getSchemaJson(tool.schema);

        return {
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: parameters as Record<string, any>,
          },
        };
      });

      // beforeLLMCall hook
      let streamMessages = this.messageHistory;
      if (this.config.hooks.beforeLLMCall) {
        streamMessages = (await this.config.hooks.beforeLLMCall(this.messageHistory)) ?? this.messageHistory;
      }

      this.log(`Calling LLM Stream (${this.config.model})...`);
      const stream = this.llmClient.chatCompletionStream({
        model: this.config.model,
        messages: streamMessages,
        tools: toolsPayload.length > 0 ? toolsPayload : undefined,
        temperature: this.config.temperature,
      });

      let accumulatedContent = "";
      const accumulatedToolCalls: Record<number, { id?: string; name?: string; arguments: string }> = {};
      let hasToolCalls = false;
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;

      let inThinkingBlock = false;
      let inToolCallBlock = false;
      let thinkingBuffer = "";
      let streamBuffer = "";
      let toolCallCount = 0;
      // Tool-call markers vary by model/template. Track the end tag that matches
      // whichever start tag we entered on.
      const TOOL_CALL_MARKERS = [
        { start: "<|tool_call_start|>", end: "<|tool_call_end|>" },
        { start: "<tool_call>", end: "</tool_call>" },
      ];
      let toolCallEndTag = "<|tool_call_end|>";

      // Some reasoning models stream their chain-of-thought in a dedicated
      // delta field (`reasoning_content` or `reasoning`) instead of inline
      // <think> tags in `content`. Surface it as a <think>…</think> block.
      let reasoningOpen = false;
      let accumulatedReasoning = "";
      const closeReasoning = (): string | null => {
        if (!reasoningOpen) return null;
        reasoningOpen = false;
        return this.config.showThinking ? "</think>" : null;
      };

      for await (const chunk of stream) {
        if (chunk.usage) streamUsage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        // Process dedicated reasoning field (reasoning_content / reasoning)
        const reasoningChunk: string | undefined = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningChunk === "string" && reasoningChunk.length > 0) {
          accumulatedReasoning += reasoningChunk;
          if (this.config.showThinking) {
            if (!reasoningOpen) {
              reasoningOpen = true;
              yield "<think>";
            }
            yield reasoningChunk;
          }
        }

        // Process standard tool calls
        if (delta.tool_calls) {
          const closeTag = closeReasoning();
          if (closeTag) yield closeTag;
          hasToolCalls = true;
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!accumulatedToolCalls[idx]) {
              accumulatedToolCalls[idx] = { arguments: "" };
            }
            if (tc.id) accumulatedToolCalls[idx].id = tc.id;
            if (tc.function?.name) accumulatedToolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) {
              accumulatedToolCalls[idx].arguments += tc.function.arguments;
            }
          }
        }

        // Process text content
        if (delta.content) {
          const closeTag = closeReasoning();
          if (closeTag) yield closeTag;
          const contentChunk = delta.content;
          accumulatedContent += contentChunk;

          if (!hasToolCalls) {
            streamBuffer += contentChunk;

            let processed = true;
            while (processed) {
              processed = false;

              if (!inThinkingBlock && !inToolCallBlock) {
                // Find the earliest tool-call start marker among known variants
                let idxTool = -1;
                let toolStartLen = 0;
                let toolEnd = "<|tool_call_end|>";
                for (const marker of TOOL_CALL_MARKERS) {
                  const i = streamBuffer.indexOf(marker.start);
                  if (i !== -1 && (idxTool === -1 || i < idxTool)) {
                    idxTool = i;
                    toolStartLen = marker.start.length;
                    toolEnd = marker.end;
                  }
                }
                const idxThink = streamBuffer.indexOf("<think>");

                if (idxTool !== -1 && (idxThink === -1 || idxTool < idxThink)) {
                  // Tool call starts first
                  const before = streamBuffer.substring(0, idxTool);
                  if (before) {
                    yield before;
                  }
                  streamBuffer = streamBuffer.substring(idxTool + toolStartLen);
                  inToolCallBlock = true;
                  toolCallEndTag = toolEnd;
                  processed = true;
                } else if (idxThink !== -1 && (idxTool === -1 || idxThink < idxTool)) {
                  // Thinking starts first
                  const before = streamBuffer.substring(0, idxThink);
                  if (before) {
                    yield before;
                  }
                  streamBuffer = streamBuffer.substring(idxThink + "<think>".length);
                  inThinkingBlock = true;
                  if (this.config.showThinking) {
                    yield "<think>";
                  }
                  processed = true;
                } else {
                  // Check for partial prefix matches at the end (any start marker)
                  const prefixLenThink = this.getPrefixMatchLen(streamBuffer, "<think>");
                  const prefixLenTool = Math.max(
                    ...TOOL_CALL_MARKERS.map((m) => this.getPrefixMatchLen(streamBuffer, m.start))
                  );
                  const keepLen = Math.max(prefixLenTool, prefixLenThink);

                  if (keepLen > 0) {
                    const before = streamBuffer.substring(0, streamBuffer.length - keepLen);
                    if (before) {
                      yield before;
                    }
                    streamBuffer = streamBuffer.substring(streamBuffer.length - keepLen);
                  } else {
                    if (streamBuffer) {
                      yield streamBuffer;
                    }
                    streamBuffer = "";
                  }
                }
              } else if (inThinkingBlock) {
                const idxThinkEnd = streamBuffer.indexOf("</think>");
                if (idxThinkEnd !== -1) {
                  const thinkContent = streamBuffer.substring(0, idxThinkEnd);
                  if (this.config.showThinking) {
                    yield thinkContent;
                    yield "</think>";
                  } else {
                    thinkingBuffer += thinkContent;
                    if (this.config.verbose) {
                      console.log(`\x1b[36m[Agent: ${this.config.name}] [Thinking]\n${thinkingBuffer.trim()}\x1b[0m`);
                    }
                  }
                  streamBuffer = streamBuffer.substring(idxThinkEnd + "</think>".length);
                  inThinkingBlock = false;
                  thinkingBuffer = "";
                  processed = true;
                } else {
                  const keepLen = this.getPrefixMatchLen(streamBuffer, "</think>");
                  if (keepLen > 0) {
                    const before = streamBuffer.substring(0, streamBuffer.length - keepLen);
                    if (this.config.showThinking) {
                      yield before;
                    } else {
                      thinkingBuffer += before;
                    }
                    streamBuffer = streamBuffer.substring(streamBuffer.length - keepLen);
                  } else {
                    if (this.config.showThinking) {
                      yield streamBuffer;
                    } else {
                      thinkingBuffer += streamBuffer;
                    }
                    streamBuffer = "";
                  }
                }
              } else if (inToolCallBlock) {
                const idxToolEnd = streamBuffer.indexOf(toolCallEndTag);
                if (idxToolEnd !== -1) {
                  const toolCallBody = streamBuffer.substring(0, idxToolEnd).trim();
                  let toolName = "";
                  let toolArgs = "{}";

                  if (toolCallBody.startsWith('{')) {
                    try {
                      const parsed = JSON.parse(toolCallBody);
                      toolName = parsed.name || parsed.function?.name || "";
                      toolArgs = JSON.stringify(parsed.arguments || parsed.function?.arguments || parsed);
                    } catch (e) {
                      // Fallback to pythonic
                    }
                  }

                  if (!toolName) {
                    const parsedPythonic = this.parsePythonicCall(toolCallBody);
                    if (parsedPythonic) {
                      toolName = parsedPythonic.name;
                      toolArgs = JSON.stringify(parsedPythonic.arguments);
                    }
                  }

                  if (toolName) {
                    accumulatedToolCalls[toolCallCount++] = {
                      id: `call_${Math.random().toString(36).substring(2, 9)}`,
                      name: toolName,
                      arguments: toolArgs
                    };
                    hasToolCalls = true;
                  }

                  streamBuffer = streamBuffer.substring(idxToolEnd + toolCallEndTag.length);
                  inToolCallBlock = false;
                  processed = true;
                } else {
                  // Do not yield anything, wait for end tag
                  break;
                }
              }
            }
          }
        }
      }

      // Close the reasoning block if the stream ended while still open
      // (e.g. reasoning with no following content or tool call).
      {
        const closeTag = closeReasoning();
        if (closeTag) yield closeTag;
      }

      // Yield any remaining streamBuffer (excluding unfinished blocks)
      if (streamBuffer) {
        if (inThinkingBlock && this.config.showThinking) {
          yield streamBuffer;
        } else if (!inThinkingBlock && !inToolCallBlock) {
          yield streamBuffer;
        }
      }

      if (streamUsage) {
        this.accumulateUsage(streamUsage);
        this.checkBudget();
      }

      // Safety net: if no tool calls were captured during streaming, try to
      // recover any embedded in the text content (bare JSON, <tool_call>…</tool_call>,
      // <tool name="…">, etc.) — same recovery run() performs, for any model.
      if (!hasToolCalls && accumulatedContent) {
        const { toolCalls: contentToolCalls } = this.extractToolCalls(accumulatedContent);
        if (contentToolCalls.length > 0) {
          hasToolCalls = true;
          contentToolCalls.forEach((tc, i) => {
            accumulatedToolCalls[i] = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments };
          });
        }
      }

      // Convert accumulated tool calls
      const toolCalls: ToolCall[] = Object.values(accumulatedToolCalls).map((atc) => ({
        id: atc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
        type: "function",
        function: {
          name: atc.name || "",
          arguments: atc.arguments,
        },
      }));

      // Create assistant message to append to history
      const assistantMessage: Message = {
        role: "assistant",
        content: accumulatedContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      this.messageHistory.push(assistantMessage);

      if (hasToolCalls && toolCalls.length > 0) {
        this.log(`Tool Calls requested: ${toolCalls.map(tc => tc.function.name).join(", ")}`);

        // afterLLMCall hook (stream — no text content, only tool calls)
        if (this.config.hooks.afterLLMCall) {
          await this.config.hooks.afterLLMCall(accumulatedContent || null, toolCalls);
        }

        const results = this.config.parallelTools && toolCalls.length > 1
          ? await this.executeToolsParallel(toolCalls)
          : await this.executeToolsSequential(toolCalls);
        toolCalls.forEach((tc, i) => {
          this.messageHistory.push({ role: "tool", name: tc.function.name, tool_call_id: tc.id, content: results[i] });
        });
        continue;
      }

      return;
    }

    throw new Error(`Agent run exceeded max iterations (${this.config.maxIterations}) without returning a final response.`);
  }

  /**
   * Helper to validate LLM output against Zod schema.
   */
  private validateStructuredOutput<T extends z.ZodType>(
    text: string,
    schema: T
  ): { success: true; data: z.infer<T> } | { success: false; error: string } {
    try {
      const { cleanContent } = this.processThinking(text);
      let cleanText = (cleanContent || "").trim();

      // Find JSON block if the LLM returned extra formatting markdown wrapper
      const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
      const match = cleanText.match(jsonBlockRegex);
      if (match && match[1]) {
        cleanText = match[1].trim();
      }

      const parsed = JSON.parse(cleanText);
      const validated = schema.safeParse(parsed);
      if (validated.success) {
        return { success: true, data: validated.data };
      } else {
        return { success: false, error: validated.error.message };
      }
    } catch (e: any) {
      return { success: false, error: `Invalid JSON format: ${e.message}. Raw content was: ${text}` };
    }
  }

  /**
   * Ask the LLM to correct its output if it fails validation.
   */
  private async retryStructuredOutputCorrection<T extends z.ZodType>(
    structuredConfig: StructuredOutputConfig<T>,
    lastError: string,
    currentIteration: number
  ): Promise<z.infer<T>> {
    const maxRetries = structuredConfig.maxRetries || 3;
    let retries = 0;
    let errorToReport = lastError;

    while (retries < maxRetries) {
      retries++;
      this.log(`Correction attempt ${retries}/${maxRetries} for validation error: ${errorToReport}`);

      // Push correction request to message history
      this.messageHistory.push({
        role: "user",
        content: `Your previous response failed JSON/Zod validation with the following error:\n${errorToReport}\n\nPlease correct your output and reply ONLY with a valid JSON object matching the requested schema. Do not explain anything, do not wrap in markdown blocks, just return raw JSON.`,
      });

      this.log(`Calling LLM for correction...`);
      const response = await this.llmClient.chatCompletion({
        model: this.config.model,
        messages: this.messageHistory,
        response_format: { type: "json_object" },
        temperature: this.config.temperature,
      });

      const choice = response.choices?.[0];
      const content = choice?.message?.content || "";
      this.log(`Received Correction Response: ${content}`);

      // Save LLM correction response to history
      this.messageHistory.push({
        role: "assistant",
        content,
      });

      const validationResult = this.validateStructuredOutput(content, structuredConfig.schema);
      if (validationResult.success) {
        return validationResult.data;
      } else {
        errorToReport = validationResult.error;
      }
    }

    throw new Error(`Structured output validation failed after ${maxRetries} correction retries. Last error: ${errorToReport}`);
  }

  /**
   * Cleans up all MCP clients connected.
   */
  async shutdown(): Promise<void> {
    this.log("Shutting down agent...");

    // Shutdown all skills
    for (const [name, skill] of this.skills) {
      try {
        await skill.shutdown();
        this.log(`Skill '${name}' shut down.`);
      } catch (err: any) {
        this.log(`[Error] Failed to shut down skill '${name}': ${err.message}`);
      }
    }

    await this.mcpManager.disconnectAll();
    this.isInitialized = false;
    this.log("Agent shutdown complete.");
  }

  private getPrefixMatchLen(str: string, target: string): number {
    for (let len = Math.min(str.length, target.length - 1); len > 0; len--) {
      if (str.endsWith(target.substring(0, len))) {
        return len;
      }
    }
    return 0;
  }

  private parsePythonicCall(callStr: string): { name: string; arguments: Record<string, any> } | null {
    let clean = callStr.trim();
    if (clean.startsWith('[') && clean.endsWith(']')) {
      clean = clean.slice(1, -1).trim();
    }
    const match = clean.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)$/);
    if (!match) return null;

    const name = match[1];
    const argsStr = match[2].trim();
    const args: Record<string, any> = {};

    if (argsStr) {
      let i = 0;
      while (i < argsStr.length) {
        while (i < argsStr.length && /\s/.test(argsStr[i])) i++;
        if (i >= argsStr.length) break;

        let keyStart = i;
        while (i < argsStr.length && /[a-zA-Z0-9_]/.test(argsStr[i])) i++;
        const key = argsStr.slice(keyStart, i);

        while (i < argsStr.length && /\s/.test(argsStr[i])) i++;
        if (argsStr[i] !== '=') break;
        i++; // skip '='

        while (i < argsStr.length && /\s/.test(argsStr[i])) i++;

        let value: any;
        if (argsStr[i] === '"' || argsStr[i] === "'") {
          const quote = argsStr[i];
          i++; // skip quote
          let valStart = i;
          let escaped = false;
          while (i < argsStr.length) {
            if (escaped) {
              escaped = false;
            } else if (argsStr[i] === '\\') {
              escaped = true;
            } else if (argsStr[i] === quote) {
              break;
            }
            i++;
          }
          value = argsStr.slice(valStart, i);
          i++; // skip closing quote
        } else {
          let valStart = i;
          let nestCount = 0;
          while (i < argsStr.length) {
            const char = argsStr[i];
            if (char === '[' || char === '{' || char === '(') {
              nestCount++;
            } else if (char === ']' || char === '}' || char === ')') {
              nestCount--;
            } else if (char === ',' && nestCount === 0) {
              break;
            }
            i++;
          }
          let rawVal = argsStr.slice(valStart, i).trim();
          if (rawVal.toLowerCase() === 'true') {
            value = true;
          } else if (rawVal.toLowerCase() === 'false') {
            value = false;
          } else if (rawVal.toLowerCase() === 'none' || rawVal.toLowerCase() === 'null') {
            value = null;
          } else if (!isNaN(Number(rawVal)) && rawVal !== '') {
            value = Number(rawVal);
          } else {
            try {
              value = JSON.parse(rawVal.replace(/'/g, '"'));
            } catch {
              value = rawVal;
            }
          }
        }

        args[key] = value;

        while (i < argsStr.length && /\s/.test(argsStr[i])) i++;
        if (argsStr[i] === ',') {
          i++;
        }
      }
    }

    return { name, arguments: args };
  }

  private extractToolCalls(content: string | null): { toolCalls: ToolCall[], cleanContent: string } {
    if (!content) return { toolCalls: [], cleanContent: "" };

    const toolCalls: ToolCall[] = [];
    // Match both the LFM marker (<|tool_call_start|>…<|tool_call_end|>) and the
    // Qwen/Hermes-style tag (<tool_call>…</tool_call>) used by many GGUF templates.
    const toolCallRegex = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>|<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;
    let cleanContent = content;

    while ((match = toolCallRegex.exec(content)) !== null) {
      const rawBody = (match[1] ?? match[2] ?? "").trim();
      cleanContent = cleanContent.replace(match[0], '');

      if (rawBody.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawBody);
          toolCalls.push({
            id: `call_${Math.random().toString(36).substring(2, 9)}`,
            type: "function",
            function: {
              name: parsed.name || parsed.function?.name || "",
              arguments: JSON.stringify(parsed.arguments || parsed.function?.arguments || parsed)
            }
          });
          continue;
        } catch (e) {
          // Fallback to pythonic
        }
      }

      const parsedPythonic = this.parsePythonicCall(rawBody);
      if (parsedPythonic) {
        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 9)}`,
          type: "function",
          function: {
            name: parsedPythonic.name,
            arguments: JSON.stringify(parsedPythonic.arguments)
          }
        });
      }
    }

    // Handle bare JSON tool call: {"name":"...", "arguments":{...}} or an array of them
    if (toolCalls.length === 0) {
      try {
        const trimmed = cleanContent.trim();
        const parsed = JSON.parse(trimmed);
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        const allValid = entries.every((e: any) => typeof e?.name === "string" && e?.arguments !== undefined);
        if (allValid && entries.length > 0) {
          cleanContent = "";
          for (const entry of entries) {
            toolCalls.push({
              id: `call_${Math.random().toString(36).substring(2, 9)}`,
              type: "function",
              function: {
                name: entry.name,
                arguments: typeof entry.arguments === "string" ? entry.arguments : JSON.stringify(entry.arguments),
              },
            });
          }
        }
      } catch { }
    }

    // Handle <tool name="..." arguments={...}> format (some local models)
    const xmlToolRegex = /<tool\s+name="([^"]+)"\s+arguments=(\{[\s\S]*?\})\s*\)?>/g;
    while ((match = xmlToolRegex.exec(content)) !== null) {
      cleanContent = cleanContent.replace(match[0], "");
      const parsedArgs = this.parsePythonLikeLiteral(match[2]);
      toolCalls.push({
        id: `call_${Math.random().toString(36).substring(2, 9)}`,
        type: "function",
        function: {
          name: match[1],
          arguments: parsedArgs !== null ? JSON.stringify(parsedArgs) : "{}",
        },
      });
    }

    return { toolCalls, cleanContent: cleanContent.trim() };
  }

  private parsePythonLikeLiteral(raw: string): Record<string, any> | null {
    // Try JSON first
    try { return JSON.parse(raw); } catch { }

    // Convert Python dict syntax to JSON:
    // - single-quoted strings → double-quoted (handles escaped \' inside)
    // - True/False/None → true/false/null
    const normalized = raw
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null");

    let result = "";
    let i = 0;
    while (i < normalized.length) {
      if (normalized[i] === "'") {
        result += '"';
        i++;
        while (i < normalized.length) {
          if (normalized[i] === "\\" && normalized[i + 1] === "'") {
            result += "'";   // unescape \'
            i += 2;
          } else if (normalized[i] === '"') {
            result += '\\"'; // escape " inside string
            i++;
          } else if (normalized[i] === "'") {
            result += '"';   // close string
            i++;
            break;
          } else {
            result += normalized[i];
            i++;
          }
        }
      } else {
        result += normalized[i];
        i++;
      }
    }

    try { return JSON.parse(result); } catch { return null; }
  }

  private getSchemaJson(schema: any): any {
    if (schema && typeof schema === "object") {
      // Zod v4 schemas expose a top-level converter via z.toJSONSchema().
      if ("safeParse" in schema) {
        const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, any>;
        // Strip the $schema dialect marker: harmless but rejected by some
        // strict function-calling validators that expect a bare parameters object.
        const { $schema, ...rest } = json;
        return rest;
      }
    }
    return schema;
  }

  private processThinking(content: string | null): { thinking: string; cleanContent: string | null } {
    if (!content) return { thinking: "", cleanContent: null };

    // Use a non-greedy regex to match the first <think>...</think> block.
    // Make the tags case-insensitive.
    const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
    const match = content.match(thinkRegex);

    if (match) {
      const thinking = match[1].trim();
      // Only replace the first match to preserve internal structures if needed
      const cleanContent = content.replace(thinkRegex, "").trim();
      return { thinking, cleanContent: cleanContent || null };
    }

    return { thinking: "", cleanContent: content };
  }

  /**
   * Registers a skill's tools into the agent's localTools map.
   */
  private registerSkill(skill: Skill): void {
    const skillName = skill.getName();
    if (this.skills.has(skillName)) {
      throw new Error(`Skill '${skillName}' is already registered on agent '${this.config.name}'.`);
    }

    this.skills.set(skillName, skill);

    // Register the skill's tools (potentially prefixed) into localTools
    const skillTools = skill.getTools();
    for (const tool of skillTools) {
      if (this.localTools.has(tool.name)) {
        throw new Error(
          `Tool name collision: '${tool.name}' from skill '${skillName}' conflicts with an existing tool on agent '${this.config.name}'.`
        );
      }
      this.localTools.set(tool.name, tool);
      this.log(`Registered skill tool: ${tool.name} (from skill '${skillName}')`);
    }
  }

  /**
   * Builds the full system prompt by appending all skill system prompts.
   */
  private buildSystemPrompt(): string {
    let prompt = this.config.systemPrompt;

    const skillPrompts: string[] = [];
    for (const [, skill] of this.skills) {
      const sp = skill.getSystemPrompt();
      if (sp) {
        skillPrompts.push(sp);
      }
    }

    if (skillPrompts.length > 0) {
      prompt += "\n\n" + skillPrompts.join("\n\n");
    }

    return prompt;
  }

  /**
   * Returns the cumulative token usage and estimated cost for this agent's session.
   */
  getUsage(): UsageSummary {
    return {
      ...this.sessionUsage,
      estimatedCostUSD: this.estimateCost(),
    };
  }

  /**
   * Resets session usage counters.
   */
  clearUsage(): void {
    this.sessionUsage = { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, llmCallCount: 0 };
  }

  private accumulateUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): void {
    this.sessionUsage.totalPromptTokens += usage.prompt_tokens ?? 0;
    this.sessionUsage.totalCompletionTokens += usage.completion_tokens ?? 0;
    this.sessionUsage.totalTokens += usage.total_tokens ?? 0;
    this.sessionUsage.llmCallCount++;
  }

  private estimateCost(): number | null {
    const pricing = this.config.budget?.pricing;
    if (!pricing) return null;
    const input = (this.sessionUsage.totalPromptTokens / 1_000_000) * pricing.inputPerMToken;
    const output = (this.sessionUsage.totalCompletionTokens / 1_000_000) * pricing.outputPerMToken;
    return input + output;
  }

  private checkBudget(): void {
    const budget = this.config.budget;
    if (!budget) return;

    if (budget.maxTokens && this.sessionUsage.totalTokens >= budget.maxTokens) {
      throw new Error(
        `[Budget] Token limit reached: ${this.sessionUsage.totalTokens}/${budget.maxTokens} tokens used.`
      );
    }

    if (budget.maxCostUSD) {
      const cost = this.estimateCost();
      if (cost !== null && cost >= budget.maxCostUSD) {
        throw new Error(
          `[Budget] Cost limit reached: $${cost.toFixed(6)}/$${budget.maxCostUSD} USD used.`
        );
      }
    }
  }

  private async executeTool(toolCall: ToolCall): Promise<string> {
    const toolName = toolCall.function.name;
    const toolArgsString = toolCall.function.arguments;

    this.log(`Executing tool '${toolName}' with arguments: ${toolArgsString}`);

    const tool = this.localTools.get(toolName) || this.mcpTools.get(toolName);

    if (!tool) {
      const error = `Tool '${toolName}' not found.`;
      this.log(`[Error] ${error}`);
      return JSON.stringify({ error });
    }

    let parsedArgs: any;
    try {
      parsedArgs = JSON.parse(toolArgsString || "{}");
    } catch (err: any) {
      return JSON.stringify({ error: `Invalid JSON arguments: ${err.message}` });
    }

    // Approval check
    if (tool.requiresApproval && this.config.onApprovalRequired) {
      const approved = await this.config.onApprovalRequired(toolName, parsedArgs);
      if (!approved) {
        this.log(`Tool '${toolName}' rejected by user.`);
        return JSON.stringify({ cancelled: true, reason: "Tool execution was rejected." });
      }
    }

    // beforeToolCall hook — false cancels, object replaces args
    if (this.config.hooks.beforeToolCall) {
      const hookResult = await this.config.hooks.beforeToolCall(toolName, parsedArgs);
      if (hookResult === false) {
        this.log(`Tool '${toolName}' cancelled by beforeToolCall hook.`);
        return JSON.stringify({ cancelled: true, reason: "Tool execution was cancelled." });
      }
      if (hookResult !== undefined && hookResult !== true) {
        parsedArgs = hookResult;
      }
    }

    let toolResult: any;
    try {
      toolResult = await tool.execute(parsedArgs);
    } catch (err: any) {
      toolResult = { error: `Error executing tool: ${err.message}` };
      this.log(`[Error] Execution of '${toolName}' failed: ${err.message}`);
    }

    // afterToolCall hook — can replace result
    if (this.config.hooks.afterToolCall) {
      const hookResult = await this.config.hooks.afterToolCall(toolName, parsedArgs, toolResult);
      if (hookResult !== undefined) {
        toolResult = hookResult;
      }
    }

    return typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
  }

  private log(message: string): void {
    if (this.config.logger) {
      this.logger.debug(message);
    } else if (this.config.verbose) {
      console.log(`[Agent: ${this.config.name}] ${message}`);
    }
  }

  getName(): string {
    return this.config.name;
  }

  private async runGuardrails(text: string, fns: ((t: string) => any)[]): Promise<string> {
    let current = text;
    for (const fn of fns) {
      const result = await fn(current);
      if (!result.allowed) {
        throw new Error(`[Guardrail] ${result.reason ?? "Input blocked by guardrail."}`);
      }
      if (result.sanitized !== undefined) current = result.sanitized;
    }
    return current;
  }

  private executeToolsParallel(toolCalls: ToolCall[]): Promise<string[]> {
    return Promise.all(toolCalls.map((tc) => this.executeTool(tc)));
  }

  private async executeToolsSequential(toolCalls: ToolCall[]): Promise<string[]> {
    const results: string[] = [];
    for (const tc of toolCalls) results.push(await this.executeTool(tc));
    return results;
  }

  private async saveHistory(): Promise<void> {
    if (this.config.historyAdapter && this.config.sessionId) {
      await this.config.historyAdapter.save(this.config.sessionId, this.messageHistory);
    }
  }

  /**
   * Stream the response as text chunks while also resolving a typed structured output.
   * Returns immediately — iterate `stream` for tokens, await `result` for the validated object.
   */
  runStreamStructured<T extends z.ZodType>(
    input: string | Message[],
    structuredConfig: StructuredOutputConfig<T>
  ): { stream: AsyncGenerator<string, void, unknown>; result: Promise<z.infer<T>> } {
    let resolve!: (v: z.infer<T>) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<z.infer<T>>((res, rej) => { resolve = res; reject = rej; });

    const self = this;
    async function* gen(): AsyncGenerator<string, void, unknown> {
      let accumulated = "";
      try {
        for await (const chunk of self.runStream(input)) {
          accumulated += chunk;
          yield chunk;
        }
        const validation = self.validateStructuredOutput(accumulated, structuredConfig.schema);
        if (validation.success) {
          resolve(validation.data);
        } else if ((structuredConfig.maxRetries ?? 0) > 0) {
          try {
            resolve(await self.retryStructuredOutputCorrection(structuredConfig, validation.error, 0));
          } catch (e: any) { reject(e); }
        } else {
          reject(new Error(`Structured output validation failed: ${validation.error}`));
        }
      } catch (e: any) {
        reject(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
    }

    return { stream: gen(), result };
  }

  /**
   * Interactive REPL — starts a readline loop in the terminal.
   * Commands: /exit  /clear  /usage  /tools  /help
   */
  async repl(options: { stream?: boolean; prompt?: string } = {}): Promise<void> {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const promptStr = options.prompt ?? "Vous";
    const useStream = options.stream ?? false;

    console.log(`\x1b[36m╔══ GetAgent REPL ${"═".repeat(20)}╗\x1b[0m`);
    console.log(`\x1b[36m║  Agent : ${this.config.name.padEnd(26)}║\x1b[0m`);
    console.log(`\x1b[36m╚${"═".repeat(37)}╝\x1b[0m`);
    console.log(`\x1b[90mCommandes : /exit  /clear  /usage  /tools  /help\x1b[0m\n`);

    await new Promise<void>((done) => {
      const ask = () => {
        rl.question(`\x1b[32m${promptStr} :\x1b[0m `, async (raw) => {
          const input = raw.trim();
          if (!input) return ask();

          if (input === "/exit") { rl.close(); return done(); }

          if (input === "/clear") {
            this.clearHistory();
            console.log("\x1b[90m[historique effacé]\x1b[0m\n");
            return ask();
          }
          if (input === "/usage") {
            const u = this.getUsage();
            console.log(
              `\x1b[90m tokens: ${u.totalTokens}  appels: ${u.llmCallCount}` +
              `  coût: $${u.estimatedCostUSD?.toFixed(6) ?? "n/a"}\x1b[0m\n`
            );
            return ask();
          }
          if (input === "/tools") {
            this.getRegisteredTools().forEach((t) =>
              console.log(`\x1b[90m  - ${t.name}: ${t.description}\x1b[0m`)
            );
            console.log();
            return ask();
          }
          if (input === "/help") {
            console.log(
              "\x1b[90m  /exit   — quitter\n  /clear  — effacer l'historique\n" +
              "  /usage  — tokens & coût\n  /tools  — lister les outils\x1b[0m\n"
            );
            return ask();
          }

          try {
            process.stdout.write("\x1b[35mAgent :\x1b[0m ");
            if (useStream) {
              for await (const chunk of this.runStream(input)) process.stdout.write(chunk);
            } else {
              process.stdout.write(String(await this.run(input)));
            }
            process.stdout.write("\n\n");
          } catch (err: any) {
            console.error(`\x1b[31m[Erreur] ${err.message}\x1b[0m\n`);
          }
          ask();
        });
      };
      ask();
    });
  }
}
