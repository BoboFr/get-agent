import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  END,
  FileCheckpointAdapter,
  MemoryCheckpointAdapter,
  Workflow,
  WorkflowError,
} from "../src/index.js";
import type { LogEntry } from "../src/index.js";

type S = { n: number; log?: string[] };

const silent = { transport: () => {} };

function counter(config: Partial<ConstructorParameters<typeof Workflow<S>>[0]> = {}) {
  return new Workflow<S>({ name: "w", logger: silent, ...config });
}

describe("Workflow basics", () => {
  it("follows edges and conditional edges", async () => {
    const wf = new Workflow<{ n: number }>({ name: "w", stateSchema: z.object({ n: z.number() }) })
      .addStep("inc", (s) => ({ n: s.n + 1 }))
      .addConditionalEdge("inc", (s) => (s.n < 3 ? "inc" : "END"))
      .setStart("inc");
    expect(await wf.run({ n: 0 })).toEqual({ n: 3 });
  });

  it("still accepts the __end__ alias and stops when there is no edge", async () => {
    const wf = counter()
      .addStep("a", (s) => ({ n: s.n + 1 }))
      .addStep("b", (s) => ({ n: s.n * 10 }))
      .addEdge("a", "__end__")
      .setStart("a");
    expect(await wf.run({ n: 1 })).toEqual({ n: 2 });
    expect(await counter().addStep("a", () => ({ n: 5 })).setStart("a").run({ n: 0 })).toEqual({ n: 5 });
  });

  it("stops runaway loops", async () => {
    const wf = counter({ maxSteps: 5 }).addStep("loop", () => {}).addEdge("loop", "loop").setStart("loop");
    const err = await wf.run({ n: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.message).toMatch(/maximum steps limit of 5/);
  });
});

describe("graph validation", () => {
  it("rejects an invalid graph before running any step", async () => {
    const first = vi.fn();
    const wf = counter()
      .addStep("a", first)
      .addEdge("a", "missing")
      .addEdge("ghost", "a")
      .setStart("a");
    const err = await wf.run({ n: 0 }).catch((e) => e);
    expect(first).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.message).toContain("step 'missing' is not defined");
    expect(err.message).toContain("edge from undefined step 'ghost'");
  });

  it("requires a valid start step", () => {
    expect(() => counter().addStep("a", () => {}).validate()).toThrow(/no start step/);
    expect(() => counter().addStep("a", () => {}).setStart("b").validate()).toThrow(/start step 'b' is not defined/);
  });

  it("reserves END as a step name", () => {
    expect(() => counter().addStep(END, () => {})).toThrow(/reserved/);
    expect(() => counter().addStep("__end__", () => {})).toThrow(/reserved/);
  });

  it("checks declared conditional targets statically and at runtime", async () => {
    expect(() =>
      counter().addStep("a", () => {}).addConditionalEdge("a", () => END, ["nope"]).setStart("a").validate()
    ).toThrow(/step 'nope' is not defined/);

    const wf = counter()
      .addStep("a", () => {})
      .addStep("b", () => {})
      .addStep("c", () => {})
      .addConditionalEdge("a", () => "c", ["b", END])
      .addEdge("b", END)
      .addEdge("c", END)
      .setStart("a");
    await expect(wf.run({ n: 0 })).rejects.toThrow(/Condition of step 'a' returned 'c', which is not one of its declared targets: b, END/);
  });

  it("reports an undefined step returned by a condition", async () => {
    const wf = counter().addStep("a", () => {}).addConditionalEdge("a", () => "zzz").setStart("a");
    await expect(wf.run({ n: 0 })).rejects.toThrow(/Condition of step 'a' returned 'zzz', which is not a defined step/);
  });

  it("warns about unreachable steps", () => {
    const entries: LogEntry[] = [];
    new Workflow<S>({ name: "w", logger: { transport: (e) => entries.push(e) } })
      .addStep("a", () => {})
      .addStep("orphan", () => {})
      .addEdge("a", END)
      .setStart("a")
      .validate();
    expect(entries.map((e) => e.message)).toContain("Unreachable step(s) in workflow 'w': orphan.");
  });
});

describe("errors and strict mode", () => {
  it("wraps step failures with the step, state and cause", async () => {
    const boom = new Error("boom");
    const wf = counter()
      .addStep("a", () => ({ n: 1 }))
      .addStep("b", () => { throw boom; })
      .addEdge("a", "b")
      .setStart("a");
    const err: WorkflowError = await wf.run({ n: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowError);
    expect(err.message).toBe("Step 'b' failed: boom");
    expect(err).toMatchObject({ workflow: "w", step: "b", stepCount: 1, state: { n: 1 } });
    expect(err.cause).toBe(boom);
  });

  it("requires explicit edges in strict mode", () => {
    expect(() => counter({ strict: true }).addStep("a", () => {}).setStart("a").validate()).toThrow(/no outgoing edge/);
  });

  it("freezes the state in strict mode", async () => {
    const wf = counter({ strict: true })
      .addStep("a", (s) => { s.n = 99; })
      .addEdge("a", END)
      .setStart("a");
    await expect(wf.run({ n: 0 })).rejects.toThrow(/Step 'a' failed: Cannot assign to read only property/);
  });

  it("warns when the schema drops keys returned by a step", async () => {
    const entries: LogEntry[] = [];
    const wf = new Workflow<{ n: number }>({
      name: "w",
      stateSchema: z.object({ n: z.number() }),
      logger: { transport: (e) => entries.push(e) },
    })
      .addStep("a", () => ({ n: 1, extra: true } as any))
      .setStart("a");
    expect(await wf.run({ n: 0 })).toEqual({ n: 1 });
    expect(entries.some((e) => e.level === "warn" && e.message.includes("dropped: extra"))).toBe(true);
  });
});

describe("Workflow.fromSchema", () => {
  it("makes fields with defaults optional in the initial state", async () => {
    const wf = Workflow.fromSchema(
      z.object({ question: z.string(), tries: z.number().default(0), tags: z.array(z.string()).default([]) }),
      { name: "w" }
    )
      .addStep("a", (s) => ({ tries: s.tries + 1 }))
      .setStart("a");
    expect(await wf.run({ question: "?" })).toEqual({ question: "?", tries: 1, tags: [] });
  });
});

describe("validate modes", () => {
  it("only parses the initial and final state with validate: 'end'", async () => {
    const schema = z.object({ n: z.number() });
    const spy = vi.spyOn(schema, "safeParse");
    const wf = new Workflow<{ n: number }>({ name: "w", stateSchema: schema, validate: "end" })
      .addStep("a", (s) => ({ n: s.n + 1 }))
      .addConditionalEdge("a", (s) => (s.n < 5 ? "a" : END))
      .setStart("a");
    expect(await wf.run({ n: 0 })).toEqual({ n: 5 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never parses with validate: 'none'", async () => {
    const schema = z.object({ n: z.number() });
    const spy = vi.spyOn(schema, "safeParse");
    await new Workflow<{ n: number }>({ name: "w", stateSchema: schema, validate: "none" })
      .addStep("a", () => ({ n: 1 }))
      .setStart("a")
      .run({ n: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parallel steps", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("runs branches concurrently and merges their updates", async () => {
    const events: string[] = [];
    const wf = new Workflow<{ q: string; a?: string; b?: string; done?: boolean }>({ name: "p", logger: silent })
      .addParallelStep("fanout", {
        a: async (s) => { events.push("a:start"); await tick(); events.push("a:end"); return { a: s.q + "A" }; },
        b: async (s) => { events.push("b:start"); await tick(); events.push("b:end"); return { b: s.q + "B" }; },
      })
      .addStep("join", () => ({ done: true }))
      .addEdge("fanout", "join")
      .addEdge("join", END)
      .setStart("fanout");

    expect(await wf.run({ q: "x" })).toEqual({ q: "x", a: "xA", b: "xB", done: true });
    expect(events.slice(0, 2).sort()).toEqual(["a:start", "b:start"]);
  });

  it("rejects conflicting keys unless a merge function is given", async () => {
    const branches = { a: () => ({ n: 1 }), b: () => ({ n: 2 }) };
    await expect(
      counter().addParallelStep("p", branches).setStart("p").run({ n: 0 })
    ).rejects.toThrow(/branches 'a' and 'b' both update 'n'/);

    const merged = await counter()
      .addParallelStep("p", branches, { merge: (u) => ({ n: (u.a.n ?? 0) + (u.b.n ?? 0) }) })
      .setStart("p")
      .run({ n: 0 });
    expect(merged).toEqual({ n: 3 });
  });

  it("aborts sibling branches when one fails and names the branch", async () => {
    let siblingAborted = false;
    const wf = counter()
      .addParallelStep("p", {
        slow: async (_s, ctx) => {
          await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
          siblingAborted = true;
        },
        fail: async () => { await tick(); throw new Error("kaput"); },
      })
      .setStart("p");
    await expect(wf.run({ n: 0 })).rejects.toThrow(/Branch 'fail' of parallel step 'p' failed: kaput/);
    expect(siblingAborted).toBe(true);
  });

  it("passes a frozen snapshot to branches", async () => {
    const wf = counter().addParallelStep("p", { a: (s) => { s.n = 1; } }).setStart("p");
    await expect(wf.run({ n: 0 })).rejects.toThrow(/read only/);
  });
});

describe("retries, timeouts and abort", () => {
  it("retries a failing step", async () => {
    let calls = 0;
    const attempts: number[] = [];
    const wf = counter()
      .addStep("flaky", (_s, ctx) => {
        attempts.push(ctx.attempt);
        if (++calls < 3) throw new Error("pas encore");
        return { n: calls };
      }, { retries: 2 })
      .setStart("flaky");
    const { state, trace } = await wf.runWithTrace({ n: 0 });
    expect(state).toEqual({ n: 3 });
    expect(attempts).toEqual([1, 2, 3]);
    expect(trace[0].attempts).toBe(3);
  });

  it("gives up after the last retry", async () => {
    const wf = counter().addStep("ko", () => { throw new Error("non"); }, { retries: 1 }).setStart("ko");
    await expect(wf.run({ n: 0 })).rejects.toThrow("Step 'ko' failed: non");
  });

  it("times out a step and aborts its signal", async () => {
    let signalAborted = false;
    const wf = counter()
      .addStep("slow", (_s, ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => { signalAborted = true; resolve(); });
        setTimeout(resolve, 1000);
      }), { timeoutMs: 10 })
      .setStart("slow");
    await expect(wf.run({ n: 0 })).rejects.toThrow(/timed out after 10ms/);
    expect(signalAborted).toBe(true);
  });

  it("stops when the run signal is aborted", async () => {
    const controller = new AbortController();
    const second = vi.fn();
    const wf = counter()
      .addStep("a", () => { controller.abort(); })
      .addStep("b", second)
      .addEdge("a", "b")
      .setStart("a");
    await expect(wf.run({ n: 0 }, { signal: controller.signal })).rejects.toThrow(/aborted before step 'b'/);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("hooks and trace", () => {
  it("calls hooks in order and returns a trace", async () => {
    const calls: string[] = [];
    const wf = counter({
      hooks: {
        onStepStart: (step) => { calls.push(`start:${step}`); },
        onStepEnd: (step, { state }) => { calls.push(`end:${step}:${state.n}`); },
        onError: (step, err) => { calls.push(`error:${step}:${err.message}`); },
      },
    })
      .addStep("a", () => ({ n: 1 }))
      .addStep("b", () => { throw new Error("x"); })
      .addEdge("a", "b")
      .setStart("a");
    await wf.run({ n: 0 }).catch(() => {});
    expect(calls).toEqual(["start:a", "end:a:1", "start:b", "error:b:Step 'b' failed: x"]);

    const ok = counter().addStep("a", () => ({ n: 1 })).addStep("b", () => {}).addEdge("a", "b").setStart("a");
    const { trace } = await ok.runWithTrace({ n: 0 });
    expect(trace.map(({ step, update, next, attempts }) => ({ step, update, next, attempts }))).toEqual([
      { step: "a", update: { n: 1 }, next: "b", attempts: 1 },
      { step: "b", update: undefined, next: null, attempts: 1 },
    ]);
    expect(trace[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("checkpoints", () => {
  function pipeline(checkpoint: MemoryCheckpointAdapter<S> | FileCheckpointAdapter<S>, failAtC: { value: boolean }) {
    return counter({ checkpoint })
      .addStep("a", (s) => ({ log: [...(s.log ?? []), "a"] }))
      .addStep("b", (s) => ({ log: [...(s.log ?? []), "b"] }))
      .addStep("c", (s) => {
        if (failAtC.value) throw new Error("crash");
        return { log: [...(s.log ?? []), "c"] };
      })
      .addEdge("a", "b")
      .addEdge("b", "c")
      .addEdge("c", END)
      .setStart("a");
  }

  it("resumes a failed run from the last completed step", async () => {
    const checkpoint = new MemoryCheckpointAdapter<S>();
    const fail = { value: true };
    const wf = pipeline(checkpoint, fail);

    await expect(wf.run({ n: 0 }, { runId: "r1" })).rejects.toThrow(/crash/);
    expect(await checkpoint.load("r1")).toMatchObject({ nextStep: "c", stepCount: 2, state: { log: ["a", "b"] } });

    fail.value = false;
    const { state, trace } = await wf.resume("r1");
    expect(state.log).toEqual(["a", "b", "c"]);
    expect(trace.map((t) => t.step)).toEqual(["c"]);
    expect(await checkpoint.load("r1")).toMatchObject({ nextStep: null, stepCount: 3 });

    // A completed run returns its final state without running anything.
    expect((await wf.resume("r1")).state.log).toEqual(["a", "b", "c"]);
  });

  it("persists checkpoints to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "get-agent-wf-"));
    try {
      const fail = { value: true };
      await pipeline(new FileCheckpointAdapter<S>(dir), fail).run({ n: 0 }, { runId: "disk" }).catch(() => {});
      fail.value = false;
      // A fresh workflow instance (e.g. after a process restart) picks the run up.
      const { state } = await pipeline(new FileCheckpointAdapter<S>(dir), fail).resume("disk");
      expect(state.log).toEqual(["a", "b", "c"]);
      await expect(new FileCheckpointAdapter(dir).load("../x")).rejects.toThrow(/Invalid run id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects resume without adapter, unknown run or another workflow", async () => {
    await expect(counter().addStep("a", () => {}).setStart("a").resume("x")).rejects.toThrow(/no checkpoint adapter/);
    const checkpoint = new MemoryCheckpointAdapter<S>();
    const wf = counter({ checkpoint }).addStep("a", () => {}).setStart("a");
    await expect(wf.resume("absent")).rejects.toThrow(/No checkpoint found for run 'absent'/);
    await checkpoint.save({ runId: "o", workflow: "other", nextStep: "a", state: { n: 0 }, stepCount: 0, updatedAt: "" });
    await expect(wf.resume("o")).rejects.toThrow(/belongs to workflow 'other'/);
  });
});
