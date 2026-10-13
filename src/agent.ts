import { z } from "zod";
import { LLMClient } from "./llm.js";
import type { LLMRequestOptions } from "./llm.js";
import { McpManager } from "./mcp.js";
import { Toolkit } from "./toolkit.js";
import { agentSkillsPrompt, createAgentSkillTools, loadAgentSkills } from "./agent-skill.js";
import type { AgentSkill } from "./agent-skill.js";
import { Logger } from "./logger.js";
import type { LoggerConfig } from "./logger.js";
import type { HistoryAdapter } from "./history.js";
import { applyGuardrails, GuardrailError } from "./guardrails.js";
import type { Guardrails, GuardrailContext, GuardrailStage } from "./guardrails.js";
import { StreamTagParser } from "./stream-parser.js";
import {
  extractToolCalls,
  newToolCallId,
  processThinking,
  toJsonSchema,
  validateStructuredOutput,
} from "./parsing.js";
import {
  AgentConfig,
  AgentHooks,
  BudgetConfig,
  ContextConfig,
  Message,
  RetryConfig,
  RunOptions,
  StructuredOutputConfig,
  Tool,
  ToolCall,
  ToolCallFormat,
  UsageSummary,
} from "./types.js";

type ToolPayload = NonNullable<LLMRequestOptions["tools"]>[number];
type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

const DEFAULT_STRUCTURED_RETRIES = 3;

export class Agent {
  private config: Required<Omit<AgentConfig,
    'skills' | 'toolkits' | 'agentSkills' | 'hooks' | 'onApprovalRequired' | 'budget' | 'logger' | 'retry' | 'parallelTools' |
    'historyAdapter' | 'sessionId' | 'guardrails' | 'toolCallFormat' | 'context' | 'mcpStrict'
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
    toolCallFormat: ToolCallFormat;
    context: ContextConfig;
    mcpStrict: boolean;
    agentSkills: Array<string | AgentSkill>;
  };

  private sessionUsage = { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, llmCallCount: 0 };
  private logger: Logger;
  private llmClient: LLMClient;
  private mcpManager: McpManager;
  private localTools: Map<string, Tool> = new Map();
  private mcpTools: Map<string, Tool> = new Map();
  private toolkits: Map<string, Toolkit> = new Map();
  private agentSkills: Map<string, AgentSkill> = new Map();
  /** Names of the load_skill / read_skill_file tools registered for agent skills. */
  private agentSkillToolNames: string[] = [];
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private messageHistory: Message[] = [];
  /** Tail of the run queue: runs on one instance share the history, so they are serialized. */
  private runLock: Promise<void> = Promise.resolve();
  /** Cached function-calling payload; reset whenever the tool set changes. */
  private toolsPayloadCache: ToolPayload[] | null = null;

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
      maxIterations: config.maxIterations ?? 10,
      temperature: config.temperature ?? 0.2,
      verbose,
      showThinking: config.showThinking ?? true,
      hooks: config.hooks || {},
      onApprovalRequired: config.onApprovalRequired,
      budget: config.budget,
      logger: config.logger,
      retry: config.retry,
      parallelTools: config.parallelTools ?? false,
      historyAdapter: config.historyAdapter,
      sessionId: config.sessionId,
      guardrails: config.guardrails,
      toolCallFormat: config.toolCallFormat ?? "auto",
      context: config.context ?? {},
      mcpStrict: config.mcpStrict ?? false,
      agentSkills: config.agentSkills ?? [],
    };

    this.logger = new Logger(`Agent: ${config.name}`, {
      level: config.logger?.level ?? (verbose ? "debug" : "warn"),
      format: config.logger?.format,
      transport: config.logger?.transport,
    });

    this.llmClient = new LLMClient(this.config.baseUrl, this.config.apiKey, this.config.retry);
    this.mcpManager = new McpManager(verbose, this.logger);

    for (const tool of this.config.tools) {
      this.localTools.set(tool.name, tool);
    }

    for (const toolkit of [...(config.toolkits ?? []), ...(config.skills ?? [])]) {
      this.registerToolkit(toolkit);
    }
  }

  /**
   * Initializes the agent: runs toolkit initializers, loads Agent Skills, connects to
   * configured MCP servers and loads the persisted history. Safe to call concurrently; runs only once.
   */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = null; // allow a later retry
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (this.toolkits.size > 0) {
      this.log(`Initializing ${this.toolkits.size} toolkit(s): ${[...this.toolkits.keys()].join(", ")}...`);
      for (const [name, toolkit] of this.toolkits) {
        try {
          await toolkit.initialize();
          this.log(`Toolkit '${name}' initialized.`);
        } catch (err: any) {
          this.logger.error(`Failed to initialize toolkit '${name}': ${err.message}`);
          throw err;
        }
      }
    }

    if (this.config.agentSkills.length > 0) {
      await this.loadAgentSkills(this.config.agentSkills);
    }

    if (this.config.mcpServers.length > 0) {
      this.log(`Initializing MCP connections for: ${this.config.mcpServers.map(s => s.name).join(", ")}...`);
      const mcpToolsList = await this.mcpManager.connectAll(this.config.mcpServers, this.config.mcpStrict);
      for (const tool of mcpToolsList) {
        // Handle name collision by appending _mcp if tool name already exists locally
        if (this.localTools.has(tool.name)) {
          tool.name = `${tool.name}_mcp`;
        }
        this.mcpTools.set(tool.name, tool);
        this.log(`Exposing MCP tool: ${tool.name}`);
      }
      this.toolsPayloadCache = null;
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
   * Returns a list of all currently registered tools (local, toolkits, agent skills and MCP).
   */
  getRegisteredTools(): Tool[] {
    return [...this.localTools.values(), ...this.mcpTools.values()];
  }

  /**
   * Returns a list of all registered toolkits.
   */
  getRegisteredToolkits(): Toolkit[] {
    return [...this.toolkits.values()];
  }

  /**
   * Returns the Agent Skills (SKILL.md folders) available to the model.
   * Populated by initialize().
   */
  getAgentSkills(): AgentSkill[] {
    return [...this.agentSkills.values()];
  }

  /**
   * Adds a toolkit dynamically to the agent.
   * If the agent is already initialized, the toolkit's initialize() hook is called immediately.
   * @param toolkit The Toolkit instance to add.
   */
  async addToolkit(toolkit: Toolkit): Promise<void> {
    this.registerToolkit(toolkit);
    if (this.isInitialized && !toolkit.isReady()) {
      await toolkit.initialize();
      this.log(`Toolkit '${toolkit.getName()}' dynamically initialized.`);
    }
  }

  /**
   * Removes a toolkit and all its associated tools from the agent.
   * If the toolkit is initialized, its shutdown() hook is called.
   * @param name The name of the toolkit to remove.
   */
  async removeToolkit(name: string): Promise<void> {
    const toolkit = this.toolkits.get(name);
    if (!toolkit) {
      this.log(`Toolkit '${name}' not found, nothing to remove.`);
      return;
    }

    if (toolkit.isReady()) {
      await toolkit.shutdown();
    }

    for (const tool of toolkit.getTools()) {
      this.localTools.delete(tool.name);
      this.log(`Removed toolkit tool: ${tool.name}`);
    }
    this.toolsPayloadCache = null;

    this.toolkits.delete(name);
    this.log(`Toolkit '${name}' removed.`);
  }

  /** @deprecated Use {@link getRegisteredToolkits}. */
  getRegisteredSkills(): Toolkit[] {
    return this.getRegisteredToolkits();
  }

  /** @deprecated Use {@link addToolkit}. */
  addSkill(toolkit: Toolkit): Promise<void> {
    return this.addToolkit(toolkit);
  }

  /** @deprecated Use {@link removeToolkit}. */
  removeSkill(name: string): Promise<void> {
    return this.removeToolkit(name);
  }

  /**
   * Resolves Agent Skill sources (paths or loaded skills) and exposes them to the
   * model through the load_skill / read_skill_file tools.
   */
  private async loadAgentSkills(sources: Array<string | AgentSkill>): Promise<void> {
    for (const source of sources) {
      const skills = typeof source === "string" ? await loadAgentSkills(source) : [source];
      if (typeof source === "string" && skills.length === 0) {
        this.logger.warn(`No Agent Skill (SKILL.md) found in '${source}'.`);
      }
      for (const skill of skills) {
        const existing = this.agentSkills.get(skill.name);
        if (existing && existing.dir !== skill.dir) {
          throw new Error(`Agent Skill name collision: '${skill.name}' is defined in '${existing.dir}' and '${skill.dir}'.`);
        }
        this.agentSkills.set(skill.name, skill);
        this.log(`Agent Skill available: ${skill.name}`);
      }
    }
    if (this.agentSkills.size === 0) return;

    const tools = createAgentSkillTools(this.agentSkills);
    for (const tool of tools) {
      if (this.localTools.has(tool.name)) {
        throw new Error(`Tool name collision: '${tool.name}' is reserved for Agent Skills on agent '${this.config.name}'.`);
      }
    }
    for (const tool of tools) this.localTools.set(tool.name, tool);
    this.agentSkillToolNames = tools.map((t) => t.name);
    this.toolsPayloadCache = null;
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
   * Concurrent calls on the same instance are queued and run one after the other.
   * @param input A prompt string or a list of messages.
   */
  async run(input: string | Message[], options?: RunOptions): Promise<string>;
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
    options?: StructuredOutputConfig<T> | RunOptions
  ): Promise<z.infer<T> | string> {
    const structuredConfig = options && "schema" in options ? options : undefined;
    const release = await this.acquireRunLock();
    try {
      return await this.runUnlocked(input, structuredConfig, options?.signal);
    } finally {
      release();
    }
  }

  private async runUnlocked<T extends z.ZodType>(
    input: string | Message[],
    structuredConfig: StructuredOutputConfig<T> | undefined,
    signal: AbortSignal | undefined
  ): Promise<z.infer<T> | string> {
    await this.initialize();
    // A blocked turn leaves no trace in the history.
    const historyBefore = [...this.messageHistory];
    try {
      return await this.runTurn(input, structuredConfig, signal);
    } catch (err) {
      if (err instanceof GuardrailError) this.messageHistory = historyBefore;
      throw err;
    }
  }

  private async runTurn<T extends z.ZodType>(
    input: string | Message[],
    structuredConfig: StructuredOutputConfig<T> | undefined,
    signal: AbortSignal | undefined
  ): Promise<z.infer<T> | string> {
    let { isLfm, pendingInputCheck } = await this.prepareTurn(input, signal);

    // The schema instructions only depend on the schema, so build them once per run.
    const promptSchemaInstructions = structuredConfig
      ? `\n\nCRITICAL: You MUST respond with a single valid JSON object that strictly conforms to the following JSON Schema:\n${JSON.stringify(toJsonSchema(structuredConfig.schema), null, 2)}\nDo not include any normal conversation or markdown blocks like \`\`\`json. Return only the raw JSON.`
      : "";

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      this.log(`--- Iteration ${iteration} ---`);

      const toolsPayload = this.getToolsPayload();
      const call = async (callSignal: AbortSignal | undefined): Promise<any> => {
        // Temporarily append schema instructions to the last user/tool message so the
        // LLM keeps them in immediate context. Multimodal bodies (content arrays) get
        // the instructions as an extra text part instead of string concatenation.
        const activeMessages = [...this.messageHistory];
        const lastMessage = activeMessages[activeMessages.length - 1];
        if (promptSchemaInstructions && lastMessage && (lastMessage.role === "user" || lastMessage.role === "tool")) {
          activeMessages[activeMessages.length - 1] = {
            ...lastMessage,
            content: Array.isArray(lastMessage.content)
              ? [...lastMessage.content, { type: "text" as const, text: promptSchemaInstructions }]
              : (lastMessage.content || "") + promptSchemaInstructions,
          };
        }
        this.log(`Calling LLM (${this.config.model})...`);
        return this.llmClient.chatCompletion({
          model: this.config.model,
          messages: await this.prepareRequestMessages(activeMessages),
          tools: toolsPayload.length > 0 ? toolsPayload : undefined,
          // Use JSON Object response format constraint if the LLM backend supports it
          response_format: structuredConfig ? { type: "json_object" } : undefined,
          temperature: this.config.temperature,
          signal: callSignal,
        });
      };

      let response: any;
      if (pendingInputCheck) {
        const check = pendingInputCheck;
        pendingInputCheck = null;
        response = await this.callWithParallelInputCheck(check, call, signal);
      } else {
        response = await call(signal);
      }
      this.recordUsage(response.usage);

      const choice = response.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error("Invalid or empty response received from the LLM.");
      }

      const content: string | null = choice.message.content;
      let toolCalls: ToolCall[] | undefined = choice.message.tool_calls;

      if (this.config.hooks.afterLLMCall) {
        await this.config.hooks.afterLLMCall(content, toolCalls);
      }

      // Parse embedded tool calls when the model doesn't use the standard tool_calls API
      if ((!toolCalls || toolCalls.length === 0) && content) {
        const recovered = this.recoverToolCalls(content);
        if (recovered.length > 0) toolCalls = recovered;
      }

      const assistantMessage: Message = { role: "assistant", content, tool_calls: toolCalls };

      const { thinking, cleanContent } = processThinking(content);
      const cleanContentWithoutTools = isLfm && cleanContent ? extractToolCalls(cleanContent).cleanContent : cleanContent;
      if (thinking) this.log(`[Thinking]\n${thinking}`);

      this.log(`Received LLM Response: ${cleanContentWithoutTools || "[No text content]"}`);
      this.messageHistory.push(assistantMessage);

      if (toolCalls && toolCalls.length > 0) {
        await this.handleToolCalls(toolCalls, signal);
        continue;
      }

      // No tool calls — final response
      if (structuredConfig) {
        const validationResult = validateStructuredOutput(typeof content === "string" ? content : "", structuredConfig.schema);
        const data = validationResult.success
          ? validationResult.data
          : await this.retryStructuredOutputCorrection(structuredConfig, validationResult.error, signal);
        const guarded = await this.guardStructuredOutput(data, structuredConfig.schema, signal);
        await this.saveHistory();
        return guarded;
      }

      const finalText = await this.guardFinalText(
        this.config.showThinking ? (typeof content === "string" ? content : "") : (cleanContentWithoutTools || ""),
        signal
      );

      await this.saveHistory();
      return finalText;
    }

    throw new Error(`Agent run exceeded max iterations (${this.config.maxIterations}) without returning a final response.`);
  }

  /**
   * Executes the agent loop and yields chunks of the final text response in real-time.
   * Tool calls are handled transparently behind the scenes.
   *
   * Output guardrails run on the full answer once the stream has ended: a blocking
   * guardrail throws after the text was streamed, unless `guardrails.streamOutput` is
   * "buffer" (the answer is then checked first and emitted in one chunk).
   */
  async *runStream(
    input: string | Message[],
    options: RunOptions = {}
  ): AsyncGenerator<string, void, unknown> {
    const release = await this.acquireRunLock();
    try {
      yield* this.runStreamUnlocked(input, options.signal);
    } finally {
      release();
    }
  }

  /** Streams one turn; returns the final (guarded) answer text. */
  private async *runStreamUnlocked(
    input: string | Message[],
    signal: AbortSignal | undefined
  ): AsyncGenerator<string, string, unknown> {
    await this.initialize();
    const historyBefore = [...this.messageHistory];
    try {
      return yield* this.streamTurn(input, signal);
    } catch (err) {
      if (err instanceof GuardrailError) this.messageHistory = historyBefore;
      throw err;
    }
  }

  private async *streamTurn(
    input: string | Message[],
    signal: AbortSignal | undefined
  ): AsyncGenerator<string, string, unknown> {
    let { pendingInputCheck } = await this.prepareTurn(input, signal);
    const buffering = this.config.guardrails?.streamOutput === "buffer";

    for (let iteration = 1; iteration <= this.config.maxIterations; iteration++) {
      this.log(`--- Iteration ${iteration} (Streaming) ---`);

      const toolsPayload = this.getToolsPayload();
      const openStream = async (callSignal: AbortSignal | undefined) => {
        this.log(`Calling LLM Stream (${this.config.model})...`);
        return this.llmClient.chatCompletionStream({
          model: this.config.model,
          messages: await this.prepareRequestMessages(this.messageHistory),
          tools: toolsPayload.length > 0 ? toolsPayload : undefined,
          temperature: this.config.temperature,
          signal: callSignal,
        });
      };

      let stream: AsyncGenerator<any, void, unknown>;
      let firstChunk: Promise<IteratorResult<any, void>> | null = null;
      if (pendingInputCheck) {
        // Start the request (up to its first chunk) while the input guardrails run.
        const check = pendingInputCheck;
        pendingInputCheck = null;
        const controller = new AbortController();
        stream = await openStream(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
        firstChunk = stream.next();
        firstChunk.catch(() => {});
        let changed: boolean;
        try {
          changed = await check();
        } catch (err) {
          controller.abort();
          await stream.return().catch(() => {});
          throw err;
        }
        if (changed) {
          this.log("Input sanitized by a guardrail: restarting the LLM call.");
          controller.abort();
          await stream.return().catch(() => {});
          stream = await openStream(signal);
          firstChunk = null;
        }
      } else {
        stream = await openStream(signal);
      }

      let accumulatedContent = "";
      let visibleText = "";
      /** Reasoning-field output (with its <think> tags), re-emitted in buffer mode. */
      let reasoningText = "";
      const nativeToolCalls: Record<number, { id?: string; name?: string; arguments: string }> = {};
      let hasNativeToolCalls = false;
      let streamUsage: Usage | undefined;

      const parser = new StreamTagParser({
        showThinking: this.config.showThinking,
        onThinking: (thinking) => this.log(`[Thinking]\n${thinking}`),
      });

      // Some reasoning models stream their chain-of-thought in a dedicated
      // delta field (`reasoning_content` or `reasoning`) instead of inline
      // <think> tags in `content`. Surface it as a <think>…</think> block.
      let reasoningOpen = false;
      const closeReasoning = (): string | null => {
        if (!reasoningOpen) return null;
        reasoningOpen = false;
        return this.config.showThinking ? "</think>" : null;
      };

      try {
        while (true) {
          const step = firstChunk ? await firstChunk : await stream.next();
          firstChunk = null;
          if (step.done) break;
          const chunk = step.value;
          if (chunk.usage) streamUsage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          const out: string[] = [];
          const reasoning = (text: string) => { reasoningText += text; out.push(text); };

          const reasoningChunk: string | undefined = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoningChunk === "string" && reasoningChunk.length > 0 && this.config.showThinking) {
            if (!reasoningOpen) {
              reasoningOpen = true;
              reasoning("<think>");
            }
            reasoning(reasoningChunk);
          }

          if (delta.tool_calls) {
            const closeTag = closeReasoning();
            if (closeTag) reasoning(closeTag);
            hasNativeToolCalls = true;
            for (const tc of delta.tool_calls) {
              const acc = (nativeToolCalls[tc.index] ??= { arguments: "" });
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }

          if (delta.content) {
            const closeTag = closeReasoning();
            if (closeTag) reasoning(closeTag);
            accumulatedContent += delta.content;
            // Once native tool calls started, the text is no longer shown.
            if (!hasNativeToolCalls) {
              for (const text of parser.push(delta.content)) {
                visibleText += text;
                out.push(text);
              }
            }
          }

          if (!buffering) for (const text of out) yield text;
        }
      } finally {
        // Closes the HTTP stream if the consumer stopped early or an error occurred.
        await stream.return().catch(() => {});
      }

      // Close the reasoning block if the stream ended while still open
      // (e.g. reasoning with no following content or tool call).
      const tail: string[] = [];
      const closeTag = closeReasoning();
      if (closeTag) {
        reasoningText += closeTag;
        tail.push(closeTag);
      }
      if (!hasNativeToolCalls) {
        for (const text of parser.flush()) {
          visibleText += text;
          tail.push(text);
        }
      }
      if (!buffering) for (const text of tail) yield text;

      this.recordUsage(streamUsage);

      let toolCalls: ToolCall[] = hasNativeToolCalls
        ? Object.values(nativeToolCalls).map((atc) => ({
            id: atc.id || newToolCallId(),
            type: "function" as const,
            function: { name: atc.name || "", arguments: atc.arguments },
          }))
        : parser.toolCalls;

      // Safety net: if no tool calls were captured during streaming, try to
      // recover any embedded in the text content (bare JSON, <tool name="…">, etc.)
      // — same recovery run() performs, for any model.
      if (toolCalls.length === 0 && accumulatedContent) {
        toolCalls = this.recoverToolCalls(accumulatedContent);
      }

      if (this.config.hooks.afterLLMCall) {
        await this.config.hooks.afterLLMCall(accumulatedContent || null, toolCalls.length > 0 ? toolCalls : undefined);
      }

      this.messageHistory.push({
        role: "assistant",
        content: accumulatedContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length > 0) {
        // In buffer mode, text produced before a tool call is dropped, like run() does.
        await this.handleToolCalls(toolCalls, signal);
        continue;
      }

      const finalText = await this.guardFinalText(visibleText, signal);
      if (buffering && reasoningText + finalText) yield reasoningText + finalText;

      await this.saveHistory();
      return finalText;
    }

    throw new Error(`Agent run exceeded max iterations (${this.config.maxIterations}) without returning a final response.`);
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
    // Avoid an unhandled rejection when the caller only consumes the stream.
    result.catch(() => {});

    const self = this;
    async function* gen(): AsyncGenerator<string, void, unknown> {
      const release = await self.acquireRunLock();
      try {
        await self.initialize();
        const historyBefore = [...self.messageHistory];
        // The stream's return value is the final answer, already checked by the output guardrails.
        const finalText = yield* self.runStreamUnlocked(input, structuredConfig.signal);
        const validation = validateStructuredOutput(finalText, structuredConfig.schema);
        if (validation.success) {
          resolve(validation.data);
        } else {
          try {
            const corrected = await self.retryStructuredOutputCorrection<T>(structuredConfig, validation.error, structuredConfig.signal);
            resolve(await self.guardStructuredOutput<T>(corrected, structuredConfig.schema, structuredConfig.signal));
            await self.saveHistory();
          } catch (e: any) {
            if (e instanceof GuardrailError) self.messageHistory = historyBefore;
            reject(e);
          }
        }
      } catch (e: any) {
        reject(e instanceof Error ? e : new Error(String(e)));
        throw e;
      } finally {
        release();
      }
    }

    return { stream: gen(), result };
  }

  /**
   * Ask the LLM to correct its output if it fails validation.
   * On success the intermediate failed attempts and correction requests are removed
   * from the history, so only the valid answer remains after the original request.
   */
  private async retryStructuredOutputCorrection<T extends z.ZodType>(
    structuredConfig: StructuredOutputConfig<T>,
    lastError: string,
    signal: AbortSignal | undefined
  ): Promise<z.infer<T>> {
    const maxRetries = structuredConfig.maxRetries ?? DEFAULT_STRUCTURED_RETRIES;
    // History index of the invalid assistant answer that triggered the correction.
    const invalidAnswerIndex = this.messageHistory.length - 1;
    const correctionStart = this.messageHistory.length;
    let errorToReport = lastError;

    for (let retries = 1; retries <= maxRetries; retries++) {
      this.log(`Correction attempt ${retries}/${maxRetries} for validation error: ${errorToReport}`);

      this.messageHistory.push({
        role: "user",
        content: `Your previous response failed JSON/Zod validation with the following error:\n${errorToReport}\n\nPlease correct your output and reply ONLY with a valid JSON object matching the requested schema. Do not explain anything, do not wrap in markdown blocks, just return raw JSON.`,
      });

      this.log(`Calling LLM for correction...`);
      const response = await this.llmClient.chatCompletion({
        model: this.config.model,
        messages: await this.prepareRequestMessages(this.messageHistory),
        response_format: { type: "json_object" },
        temperature: this.config.temperature,
        signal,
      });
      this.recordUsage(response.usage);

      const content = response.choices?.[0]?.message?.content || "";
      this.log(`Received Correction Response: ${content}`);
      this.messageHistory.push({ role: "assistant", content });

      const validationResult = validateStructuredOutput(content, structuredConfig.schema);
      if (validationResult.success) {
        const start = this.messageHistory[invalidAnswerIndex]?.role === "assistant" ? invalidAnswerIndex : correctionStart;
        this.messageHistory.splice(start, this.messageHistory.length - start, { role: "assistant", content });
        return validationResult.data;
      }
      errorToReport = validationResult.error;
    }

    // Drop the correction exchange so the next turn starts from a clean history.
    this.messageHistory.splice(correctionStart);
    throw new Error(`Structured output validation failed after ${maxRetries} correction retries. Last error: ${errorToReport}`);
  }

  /**
   * Cleans up all MCP clients connected.
   */
  async shutdown(): Promise<void> {
    this.log("Shutting down agent...");

    for (const [name, toolkit] of this.toolkits) {
      try {
        await toolkit.shutdown();
        this.log(`Toolkit '${name}' shut down.`);
      } catch (err: any) {
        this.logger.error(`Failed to shut down toolkit '${name}': ${err.message}`);
      }
    }

    // Agent Skills are reloaded from disk on the next initialize().
    for (const name of this.agentSkillToolNames) this.localTools.delete(name);
    this.agentSkillToolNames = [];
    this.agentSkills.clear();

    await this.mcpManager.disconnectAll();
    this.mcpTools.clear();
    this.toolsPayloadCache = null;
    this.isInitialized = false;
    this.initPromise = null;
    this.log("Agent shutdown complete.");
  }

  /**
   * Waits for the previous run to finish and returns the release function.
   * Note: an agent must not call itself as a tool, which would deadlock.
   */
  private async acquireRunLock(): Promise<() => void> {
    let release!: () => void;
    const current = new Promise<void>((r) => { release = r; });
    const previous = this.runLock;
    this.runLock = previous.then(() => current);
    await previous;
    return release;
  }

  /**
   * Initializes if needed and appends the input to the history. Input guardrails run
   * right away, or are returned as `pendingInputCheck` when `parallelInput` is enabled.
   */
  private async prepareTurn(
    input: string | Message[],
    signal: AbortSignal | undefined
  ): Promise<{ isLfm: boolean; pendingInputCheck: (() => Promise<boolean>) | null }> {
    await this.initialize();

    // Index of the first message of the new turn (the messages the input guardrails check).
    let turnStart: number;
    if (typeof input === "string") {
      if (this.messageHistory.length === 0) {
        this.messageHistory.push({ role: "system", content: this.buildSystemPrompt() });
      }
      turnStart = this.messageHistory.length;
      this.messageHistory.push({ role: "user", content: input });
    } else {
      this.messageHistory = [...input];
      if (!this.messageHistory.some(m => m.role === "system")) {
        this.messageHistory.unshift({ role: "system", content: this.buildSystemPrompt() });
      }
      // With a full message list, the new turn is everything after the last assistant message.
      turnStart = 0;
      for (let i = this.messageHistory.length - 1; i >= 0; i--) {
        if (this.messageHistory[i].role === "assistant") { turnStart = i + 1; break; }
      }
    }

    const format = this.config.toolCallFormat;
    const isLfm = format === "lfm" || (format === "auto" && this.config.model.toLowerCase().includes("lfm"));
    if (isLfm) this.injectLfmToolList();

    if (!this.config.guardrails?.input?.length) return { isLfm, pendingInputCheck: null };
    const check = () => this.checkInput(turnStart, signal);
    if (this.config.guardrails.parallelInput) return { isLfm, pendingInputCheck: check };
    await check();
    return { isLfm, pendingInputCheck: null };
  }

  /**
   * Runs the input guardrails on the text of the user messages from `turnStart`
   * (each text part of a multimodal message is checked separately; images, files and
   * audio are not inspected). Sanitized text replaces the original in the history.
   * @returns true when a guardrail changed the input.
   */
  private async checkInput(turnStart: number, signal: AbortSignal | undefined): Promise<boolean> {
    const fns = this.config.guardrails?.input ?? [];
    const ctx = this.guardrailContext("input", signal);
    let changed = false;

    for (let i = turnStart; i < this.messageHistory.length; i++) {
      const message = this.messageHistory[i];
      if (message.role !== "user") continue;

      if (typeof message.content === "string") {
        const sanitized = await applyGuardrails(message.content, fns, ctx);
        if (sanitized !== message.content) {
          this.messageHistory[i] = { ...message, content: sanitized };
          changed = true;
        }
      } else if (Array.isArray(message.content)) {
        let partsChanged = false;
        const parts = [];
        for (const part of message.content) {
          if (part.type !== "text") { parts.push(part); continue; }
          const sanitized = await applyGuardrails(part.text, fns, ctx);
          partsChanged ||= sanitized !== part.text;
          parts.push(sanitized === part.text ? part : { ...part, text: sanitized });
        }
        if (partsChanged) {
          this.messageHistory[i] = { ...message, content: parts };
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Sends the first LLM call while the input guardrails run. A block aborts the call;
   * a sanitized input discards it and sends the call again with the new history.
   */
  private async callWithParallelInputCheck<R>(
    check: () => Promise<boolean>,
    call: (signal: AbortSignal | undefined) => Promise<R>,
    signal: AbortSignal | undefined
  ): Promise<R> {
    const controller = new AbortController();
    const pending = call(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    pending.catch(() => {});
    let changed: boolean;
    try {
      changed = await check();
    } catch (err) {
      controller.abort();
      throw err;
    }
    if (!changed) return pending;
    this.log("Input sanitized by a guardrail: restarting the LLM call.");
    controller.abort();
    return call(signal);
  }

  private guardrailContext(stage: GuardrailStage, signal: AbortSignal | undefined, toolName?: string): GuardrailContext {
    return { stage, agentName: this.config.name, messages: this.messageHistory, signal, ...(toolName ? { toolName } : {}) };
  }

  /**
   * Runs the output guardrails on the final answer. A sanitized answer also replaces
   * the last assistant message, so the raw text is neither re-sent nor persisted.
   */
  private async guardFinalText(text: string, signal: AbortSignal | undefined): Promise<string> {
    const fns = this.config.guardrails?.output;
    if (!fns?.length) return text;
    const sanitized = await applyGuardrails(text, fns, this.guardrailContext("output", signal));
    if (sanitized !== text) this.replaceLastAssistantContent(sanitized);
    return sanitized;
  }

  /**
   * Runs the output guardrails on a structured answer (as JSON text). A sanitized
   * answer is parsed and validated again against the schema.
   */
  private async guardStructuredOutput<T extends z.ZodType>(
    data: z.infer<T>,
    schema: T,
    signal: AbortSignal | undefined
  ): Promise<z.infer<T>> {
    const fns = this.config.guardrails?.output;
    if (!fns?.length) return data;
    const json = JSON.stringify(data);
    const sanitized = await applyGuardrails(json, fns, this.guardrailContext("output", signal));
    if (sanitized === json) return data;

    const revalidated = validateStructuredOutput(sanitized, schema);
    if (!revalidated.success) {
      throw new GuardrailError("output", "schema", `Sanitized output no longer matches the schema: ${revalidated.error}`);
    }
    this.replaceLastAssistantContent(sanitized);
    return revalidated.data;
  }

  private replaceLastAssistantContent(content: string): void {
    for (let i = this.messageHistory.length - 1; i >= 0; i--) {
      if (this.messageHistory[i].role === "assistant") {
        this.messageHistory[i] = { ...this.messageHistory[i], content };
        return;
      }
    }
  }

  /**
   * Runs the tool-result guardrails. A blocked result is replaced by an error message
   * for the model, or aborts the run when `onToolResultBlocked` is "throw".
   */
  private async guardToolResult(content: string, toolName: string, signal: AbortSignal | undefined): Promise<string> {
    const fns = this.config.guardrails?.toolResults;
    if (!fns?.length) return content;
    try {
      return await applyGuardrails(content, fns, this.guardrailContext("toolResult", signal, toolName));
    } catch (err) {
      if (!(err instanceof GuardrailError) || this.config.guardrails?.onToolResultBlocked === "throw") throw err;
      this.logger.warn(`Result of tool '${toolName}' blocked by guardrail '${err.guardrail}': ${err.reason}`);
      return JSON.stringify({ error: `Tool result blocked by guardrail '${err.guardrail}': ${err.reason}` });
    }
  }

  /** LFM templates expect the tool list inside the system prompt. */
  private injectLfmToolList(): void {
    const tools = this.getRegisteredTools();
    if (tools.length === 0) return;
    const systemMessage = this.messageHistory.find(m => m.role === "system");
    if (!systemMessage) return;

    const contentStr = typeof systemMessage.content === "string" ? systemMessage.content : "";
    if (contentStr.includes("List of tools:")) return;

    const cleanTools = this.getToolsPayload().map((t) => t.function);
    systemMessage.content = `${contentStr}\n\nList of tools: ${JSON.stringify(cleanTools)}\nOutput function calls as JSON.`;
  }

  /** Function-calling payload for all registered tools, built once per tool set. */
  private getToolsPayload(): ToolPayload[] {
    if (!this.toolsPayloadCache) {
      this.toolsPayloadCache = this.getRegisteredTools().map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toJsonSchema(tool.schema) as Record<string, any>,
        },
      }));
    }
    return this.toolsPayloadCache;
  }

  /**
   * Recovers tool calls embedded in text. Bare JSON objects are only accepted when
   * they name a registered tool, so a JSON answer is not mistaken for a tool call.
   */
  private recoverToolCalls(content: string): ToolCall[] {
    const knownTools = new Set([...this.localTools.keys(), ...this.mcpTools.keys()]);
    return extractToolCalls(content, { knownTools }).toolCalls;
  }

  /** Applies the context window limit, then the beforeLLMCall hook. */
  private async prepareRequestMessages(messages: Message[]): Promise<Message[]> {
    const windowed = this.applyContextWindow(messages);
    if (!this.config.hooks.beforeLLMCall) return windowed;
    return (await this.config.hooks.beforeLLMCall(windowed)) ?? windowed;
  }

  /**
   * Keeps the system message(s) and the last `context.maxMessages` other messages.
   * Leading tool results whose assistant tool call was dropped are dropped too.
   */
  private applyContextWindow(messages: Message[]): Message[] {
    const max = this.config.context.maxMessages;
    if (!max || messages.length <= max) return messages;

    const system = messages.filter((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    if (rest.length <= max) return messages;

    let tail = rest.slice(rest.length - max);
    let firstKept = 0;
    while (firstKept < tail.length && tail[firstKept].role === "tool") firstKept++;
    tail = tail.slice(firstKept);
    return [...system, ...tail];
  }

  /** Executes the tool calls and appends their results to the history. */
  private async handleToolCalls(toolCalls: ToolCall[], signal: AbortSignal | undefined): Promise<void> {
    this.log(`Tool Calls requested: ${toolCalls.map(tc => tc.function.name).join(", ")}`);
    const results = this.config.parallelTools && toolCalls.length > 1
      ? await Promise.all(toolCalls.map((tc) => this.executeTool(tc)))
      : await this.executeToolsSequential(toolCalls);

    const maxChars = this.config.context.maxToolResultChars;
    for (const [i, tc] of toolCalls.entries()) {
      let content = results[i];
      if (maxChars && content.length > maxChars) {
        content = `${content.slice(0, maxChars)}\n…[truncated ${content.length - maxChars} characters]`;
      }
      // Guard what the model will actually see (after truncation).
      content = await this.guardToolResult(content, tc.function.name, signal);
      this.messageHistory.push({ role: "tool", name: tc.function.name, tool_call_id: tc.id, content });
    }
  }

  private async executeToolsSequential(toolCalls: ToolCall[]): Promise<string[]> {
    const results: string[] = [];
    for (const tc of toolCalls) results.push(await this.executeTool(tc));
    return results;
  }

  /**
   * Registers a toolkit's tools into the agent's localTools map.
   */
  private registerToolkit(toolkit: Toolkit): void {
    const name = toolkit.getName();
    if (this.toolkits.has(name)) {
      throw new Error(`Toolkit '${name}' is already registered on agent '${this.config.name}'.`);
    }

    const tools = toolkit.getTools();
    for (const tool of tools) {
      if (this.localTools.has(tool.name)) {
        throw new Error(
          `Tool name collision: '${tool.name}' from toolkit '${name}' conflicts with an existing tool on agent '${this.config.name}'.`
        );
      }
    }

    this.toolkits.set(name, toolkit);
    for (const tool of tools) {
      this.localTools.set(tool.name, tool);
      this.log(`Registered toolkit tool: ${tool.name} (from toolkit '${name}')`);
    }
    this.toolsPayloadCache = null;
  }

  /**
   * Builds the full system prompt: base prompt, toolkit prompts, then the
   * catalog of Agent Skills (names and descriptions only).
   */
  private buildSystemPrompt(): string {
    const sections = [
      this.config.systemPrompt,
      ...[...this.toolkits.values()].map((toolkit) => toolkit.getSystemPrompt()),
      agentSkillsPrompt(this.getAgentSkills()),
    ].filter((section): section is string => !!section);
    return sections.join("\n\n");
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

  /** Accumulates the usage of one LLM call and enforces the budget. */
  private recordUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.sessionUsage.totalPromptTokens += usage.prompt_tokens ?? 0;
    this.sessionUsage.totalCompletionTokens += usage.completion_tokens ?? 0;
    this.sessionUsage.totalTokens += usage.total_tokens ?? 0;
    this.sessionUsage.llmCallCount++;
    this.checkBudget();
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
    this.logger.debug(message);
  }

  getName(): string {
    return this.config.name;
  }

  private async saveHistory(): Promise<void> {
    if (this.config.historyAdapter && this.config.sessionId) {
      await this.config.historyAdapter.save(this.config.sessionId, this.messageHistory);
    }
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
