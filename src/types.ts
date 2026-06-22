import { z } from "zod";
import type { Skill } from "./skill.js";
import type { LoggerConfig } from "./logger.js";
import type { HistoryAdapter } from "./history.js";
import type { Guardrails } from "./guardrails.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: {
    /** A remote URL or a `data:<mime>;base64,<...>` URL. */
    url: string;
    /** Resolution hint for vision models. Default: "auto". */
    detail?: "auto" | "low" | "high";
  };
}

export interface FilePart {
  type: "file";
  file: {
    /** Display name of the document (e.g. "report.pdf"). */
    filename?: string;
    /** A `data:<mime>;base64,<...>` URL holding the document bytes. */
    file_data?: string;
    /** Id of a file previously uploaded to the provider. */
    file_id?: string;
  };
}

export interface InputAudioPart {
  type: "input_audio";
  input_audio: {
    /** Base64-encoded audio data. */
    data: string;
    format: "wav" | "mp3";
  };
}

/** A single block of a multimodal message body. */
export type ContentPart = TextPart | ImagePart | FilePart | InputAudioPart;

export interface Message {
  role: MessageRole;
  /** Plain text, or an array of content parts for multimodal (image/document/audio) input. */
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface Tool<T = any> {
  name: string;
  description: string;
  schema: z.ZodObject<any> | Record<string, any>;
  execute: (args: T) => Promise<any> | any;
  requiresApproval?: boolean;
}

export interface AgentHooks {
  /** Called before each LLM call. Can return modified messages or undefined to keep originals. */
  beforeLLMCall?: (messages: Message[]) => Promise<Message[]> | Message[] | void;
  /** Called after each LLM response. */
  afterLLMCall?: (content: string | null, toolCalls?: ToolCall[]) => Promise<void> | void;
  /** Called before each tool execution. Return false to cancel, return an object to replace args, or return void to proceed as-is. */
  beforeToolCall?: (toolName: string, args: any) => Promise<any | false> | any | false;
  /** Called after each tool execution. Can return a value to replace the tool result. */
  afterToolCall?: (toolName: string, args: any, result: any) => Promise<any> | any;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentConfig {
  name: string;
  systemPrompt?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  tools?: Tool[];
  skills?: Skill[];
  mcpServers?: McpServerConfig[];
  maxIterations?: number;
  temperature?: number;
  showThinking?: boolean;
  hooks?: AgentHooks;
  /** Called when a tool with requiresApproval=true is about to execute. Return true to allow, false to cancel. */
  onApprovalRequired?: (toolName: string, args: any) => Promise<boolean>;
  budget?: BudgetConfig;
  /** Structured logger config. Overrides verbose when set. */
  logger?: LoggerConfig;
  /** Retry/backoff config for LLM API calls. */
  retry?: RetryConfig;
  /** Execute independent tool calls in parallel. Default: false. */
  parallelTools?: boolean;
  /** Adapter for persisting/loading conversation history between sessions. */
  historyAdapter?: HistoryAdapter;
  /** Session ID used by the historyAdapter. Required when historyAdapter is set. */
  sessionId?: string;
  /** Input/output content filters. */
  guardrails?: Guardrails;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelPricing {
  /** Price per million input tokens in USD */
  inputPerMToken: number;
  /** Price per million output tokens in USD */
  outputPerMToken: number;
}

export interface BudgetConfig {
  /** Max total tokens for the session. Agent throws if exceeded. */
  maxTokens?: number;
  /** Max cost in USD for the session. Requires pricing to be set. */
  maxCostUSD?: number;
  /** Pricing info used for cost estimation. */
  pricing?: ModelPricing;
}

export interface UsageSummary {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  /** null when no pricing config is provided */
  estimatedCostUSD: number | null;
  llmCallCount: number;
}

export interface RetryConfig {
  /** Max number of retries after the initial attempt. Default: 3. */
  maxRetries?: number;
  /** Initial delay in ms before first retry. Default: 500. */
  initialDelayMs?: number;
  /** Maximum delay in ms between retries. Default: 10000. */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry. Default: [429, 500, 502, 503, 504]. */
  retryableStatuses?: number[];
}

export interface StructuredOutputConfig<T extends z.ZodType> {
  schema: T;
  prompt?: string;
  maxRetries?: number;
}
