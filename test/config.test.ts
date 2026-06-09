import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { findConfig, saveAiTools, ensureScaffoldIdentity, getScaffoldIdentity } from "../src/config.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-config-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findConfig", () => {
  it("throws when you run it from inside the .mex/ folder", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    expect(() => findConfig(mexPath)).toThrow("You're inside the .mex/ directory");
  });

  it("throws when no git repository is found", () => {
    expect(() => findConfig(tmpDir)).toThrow("No git repository found");
  });

  it("throws when scaffold directory exists but looks incomplete", () => {
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, ".mex"));
    expect(() => findConfig(tmpDir)).toThrow("Scaffold directory exists but looks incomplete");
  });

  it("throws when no .mex/ scaffold found at all", () => {
    mkdirSync(join(tmpDir, ".git"));
    expect(() => findConfig(tmpDir)).toThrow("No .mex/ scaffold found. Run: mex setup");
  });

  it("works without .git if a complete scaffold exists", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    
    const config = findConfig(tmpDir);
    expect(config.projectRoot).toBe(tmpDir);
    expect(config.scaffoldRoot).toBe(mexPath);
  });

  it("finds scaffold with context/ directory", () => {
    mkdirSync(join(tmpDir, ".git"));
    mkdirSync(join(tmpDir, "context"));
    const config = findConfig(tmpDir);
    expect(config.projectRoot).toBe(tmpDir);
    expect(config.scaffoldRoot).toBe(tmpDir);
  });

  it("prefers .mex/ over context/", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    mkdirSync(join(tmpDir, "context"));
    const config = findConfig(tmpDir);
    expect(config.scaffoldRoot).toBe(mexPath);
  });

  it("returns empty aiTools when no config.json exists", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    const config = findConfig(tmpDir);
    expect(config.aiTools).toEqual([]);
  });

  it("loads aiTools from config.json when present", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["opencode", "claude"] }));
    const config = findConfig(tmpDir);
    expect(config.aiTools).toEqual(["opencode", "claude"]);
  });
});

describe("findConfig — stalenessThresholds", () => {
  function setupScaffold(staleness: unknown): void {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ staleness }));
  }

  it("loads full thresholds from config.json", () => {
    setupScaffold({ warnDays: 14, errorDays: 60, warnCommits: 25, errorCommits: 100 });
    const config = findConfig(tmpDir);
    expect(config.stalenessThresholds).toEqual({
      warnDays: 14,
      errorDays: 60,
      warnCommits: 25,
      errorCommits: 100,
    });
  });

  it("fills missing fields from the checker defaults", () => {
    setupScaffold({ warnDays: 14 });
    const config = findConfig(tmpDir);
    expect(config.stalenessThresholds).toEqual({
      warnDays: 14,
      errorDays: 90,
      warnCommits: 50,
      errorCommits: 200,
    });
  });

  it("warns and falls back to defaults when warn exceeds error", () => {
    setupScaffold({ warnDays: 90, errorDays: 30 });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const config = findConfig(tmpDir);
      expect(config.stalenessThresholds).toEqual({
        warnDays: 30,
        errorDays: 90,
        warnCommits: 50,
        errorCommits: 200,
      });
      expect(warnings.some((w) => w.includes("invert warn/error"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("warns when commit invariant is violated too", () => {
    setupScaffold({ warnCommits: 500, errorCommits: 100 });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const config = findConfig(tmpDir);
      expect(config.stalenessThresholds).toEqual({
        warnDays: 30,
        errorDays: 90,
        warnCommits: 50,
        errorCommits: 200,
      });
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("findConfig — watch and heartbeat config", () => {
  function setupConfig(config: unknown): void {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify(config));
  }

  it("loads watch interval from config.json", () => {
    setupConfig({ watch: { intervalMinutes: 45 } });
    const config = findConfig(tmpDir);
    expect(config.watch).toEqual({ intervalMinutes: 45 });
  });

  it("loads heartbeat thresholds from config.json", () => {
    setupConfig({ heartbeat: { staleDays: 5, memoryCleanupDays: 8, dailyMemoryRetentionDays: 21 } });
    const config = findConfig(tmpDir);
    expect(config.heartbeat).toEqual({
      staleDays: 5,
      memoryCleanupDays: 8,
      dailyMemoryRetentionDays: 21,
    });
  });

  it("ignores non-positive watch and heartbeat values", () => {
    setupConfig({ watch: { intervalMinutes: 0 }, heartbeat: { staleDays: -1 } });
    const config = findConfig(tmpDir);
    expect(config.watch).toBeUndefined();
    expect(config.heartbeat).toBeUndefined();
  });
});

describe("scaffold identity", () => {
  function makeMex(): string {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    return mexPath;
  }

  it("mints a v4 scaffold_id, names it after the project dir, and persists it", () => {
    const mexPath = makeMex();
    const id = ensureScaffoldIdentity(mexPath, tmpDir);

    expect(id.scaffold_id).toMatch(UUID_V4);
    expect(id.scaffold_name).toBe(basename(tmpDir));
    expect(id.origin).toBeNull();
    expect(id.upstream).toBeNull();

    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.scaffold_id).toBe(id.scaffold_id);
    expect(raw.scaffold_name).toBe(id.scaffold_name);
    expect(raw.origin).toBeNull();
    expect(raw.upstream).toBeNull();
  });

  it("is idempotent — never regenerates an existing id", () => {
    const mexPath = makeMex();
    const first = ensureScaffoldIdentity(mexPath, tmpDir);
    const second = ensureScaffoldIdentity(mexPath, tmpDir);
    expect(second.scaffold_id).toBe(first.scaffold_id);
  });

  it("preserves existing config keys when minting identity", () => {
    const mexPath = makeMex();
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["claude"], someOther: true }));
    ensureScaffoldIdentity(mexPath, tmpDir);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["claude"]);
    expect(raw.someOther).toBe(true);
    expect(raw.scaffold_id).toMatch(UUID_V4);
  });

  it("mints distinct ids for distinct scaffolds (id is random, not path-derived)", () => {
    const a = join(tmpDir, "a", ".mex");
    const b = join(tmpDir, "b", ".mex");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const idA = ensureScaffoldIdentity(a, join(tmpDir, "a"));
    const idB = ensureScaffoldIdentity(b, join(tmpDir, "b"));
    expect(idA.scaffold_id).not.toBe(idB.scaffold_id);
  });

  it("swallows a write failure and still returns an identity", () => {
    // Put a file where a directory needs to be so the config write throws.
    const blocker = join(tmpDir, "blocker");
    writeFileSync(blocker, "not a directory");
    const scaffoldRoot = join(blocker, ".mex");
    const id = ensureScaffoldIdentity(scaffoldRoot, tmpDir);
    expect(id.scaffold_id).toMatch(UUID_V4);
    expect(existsSync(join(scaffoldRoot, "config.json"))).toBe(false);
  });

  it("findConfig surfaces an existing identity without minting", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "demo",
      origin: null,
      upstream: null,
    }));
    const config = findConfig(tmpDir);
    expect(config.identity).toEqual({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "demo",
      origin: null,
      upstream: null,
    });
  });

  it("findConfig stays a pure read — does not write config.json", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    const config = findConfig(tmpDir);
    expect(config.identity).toBeUndefined();
    expect(existsSync(join(mexPath, "config.json"))).toBe(false);
  });

  it("getScaffoldIdentity migrates a scaffold missing scaffold_id", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["claude"] }));

    const config = findConfig(tmpDir);
    expect(config.identity).toBeUndefined(); // not minted by the read

    const id = getScaffoldIdentity(config);
    expect(id.scaffold_id).toMatch(UUID_V4);
    expect(config.identity).toEqual(id); // accessor backfills the in-memory config

    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.scaffold_id).toBe(id.scaffold_id);
    expect(raw.aiTools).toEqual(["claude"]); // existing keys untouched
  });

  it("backfills an empty scaffold_name without regenerating the id", () => {
    mkdirSync(join(tmpDir, ".git"));
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath);
    writeFileSync(join(mexPath, "ROUTER.md"), "");
    // scaffold_id present but no scaffold_name (e.g. hand-edited / partial write)
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ scaffold_id: "keep-this-id" }));

    const id = getScaffoldIdentity(findConfig(tmpDir));
    expect(id.scaffold_id).toBe("keep-this-id"); // id preserved, never regenerated
    expect(id.scaffold_name).toBe(basename(tmpDir)); // name backfilled to the default

    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.scaffold_id).toBe("keep-this-id");
    expect(raw.scaffold_name).toBe(basename(tmpDir));
  });
});

describe("saveAiTools", () => {
  it("creates config.json with aiTools", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    saveAiTools(mexPath, ["opencode"]);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["opencode"]);
  });

  it("preserves existing config keys when saving", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    writeFileSync(join(mexPath, "config.json"), JSON.stringify({ someOther: true }));
    saveAiTools(mexPath, ["codex"]);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["codex"]);
    expect(raw.someOther).toBe(true);
  });

  it("overwrites previous aiTools value", () => {
    const mexPath = join(tmpDir, ".mex");
    mkdirSync(mexPath, { recursive: true });
    saveAiTools(mexPath, ["claude"]);
    saveAiTools(mexPath, ["opencode", "codex"]);
    const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf-8"));
    expect(raw.aiTools).toEqual(["opencode", "codex"]);
  });
});
