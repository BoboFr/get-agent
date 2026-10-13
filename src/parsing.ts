import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolCall } from "./types.js";

/** Generates an OpenAI-style tool call id. */
export function newToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Returns the length of the longest suffix of `str` that is a strict prefix of `target`.
 * Used while streaming to hold back characters that may be the start of a tag.
 */
export function getPrefixMatchLen(str: string, target: string): number {
  for (let len = Math.min(str.length, target.length - 1); len > 0; len--) {
    if (str.endsWith(target.substring(0, len))) {
      return len;
    }
  }
  return 0;
}

/** Parses a Python-style call such as `get_weather(city="Paris", days=3)`. */
export function parsePythonicCall(callStr: string): { name: string; arguments: Record<string, any> } | null {
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

/** Converts a Python dict literal (single quotes, True/False/None) to an object. */
export function parsePythonLikeLiteral(raw: string): Record<string, any> | null {
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

/**
 * Parses the body of a tool-call block (JSON object or pythonic call).
 * Returns null when the body cannot be understood.
 */
export function parseToolCallBody(rawBody: string): { name: string; arguments: string } | null {
  const body = rawBody.trim();
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      const name = parsed.name || parsed.function?.name || "";
      if (name) {
        return { name, arguments: JSON.stringify(parsed.arguments || parsed.function?.arguments || parsed) };
      }
    } catch {
      // Fallback to pythonic
    }
  }

  const parsedPythonic = parsePythonicCall(body);
  if (parsedPythonic) {
    return { name: parsedPythonic.name, arguments: JSON.stringify(parsedPythonic.arguments) };
  }
  return null;
}

function toToolCall(name: string, args: string): ToolCall {
  return { id: newToolCallId(), type: "function", function: { name, arguments: args } };
}

/**
 * Recovers tool calls embedded in text content, for models that do not use the
 * standard `tool_calls` API. Supported formats:
 * - LFM markers `<|tool_call_start|>…<|tool_call_end|>`
 * - Qwen/Hermes tags `<tool_call>…</tool_call>`
 * - bare JSON `{"name": …, "arguments": …}` (or an array of them)
 * - `<tool name="…" arguments={…}>`
 *
 * @param options.knownTools When set, a bare JSON object is only treated as a tool
 *   call if its `name` is in this set (avoids mistaking a JSON answer for a call).
 */
export function extractToolCalls(
  content: string | null,
  options: { knownTools?: ReadonlySet<string> } = {}
): { toolCalls: ToolCall[], cleanContent: string } {
  if (!content) return { toolCalls: [], cleanContent: "" };

  const toolCalls: ToolCall[] = [];
  const toolCallRegex = /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>|<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  let cleanContent = content;

  while ((match = toolCallRegex.exec(content)) !== null) {
    const rawBody = (match[1] ?? match[2] ?? "").trim();
    cleanContent = cleanContent.replace(match[0], '');

    if (rawBody.startsWith('{')) {
      try {
        const parsed = JSON.parse(rawBody);
        toolCalls.push(toToolCall(
          parsed.name || parsed.function?.name || "",
          JSON.stringify(parsed.arguments || parsed.function?.arguments || parsed)
        ));
        continue;
      } catch (e) {
        // Fallback to pythonic
      }
    }

    const parsedPythonic = parsePythonicCall(rawBody);
    if (parsedPythonic) {
      toolCalls.push(toToolCall(parsedPythonic.name, JSON.stringify(parsedPythonic.arguments)));
    }
  }

  // Handle bare JSON tool call: {"name":"...", "arguments":{...}} or an array of them
  if (toolCalls.length === 0) {
    try {
      const trimmed = cleanContent.trim();
      const parsed = JSON.parse(trimmed);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const allValid = entries.every((e: any) =>
        typeof e?.name === "string" &&
        e?.arguments !== undefined &&
        (!options.knownTools || options.knownTools.has(e.name))
      );
      if (allValid && entries.length > 0) {
        cleanContent = "";
        for (const entry of entries) {
          toolCalls.push(toToolCall(
            entry.name,
            typeof entry.arguments === "string" ? entry.arguments : JSON.stringify(entry.arguments)
          ));
        }
      }
    } catch { }
  }

  // Handle <tool name="..." arguments={...}> format (some local models)
  const xmlToolRegex = /<tool\s+name="([^"]+)"\s+arguments=(\{[\s\S]*?\})\s*\)?>/g;
  while ((match = xmlToolRegex.exec(content)) !== null) {
    cleanContent = cleanContent.replace(match[0], "");
    const parsedArgs = parsePythonLikeLiteral(match[2]);
    toolCalls.push(toToolCall(match[1], parsedArgs !== null ? JSON.stringify(parsedArgs) : "{}"));
  }

  return { toolCalls, cleanContent: cleanContent.trim() };
}

/** Splits the first `<think>…</think>` block from the rest of the content. */
export function processThinking(content: string | null): { thinking: string; cleanContent: string | null } {
  if (!content) return { thinking: "", cleanContent: null };

  const thinkRegex = /<think>([\s\S]*?)<\/think>/i;
  const match = content.match(thinkRegex);

  if (match) {
    const thinking = match[1].trim();
    const cleanContent = content.replace(thinkRegex, "").trim();
    return { thinking, cleanContent: cleanContent || null };
  }

  return { thinking: "", cleanContent: content };
}

const jsonSchemaCache = new WeakMap<object, Record<string, any>>();

/**
 * Converts a Zod schema to a JSON Schema (draft-7) suitable for function calling.
 * Non-Zod values (e.g. MCP input schemas) are returned unchanged.
 * Results are cached per schema instance.
 */
export function toJsonSchema(schema: any): any {
  if (!schema || typeof schema !== "object" || !("safeParse" in schema)) return schema;

  const cached = jsonSchemaCache.get(schema);
  if (cached) return cached;

  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, any>;
  // Strip the $schema dialect marker: harmless but rejected by some
  // strict function-calling validators that expect a bare parameters object.
  const { $schema, ...rest } = json;
  jsonSchemaCache.set(schema, rest);
  return rest;
}

/** Parses and validates an LLM text response against a Zod schema. */
export function validateStructuredOutput<T extends z.ZodType>(
  text: string,
  schema: T
): { success: true; data: z.infer<T> } | { success: false; error: string } {
  try {
    const { cleanContent } = processThinking(text);
    let cleanText = (cleanContent || "").trim();

    // Find JSON block if the LLM returned extra formatting markdown wrapper
    const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      cleanText = match[1].trim();
    }

    const parsed = JSON.parse(cleanText);
    const validated = schema.safeParse(parsed);
    if (validated.success) {
      return { success: true, data: validated.data };
    }
    return { success: false, error: validated.error.message };
  } catch (e: any) {
    return { success: false, error: `Invalid JSON format: ${e.message}. Raw content was: ${text}` };
  }
}
