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
});

function frontmatter(name: string, lastUpdated: string): string {
  return `---\nname: ${name}\nlast_updated: ${lastUpdated}\n---\n\n# ${name}\n`;
}
