import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId, writeJsonAtomic } from "./fs-utils.js";
import type { Message } from "./types.js";

export interface HistoryAdapter {
  load(sessionId: string): Promise<Message[]>;
  save(sessionId: string, messages: Message[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/**
 * Persists conversation history to JSON files on disk.
 * One file per session: <dir>/<sessionId>.json
 */
export class FileHistoryAdapter implements HistoryAdapter {
  private dir: string;

  constructor(dir = ".agent-history") {
    this.dir = dir;
  }

  private filePath(sessionId: string): string {
    assertSafeId(sessionId, "session id");
    return join(this.dir, `${sessionId}.json`);
  }

  async load(sessionId: string): Promise<Message[]> {
    const path = this.filePath(sessionId);
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as Message[];
    } catch {
      return [];
    }
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    await writeJsonAtomic(this.filePath(sessionId), messages);
  }

  async clear(sessionId: string): Promise<void> {
    const path = this.filePath(sessionId);
    try {
      await access(path);
    } catch {
      return; // nothing to clear
    }
    await writeFile(path, "[]", "utf-8");
  }
}
