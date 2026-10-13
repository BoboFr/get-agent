import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  agentSkillsPrompt,
  createAgentSkillTools,
  createTool,
  listAgentSkillFiles,
  loadAgentSkill,
  loadAgentSkills,
  readAgentSkillFile,
} from "../src/index.js";
import { parseFrontmatter } from "../src/agent-skill.js";
import { z } from "zod";
import { completion, mockFetch } from "./helpers.js";

let root: string;

async function writeSkill(name: string, frontmatter: string, body = "Instructions.", files: Record<string, string> = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "get-agent-skills-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("parses scalars, quoted values, block scalars, maps and lists", () => {
    const { data, body } = parseFrontmatter([
      "---",
      "name: pdf-tools",
      'description: "Extract text: tables & forms"',
      "license: 'Apache-2.0'",
      "# a comment",
      "compatibility: >",
      "  Requires python3",
      "  and poppler.",
      "notes: |",
      "  line 1",
      "  line 2",
      "metadata:",
      "  author: acme",
      '  version: "1.0"',
      "tags:",
      "  - pdf",
      "  - text",
      "allowed-tools: Bash(pdftotext:*) Read",
      "---",
      "# Body",
    ].join("\r\n"));
    expect(data).toEqual({
      name: "pdf-tools",
      description: "Extract text: tables & forms",
      license: "Apache-2.0",
      compatibility: "Requires python3 and poppler.",
      notes: "line 1\nline 2",
      metadata: { author: "acme", version: "1.0" },
      tags: ["pdf", "text"],
      "allowed-tools": "Bash(pdftotext:*) Read",
    });
    expect(body).toBe("# Body");
  });

  it("folds a plain scalar continued on indented lines", () => {
    expect(parseFrontmatter("---\ndescription: first part\n  second part\n---\n").data.description)
      .toBe("first part second part");
  });

  it("rejects a file without frontmatter", () => {
    expect(() => parseFrontmatter("# no frontmatter")).toThrow(/missing YAML frontmatter/);
  });
});

describe("loadAgentSkill", () => {
  it("loads and validates a skill", async () => {
    const dir = await writeSkill(
      "pdf-tools",
      "name: pdf-tools\ndescription: Work with PDF files.\nmetadata:\n  author: acme\nallowed-tools: Read Bash"
    );
    expect(await loadAgentSkill(dir)).toEqual({
      name: "pdf-tools",
      description: "Work with PDF files.",
      dir,
      metadata: { author: "acme" },
      allowedTools: ["Read", "Bash"],
    });
  });

  it.each([
    ["missing name", "bad-1", "description: x", /'name' is required/],
    ["uppercase name", "Bad", "name: Bad\ndescription: x", /lowercase/],
    ["double hyphen", "a--b", "name: a--b\ndescription: x", /lowercase/],
    ["folder mismatch", "folder", "name: other\ndescription: x", /must match the folder name/],
    ["missing description", "no-desc", "name: no-desc", /'description' is required/],
    ["description too long", "long", `name: long\ndescription: ${"x".repeat(1025)}`, /at most 1024/],
  ])("rejects %s", async (_label, folder, frontmatter, error) => {
    const dir = await writeSkill(folder, frontmatter);
    await expect(loadAgentSkill(dir)).rejects.toThrow(error);
  });

  it("reports a folder without SKILL.md", async () => {
    await expect(loadAgentSkill(root)).rejects.toThrow(/No SKILL.md found/);
  });
});

describe("loadAgentSkills", () => {
  it("loads every skill folder of a directory, sorted, ignoring other folders", async () => {
    await writeSkill("zeta", "name: zeta\ndescription: Z");
    await writeSkill("alpha", "name: alpha\ndescription: A");
    await mkdir(join(root, "not-a-skill"));
    await mkdir(join(root, ".hidden"));
    expect((await loadAgentSkills(root)).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("accepts a skill folder directly", async () => {
    const dir = await writeSkill("solo", "name: solo\ndescription: S");
    expect((await loadAgentSkills(dir)).map((s) => s.name)).toEqual(["solo"]);
  });
});

describe("skill files", () => {
  it("lists bundled files and reads them safely", async () => {
    const dir = await writeSkill("tools", "name: tools\ndescription: T", "Body", {
      "references/guide.md": "# Guide",
      "scripts/run.py": "print('hi')",
      "assets/logo.bin": "a\u0000b",
      ".secret": "nope",
    });
    const skill = await loadAgentSkill(dir);
    expect(await listAgentSkillFiles(skill)).toEqual(["assets/logo.bin", "references/guide.md", "scripts/run.py"]);
    expect(await readAgentSkillFile(skill, "references/guide.md")).toBe("# Guide");
    expect(await readAgentSkillFile(skill, "scripts/run.py", 5)).toMatch(/^print\n…\[truncated: file is 11 bytes/);
    await expect(readAgentSkillFile(skill, "../outside.txt")).rejects.toThrow(/outside the skill/);
    await expect(readAgentSkillFile(skill, join(dir, "references/guide.md"))).rejects.toThrow(/must be relative/);
    await expect(readAgentSkillFile(skill, "assets/logo.bin")).rejects.toThrow(/binary/);
    await expect(readAgentSkillFile(skill, "missing.md")).rejects.toThrow(/not found/);
  });
});

describe("agentSkillsPrompt and tools", () => {
  it("lists only names and descriptions, escaping XML", async () => {
    const skill = await loadAgentSkill(await writeSkill("x", "name: x\ndescription: Use for <tags> & co"));
    const prompt = agentSkillsPrompt([skill]);
    expect(prompt).toContain("<name>x</name>");
    expect(prompt).toContain("<description>Use for &lt;tags&gt; &amp; co</description>");
    expect(prompt).not.toContain("Instructions.");
    expect(agentSkillsPrompt([])).toBe("");
  });

  it("load_skill returns the instructions and bundled files", async () => {
    const skill = await loadAgentSkill(
      await writeSkill("report", "name: report\ndescription: R", "# Steps\n1. Do it", { "references/a.md": "A" })
    );
    const [loadSkill, readSkillFile] = createAgentSkillTools([skill]);
    const result = await loadSkill.execute({ name: "report" });
    expect(result).toContain("# Skill: report");
    expect(result).toContain("# Steps\n1. Do it");
    expect(result).toContain("- references/a.md");
    expect(result).not.toContain("description: R");
    expect(await readSkillFile.execute({ skill: "report", path: "references/a.md" })).toBe("A");
    await expect(loadSkill.execute({ name: "nope" })).rejects.toThrow(/Unknown skill 'nope'. Available skills: report/);
  });
});

describe("Agent with agentSkills", () => {
  it("advertises skills in the system prompt and loads them on demand", async () => {
    await writeSkill("commit-message", "name: commit-message\ndescription: Write git commit messages.", "Use the imperative mood.");
    const http = mockFetch([
      completion(null, [{ name: "load_skill", args: { name: "commit-message" } }]),
      completion("Add login form"),
    ]);
    const agent = new Agent({ name: "a", retry: { maxRetries: 0 }, agentSkills: [root] });

    expect(await agent.run("Écris un message de commit.")).toBe("Add login form");
    expect(agent.getAgentSkills().map((s) => s.name)).toEqual(["commit-message"]);

    const first = http.body(0);
    expect(first.messages[0].content).toContain("<name>commit-message</name>");
    expect(first.messages[0].content).not.toContain("imperative");
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["load_skill", "read_skill_file"]);
    expect(agent.getHistory()[3].content).toContain("Use the imperative mood.");
  });

  it("rejects duplicate skill names from different folders", async () => {
    const other = await mkdtemp(join(tmpdir(), "get-agent-skills-b-"));
    try {
      await writeSkill("dup", "name: dup\ndescription: A");
      await mkdir(join(other, "dup"));
      await writeFile(join(other, "dup", "SKILL.md"), "---\nname: dup\ndescription: B\n---\n");
      const agent = new Agent({ name: "a", agentSkills: [root, other] });
      await expect(agent.initialize()).rejects.toThrow(/Agent Skill name collision: 'dup'/);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("refuses a user tool named load_skill", async () => {
    await writeSkill("s", "name: s\ndescription: S");
    const clash = createTool("load_skill", "mine", z.object({}), () => "x");
    await expect(new Agent({ name: "a", tools: [clash], agentSkills: [root] }).initialize())
      .rejects.toThrow(/reserved for Agent Skills/);
  });

  it("can be shut down and initialized again", async () => {
    await writeSkill("s", "name: s\ndescription: S");
    const agent = new Agent({ name: "a", agentSkills: [root] });
    await agent.initialize();
    await agent.shutdown();
    expect(agent.getAgentSkills()).toEqual([]);
    await agent.initialize();
    expect(agent.getRegisteredTools().map((t) => t.name)).toEqual(["load_skill", "read_skill_file"]);
  });
});
