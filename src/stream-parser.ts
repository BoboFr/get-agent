import { getPrefixMatchLen, newToolCallId, parseToolCallBody } from "./parsing.js";
import type { ToolCall } from "./types.js";

/** Tool-call markers vary by model/template. Each start tag has a matching end tag. */
const TOOL_CALL_MARKERS = [
  { start: "<|tool_call_start|>", end: "<|tool_call_end|>" },
  { start: "<tool_call>", end: "</tool_call>" },
];
const THINK_START = "<think>";
const THINK_END = "</think>";

export interface StreamTagParserOptions {
  /** When true, `<think>…</think>` blocks are forwarded to the output. Default: true. */
  showThinking?: boolean;
  /** Called with the content of each hidden thinking block (only when showThinking is false). */
  onThinking?: (thinking: string) => void;
}

/**
 * Incremental parser for streamed assistant text.
 *
 * Feed it content deltas with `push()`; it returns the text that is safe to show
 * right away, holds back partial tags split across chunks, hides tool-call blocks
 * and collects the tool calls found inside them.
 */
export class StreamTagParser {
  readonly toolCalls: ToolCall[] = [];

  private buffer = "";
  private state: "text" | "thinking" | "tool" = "text";
  private toolCallEndTag = TOOL_CALL_MARKERS[0].end;
  private thinkingBuffer = "";
  private readonly showThinking: boolean;
  private readonly onThinking?: (thinking: string) => void;

  constructor(options: StreamTagParserOptions = {}) {
    this.showThinking = options.showThinking ?? true;
    this.onThinking = options.onThinking;
  }

  /** Processes a content delta and returns the chunks to emit, in order. */
  push(chunk: string): string[] {
    const out: string[] = [];
    this.buffer += chunk;

    let processed = true;
    while (processed) {
      processed = false;

      if (this.state === "text") {
        // Find the earliest tool-call start marker among known variants
        let idxTool = -1;
        let toolStartLen = 0;
        let toolEnd = TOOL_CALL_MARKERS[0].end;
        for (const marker of TOOL_CALL_MARKERS) {
          const i = this.buffer.indexOf(marker.start);
          if (i !== -1 && (idxTool === -1 || i < idxTool)) {
            idxTool = i;
            toolStartLen = marker.start.length;
            toolEnd = marker.end;
          }
        }
        const idxThink = this.buffer.indexOf(THINK_START);

        if (idxTool !== -1 && (idxThink === -1 || idxTool < idxThink)) {
          emit(out, this.buffer.substring(0, idxTool));
          this.buffer = this.buffer.substring(idxTool + toolStartLen);
          this.state = "tool";
          this.toolCallEndTag = toolEnd;
          processed = true;
        } else if (idxThink !== -1) {
          emit(out, this.buffer.substring(0, idxThink));
          this.buffer = this.buffer.substring(idxThink + THINK_START.length);
          this.state = "thinking";
          if (this.showThinking) out.push(THINK_START);
          processed = true;
        } else {
          // Hold back a possible partial start marker at the end of the buffer
          const keepLen = Math.max(
            getPrefixMatchLen(this.buffer, THINK_START),
            ...TOOL_CALL_MARKERS.map((m) => getPrefixMatchLen(this.buffer, m.start))
          );
          emit(out, this.buffer.substring(0, this.buffer.length - keepLen));
          this.buffer = this.buffer.substring(this.buffer.length - keepLen);
        }
      } else if (this.state === "thinking") {
        const idxThinkEnd = this.buffer.indexOf(THINK_END);
        if (idxThinkEnd !== -1) {
          const thinkContent = this.buffer.substring(0, idxThinkEnd);
          if (this.showThinking) {
            emit(out, thinkContent);
            out.push(THINK_END);
          } else {
            this.thinkingBuffer += thinkContent;
            this.onThinking?.(this.thinkingBuffer.trim());
          }
          this.buffer = this.buffer.substring(idxThinkEnd + THINK_END.length);
          this.state = "text";
          this.thinkingBuffer = "";
          processed = true;
        } else {
          const keepLen = getPrefixMatchLen(this.buffer, THINK_END);
          const before = this.buffer.substring(0, this.buffer.length - keepLen);
          if (this.showThinking) emit(out, before);
          else this.thinkingBuffer += before;
          this.buffer = this.buffer.substring(this.buffer.length - keepLen);
        }
      } else {
        const idxToolEnd = this.buffer.indexOf(this.toolCallEndTag);
        if (idxToolEnd === -1) break; // wait for the end tag

        const parsed = parseToolCallBody(this.buffer.substring(0, idxToolEnd));
        if (parsed) {
          this.toolCalls.push({ id: newToolCallId(), type: "function", function: parsed });
        }
        this.buffer = this.buffer.substring(idxToolEnd + this.toolCallEndTag.length);
        this.state = "text";
        processed = true;
      }
    }

    return out;
  }

  /** Returns any remaining text once the stream has ended (unfinished tool blocks are dropped). */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest) return [];
    if (this.state === "text" || (this.state === "thinking" && this.showThinking)) return [rest];
    return [];
  }
}

function emit(out: string[], text: string): void {
  if (text) out.push(text);
}
