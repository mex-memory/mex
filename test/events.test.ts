import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLog, readEvents, runTimeline } from "../src/events.js";
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

  it("reads valid events and skips malformed lines", () => {
    mkdirSync(join(tmpDir, ".mex/events"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".mex/events/decisions.jsonl"),
      `${JSON.stringify({ timestamp: "2026-05-14T00:00:00.000Z", kind: "note", message: "ok", files: [] })}\nnot-json\n`,
    );
    expect(readEvents(config)).toHaveLength(1);
  });

  it("timeline can emit JSON", async () => {
    await runLog(config, "hello", {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTimeline(config, { json: true });
    expect(spy.mock.calls.at(-1)?.[0]).toContain('"events"');
  });
});
