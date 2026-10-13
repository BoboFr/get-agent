import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId, writeJsonAtomic } from "./fs-utils.js";

/** Snapshot of a workflow run, saved after each step. */
export interface WorkflowCheckpoint<TState = any> {
  runId: string;
  workflow: string;
  /** Step to execute next, or null when the run has completed. */
  nextStep: string | null;
  state: TState;
  stepCount: number;
  /** ISO timestamp of the save. */
  updatedAt: string;
}

export interface CheckpointAdapter<TState = any> {
  save(checkpoint: WorkflowCheckpoint<TState>): Promise<void>;
  load(runId: string): Promise<WorkflowCheckpoint<TState> | null>;
  clear?(runId: string): Promise<void>;
}

/** Keeps checkpoints in memory (useful for tests and short-lived processes). */
export class MemoryCheckpointAdapter<TState = any> implements CheckpointAdapter<TState> {
  private store = new Map<string, WorkflowCheckpoint<TState>>();

  async save(checkpoint: WorkflowCheckpoint<TState>): Promise<void> {
    // Clone so later in-place changes to the state do not alter the checkpoint.
    this.store.set(checkpoint.runId, structuredClone(checkpoint));
  }

  async load(runId: string): Promise<WorkflowCheckpoint<TState> | null> {
    const checkpoint = this.store.get(runId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async clear(runId: string): Promise<void> {
    this.store.delete(runId);
  }
}

/**
 * Persists checkpoints as JSON files: <dir>/<runId>.json.
 * The workflow state must be JSON-serializable.
 */
export class FileCheckpointAdapter<TState = any> implements CheckpointAdapter<TState> {
  constructor(private readonly dir = ".workflow-checkpoints") {}

  private filePath(runId: string): string {
    assertSafeId(runId, "run id");
    return join(this.dir, `${runId}.json`);
  }

  async save(checkpoint: WorkflowCheckpoint<TState>): Promise<void> {
    await writeJsonAtomic(this.filePath(checkpoint.runId), checkpoint);
  }

  async load(runId: string): Promise<WorkflowCheckpoint<TState> | null> {
    const path = this.filePath(runId);
    try {
      return JSON.parse(await readFile(path, "utf-8"));
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async clear(runId: string): Promise<void> {
    await rm(this.filePath(runId), { force: true });
  }
}
