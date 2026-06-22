import { z } from "zod";
import { Tool } from "./types.js";

/** Unwraps optional/default/nullable wrappers to reach the underlying Zod type. */
function unwrap(def: z.ZodType): z.ZodType {
  let current: any = def;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable
  ) {
    current = current._def.innerType;
  }
  return current;
}

/**
 * Coerces top-level string arguments to the primitive type the schema expects.
 * Local models frequently emit tool arguments as strings ("250", "true") even
 * when a number or boolean is required. Coercion is conservative: it only acts
 * when the value cleanly converts, otherwise the original value is kept and Zod
 * reports the validation error as usual.
 */
function coercePrimitives<T extends z.ZodObject<any>>(schema: T, args: any): any {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const shape: Record<string, z.ZodType> = schema.shape;
  const out: Record<string, any> = { ...args };

  for (const key of Object.keys(shape)) {
    if (!(key in out)) continue;
    const field = unwrap(shape[key]);
    const value = out[key];
    if (typeof value !== "string") continue;

    if (field instanceof z.ZodNumber) {
      const n = Number(value);
      if (value.trim() !== "" && !Number.isNaN(n)) out[key] = n;
    } else if (field instanceof z.ZodBoolean) {
      const v = value.trim().toLowerCase();
      if (v === "true") out[key] = true;
      else if (v === "false") out[key] = false;
    }
  }
  return out;
}

/**
 * Creates a validated tool helper.
 * @param name The name of the tool. Must be alphanumeric (underscores allowed) for LLM usage.
 * @param description A clear description of what the tool does.
 * @param schema A Zod schema representing the tool's input parameters.
 * @param execute The function to run when the tool is called.
 */
export function createTool<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  schema: T,
  execute: (args: z.infer<T>) => Promise<any> | any
): Tool<z.infer<T>> {
  // Validate tool name structure (some LLMs are strict about naming, e.g. no special chars except underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tool name '${name}'. Tool names must be alphanumeric with dashes or underscores.`);
  }

  return {
    name,
    description,
    schema,
    execute: async (args: any) => {
      // Coerce common string→primitive mismatches, then validate with Zod.
      const coerced = coercePrimitives(schema, args);
      const parsedArgs = schema.safeParse(coerced);
      if (!parsedArgs.success) {
        throw new Error(`Validation failed for tool '${name}': ${parsedArgs.error.message}`);
      }
      return execute(parsedArgs.data);
    },
  };
}
