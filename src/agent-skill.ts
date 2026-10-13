import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { createTool } from "./tool.js";
import type { Tool } from "./types.js";

/**
 * An Agent Skill: a folder holding a `SKILL.md` file (YAML frontmatter + Markdown
 * instructions) and optional bundled files (`scripts/`, `references/`, `assets/`).
 *
 * Only the name and description are shown to the model up front; the instructions
 * and files are loaded on demand. See https://agentskills.io/specification.
 */
export interface AgentSkill {
  /** Lowercase letters, digits and hyphens; matches the folder name. */
  name: string;
  /** What the skill does and when to use it. */
  description: string;
  /** Absolute path of the skill folder. */
  dir: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** Tools the skill expects to use (`allowed-tools`, informational). */
  allowedTools?: string[];
}

export interface AgentSkillToolsOptions {
  /** Max size in bytes returned by `read_skill_file`. Default: 200 000. */
  maxFileBytes?: number;
}

const SKILL_FILE = "SKILL.md";
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_LISTED_FILES = 100;

type FrontmatterValue = string | string[] | Record<string, string>;

/** Removes the quotes of a YAML scalar. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Parses the YAML subset used by SKILL.md frontmatter: scalars (plain or quoted),
 * block scalars (`|`, `>`), one-level maps and lists.
 */
export function parseFrontmatter(source: string): { data: Record<string, FrontmatterValue>; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!match) throw new Error("missing YAML frontmatter (the file must start with '---').");

  const lines = match[1].split("\n");
  const data: Record<string, FrontmatterValue> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentOf(line) > 0) throw new Error(`unexpected indentation on line ${i + 2}: '${line.trim()}'.`);

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`cannot parse line ${i + 2}: '${line}'.`);
    const [, key, rest] = kv;

    // Collect the indented lines that belong to this key.
    const block: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === "" || indentOf(lines[i + 1]) > 0)) {
      block.push(lines[++i]);
    }
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();

    const blockScalar = rest.trim().match(/^([|>])[+-]?$/);
    if (blockScalar) {
      const minIndent = Math.min(...block.filter((l) => l.trim()).map(indentOf));
      const content = block.map((l) => l.slice(Number.isFinite(minIndent) ? minIndent : 0));
      data[key] = blockScalar[1] === "|"
        ? content.join("\n")
        : content.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ").trim();
    } else if (rest.trim() !== "") {
      // A plain scalar may continue on indented lines (folded with spaces).
      data[key] = unquote([rest, ...block.map((l) => l.trim())].filter(Boolean).join(" "));
    } else if (block.some((l) => l.trim().startsWith("- "))) {
      data[key] = block.filter((l) => l.trim()).map((l) => unquote(l.trim().replace(/^-\s*/, "")));
    } else if (block.length > 0) {
      const map: Record<string, string> = {};
      for (const entry of block.filter((l) => l.trim())) {
        const pair = entry.trim().match(/^([^:]+?)\s*:\s*(.*)$/);
        if (!pair) throw new Error(`cannot parse '${entry.trim()}' under '${key}'.`);
        map[unquote(pair[1])] = unquote(pair[2]);
      }
      data[key] = map;
    } else {
      data[key] = "";
    }
  }

  return { data, body: text.slice(match[0].length).trim() };
}

function validateSkill(data: Record<string, FrontmatterValue>, dir: string): AgentSkill {
  const fail = (message: string): never => {
    throw new Error(`Invalid Agent Skill at '${dir}': ${message}`);
  };
  const str = (key: string): string | undefined => {
    const value = data[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") fail(`'${key}' must be a string.`);
    return value as string;
  };

  const name = str("name");
  if (!name) return fail("'name' is required.");
  if (name.length > 64 || !NAME_PATTERN.test(name)) {
    fail(`'name' must be 1-64 lowercase letters, digits or single hyphens (got '${name}').`);
  }
  if (basename(dir) !== name) fail(`'name' (${name}) must match the folder name (${basename(dir)}).`);

  const description = str("description")?.trim();
  if (!description) return fail("'description' is required.");
  if (description.length > 1024) fail("'description' must be at most 1024 characters.");

  const compatibility = str("compatibility");
  if (compatibility && compatibility.length > 500) fail("'compatibility' must be at most 500 characters.");

  const metadata = data.metadata;
  if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
    fail("'metadata' must be a map of strings.");
  }

  const allowed = data["allowed-tools"];
  const allowedTools = typeof allowed === "string"
    ? allowed.split(/\s+/).filter(Boolean)
    : Array.isArray(allowed) ? allowed : undefined;

  return {
    name,
    description,
    dir,
    ...(str("license") ? { license: str("license") } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(metadata ? { metadata: metadata as Record<string, string> } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

async function hasSkillFile(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, SKILL_FILE))).isFile();
  } catch {
    return false;
  }
}

/** Loads the skill in `dir` (which must contain a SKILL.md file). */
export async function loadAgentSkill(dir: string): Promise<AgentSkill> {
  const absolute = resolve(dir);
  let source: string;
  try {
    source = await readFile(join(absolute, SKILL_FILE), "utf-8");
  } catch {
    throw new Error(`No ${SKILL_FILE} found in '${absolute}'.`);
  }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(source);
  } catch (err: any) {
    throw new Error(`Invalid Agent Skill at '${absolute}': ${err.message}`);
  }
  return validateSkill(parsed.data, absolute);
}

/**
 * Loads Agent Skills from a path: the skill itself when the folder contains a
 * SKILL.md, otherwise every direct sub-folder that contains one (sorted by name).
 */
export async function loadAgentSkills(path: string): Promise<AgentSkill[]> {
  const absolute = resolve(path);
  if (await hasSkillFile(absolute)) return [await loadAgentSkill(absolute)];

  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    throw new Error(`Agent Skills folder '${absolute}' does not exist.`);
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => join(absolute, e.name))
    .sort();
  const skills: AgentSkill[] = [];
  for (const dir of dirs) {
    if (await hasSkillFile(dir)) skills.push(await loadAgentSkill(dir));
  }
  return skills;
}

/** Returns the Markdown instructions of a skill (SKILL.md without its frontmatter). */
export async function readAgentSkillInstructions(skill: AgentSkill): Promise<string> {
  return parseFrontmatter(await readFile(join(skill.dir, SKILL_FILE), "utf-8")).body;
}

/** Lists the files bundled with a skill, as relative POSIX paths (SKILL.md excluded). */
export async function listAgentSkillFiles(skill: AgentSkill, max = MAX_LISTED_FILES): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= max) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && full !== join(skill.dir, SKILL_FILE)) {
        files.push(relative(skill.dir, full).split(sep).join("/"));
      }
    }
  };
  await walk(skill.dir);
  return files;
}

/** Reads a file bundled with a skill. Paths outside the skill folder are rejected. */
export async function readAgentSkillFile(skill: AgentSkill, path: string, maxBytes = 200_000): Promise<string> {
  if (isAbsolute(path)) throw new Error(`Path must be relative to the skill folder (got '${path}').`);
  const full = resolve(skill.dir, path);
  const rel = relative(skill.dir, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path '${path}' is outside the skill '${skill.name}'.`);
  }

  const buffer = await readFile(full).catch(() => {
    throw new Error(`File '${path}' not found in skill '${skill.name}'.`);
  });
  if (buffer.includes(0)) throw new Error(`File '${path}' is binary and cannot be read as text.`);
  const content = buffer.subarray(0, maxBytes).toString("utf-8");
  return buffer.length > maxBytes
    ? `${content}\n…[truncated: file is ${buffer.length} bytes, showing the first ${maxBytes}]`
    : content;
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** System prompt section listing the available skills (names and descriptions only). */
export function agentSkillsPrompt(skills: AgentSkill[]): string {
  if (skills.length === 0) return "";
  const catalog = skills
    .map((s) => `<skill>\n<name>${escapeXml(s.name)}</name>\n<description>${escapeXml(s.description)}</description>\n</skill>`)
    .join("\n");
  return [
    "## Skills",
    "",
    "The following skills provide instructions for specific tasks. When a task matches a skill's description, " +
      "call the `load_skill` tool with its name before starting, then follow its instructions. " +
      "Use `read_skill_file` to read files the instructions refer to.",
    "",
    `<available_skills>\n${catalog}\n</available_skills>`,
  ].join("\n");
}

/**
 * Creates the `load_skill` and `read_skill_file` tools giving the model on-demand
 * access to the given skills. Bundled scripts are never executed by these tools.
 */
export function createAgentSkillTools(
  skills: Map<string, AgentSkill> | AgentSkill[],
  options: AgentSkillToolsOptions = {}
): Tool[] {
  const byName = skills instanceof Map ? skills : new Map(skills.map((s) => [s.name, s]));
  const find = (name: string): AgentSkill => {
    const skill = byName.get(name);
    if (!skill) throw new Error(`Unknown skill '${name}'. Available skills: ${[...byName.keys()].join(", ") || "none"}.`);
    return skill;
  };

  const loadSkill = createTool(
    "load_skill",
    "Loads the full instructions of a skill listed in <available_skills>. Call it before working on a task that matches the skill.",
    z.object({ name: z.string().describe("Name of the skill, exactly as listed") }),
    async ({ name }) => {
      const skill = find(name);
      const [instructions, files] = await Promise.all([readAgentSkillInstructions(skill), listAgentSkillFiles(skill)]);
      const filesSection = files.length > 0
        ? `\n\n---\nFiles bundled with this skill (read them with read_skill_file):\n${files.map((f) => `- ${f}`).join("\n")}`
        : "";
      return `# Skill: ${skill.name}\n\n${instructions}${filesSection}`;
    }
  );

  const readSkillFile = createTool(
    "read_skill_file",
    "Reads a text file bundled with a skill (e.g. references/guide.md or scripts/run.py), by path relative to the skill folder.",
    z.object({
      skill: z.string().describe("Name of the skill"),
      path: z.string().describe("Path relative to the skill folder"),
    }),
    async ({ skill, path }) => readAgentSkillFile(find(skill), path, options.maxFileBytes)
  );

  return [loadSkill, readSkillFile];
}
