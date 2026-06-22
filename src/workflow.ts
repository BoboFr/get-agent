import { z } from "zod";

export interface WorkflowConfig<TState> {
  name: string;
  stateSchema?: z.ZodType<TState>;
  verbose?: boolean;
  maxSteps?: number;
}

export type StepFunction<TState> = (
  state: TState
) => Promise<Partial<TState> | void> | Partial<TState> | void;

export type ConditionFunction<TState> = (
  state: TState
) => string | Promise<string>;

export class Workflow<TState extends Record<string, any>> {
  private name: string;
  private stateSchema?: z.ZodType<TState>;
  private verbose: boolean;
  private maxSteps: number;

  private steps: Map<string, StepFunction<TState>> = new Map();
  private edges: Map<string, string> = new Map();
  private conditionalEdges: Map<string, ConditionFunction<TState>> = new Map();
  private startStep: string | null = null;

  constructor(config: WorkflowConfig<TState>) {
    this.name = config.name;
    this.stateSchema = config.stateSchema;
    this.verbose = config.verbose ?? false;
    this.maxSteps = config.maxSteps ?? 100;
  }

  /**
   * Adds a step function to the workflow.
   * @param name Unique name of the step.
   * @param fn Function that receives current state and returns updated state fields or void.
   */
  addStep(name: string, fn: StepFunction<TState>): this {
    if (this.steps.has(name)) {
      throw new Error(`Step '${name}' is already defined in workflow '${this.name}'.`);
    }
    this.steps.set(name, fn);
    return this;
  }

  /**
   * Defines a transition from one step to another.
   * @param from The origin step name.
   * @param to The target step name. Use '__end__' or 'END' to terminate the workflow.
   */
  addEdge(from: string, to: string): this {
    if (this.edges.has(from) || this.conditionalEdges.has(from)) {
      throw new Error(`Step '${from}' already has an outgoing edge.`);
    }
    this.edges.set(from, to);
    return this;
  }

  /**
   * Defines a conditional transition based on a function evaluating the state.
   * @param from The origin step name.
   * @param conditionFn Function that evaluates the state and returns the next step name.
   */
  addConditionalEdge(
    from: string,
    conditionFn: ConditionFunction<TState>
  ): this {
    if (this.edges.has(from) || this.conditionalEdges.has(from)) {
      throw new Error(`Step '${from}' already has an outgoing edge.`);
    }
    this.conditionalEdges.set(from, conditionFn);
    return this;
  }

  /**
   * Configures the entry step for the workflow execution.
   */
  setStart(stepName: string): this {
    this.startStep = stepName;
    return this;
  }

  /**
   * Executes the workflow beginning from the configured start step.
   * @param initialState The initial workflow state.
   */
  async run(initialState: TState): Promise<TState> {
    if (!this.startStep) {
      throw new Error(`Workflow '${this.name}' does not have a start step configured.`);
    }

    let state = { ...initialState };

    // Validate initial state if schema is provided
    if (this.stateSchema) {
      const parsed = this.stateSchema.safeParse(state);
      if (!parsed.success) {
        throw new Error(`Initial state validation failed: ${parsed.error.message}`);
      }
      state = parsed.data;
    }

    let currentStep: string | null = this.startStep;
    let stepCount = 0;

    this.log(`Starting workflow '${this.name}'`);

    while (currentStep && currentStep !== "__end__" && currentStep !== "END") {
      if (stepCount >= this.maxSteps) {
        throw new Error(
          `Workflow '${this.name}' exceeded maximum steps limit of ${this.maxSteps}. Possible infinite loop detected.`
        );
      }

      const stepFn = this.steps.get(currentStep);
      if (!stepFn) {
        throw new Error(`Step '${currentStep}' is not defined in workflow.`);
      }

      this.log(`[Step] Executing: '${currentStep}' (Step ${stepCount + 1})...`);
      
      try {
        const update = await stepFn(state);
        if (update) {
          state = { ...state, ...update };
          
          // Validate state update if schema is provided
          if (this.stateSchema) {
            const parsed = this.stateSchema.safeParse(state);
            if (!parsed.success) {
              throw new Error(`State validation failed after step '${currentStep}': ${parsed.error.message}`);
            }
            state = parsed.data;
          }
        }
      } catch (error: any) {
        this.log(`[Error] Step '${currentStep}' failed: ${error.message}`);
        throw error;
      }

      stepCount++;

      // Determine next step
      let nextStep: string | null = null;
      if (this.edges.has(currentStep)) {
        nextStep = this.edges.get(currentStep) || null;
      } else if (this.conditionalEdges.has(currentStep)) {
        const condFn: ConditionFunction<TState> = this.conditionalEdges.get(currentStep)!;
        const result: string = await condFn(state);
        nextStep = result;
      }

      if (!nextStep) {
        this.log(`No outgoing edge from step '${currentStep}'. Workflow will terminate.`);
        break;
      }

      this.log(`Transitioning from '${currentStep}' to '${nextStep}'`);
      currentStep = nextStep;
    }

    this.log(`Workflow '${this.name}' completed in ${stepCount} steps.`);
    return state;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(`\x1b[35m[Workflow: ${this.name}]\x1b[0m ${message}`);
    }
  }
}
