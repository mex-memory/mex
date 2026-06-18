/**
 * Public API smoke test.
 *
 * This file imports ONLY from src/index.ts — the same surface that
 * package.json's `exports` field publishes. Its job is to fail when someone
 * accidentally renames, removes, or reshapes a public-facing export.
 *
 * See COMPATIBILITY.md at the repo root for the contract this test enforces.
 * Any change here is a breaking change — bump the major version and update
 * the doc.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  // functions
  appendEvent,
  readEvents,
  eventLogPath,
  runDriftCheck,
  checkHeartbeat,
  runHeartbeat,
  parseFrontmatter,
  findConfig,
  createConfig,
  getScaffoldIdentity,

  // runtime constants
  EVENT_KINDS,
  DEFAULT_STALENESS_THRESHOLDS,
  DEFAULT_SCAFFOLD_PATTERNS,
  DEFAULT_HEARTBEAT_PATTERNS,

  // types (compile-time only — verified by usage below)
  type MexConfig,
  type EventEntry,
  type EventKind,
  type LogOpts,
  type DriftReport,
  type HeartbeatResult,
  type CreateConfigInput,
  type RunDriftCheckOpts,
  type StalenessThresholds,
  type ScaffoldFrontmatter,
  type ScaffoldIdentity,
} from "../src/index.js";

let tmpDir: string;
let config: MexConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-public-api-"));
  mkdirSync(join(tmpDir, ".mex"), { recursive: true });
  config = createConfig({
    projectRoot: tmpDir,
    scaffoldRoot: join(tmpDir, ".mex"),
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("public API — function exports", () => {
  it("exports the functions embedders depend on", () => {
    expect(typeof appendEvent).toBe("function");
    expect(typeof readEvents).toBe("function");
    expect(typeof eventLogPath).toBe("function");
    expect(typeof runDriftCheck).toBe("function");
    expect(typeof checkHeartbeat).toBe("function");
    expect(typeof runHeartbeat).toBe("function");
    expect(typeof parseFrontmatter).toBe("function");
    expect(typeof findConfig).toBe("function");
    expect(typeof createConfig).toBe("function");
    expect(typeof getScaffoldIdentity).toBe("function");
  });
});

describe("public API — getScaffoldIdentity", () => {
  it("mints and returns a ScaffoldIdentity with the documented shape", () => {
    const identity: ScaffoldIdentity = getScaffoldIdentity(config);
    expect(typeof identity.scaffold_id).toBe("string");
    expect(identity.scaffold_id.length).toBeGreaterThan(0);
    expect(typeof identity.scaffold_name).toBe("string");
    expect(identity.origin).toBeNull();
    expect(identity.upstream).toBeNull();
  });
});

describe("public API — runtime constants", () => {
  it("exports EVENT_KINDS as an array of valid kinds", () => {
    expect(Array.isArray(EVENT_KINDS)).toBe(true);
    expect(EVENT_KINDS).toContain("decision");
    expect(EVENT_KINDS).toContain("note");
    expect(EVENT_KINDS).toContain("risk");
    expect(EVENT_KINDS).toContain("todo");
  });

  it("exports DEFAULT_STALENESS_THRESHOLDS with the documented shape", () => {
    const t: StalenessThresholds = DEFAULT_STALENESS_THRESHOLDS;
    expect(typeof t.warnDays).toBe("number");
    expect(typeof t.errorDays).toBe("number");
    expect(typeof t.warnCommits).toBe("number");
    expect(typeof t.errorCommits).toBe("number");
  });

  it("exports DEFAULT_SCAFFOLD_PATTERNS as a non-empty list", () => {
    expect(Array.isArray(DEFAULT_SCAFFOLD_PATTERNS)).toBe(true);
    expect(DEFAULT_SCAFFOLD_PATTERNS.length).toBeGreaterThan(0);
  });

  it("exports DEFAULT_HEARTBEAT_PATTERNS as a non-empty list", () => {
    expect(Array.isArray(DEFAULT_HEARTBEAT_PATTERNS)).toBe(true);
    expect(DEFAULT_HEARTBEAT_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("public API — createConfig", () => {
  it("builds a usable MexConfig from minimal input", () => {
    const input: CreateConfigInput = {
      projectRoot: tmpDir,
      scaffoldRoot: join(tmpDir, ".mex"),
    };
    const c = createConfig(input);
    expect(c.projectRoot).toBe(tmpDir);
    expect(c.scaffoldRoot).toBe(join(tmpDir, ".mex"));
    expect(c.aiTools).toEqual([]);
  });

  it("rejects relative paths to prevent silent breakage", () => {
    expect(() =>
      createConfig({ projectRoot: "relative/path", scaffoldRoot: join(tmpDir, ".mex") }),
    ).toThrow(/projectRoot must be an absolute path/);
    expect(() =>
      createConfig({ projectRoot: tmpDir, scaffoldRoot: "relative/path" }),
    ).toThrow(/scaffoldRoot must be an absolute path/);
  });
});

describe("public API — appendEvent / readEvents round-trip", () => {
  it("persists a decision event and reads it back with the documented shape", () => {
    const written: EventEntry = appendEvent(config, "JWT over sessions", {
      kind: "decision",
      files: ["src/auth.ts"],
    });
    expect(written.kind).toBe("decision");
    expect(written.message).toBe("JWT over sessions");
    // Normalize separators so the test is path-agnostic across OSes —
    // appendEvent uses `path.relative` internally, which emits backslashes on Windows.
    expect(written.files.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/auth.ts"]);
    expect(typeof written.timestamp).toBe("string");

    const events = readEvents(config);
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("JWT over sessions");
    expect(events[0].kind).toBe("decision");

    // eventLogPath should point at a real file under scaffoldRoot
    expect(eventLogPath(config)).toContain(".mex");
  });

  it("accepts every kind in EVENT_KINDS", () => {
    for (const kind of EVENT_KINDS) {
      const k: EventKind = kind;
      appendEvent(config, `event for ${k}`, { kind: k });
    }
    expect(readEvents(config)).toHaveLength(EVENT_KINDS.length);
  });

  it("persists and reads back the optional trace field", () => {
    const tracePath = ".mex/traces/2026-05-15-jwt.md";
    const opts: LogOpts = {
      kind: "decision",
      trace: tracePath,
    };
    const written = appendEvent(config, "Use JWT over sessions", opts);
    expect(written.trace).toBe(tracePath);

    const events = readEvents(config);
    expect(events).toHaveLength(1);
    expect(events[0].trace).toBe(tracePath);
  });

  it("omits the trace field when not provided", () => {
    const written = appendEvent(config, "Plain note", { kind: "note" });
    expect(written.trace).toBeUndefined();

    const events = readEvents(config);
    expect(events).toHaveLength(1);
    expect(events[0].trace).toBeUndefined();
  });
});

describe("public API — parseFrontmatter", () => {
  it("reads YAML frontmatter from a markdown file", () => {
    const file = join(tmpDir, "page.md");
    writeFileSync(
      file,
      "---\nname: example\ndescription: a doc\nlast_updated: 2026-05-14\n---\n\nbody\n",
    );
    const fm: ScaffoldFrontmatter | null = parseFrontmatter(file);
    expect(fm).not.toBeNull();
    expect(fm?.name).toBe("example");
    expect(fm?.description).toBe("a doc");
    expect(fm?.last_updated).toBe("2026-05-14");
  });

  it("returns null for files that don't exist", () => {
    expect(parseFrontmatter(join(tmpDir, "missing.md"))).toBeNull();
  });
});

describe("public API — runDriftCheck", () => {
  it("runs on an empty scaffold and returns a DriftReport", async () => {
    // Minimum scaffold so runDriftCheck has something to scan
    writeFileSync(join(tmpDir, ".mex/ROUTER.md"), "# Router\n");
    const report: DriftReport = await runDriftCheck(config);
    expect(typeof report.score).toBe("number");
    expect(Array.isArray(report.issues)).toBe(true);
    expect(typeof report.filesChecked).toBe("number");
    expect(typeof report.timestamp).toBe("string");
  });

  it("accepts scaffoldPatterns override without throwing", async () => {
    const opts: RunDriftCheckOpts = {
      scaffoldPatterns: [...DEFAULT_SCAFFOLD_PATTERNS, "traces/**/*.md"],
    };
    const report = await runDriftCheck(config, opts);
    expect(report).toBeDefined();
  });
});

describe("public API — heartbeat", () => {
  it("checkHeartbeat returns the documented HeartbeatResult shape", () => {
    const result: HeartbeatResult = checkHeartbeat(config);
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.staleFiles)).toBe(true);
    expect(typeof result.memoryCleanupDue).toBe("boolean");
    expect(Array.isArray(result.oldDailyMemoryFiles)).toBe(true);
  });

  it("checkHeartbeat accepts a scaffoldPatterns override", () => {
    const result = checkHeartbeat(config, new Date(), {
      scaffoldPatterns: [...DEFAULT_HEARTBEAT_PATTERNS, "traces/**/*.md"],
    });
    expect(result).toBeDefined();
  });
});
