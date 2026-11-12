import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRecord, openRecordReadOnly, schemaVersion, migrateRecord, type RecordWriter } from "../index.js";
import { recordMigrations } from "../schema.js";
import { createCallUsage, modelCallTotals, recordModelCall } from "../usage.js";
import { ownUsageStatus, ownUsageTotals, refreshOwnUsage as refreshAt, usageWindows, type OwnUsageOptions } from "../own-usage.js";

// Fixture events are dated early January 2026; the reader's window is measured from this clock.
const FIXTURE_NOW = new Date("2026-01-03T00:00:00Z");
const refreshOwnUsage = (target: RecordWriter, options: OwnUsageOptions = {}) => refreshAt(target, { now: FIXTURE_NOW, ...options });

let home: string, claude: string, codex: string, writer: RecordWriter;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mex-usage-"));
  claude = join(home, "claude"); codex = join(home, "codex");
  vi.stubEnv("MEX_HOME", home); vi.stubEnv("CLAUDE_CONFIG_DIR", claude); vi.stubEnv("CODEX_HOME", codex);
  writer = openRecord({ home: join(home, "record"), isNetwork: () => false });
});
afterEach(() => { writer.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const day1 = "2026-01-01T23:59:00Z", day2 = "2026-01-02T00:01:00Z";
function file(root: string, path: string, events: unknown[]): string {
  const name = join(root, path); mkdirSync(join(name, ".."), { recursive: true });
  writeFileSync(name, events.map((e) => JSON.stringify(e)).join("\n") + "\n"); return name;
}
function assistant(id: string, input: number, write: number, read: number, output: number, timestamp = day1) {
  return { type: "assistant", timestamp, requestId: `req-${id}`, message: { id, role: "assistant", model: "fixture-model",
    content: [{ type: "text", text: "synthetic" }], usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output } } };
}
function token(input: number, cached: number, output: number, timestamp = day1) {
  return { timestamp, type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 3 },
    last_token_usage: { input_tokens: 99999, output_tokens: 99999 },
  }, rate_limits: { primary: { used_percent: 62, resets_at: 1767312000 } } } };
}
function reader() {
  // Read through the public read-only API, not a write-capable SQL facade.
  return { all: <T>(sql: string, ...args: import("node:sqlite").SQLInputValue[]) => {
    const opened = openRecordReadOnly({ home: writer.location.home })!;
    try { return opened.all<T>(sql, ...args); } finally { opened.close(); }
  } };
}

describe("own usage with hand counts", () => {
  it("deduplicates Claude blocks, includes subagents, ignores no-usage and synthetic errors, and uses UTC", () => {
    const first = assistant("a", 10, 20, 30, 4);
    file(claude, "projects/p/main.jsonl", [first, first, { ...first, message: { ...first.message, content: [{ type: "text", text: "another block" }] } },
      { type: "assistant", timestamp: day1, message: { role: "assistant", id: "no-usage" } },
      { ...assistant("error", 800, 900, 900, 900), isApiErrorMessage: true },
      { ...assistant("synthetic", 900, 900, 900, 900), isSynthetic: true },
      assistant("c", 5, 2, 7, 8, "2026-01-01T19:01:00-05:00")]);
    file(claude, "projects/p/session/subagents/agent-a.jsonl", [assistant("sub", 3, 4, 5, 6)]);
    const statuses = refreshOwnUsage(writer);
    expect(statuses[0].status).toBe("readable");
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-02")).toEqual([
      { day: "2026-01-01", agent: "claude", input: 13, cache_write: 24, cache_read: 35, output: 10, estimated: 0 },
      { day: "2026-01-02", agent: "claude", input: 5, cache_write: 2, cache_read: 7, output: 8, estimated: 0 },
    ]);
    refreshOwnUsage(writer); expect(writer.db.prepare("SELECT count(*) n FROM usage_events").get()!.n).toBe(3);
  });
  it("uses Codex cumulative totals across events and resumed/archived files; reasoning is not added twice", () => {
    const meta = { type: "session_meta", timestamp: day1, payload: { id: "session-a" } };
    file(codex, "sessions/2026/01/rollout-a.jsonl", [meta, token(100, 40, 10), token(150, 60, 30), token(150, 60, 30)]);
    file(codex, "archived_sessions/rollout-resumed.jsonl", [meta, token(150, 60, 30), token(220, 90, 50, day2)]);
    refreshOwnUsage(writer);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-02")).toEqual([
      { day: "2026-01-01", agent: "codex", input: 90, cache_write: 0, cache_read: 60, output: 30, estimated: 0 },
      { day: "2026-01-02", agent: "codex", input: 40, cache_write: 0, cache_read: 30, output: 20, estimated: 0 },
    ]);
    refreshOwnUsage(writer);
    expect(writer.db.prepare("SELECT sum(output) n FROM own_usage").get()!.n).toBe(50);
    expect(usageWindows(reader())).toEqual([{ agent: "codex", window: "primary", observed_at: "2026-01-02T00:01:00.000Z", used_percent: 62, resets_at: "2026-01-02T00:00:00.000Z", status: null }]);
  });
  it("corrects daily attribution when a newer archived rollout is discovered before older sessions", () => {
    const meta = { type: "session_meta", timestamp: day1, payload: { id: "session-order" } };
    file(codex, "archived_sessions/rollout-new.jsonl", [meta, token(220, 90, 50, day2)]);
    refreshOwnUsage(writer);
    file(codex, "sessions/rollout-old.jsonl", [meta, token(150, 60, 30)]);
    refreshOwnUsage(writer);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-02")).toEqual([
      { day: "2026-01-01", agent: "codex", input: 90, cache_write: 0, cache_read: 60, output: 30, estimated: 0 },
      { day: "2026-01-02", agent: "codex", input: 40, cache_write: 0, cache_read: 30, output: 20, estimated: 0 },
    ]);
  });
  it("does not recount after restart, append, truncation, same-size rewrite or rotation", () => {
    const path = file(claude, "projects/p/a.jsonl", [assistant("a", 1, 2, 3, 4)]);
    refreshOwnUsage(writer); writer.close(); writer = openRecord({ home: join(home, "record") });
    refreshOwnUsage(writer);
    appendFileSync(path, JSON.stringify(assistant("b", 2, 3, 4, 5)) + "\n"); refreshOwnUsage(writer);
    writeFileSync(path, JSON.stringify(assistant("a", 1, 2, 3, 4)) + "\n"); refreshOwnUsage(writer);
    writeFileSync(path, JSON.stringify(assistant("c", 1, 2, 3, 4)) + "\n"); refreshOwnUsage(writer);
    renameSync(path, `${path}.old`); file(claude, "projects/p/a.jsonl", [assistant("c", 1, 2, 3, 4), assistant("d", 5, 6, 7, 8)]);
    refreshOwnUsage(writer); refreshOwnUsage(writer);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toEqual([
      { day: "2026-01-01", agent: "claude", input: 9, cache_write: 13, cache_read: 17, output: 21, estimated: 0 },
    ]);
  });
  it("retires a fully consumed rotated path while preserving global deduplication", () => {
    const path = file(codex, "sessions/rollout-a.jsonl", [{ type: "session_meta", timestamp: day1, payload: { id: "rotated" } }, token(100, 40, 10)]);
    refreshOwnUsage(writer);
    mkdirSync(join(codex, "archived_sessions")); renameSync(path, join(codex, "archived_sessions/rollout-a.jsonl"));
    expect(refreshOwnUsage(writer)[1].status).toBe("readable");
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toEqual([
      { day: "2026-01-01", agent: "codex", input: 60, cache_write: 0, cache_read: 40, output: 10, estimated: 0 },
    ]);
  });
  it("holds a half-written last line and picks it up exactly once", () => {
    const path = file(claude, "projects/p/a.jsonl", [assistant("a", 1, 0, 0, 1)]);
    const next = JSON.stringify(assistant("b", 2, 0, 0, 3));
    appendFileSync(path, next.slice(0, 90)); refreshOwnUsage(writer);
    expect(writer.db.prepare("SELECT output FROM own_usage").get()!.output).toBe(1);
    appendFileSync(path, next.slice(90) + "\n"); refreshOwnUsage(writer); refreshOwnUsage(writer);
    expect(writer.db.prepare("SELECT output FROM own_usage").get()!.output).toBe(4);
  });
  it("rolls back a failed batch's cursor and dedup keys together with its totals", () => {
    file(claude, "projects/p/a.jsonl", [assistant("atomic", 3, 4, 5, 6)]);
    writer.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON own_usage BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect(refreshOwnUsage(writer)[0].status).toBe("unreadable");
    expect(writer.db.prepare("SELECT count(*) n FROM usage_events").get()!.n).toBe(0);
    expect(writer.db.prepare("SELECT offset FROM usage_files").get()!.offset).toBe(0);
    writer.db.exec("DROP TRIGGER fail_usage"); refreshOwnUsage(writer); refreshOwnUsage(writer);
    expect(writer.db.prepare("SELECT output FROM own_usage").get()!.output).toBe(6);
  });
  it("reports an unreadable file and a missing response identity instead of manufacturing tokens", () => {
    const path = file(claude, "projects/p/a.jsonl", [{ ...assistant("missing-key", 10, 20, 30, 40), requestId: undefined }]);
    expect(refreshOwnUsage(writer)[0].status).toBe("unreadable");
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toEqual([]);
    renameSync(path, `${path}.unavailable`);
    expect(refreshOwnUsage(writer)[0].status).toBe("unreadable");
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toEqual([]);
  });
  it("caps files and bytes, resumes discovery and big files, and never saves transcript text", () => {
    for (let i = 0; i < 3; i++) file(claude, `projects/p/${i}.jsonl`, Array.from({ length: 250 }, (_, j) => assistant(`${i}-${j}`, 1, 0, 0, 1)));
    let pending = true, runs = 0;
    while (pending && runs++ < 35) {
      const status = refreshOwnUsage(writer, { maxFiles: 1, maxBytes: 64 * 1024, maxDiscoveryEntries: 2 });
      expect(status.reduce((n, s) => n + s.files, 0)).toBeLessThanOrEqual(1);
      expect(status.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(64 * 1024);
      pending = Number(writer.db.prepare("SELECT coalesce(sum(output),0) n FROM own_usage").get()!.n) < 750;
    }
    expect(pending).toBe(false);
    expect(writer.db.prepare("SELECT sum(output) n FROM own_usage").get()!.n).toBe(750);
    const metadata = JSON.stringify(writer.db.prepare("SELECT * FROM usage_files").all());
    expect(metadata).not.toContain("synthetic");
  });
  it("finishes a bounded catalog cycle instead of keeping large catalogs permanently partial", () => {
    for (let i = 0; i < 3; i++) file(claude, `projects/p/${i}.jsonl`, [assistant(`cycle-${i}`, 1, 0, 0, 1)]);
    expect(refreshOwnUsage(writer, { maxFiles: 1 })[0].status).toBe("partial");
    expect(refreshOwnUsage(writer, { maxFiles: 1 })[0].status).toBe("partial");
    expect(refreshOwnUsage(writer, { maxFiles: 1 })[0].status).toBe("readable");
    expect(writer.db.prepare("SELECT output FROM own_usage").get()!.output).toBe(3);
  });
  it("reports missing logs as unreadable, skips new line types, honors the two environment homes, and records Claude plan room", () => {
    expect(refreshOwnUsage(writer).map((s) => s.status)).toEqual(["unreadable", "unreadable"]);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-02")).toEqual([]);
    // A line type the reader has never seen is skipped and counted, not an unknown format.
    file(codex, "sessions/rollout-unknown.jsonl", [{ timestamp: day1, type: "new-format", arbitrary: 999 }]);
    file(claude, "projects/p/a.jsonl", [assistant("a", 1, 0, 0, 1), { timestamp: day1, type: "rate_limit_event",
      rate_limit_info: { rateLimitType: "five_hour", utilization: 0.75, resetsAt: 1767312000, status: "allowed_warning" } }]);
    const result = refreshOwnUsage(writer);
    expect(result.map((s) => s.status)).toEqual(["readable", "readable"]);
    expect(result[1]).toMatchObject({ usageLines: 0, skippedLines: 1, problemLines: 0 });
    expect(ownUsageStatus({ setting: writer.setting.bind(writer) })).toEqual(result);
    expect(usageWindows(reader())[0]).toMatchObject({ agent: "claude", used_percent: 75, status: "allowed_warning" });
  });
});

describe("own usage under agent format changes and long histories", () => {
  it("keeps exact totals through a transcript full of line types it has never seen", () => {
    const unknown = (n: number) => ({ timestamp: day1, type: `future-type-${n}`, payload: { nested: { anything: n } } });
    file(claude, "projects/p/a.jsonl", [unknown(1), assistant("a", 10, 1, 2, 3), unknown(2), unknown(3),
      { type: "attachment", timestamp: day1 }, assistant("b", 20, 0, 4, 5), "not an object", unknown(4)]);
    file(codex, "sessions/rollout-a.jsonl", [{ timestamp: day1, type: "session_meta", payload: { id: "s1" } }, unknown(5),
      { timestamp: day1, type: "event_msg", payload: { type: "agent_reasoning_new_kind" } }, token(100, 40, 9), unknown(6)]);
    const result = refreshOwnUsage(writer);
    expect(result.map((s) => s.status)).toEqual(["readable", "readable"]);
    expect(result[0]).toMatchObject({ usageLines: 2, skippedLines: 6, problemLines: 0 });
    expect(result[1]).toMatchObject({ usageLines: 1, problemLines: 0 });
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toEqual([
      { day: "2026-01-01", agent: "claude", input: 30, cache_write: 1, cache_read: 6, output: 8, estimated: 0 },
      { day: "2026-01-01", agent: "codex", input: 60, cache_write: 0, cache_read: 40, output: 9, estimated: 0 },
    ]);
  });
  it("counts a broken usage line as a problem, and only a log with no readable usage is unreadable", () => {
    const broken = { ...assistant("x", 1, 0, 0, 1), requestId: undefined };
    file(claude, "projects/p/a.jsonl", [broken]);
    expect(refreshOwnUsage(writer)[0]).toMatchObject({ status: "unreadable", reason: "unknown-format", problemLines: 1 });
    file(claude, "projects/p/b.jsonl", [assistant("y", 1, 0, 0, 1)]);
    expect(refreshOwnUsage(writer)[0]).toMatchObject({ status: "readable", usageLines: 1, problemLines: 1 });
  });
  it("counts a response repeated by a resumed session in a new file once", () => {
    file(claude, "projects/p/first.jsonl", [assistant("a", 5, 1, 1, 2), assistant("b", 7, 0, 0, 1)]);
    refreshOwnUsage(writer);
    // A resumed session's new transcript repeats earlier responses before adding its own.
    file(claude, "projects/p/resumed.jsonl", [assistant("a", 5, 1, 1, 2), assistant("b", 7, 0, 0, 1), assistant("c", 3, 0, 0, 1)]);
    refreshOwnUsage(writer); refreshOwnUsage(writer);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toEqual([
      { day: "2026-01-01", agent: "claude", input: 15, cache_write: 1, cache_read: 1, output: 4, estimated: 0 }]);
  });
  it("never crawls logs older than the window, skips lines past the horizon, and prunes dedup rows", () => {
    const old = file(claude, "projects/p/old.jsonl", [assistant("old", 100, 0, 0, 100)]);
    const past = new Date("2025-10-01T00:00:00Z");
    utimesSync(old, past, past);
    file(claude, "projects/p/new.jsonl", [assistant("new", 1, 0, 0, 1), assistant("ancient", 50, 0, 0, 50, "2025-11-01T00:00:00Z")]);
    const status = refreshOwnUsage(writer);
    expect(status[0]).toMatchObject({ files: 1, usageLines: 1, skippedLines: 1 });
    expect(writer.db.prepare("SELECT count(*) n FROM usage_files WHERE path=?").get(old)!.n).toBe(0);
    expect(ownUsageTotals(reader(), "2025-01-01", "2026-12-31")).toEqual([
      { day: "2026-01-01", agent: "claude", input: 1, cache_write: 0, cache_read: 0, output: 1, estimated: 0 }]);
    // Fifty days later the dedup row is gone; the daily total stays.
    refreshAt(writer, { now: new Date("2026-02-22T00:00:00Z") });
    expect(writer.db.prepare("SELECT count(*) n FROM usage_events WHERE agent='claude'").get()!.n).toBe(0);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")).toHaveLength(1);
  });
  it("keeps a Codex session's earlier snapshots while it spans the horizon, so later days are not inflated", () => {
    const meta = { timestamp: "2025-11-15T00:00:00Z", type: "session_meta", payload: { id: "long" } };
    file(codex, "sessions/rollout-long.jsonl", [meta, token(100, 0, 10, "2025-11-15T00:00:00Z"), token(130, 0, 12, day1)]);
    refreshOwnUsage(writer);
    // 2025-11-15 is past the horizon: it is only the baseline; 2026-01-01 gets the difference.
    expect(ownUsageTotals(reader(), "2025-01-01", "2026-12-31")).toEqual([
      { day: "2026-01-01", agent: "codex", input: 30, cache_write: 0, cache_read: 0, output: 2, estimated: 0 }]);
    refreshOwnUsage(writer);
    expect(ownUsageTotals(reader(), "2026-01-01", "2026-01-01")[0]).toMatchObject({ input: 30, output: 2 });
  });
});

describe("MEX call accounting", () => {
  it("survives restart and groups UTC day, agent, purpose and all classes over a range", () => {
    const options = { home: writer.location.home };
    expect(recordModelCall({ purpose: "setup", agent: "claude", model: "fixture", input: 1, cache_write: 2, cache_read: 3, output: 4, estimated: false, timestamp: day1 }, options)).toBe(true);
    expect(recordModelCall({ purpose: "setup", agent: "claude", model: "fixture", input: 2, cache_write: 3, cache_read: 4, output: 5, estimated: true, timestamp: day1 }, options)).toBe(true);
    expect(recordModelCall({ purpose: "repair", agent: "codex", model: "unknown", input: 3, cache_write: 0, cache_read: 1, output: 6, estimated: false, timestamp: day2 }, options)).toBe(true);
    expect(modelCallTotals(reader(), "2026-01-01", "2026-01-02")).toEqual([
      { day: "2026-01-01", agent: "claude", purpose: "setup", kind: "headless", input: 3, cache_write: 5, cache_read: 7, output: 9, estimated: 1, calls: 2 },
      { day: "2026-01-02", agent: "codex", purpose: "repair", kind: "headless", input: 3, cache_write: 0, cache_read: 1, output: 6, estimated: 0, calls: 1 },
    ]);
  });
  it("fails open for broken storage, invalid input and a throwing warning sink", () => {
    const warn = vi.fn();
    const call = { purpose: "setup", agent: "claude", model: "fixture", input: 1, cache_write: 0, cache_read: 0, output: 1, estimated: false };
    const broken = join(home, "broken"); writeFileSync(broken, "not a directory");
    expect(recordModelCall(call, { home: broken, warn })).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith("MEX could not record model usage; the command continues.");
    expect(() => recordModelCall({ ...call, input: -1 }, { warn: () => { throw new Error("observer"); } })).not.toThrow();
  });
  it("warns and continues when another real connection holds the writer lock", () => {
    const lock = new DatabaseSync(writer.location.record); lock.exec("BEGIN IMMEDIATE");
    const warn = vi.fn();
    try {
      expect(recordModelCall({ purpose: "setup", agent: "claude", model: "fixture", input: 1, cache_write: 0, cache_read: 0, output: 1, estimated: false }, { home: writer.location.home, warn })).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally { lock.exec("ROLLBACK"); lock.close(); }
  });
  it("takes Claude terminal totals, Codex turn totals and estimates unreported output without retaining it", () => {
    const c = createCallUsage("claude", "sent");
    c.write(Buffer.from(JSON.stringify({ ...assistant("a", 1, 2, 3, 4), model: "fixture" }) + "\n"));
    c.write(Buffer.from(JSON.stringify({ type: "result", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } })));
    expect(c.finish()).toEqual({ input: 10, cache_write: 20, cache_read: 30, output: 40, model: "fixture-model", estimated: false });
    const x = createCallUsage("codex", "sent");
    for (const usage of [{ input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 }, { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 }]) {
      x.write(Buffer.from(JSON.stringify({ type: "turn.started" }) + "\n" + JSON.stringify({ type: "turn.completed", usage }) + "\n"));
    }
    expect(x.finish()).toEqual({ input: 90, cache_write: 0, cache_read: 60, output: 15, model: "unknown", estimated: false });
    const unknown = createCallUsage("copilot", "12345"); unknown.write(Buffer.from("123456789"));
    expect(unknown.finish()).toMatchObject({ input: 2, output: 3, estimated: true });
  });
  it("keeps a complete Claude per-model breakdown separate from its terminal aggregate", () => {
    const collector = createCallUsage("claude", "synthetic");
    collector.write(Buffer.from(JSON.stringify({ type: "result", usage: { input_tokens: 3, output_tokens: 7 }, modelUsage: {
      "fixture-a": { inputTokens: 1, outputTokens: 3 }, "fixture-b": { inputTokens: 2, outputTokens: 4 },
    } })));
    expect(collector.finish().byModel).toEqual([
      { model: "fixture-a", input: 1, output: 3, cache_read: 0, cache_write: 0, estimated: false },
      { model: "fixture-b", input: 2, output: 4, cache_read: 0, cache_write: 0, estimated: false },
    ]);
  });
  it("migrates a step-1 file to 2 without losing calls, own usage, project or settings", () => {
    const directory = join(home, "old"); mkdirSync(directory);
    const db = new DatabaseSync(join(directory, "record.db")); db.exec(recordMigrations[0].sql);
    db.exec(`PRAGMA user_version=1; INSERT INTO settings VALUES('global','kept','yes');
      INSERT INTO projects VALUES('fixture','path','folder',0,'now');
      INSERT INTO model_calls VALUES(1,'2026-01-01T00:00:00Z','fixture','setup','claude','fixture',1,2,3,4,0);
      INSERT INTO own_usage VALUES('2026-01-01','claude',5,6,7,8,0)`); db.close();
    const upgraded = openRecord({ home: directory, isNetwork: () => false });
    try {
      expect(schemaVersion(upgraded.db)).toBe(2); expect(upgraded.setting("global", "kept")).toBe("yes");
      expect(upgraded.project("fixture")).toBeDefined();
      expect(upgraded.db.prepare("SELECT output FROM model_calls").get()!.output).toBe(4);
      expect(upgraded.db.prepare("SELECT output FROM own_usage").get()!.output).toBe(8);
    } finally { upgraded.close(); }
  });
  it("rolls migration 2 back to 1 when its SQL fails halfway", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateRecord(db, [recordMigrations[0]]);
      db.exec("INSERT INTO settings VALUES('global','kept','yes')");
      expect(() => migrateRecord(db, [{ version: 2, sql: "CREATE TABLE half_done(n); INSERT INTO missing VALUES(1)" }])).toThrow();
      expect(schemaVersion(db)).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='half_done'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM settings WHERE key='kept'").get()!.value).toBe("yes");
    } finally { db.close(); }
  });
});
