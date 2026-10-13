import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Throws unless `id` is safe to use as a file name (no path separators or `..`). */
export function assertSafeId(id: string, label = "id"): void {
  if (!/^[\w.-]+$/.test(id) || id === "." || id === "..") {
    throw new Error(`Invalid ${label} '${id}'. Use letters, digits, '_', '-' or '.'.`);
  }
}

/** Writes JSON to a temp file then renames it, so a crash never leaves a truncated file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf-8");
  await rename(tmp, path);
}
