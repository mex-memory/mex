import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findConfig, saveAiTools } from "../src/config.js";

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
