import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
    return join(this.dir, `${sessionId}.json`);
  }

  async load(sessionId: string): Promise<Message[]> {
    const path = this.filePath(sessionId);
    if (!existsSync(path)) return [];
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as Message[];
    } catch {
      return [];
    }
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(sessionId), JSON.stringify(messages, null, 2), "utf-8");
  }

  async clear(sessionId: string): Promise<void> {
    const path = this.filePath(sessionId);
    if (existsSync(path)) {
      await writeFile(path, "[]", "utf-8");
    }
  }
}
