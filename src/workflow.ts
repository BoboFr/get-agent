import { z } from "zod";
import { Logger } from "./logger.js";
import type { LoggerConfig } from "./logger.js";
import type { CheckpointAdapter } from "./checkpoint.js";

/** Target name that terminates the workflow. `"__end__"` is accepted as an alias. */
export const END = "END";
const END_ALIASES = new Set([END, "__end__"]);
const isEnd = (step: string) => END_ALIASES.has(step);

export interface StepContext {
  /** Aborted when the run is aborted, the step times out, or a sibling parallel branch fails. */
  signal: AbortSignal;
  /** Name of the step being executed. */
  step: string;
  /** Number of steps completed before this one. */
  stepCount: number;
  /** 1 for the first attempt, 2 for the first retry, etc. */
  attempt: number;
  /** Branch name, inside a parallel step. */
  branch?: string;
}

export type StepFunction<TState> = (
  state: TState,
  ctx: StepContext
) => Promise<Partial<TState> | void> | Partial<TState> | void;

export type ConditionFunction<TState> = (
  state: TState
) => string | Promise<string>;

export interface StepOptions {
  /** Number of retries after a failed attempt. Default: 0. */
  retries?: number;
  /** Delay in ms between attempts. Default: 0. */
  retryDelayMs?: number;
  /**
   * Max duration of one attempt in ms. On timeout the step's signal is aborted and the
   * attempt fails; a step that ignores its signal keeps running in the background.
   */
  timeoutMs?: number;
}

export interface ParallelStepOptions<TState> extends StepOptions {
  /**
   * Combines the branch updates (keyed by branch name). By default updates are
   * merged in declaration order and two branches writing the same key is an error.
   */
  merge?: (updates: Record<string, Partial<TState>>, state: TState) => Partial<TState>;
}

export interface WorkflowHooks<TState> {
  onStepStart?: (step: string, state: TState) => void | Promise<void>;
  onStepEnd?: (
    step: string,
    info: { update: Partial<TState> | undefined; state: TState; durationMs: number; attempts: number }
  ) => void | Promise<void>;
  onError?: (step: string, error: Error, state: TState) => void | Promise<void>;
}

export interface WorkflowConfig<TState> {
  name: string;
  /** Zod schema of the state. Its input type may differ from TState (e.g. fields with defaults). */
  stateSchema?: z.ZodType<TState, any>;
  verbose?: boolean;
  maxSteps?: number;
  /**
   * Strict mode: every step needs an outgoing edge (use END to finish), and steps
   * receive a frozen state so in-place mutation throws. Default: false.
   */
  strict?: boolean;
  /**
   * When the state schema runs: after every step (default), only on the initial and
   * final state ("end"), or never ("none").
   */
  validate?: "each-step" | "end" | "none";
  /** Structured logger config. Overrides verbose when set. */
  logger?: LoggerConfig;
  hooks?: WorkflowHooks<TState>;
  /** Persists the state after each step for runs started with a `runId`. */
  checkpoint?: CheckpointAdapter<TState>;
}

export interface WorkflowRunOptions {
  /** Aborts the run when signalled. */
  signal?: AbortSignal;
  /** Identifier used to save checkpoints (requires the `checkpoint` config). */
  runId?: string;
}

export interface StepTrace<TState> {
  step: string;
  durationMs: number;
  attempts: number;
  update: Partial<TState> | undefined;
  /** Step chosen next, or null when the workflow ended. */
  next: string | null;
}

export interface WorkflowResult<TState> {
  state: TState;
  trace: StepTrace<TState>[];
}

/** Error raised by a workflow, with the step and state at the time of failure. */
export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly workflow: string,
    public readonly step: string | null,
    public readonly stepCount: number,
    public readonly state: unknown,
    cause?: unknown
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "WorkflowError";
  }
}

type WorkflowNode<TState> =
  | { kind: "step"; fn: StepFunction<TState>; options: StepOptions }
  | { kind: "parallel"; branches: Record<string, StepFunction<TState>>; options: ParallelStepOptions<TState> };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Rejects when the signal aborts; never settles otherwise. */
function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort = () => {};
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

export class Workflow<TState extends Record<string, any>, TInput = TState> {
  private name: string;
  private stateSchema?: z.ZodType<TState, any>;
  private maxSteps: number;
  private strict: boolean;
  private validateMode: "each-step" | "end" | "none";
  private hooks: WorkflowHooks<TState>;
  private checkpoint?: CheckpointAdapter<TState>;
  private logger: Logger;

  private nodes: Map<string, WorkflowNode<TState>> = new Map();
  private edges: Map<string, string> = new Map();
  private conditionalEdges: Map<string, { fn: ConditionFunction<TState>; targets?: string[] }> = new Map();
  private startStep: string | null = null;
  /** True once validate() succeeded for the current graph. */
  private validated = false;

  constructor(config: WorkflowConfig<TState>) {
    this.name = config.name;
    this.stateSchema = config.stateSchema;
    this.maxSteps = config.maxSteps ?? 100;
    this.strict = config.strict ?? false;
    this.validateMode = config.validate ?? "each-step";
    this.hooks = config.hooks ?? {};
    this.checkpoint = config.checkpoint;
    this.logger = new Logger(`Workflow: ${config.name}`, {
      level: config.logger?.level ?? (config.verbose ? "debug" : "warn"),
      format: config.logger?.format,
      transport: config.logger?.transport,
    });
  }

  /**
   * Creates a workflow typed from its state schema: `run()` then accepts the schema's
   * input type, so fields with a `.default()` can be omitted.
   */
  static fromSchema<S extends z.ZodType<Record<string, any>, any>>(
    schema: S,
    config: Omit<WorkflowConfig<z.output<S>>, "stateSchema">
  ): Workflow<z.output<S>, z.input<S>> {
    return new Workflow<z.output<S>, z.input<S>>({ ...config, stateSchema: schema as unknown as z.ZodType<z.output<S>, any> });
  }

  /**
   * Adds a step function to the workflow.
   * @param name Unique name of the step.
   * @param fn Function that receives current state and returns updated state fields or void.
   * @param options Retry and timeout options.
   */
  addStep(name: string, fn: StepFunction<TState>, options: StepOptions = {}): this {
    this.assertNewStep(name);
    this.nodes.set(name, { kind: "step", fn, options });
    this.validated = false;
    return this;
  }

  /**
   * Adds a step whose branches run concurrently on the same state snapshot.
   * Their updates are merged (see `ParallelStepOptions.merge`) before moving on.
   */
  addParallelStep(
    name: string,
    branches: Record<string, StepFunction<TState>>,
    options: ParallelStepOptions<TState> = {}
  ): this {
    this.assertNewStep(name);
    if (Object.keys(branches).length === 0) {
      throw new Error(`Parallel step '${name}' needs at least one branch.`);
    }
    this.nodes.set(name, { kind: "parallel", branches, options });
    this.validated = false;
    return this;
  }

  /**
   * Defines a transition from one step to another.
   * @param from The origin step name.
   * @param to The target step name. Use END (or '__end__') to terminate the workflow.
   */
  addEdge(from: string, to: string): this {
    this.assertNoOutgoingEdge(from);
    this.edges.set(from, to);
    this.validated = false;
    return this;
  }

  /**
   * Defines a conditional transition based on a function evaluating the state.
   * @param from The origin step name.
   * @param conditionFn Function that evaluates the state and returns the next step name.
   * @param targets Optional list of the steps the condition may return. When given, the
   *   targets are checked by validate() and any other returned value is an error.
   */
  addConditionalEdge(
    from: string,
    conditionFn: ConditionFunction<TState>,
    targets?: string[]
  ): this {
    this.assertNoOutgoingEdge(from);
    this.conditionalEdges.set(from, { fn: conditionFn, targets });
    this.validated = false;
    return this;
  }

  /**
   * Configures the entry step for the workflow execution.
   */
  setStart(stepName: string): this {
    this.startStep = stepName;
    this.validated = false;
    return this;
  }

  /**
   * Checks the graph: start step, edge sources and targets, declared conditional targets
   * and (in strict mode) outgoing edges. Throws a WorkflowError listing every problem.
   * Called automatically before the first run.
   */
  validate(): this {
    if (this.validated) return this;
    const problems: string[] = [];
    const checkTarget = (from: string, to: string) => {
      if (!isEnd(to) && !this.nodes.has(to)) problems.push(`edge '${from}' → '${to}': step '${to}' is not defined`);
    };

    if (!this.startStep) problems.push("no start step configured (call setStart)");
    else if (!this.nodes.has(this.startStep)) problems.push(`start step '${this.startStep}' is not defined`);

    for (const [from, to] of this.edges) {
      if (!this.nodes.has(from)) problems.push(`edge from undefined step '${from}'`);
      checkTarget(from, to);
    }
    for (const [from, { targets }] of this.conditionalEdges) {
      if (!this.nodes.has(from)) problems.push(`conditional edge from undefined step '${from}'`);
      for (const to of targets ?? []) checkTarget(from, to);
    }
    if (this.strict) {
      for (const name of this.nodes.keys()) {
        if (!this.edges.has(name) && !this.conditionalEdges.has(name)) {
          problems.push(`step '${name}' has no outgoing edge (strict mode: add an edge to END)`);
        }
      }
    }

    if (problems.length > 0) {
      throw new WorkflowError(
        `Workflow '${this.name}' is invalid:\n- ${problems.join("\n- ")}`,
        this.name, null, 0, undefined
      );
    }

    this.warnUnreachableSteps();
    this.validated = true;
    return this;
  }

  /**
   * Executes the workflow beginning from the configured start step.
   * @param initialState The initial workflow state.
   */
  async run(initialState: TInput, options: WorkflowRunOptions = {}): Promise<TState> {
    return (await this.runWithTrace(initialState, options)).state;
  }

  /** Like run(), but also returns the executed steps with their duration and update. */
  async runWithTrace(initialState: TInput, options: WorkflowRunOptions = {}): Promise<WorkflowResult<TState>> {
    this.validate();
    const state = this.validateInitial({ ...initialState } as unknown as TState, "Initial state");
    return this.execute(state, this.startStep!, 0, options);
  }

  /**
   * Resumes a run from its last checkpoint. A completed run returns its final state.
   * @param runId The id passed to run() / runWithTrace().
   */
  async resume(runId: string, options: Omit<WorkflowRunOptions, "runId"> = {}): Promise<WorkflowResult<TState>> {
    if (!this.checkpoint) {
      throw new WorkflowError(`Workflow '${this.name}' has no checkpoint adapter configured.`, this.name, null, 0, undefined);
    }
    this.validate();
    const saved = await this.checkpoint.load(runId);
    if (!saved) {
      throw new WorkflowError(`No checkpoint found for run '${runId}'.`, this.name, null, 0, undefined);
    }
    if (saved.workflow !== this.name) {
      throw new WorkflowError(
        `Checkpoint '${runId}' belongs to workflow '${saved.workflow}', not '${this.name}'.`,
        this.name, null, saved.stepCount, saved.state
      );
    }
    if (saved.nextStep === null) return { state: saved.state, trace: [] };
    if (!this.nodes.has(saved.nextStep)) {
      throw new WorkflowError(
        `Checkpoint '${runId}' resumes at step '${saved.nextStep}', which is not defined.`,
        this.name, saved.nextStep, saved.stepCount, saved.state
      );
    }

    this.log(`Resuming run '${runId}' at step '${saved.nextStep}' (after ${saved.stepCount} steps)`);
    const state = this.validateInitial(saved.state, "Checkpoint state");
    return this.execute(state, saved.nextStep, saved.stepCount, { ...options, runId });
  }

  private async execute(
    initial: TState,
    startStep: string,
    initialStepCount: number,
    options: WorkflowRunOptions
  ): Promise<WorkflowResult<TState>> {
    const { signal, runId } = options;
    const trace: StepTrace<TState>[] = [];
    let state = initial;
    let stepCount = initialStepCount;
    let currentStep: string | null = startStep;

    this.log(`Starting workflow '${this.name}'`);

    while (currentStep && !isEnd(currentStep)) {
      const step: string = currentStep;
      if (signal?.aborted) {
        throw this.error(`Workflow '${this.name}' was aborted before step '${step}'.`, step, stepCount, state, signal.reason);
      }
      if (stepCount >= this.maxSteps) {
        throw this.error(
          `Workflow '${this.name}' exceeded maximum steps limit of ${this.maxSteps}. Possible infinite loop detected.`,
          step, stepCount, state
        );
      }

      const node = this.nodes.get(step);
      if (!node) {
        throw this.error(`Step '${step}' is not defined in workflow.`, step, stepCount, state);
      }

      this.log(`[Step] Executing: '${step}' (Step ${stepCount + 1})...`);
      const startedAt = performance.now();
      await this.hooks.onStepStart?.(step, state);

      let update: Partial<TState> | undefined;
      let attempts: number;
      try {
        ({ update, attempts } = await this.runNode(step, node, state, stepCount, signal));
        if (update) state = this.applyUpdate(state, update, step, stepCount);
      } catch (err: any) {
        const error = err instanceof WorkflowError
          ? err
          : this.error(`Step '${step}' failed: ${errorMessage(err)}`, step, stepCount, state, err);
        this.logger.error(error.message);
        await this.hooks.onError?.(step, error, state);
        throw error;
      }

      stepCount++;
      const durationMs = performance.now() - startedAt;
      await this.hooks.onStepEnd?.(step, { update, state, durationMs, attempts });

      const nextStep = await this.resolveNext(step, state, stepCount);
      trace.push({ step, durationMs, attempts, update, next: nextStep });

      if (this.checkpoint && runId) {
        await this.checkpoint.save({
          runId,
          workflow: this.name,
          nextStep: nextStep && !isEnd(nextStep) ? nextStep : null,
          state,
          stepCount,
          updatedAt: new Date().toISOString(),
        });
      }

      if (!nextStep) {
        if (this.strict) {
          throw this.error(`Step '${step}' has no outgoing edge (strict mode).`, step, stepCount, state);
        }
        this.log(`No outgoing edge from step '${step}'. Workflow will terminate.`);
        break;
      }

      this.log(`Transitioning from '${step}' to '${nextStep}'`);
      currentStep = nextStep;
    }

    if (this.stateSchema && this.validateMode === "end") {
      state = this.parseState(state, "Final state", null, stepCount);
      if (this.checkpoint && runId) {
        await this.checkpoint.save({
          runId, workflow: this.name, nextStep: null, state, stepCount, updatedAt: new Date().toISOString(),
        });
      }
    }

    this.log(`Workflow '${this.name}' completed in ${stepCount} steps.`);
    return { state, trace };
  }

  /** Runs one node with retries and timeout. */
  private async runNode(
    step: string,
    node: WorkflowNode<TState>,
    state: TState,
    stepCount: number,
    runSignal: AbortSignal | undefined
  ): Promise<{ update: Partial<TState> | undefined; attempts: number }> {
    const { retries = 0, retryDelayMs = 0, timeoutMs } = node.options;
    let lastError: unknown;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const controller = new AbortController();
      const signal = runSignal ? AbortSignal.any([runSignal, controller.signal]) : controller.signal;
      const timer = timeoutMs
        ? setTimeout(
            () => controller.abort(new Error(`Step '${step}' timed out after ${timeoutMs}ms.`)),
            timeoutMs
          )
        : undefined;
      const aborted = abortPromise(signal);

      try {
        const ctx: StepContext = { signal, step, stepCount, attempt };
        const work = node.kind === "step"
          ? Promise.resolve(node.fn(this.strict ? Object.freeze({ ...state }) : state, ctx))
          : this.runParallel(step, node, state, ctx, stepCount);
        work.catch(() => {}); // the race below may settle first
        const update = await Promise.race([work, aborted.promise]);
        return { update: update || undefined, attempts: attempt };
      } catch (err) {
        lastError = err;
        if (runSignal?.aborted || attempt > retries) break;
        this.logger.warn(`Step '${step}' failed (attempt ${attempt}/${retries + 1}): ${errorMessage(err)}. Retrying...`);
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      } finally {
        clearTimeout(timer);
        aborted.dispose();
      }
    }
    throw lastError;
  }

  private async runParallel(
    step: string,
    node: Extract<WorkflowNode<TState>, { kind: "parallel" }>,
    state: TState,
    ctx: StepContext,
    stepCount: number
  ): Promise<Partial<TState>> {
    const snapshot = Object.freeze({ ...state }) as TState;
    const siblings = new AbortController();
    const signal = AbortSignal.any([ctx.signal, siblings.signal]);

    const entries = await Promise.all(
      Object.entries(node.branches).map(async ([branch, fn]) => {
        try {
          return [branch, (await fn(snapshot, { ...ctx, signal, branch })) || {}] as const;
        } catch (err) {
          siblings.abort(err);
          throw this.error(
            `Branch '${branch}' of parallel step '${step}' failed: ${errorMessage(err)}`,
            step, stepCount, state, err
          );
        }
      })
    );
    const updates = Object.fromEntries(entries) as Record<string, Partial<TState>>;

    if (node.options.merge) return node.options.merge(updates, snapshot);

    const owner = new Map<string, string>();
    const merged: Partial<TState> = {};
    for (const [branch, update] of entries) {
      for (const key of Object.keys(update)) {
        const previous = owner.get(key);
        if (previous) {
          throw this.error(
            `Parallel step '${step}': branches '${previous}' and '${branch}' both update '${key}'. Provide a merge function.`,
            step, stepCount, state
          );
        }
        owner.set(key, branch);
      }
      Object.assign(merged, update);
    }
    return merged;
  }

  private async resolveNext(step: string, state: TState, stepCount: number): Promise<string | null> {
    const edge = this.edges.get(step);
    if (edge !== undefined) return edge;

    const conditional = this.conditionalEdges.get(step);
    if (!conditional) return null;

    let target: string;
    try {
      target = await conditional.fn(state);
    } catch (err) {
      throw this.error(`Condition of step '${step}' failed: ${errorMessage(err)}`, step, stepCount, state, err);
    }
    if (!target) return null;

    const declared = conditional.targets;
    if (!isEnd(target) && (declared ? !declared.includes(target) : !this.nodes.has(target))) {
      throw this.error(
        declared
          ? `Condition of step '${step}' returned '${target}', which is not one of its declared targets: ${declared.join(", ")}.`
          : `Condition of step '${step}' returned '${target}', which is not a defined step.`,
        step, stepCount, state
      );
    }
    return target;
  }

  private applyUpdate(state: TState, update: Partial<TState>, step: string, stepCount: number): TState {
    const merged = { ...state, ...update };
    if (!this.stateSchema || this.validateMode !== "each-step") return merged;

    const parsed = this.parseState(merged, `State validation failed after step '${step}'`, step, stepCount);
    const dropped = Object.keys(update).filter((key) => !(key in parsed));
    if (dropped.length > 0) {
      this.logger.warn(`Step '${step}' returned keys not in the state schema, dropped: ${dropped.join(", ")}.`);
    }
    return parsed;
  }

  private validateInitial(state: TState, label: string): TState {
    if (!this.stateSchema || this.validateMode === "none") return state;
    return this.parseState(state, `${label} validation failed`, null, 0);
  }

  private parseState(state: unknown, label: string, step: string | null, stepCount: number): TState {
    const parsed = this.stateSchema!.safeParse(state);
    if (!parsed.success) {
      throw this.error(`${label}: ${parsed.error.message}`, step, stepCount, state);
    }
    return parsed.data;
  }

  private assertNewStep(name: string): void {
    if (isEnd(name)) {
      throw new Error(`'${name}' is reserved to terminate the workflow and cannot be used as a step name.`);
    }
    if (this.nodes.has(name)) {
      throw new Error(`Step '${name}' is already defined in workflow '${this.name}'.`);
    }
  }

  private assertNoOutgoingEdge(from: string): void {
    if (this.edges.has(from) || this.conditionalEdges.has(from)) {
      throw new Error(`Step '${from}' already has an outgoing edge.`);
    }
  }

  /** Warns about steps that cannot be reached (skipped when a condition has undeclared targets). */
  private warnUnreachableSteps(): void {
    if (!this.startStep) return;
    const reachable = new Set<string>();
    const queue = [this.startStep];
    while (queue.length > 0) {
      const step = queue.pop()!;
      if (reachable.has(step) || isEnd(step)) continue;
      reachable.add(step);
      const edge = this.edges.get(step);
      if (edge) queue.push(edge);
      const conditional = this.conditionalEdges.get(step);
      if (conditional) {
        if (!conditional.targets) return; // any step may be reachable
        queue.push(...conditional.targets);
      }
    }
    const unreachable = [...this.nodes.keys()].filter((name) => !reachable.has(name));
    if (unreachable.length > 0) {
      this.logger.warn(`Unreachable step(s) in workflow '${this.name}': ${unreachable.join(", ")}.`);
    }
  }

  private error(message: string, step: string | null, stepCount: number, state: unknown, cause?: unknown): WorkflowError {
    return new WorkflowError(message, this.name, step, stepCount, state, cause);
  }

  private log(message: string): void {
    this.logger.debug(message);
  }
}
