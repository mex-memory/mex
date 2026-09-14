import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkHeartbeat } from "../src/heartbeat.js";
import type { MexConfig } from "../src/types.js";

let tmpDir: string;
let config: MexConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-heartbeat-"));
  mkdirSync(join(tmpDir, ".mex/context"), { recursive: true });
  writeFileSync(join(tmpDir, ".mex/ROUTER.md"), frontmatter("router", "2026-05-12"));
  config = {
    projectRoot: tmpDir,
    scaffoldRoot: join(tmpDir, ".mex"),
    aiTools: [],
    heartbeat: { staleDays: 7, memoryCleanupDays: 7, dailyMemoryRetentionDays: 14 },
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("heartbeat", () => {
  it("returns ok when files are fresh and memory cleanup is not configured", () => {
    const result = checkHeartbeat(config, new Date("2026-05-14T00:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.staleFiles).toEqual([]);
  });

  it("flags files with stale last_updated frontmatter", () => {
    writeFileSync(join(tmpDir, ".mex/context/architecture.md"), frontmatter("architecture", "2026-05-01"));
    const result = checkHeartbeat(config, new Date("2026-05-14T00:00:00Z"));
    expect(result.ok).toBe(false);
    expect(result.staleFiles.map((f) => f.file)).toContain("context/architecture.md");
  });

  it("detects due memory cleanup and old daily memory files", () => {
    mkdirSync(join(tmpDir, "memory"), { recursive: true });
    writeFileSync(join(tmpDir, "memory/.last-cleanup.json"), JSON.stringify({ lastCleanup: "2026-05-01T00:00:00Z" }));
    writeFileSync(join(tmpDir, "memory/2026-04-20.md"), "# old");
    const result = checkHeartbeat(config, new Date("2026-05-14T00:00:00Z"));
    expect(result.memoryCleanupDue).toBe(true);
    expect(result.oldDailyMemoryFiles).toEqual(["memory/2026-04-20.md"]);
  });

  it("reports zero participating files when no scaffold file opts into staleness (#41)", () => {
    rmSync(join(tmpDir, ".mex/ROUTER.md"));
    writeFileSync(join(tmpDir, ".mex/ROUTER.md"), "---\nname: router\n---\n\n# Router\n");
    const result = checkHeartbeat(config, new Date("2026-05-14T00:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.filesWithoutLastUpdated).toBe(1);
  });

  it("omits filesWithoutLastUpdated once any file opts in", () => {
    writeFileSync(join(tmpDir, ".mex/context/architecture.md"), "---\nname: architecture\n---\n\nno date here\n");
    const result = checkHeartbeat(config, new Date("2026-05-14T00:00:00Z"));
    expect(result.filesWithoutLastUpdated).toBeUndefined();
  });

  it("keeps staleness active and the field absent when files carry dates", () => {
    const result = checkHeartbeat(config, new Date("2026-05-14T00:00:00Z"));
    expect(result.filesWithoutLastUpdated).toBeUndefined();
    expect(result.staleFiles).toEqual([]);
  });
});

function frontmatter(name: string, lastUpdated: string): string {
  return `---\nname: ${name}\nlast_updated: ${lastUpdated}\n---\n\n# ${name}\n`;
}

describe("zero-day heartbeat thresholds (#42)", () => {
  let zeroTmp: string;
  let zeroConfig: MexConfig;

  beforeEach(() => {
    zeroTmp = mkdtempSync(join(tmpdir(), "mex-heartbeat-zero-"));
    mkdirSync(join(zeroTmp, ".mex/context"), { recursive: true });
    zeroConfig = {
      projectRoot: zeroTmp,
      scaffoldRoot: join(zeroTmp, ".mex"),
      aiTools: [],
      heartbeat: { staleDays: 0, memoryCleanupDays: 0, dailyMemoryRetentionDays: 0 },
    };
  });

  afterEach(() => {
    rmSync(zeroTmp, { recursive: true, force: true });
  });

  it("flags a file dated yesterday as stale when staleDays is 0", () => {
    writeFileSync(join(zeroTmp, ".mex/ROUTER.md"), frontmatter("router", "2026-05-13"));
    const result = checkHeartbeat(zeroConfig, new Date("2026-05-14T00:00:00Z"));
    expect(result.staleFiles.map((f) => f.file)).toContain("ROUTER.md");
  });

  it("does not flag a file dated today when staleDays is 0", () => {
    writeFileSync(join(zeroTmp, ".mex/ROUTER.md"), frontmatter("router", "2026-05-14"));
    const result = checkHeartbeat(zeroConfig, new Date("2026-05-14T00:00:00Z"));
    expect(result.staleFiles).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("symlinked scaffold files (#40)", () => {
  it("counts a file reached through two glob paths exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-heartbeat-symlink-"));
    try {
      mkdirSync(join(root, ".mex/context"), { recursive: true });
      mkdirSync(join(root, ".mex/extra"), { recursive: true });
      const real = join(root, ".mex/context/architecture.md");
      writeFileSync(real, frontmatter("architecture", "2026-05-01"));
      // Same content reachable through a second pattern's directory.
      let linked = true;
      try {
        symlinkSync(real, join(root, ".mex/extra/architecture.md"));
      } catch {
        linked = false; // Windows without symlink privilege: skip assert
      }
      const result = checkHeartbeat({
        projectRoot: root,
        scaffoldRoot: join(root, ".mex"),
        aiTools: [],
      }, new Date("2026-05-14T00:00:00Z"));
      if (!linked) return;
      expect(result.staleFiles.filter((f) => f.file.endsWith("architecture.md"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
