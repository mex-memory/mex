import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendEvent, runLog, readEvents, runTimeline, type EventEntry, type TimelineOpts } from "../src/events.js";
import type { MexConfig } from "../src/types.js";

let tmpDir: string;
let config: MexConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-events-"));
  mkdirSync(join(tmpDir, ".mex"), { recursive: true });
  config = { projectRoot: tmpDir, scaffoldRoot: join(tmpDir, ".mex"), aiTools: [] };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeHistory(entries: Array<Partial<EventEntry> & Pick<EventEntry, "message">>): string {
  const path = join(tmpDir, ".mex/events/decisions.jsonl");
  mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
  writeFileSync(path, entries.map((entry) => JSON.stringify({
    timestamp: "2026-05-14T00:00:00.000Z", kind: "note", files: [], cwd: ".", ...entry,
  })).join("\n") + "\n");
  return path;
}

async function timeline(opts: TimelineOpts = {}) {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  await runTimeline(config, { ...opts, json: true });
  const output = spy.mock.calls.at(-1)![0] as string;
  spy.mockRestore();
  return { output, result: JSON.parse(output) as { events: EventEntry[]; truncated: boolean; sourceTruncated: boolean } };
}

describe("bounded relevant timeline", () => {
  it("combines literal subject, exact recorded files, kind, and date filters", async () => {
    writeHistory([
      { message: "Auth [v2] migration", kind: "decision", files: ["src/auth.ts"] },
      { message: "Auth [v2] rollback", kind: "decision", files: ["./src/session.ts"] },
      { message: "Auth [v2] neighboring file", kind: "decision", files: ["src/auth.tsx"] },
      { message: "Auth v2 is different literal text", kind: "decision", files: ["src/auth.ts"] },
      { message: "Auth [v2] risk", kind: "risk", files: ["src/auth.ts"] },
      { message: "Auth [v2] old", kind: "decision", files: ["src/auth.ts"], timestamp: "2026-04-01T00:00:00.000Z" },
      { message: "Auth [v2] bad date", kind: "decision", files: ["src/auth.ts"], timestamp: "unknown" },
    ]);
    const { result } = await timeline({
      query: "AUTH [v2]", files: [join(tmpDir, "src/auth.ts"), "src/nested/../session.ts"],
      kind: "decision", since: "2026-05-01",
    });
    expect(result).toEqual({
      events: [expect.objectContaining({ message: "Auth [v2] rollback" }), expect.objectContaining({ message: "Auth [v2] migration" })],
      truncated: false, sourceTruncated: false,
    });
    expect(readdirSync(tmpDir)).toEqual([".mex"]);
  });

  it("defaults to 20 complete recent entries and gives stable append-order ties", async () => {
    writeHistory(Array.from({ length: 25 }, (_, index) => ({ message: String(index) })));
    const first = await timeline();
    const second = await timeline();
    expect(first.output).toBe(second.output);
    expect(first.result.events.map((entry) => entry.message)).toEqual(Array.from({ length: 20 }, (_, index) => String(24 - index)));
    expect(first.result).toMatchObject({ truncated: true, sourceTruncated: false });
    expect((await timeline({ limit: 200 })).result.events).toHaveLength(25);
  });

  it("reports the finite recent scan even when there are no relevant matches", async () => {
    writeHistory(Array.from({ length: 10_001 }, (_, index) => ({ message: index === 0 ? "older subject" : "recent" })));
    expect((await timeline({ query: "older subject" })).result).toEqual({ events: [], truncated: false, sourceTruncated: true });
  });

  it("bounds scans by UTF-8 bytes and retains a complete trailing event", async () => {
    const path = writeHistory([{ message: "newest" }]);
    const tail = readFileSync(path, "utf8");
    writeFileSync(path, `${"x".repeat(8 * 1024 * 1024)}\n${tail}`);
    expect((await timeline()).result).toEqual({
      events: [expect.objectContaining({ message: "newest" })], truncated: false, sourceTruncated: true,
    });
  });

  it("bounds multibyte output and omits oversized entries without shortening claims", async () => {
    const message = "界".repeat(1000);
    writeHistory([
      ...Array.from({ length: 30 }, () => ({ message })),
      { message: "💡".repeat(20_000) },
    ]);
    const { output, result } = await timeline({ limit: 200 });
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.length).toBeLessThan(30);
    expect(result.events.every((entry) => entry.message === message)).toBe(true);
    expect(result).toMatchObject({ truncated: true, sourceTruncated: false });
  });

  it("does not modify history, create local state, or initialize an absent log", async () => {
    const absentEntries = readdirSync(config.scaffoldRoot);
    expect((await timeline({ query: "absent" })).result.events).toEqual([]);
    expect(readdirSync(config.scaffoldRoot)).toEqual(absentEntries);
    const path = writeHistory([{ message: "remember this", files: ["src/absent.ts"] }]);
    const bytes = readFileSync(path);
    const mtime = statSync(path, { bigint: true }).mtimeNs;
    const names = readdirSync(config.scaffoldRoot);
    await timeline({ files: ["src/absent.ts"] });
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(mtime);
    expect(readdirSync(config.scaffoldRoot)).toEqual(names);
  });

  it.each<TimelineOpts>([
    { kind: "checkpoint" }, { kind: "" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 },
    { limit: Number.NaN }, { query: " " }, { query: "💡".repeat(65) },
    { files: Array(17).fill("src/a.ts") }, { files: ["../outside.ts"] }, { files: [""] },
    { files: ["界".repeat(342)] }, { since: "2026-02-30" }, { since: "999999999999999d" }, { since: "" },
  ])("rejects invalid or excessive retrieval input before reading: %j", async (opts) => {
    await expect(runTimeline(config, opts)).rejects.toThrow();
    expect(readdirSync(config.scaffoldRoot)).toEqual([]);
  });
});

describe("events", () => {
  it("appends log entries as JSONL", async () => {
    await runLog(config, "captured a decision", { kind: "decision", files: ["ROUTER.md"] });
    const raw = readFileSync(join(tmpDir, ".mex/events/decisions.jsonl"), "utf-8").trim();
    const entry = JSON.parse(raw);
    expect(entry).toMatchObject({
      kind: "decision",
      message: "captured a decision",
      files: ["ROUTER.md"],
    });
  });

  it("round-trips source and status through appendEvent -> readEvents", () => {
    const written = appendEvent(config, "captured a call decision", {
      kind: "decision",
      source: "meeting",
      status: "decided",
    });
    expect(written).toMatchObject({ source: "meeting", status: "decided" });

    const [entry] = readEvents(config);
    expect(entry).toMatchObject({
      kind: "decision",
      message: "captured a call decision",
      source: "meeting",
      status: "decided",
    });
  });

  it("omits source and status when not provided (backward compatible)", () => {
    appendEvent(config, "plain note", {});
    const [entry] = readEvents(config);
    expect(entry).not.toHaveProperty("source");
    expect(entry).not.toHaveProperty("status");
  });

  it("reads valid events and skips malformed lines", () => {
    mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".mex/events/decisions.jsonl"),
      `${JSON.stringify({ timestamp: "2026-05-14T00:00:00.000Z", kind: "note", message: "ok", files: [] })}\nnot-json\n`,
    );
    expect(readEvents(config)).toHaveLength(1);
  });

  it("bounds legacy timeline projection to the newest 10,000 records", () => {
    mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
    const lines = Array.from({ length: 10_001 }, (_, index) => JSON.stringify({
      timestamp: "2026-05-14T00:00:00.000Z",
      kind: "note",
      message: String(index),
      files: [],
    }));
    writeFileSync(join(tmpDir, ".mex/events/decisions.jsonl"), `${lines.join("\n")}\n`);

    const events = readEvents(config);
    expect(events).toHaveLength(10_000);
    expect(events[0]?.message).toBe("1");
    expect(events.at(-1)?.message).toBe("10000");
  });

  it("timeline can emit JSON", async () => {
    await runLog(config, "hello", {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { json: true });
    expect(spy.mock.calls.at(-1)?.[0]).toContain('"events"');
  });

  it("timeline --format md emits a valid Markdown table (#55)", async () => {
    await runLog(config, "chose | the | bounded resolver", { kind: "decision", files: ["ROUTER.md"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { format: "md" });
    const lines = spy.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toBe("| Date | Type | Event | Files |");
    expect(lines[1]).toBe("|---|---|---|---|");
    const row = lines[2]!;
    expect(row).toMatch(/^\| \d{4}-\d{2}-\d{2} \| decision \| /);
    expect(row).toContain("chose \\| the \\| bounded resolver");
    expect(row).toContain("`ROUTER.md`");
  });

  it("timeline --format md emits a placeholder for an empty log", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { format: "md" });
    expect(spy.mock.calls.at(-1)?.[0]).toBe("_No events found._");
  });

  it("timeline default output is unchanged when --format is absent", async () => {
    await runLog(config, "plain note", { kind: "note" });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, {});
    const rendered = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(rendered).toContain("plain note");
    expect(rendered).not.toContain("|---");
  });
});
