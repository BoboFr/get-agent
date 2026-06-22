export interface GuardrailResult {
  allowed: boolean;
  /** Explanation when blocked. */
  reason?: string;
  /** Replacement text when a sanitize guardrail transforms the input. */
  sanitized?: string;
}

export type GuardrailFn = (text: string) => GuardrailResult | Promise<GuardrailResult>;

export interface Guardrails {
  /** Applied to user input before it reaches the LLM. */
  input?: GuardrailFn[];
  /** Applied to the agent's final text response before it is returned. */
  output?: GuardrailFn[];
}

// ── Built-in guardrail factories ──────────────────────────────────────────────

/** Block input/output that exceeds a character limit. */
export function maxLength(limit: number): GuardrailFn {
  return (text) =>
    text.length <= limit
      ? { allowed: true }
      : { allowed: false, reason: `Text exceeds maximum length of ${limit} characters (got ${text.length}).` };
}

/** Block input/output matching any of the given regular expressions. */
export function blockedPatterns(patterns: RegExp[]): GuardrailFn {
  return (text) => {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return { allowed: false, reason: `Text matches blocked pattern: ${pattern}.` };
      }
    }
    return { allowed: true };
  };
}

/** Transform text before it is sent to the LLM or returned. Never blocks — only sanitizes. */
export function sanitize(fn: (text: string) => string): GuardrailFn {
  return (text) => ({ allowed: true, sanitized: fn(text) });
}

/** Strip PII-like patterns (emails, phone numbers, credit card numbers) from the text. */
export function redactPII(): GuardrailFn {
  return sanitize((text) =>
    text
      .replace(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
      .replace(/\b(?:\+?\d[\d\s\-().]{7,}\d)\b/g, "[PHONE]")
      .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD]")
  );
}
