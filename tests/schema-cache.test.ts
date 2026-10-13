import { afterEach, expect, it, vi } from "vitest";

// Count calls to z.toJSONSchema (ESM exports cannot be spied on directly).
const toJSONSchema = vi.hoisted(() => ({ calls: 0 }));
vi.mock("zod", async (importOriginal) => {
  const actual = await importOriginal<typeof import("zod")>();
  const z = Object.create(actual.z);
  z.toJSONSchema = (...args: Parameters<typeof actual.z.toJSONSchema>) => {
    toJSONSchema.calls++;
    return actual.z.toJSONSchema(...args);
  };
  return { ...actual, z };
});

const { z } = await import("zod");
const { Agent, createTool } = await import("../src/index.js");
const { completion, mockFetch } = await import("./helpers.js");

afterEach(() => vi.unstubAllGlobals());

it("builds the tool JSON schemas only once per tool set", async () => {
  mockFetch([
    completion(null, [{ name: "add", args: { a: 1, b: 1 } }]),
    completion(null, [{ name: "add", args: { a: 2, b: 2 } }]),
    completion("fini"),
  ]);
  const tool = createTool("add", "Adds", z.object({ a: z.number(), b: z.number() }), ({ a, b }) => a + b);
  const agent = new Agent({ name: "t", tools: [tool], retry: { maxRetries: 0 } });
  await agent.run("go");
  expect(toJSONSchema.calls).toBe(1);
});
