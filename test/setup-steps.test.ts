import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENT_MEMORY_FILES,
  SCAFFOLD_FILES,
  assertNotMexRepo,
  buildPopulationPrompt,
  detectProjectState,
  findProjectRoot,
  normalizeMode,
  scaffoldFilesForMode,
  templatesDir,
  writeScaffold,
  writeToolConfigs,
} from "../src/setup/steps.js";

// The headless steps are the single source of truth shared by the interactive
// CLI wizard and the web UI, so they are tested against real templates on a
// real temp directory rather than mocks.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-steps-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("templatesDir", () => {
  it("resolves a directory that actually holds the scaffold templates", () => {
    const dir = templatesDir();
    expect(existsSync(join(dir, "ROUTER.md"))).toBe(true);
    expect(existsSync(join(dir, ".tool-configs", "CLAUDE.md"))).toBe(true);
  });
});

describe("mode selection", () => {
  it("defaults to code-repo and rejects unknown modes", () => {
    expect(normalizeMode(undefined)).toBe("code-repo");
    expect(normalizeMode("agent-memory")).toBe("agent-memory");
    expect(() => normalizeMode("nonsense")).toThrow(/Unknown setup mode/);
  });

  it("adds HEARTBEAT.md only for the agent-memory template set", () => {
    expect(scaffoldFilesForMode("code-repo")).toEqual(SCAFFOLD_FILES);
    expect(scaffoldFilesForMode("agent-memory")).toEqual(AGENT_MEMORY_FILES);
    expect(scaffoldFilesForMode("agent-memory")).toContain("HEARTBEAT.md");
    expect(scaffoldFilesForMode("code-repo")).not.toContain("HEARTBEAT.md");
  });
});

describe("findProjectRoot", () => {
  it("walks up to the nearest .git directory", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
  });

  it("falls back to the start directory outside a repository", () => {
    const nested = join(root, "loose");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(nested);
  });
});

describe("assertNotMexRepo", () => {
  it("passes for an ordinary project", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "my-app" }));
    expect(() => assertNotMexRepo(root)).not.toThrow();
  });

  it("refuses to scaffold a checkout of mex itself", () => {
    mkdirSync(join(root, "src", "setup"), { recursive: true });
    writeFileSync(join(root, "src", "setup", "index.ts"), "");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mex" }));
    expect(() => assertNotMexRepo(root)).toThrow(/mex repository itself/);
  });
});

describe("detectProjectState", () => {
  const mexDir = () => join(root, ".mex");

  it("reports `fresh` when there is barely any source", () => {
    writeFileSync(join(root, "index.ts"), "export const a = 1;\n");
    expect(detectProjectState(root, mexDir())).toBe("fresh");
  });

  it("reports `existing` once there is real source and no populated scaffold", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    for (const name of ["a", "b", "c", "d", "e"]) {
      writeFileSync(join(root, "src", `${name}.ts`), `export const ${name} = 1;\n`);
    }
    expect(detectProjectState(root, mexDir())).toBe("existing");
  });

  it("reports `partial` when the scaffold already holds real content", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    mkdirSync(mexDir(), { recursive: true });
    writeFileSync(join(mexDir(), "AGENTS.md"), "# Inventory API\n\nA real description.\n");
    expect(detectProjectState(root, mexDir())).toBe("partial");
  });

  it("ignores node_modules and .git when counting source files", () => {
    for (const dir of ["node_modules/pkg", ".git/hooks"]) {
      mkdirSync(join(root, ...dir.split("/")), { recursive: true });
      for (const name of ["a", "b", "c", "d", "e"]) {
        writeFileSync(join(root, ...dir.split("/"), `${name}.js`), "module.exports = 1;\n");
      }
    }
    expect(detectProjectState(root, mexDir())).toBe("fresh");
  });
});

describe("writeScaffold", () => {
  it("copies every template file for the chosen mode", () => {
    const results = writeScaffold({ projectRoot: root, mode: "code-repo" });
    expect(results).toHaveLength(SCAFFOLD_FILES.length);
    expect(results.every((result) => result.action === "copied")).toBe(true);
    for (const file of SCAFFOLD_FILES) {
      expect(existsSync(join(root, ".mex", file))).toBe(true);
    }
  });

  it("writes HEARTBEAT.md in agent-memory mode", () => {
    writeScaffold({ projectRoot: root, mode: "agent-memory" });
    expect(existsSync(join(root, ".mex", "HEARTBEAT.md"))).toBe(true);
  });

  it("never overwrites a populated file", () => {
    writeScaffold({ projectRoot: root, mode: "code-repo" });
    const populated = join(root, ".mex", "context", "stack.md");
    writeFileSync(populated, "# Stack\n\nNode 22, SQLite, Vite.\n");

    const results = writeScaffold({ projectRoot: root, mode: "code-repo" });

    expect(readFileSync(populated, "utf-8")).toContain("Node 22, SQLite, Vite.");
    expect(results.find((r) => r.file === "context/stack.md")?.action).toBe("skipped");
  });

  it("is idempotent over untouched templates", () => {
    writeScaffold({ projectRoot: root, mode: "code-repo" });
    const results = writeScaffold({ projectRoot: root, mode: "code-repo" });
    expect(results.every((result) => result.action === "copied")).toBe(true);
  });

  it("touches nothing on a dry run", () => {
    const results = writeScaffold({ projectRoot: root, mode: "code-repo", dryRun: true });
    expect(results.every((result) => result.action === "would-copy")).toBe(true);
    expect(existsSync(join(root, ".mex"))).toBe(false);
  });
});

describe("writeToolConfigs", () => {
  it("writes one instruction file per selected tool", () => {
    const results = writeToolConfigs({ projectRoot: root, tools: ["claude", "codex", "copilot"] });
    expect(results.map((r) => r.dest).sort()).toEqual([
      ".github/copilot-instructions.md",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(existsSync(join(root, ".github", "copilot-instructions.md"))).toBe(true);
  });

  it("leaves a hand-written file alone", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# My own rules\n");
    const results = writeToolConfigs({ projectRoot: root, tools: ["claude"] });
    expect(results[0].action).toBe("exists");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf-8")).toBe("# My own rules\n");
  });

  it("deduplicates repeated tools and returns nothing for an empty selection", () => {
    expect(writeToolConfigs({ projectRoot: root, tools: [] })).toEqual([]);
    const results = writeToolConfigs({ projectRoot: root, tools: ["claude", "claude"] });
    expect(results).toHaveLength(1);
  });

  it("reports would-overwrite without writing on a dry run", () => {
    writeFileSync(join(root, "CLAUDE.md"), "# My own rules\n");
    const results = writeToolConfigs({
      projectRoot: root,
      tools: ["claude", "cursor"],
      dryRun: true,
    });
    expect(results.find((r) => r.tool === "claude")?.action).toBe("would-overwrite");
    expect(results.find((r) => r.tool === "cursor")?.action).toBe("would-copy");
    expect(existsSync(join(root, ".cursorrules"))).toBe(false);
  });
});

describe("buildPopulationPrompt", () => {
  it("prefers the scanner brief for an existing codebase", () => {
    const withBrief = buildPopulationPrompt({
      mode: "code-repo",
      state: "existing",
      scannerBrief: "SCANNER-BRIEF-MARKER",
    });
    expect(withBrief).toContain("SCANNER-BRIEF-MARKER");

    const withoutBrief = buildPopulationPrompt({
      mode: "code-repo",
      state: "existing",
      scannerBrief: null,
    });
    expect(withoutBrief).not.toContain("SCANNER-BRIEF-MARKER");
    expect(withoutBrief.length).toBeGreaterThan(0);
  });

  it("ignores a brief for a fresh project, which has no code to summarize", () => {
    const prompt = buildPopulationPrompt({
      mode: "code-repo",
      state: "fresh",
      scannerBrief: "SCANNER-BRIEF-MARKER",
    });
    expect(prompt).not.toContain("SCANNER-BRIEF-MARKER");
  });

  it("uses the agent-memory prompt regardless of detected state", () => {
    const memory = buildPopulationPrompt({ mode: "agent-memory", state: "existing" });
    const repo = buildPopulationPrompt({ mode: "code-repo", state: "existing" });
    expect(memory).not.toBe(repo);
    expect(memory).toContain("HEARTBEAT.md");
  });
});
