import { describe, expect, it } from "vitest";
import { SetupPopulationActivitySchema, SetupTranscriptBatchSchema } from "./setup.js";

const activity = {
  tool: "codex", startedAt: "2026-09-10T12:00:00.000Z", lastActivityAt: "2026-09-10T12:00:10.000Z",
  totalEvents: 1,
  events: [{ id: 1, at: "2026-09-10T12:00:10.000Z", kind: "writing", state: "completed", target: "architecture" }],
};

describe("setup activity boundary", () => {
  it.each(["claude", "codex"])("accepts only bounded %s activity summaries", (tool) => {
    expect(SetupPopulationActivitySchema.parse({ ...activity, tool })).toEqual({ ...activity, tool });
  });

  it("rejects raw provider content and arbitrary labels or paths", () => {
    for (const event of [
      { ...activity.events[0], text: "private output" },
      { ...activity.events[0], command: "private command" },
      { ...activity.events[0], kind: "Reading /private/project" },
      { ...activity.events[0], target: "/private/project" },
    ]) {
      expect(SetupPopulationActivitySchema.safeParse({ ...activity, events: [event] }).success).toBe(false);
    }
    expect(SetupPopulationActivitySchema.safeParse({ ...activity, session_id: "private session" }).success).toBe(false);
  });

  it("caps retained history and rejects unbounded counters and invalid dates", () => {
    expect(SetupPopulationActivitySchema.safeParse({ ...activity, events: Array(40).fill(activity.events[0]) }).success).toBe(true);
    expect(SetupPopulationActivitySchema.safeParse({ ...activity, events: Array(41).fill(activity.events[0]) }).success).toBe(false);
    expect(SetupPopulationActivitySchema.safeParse({ ...activity, totalEvents: Infinity }).success).toBe(false);
    expect(SetupPopulationActivitySchema.safeParse({ ...activity, lastActivityAt: "yesterday" }).success).toBe(false);
    expect(SetupPopulationActivitySchema.safeParse({ ...activity, lastActivityAt: null }).success).toBe(true);
  });
});

describe("setup transcript boundary", () => {
  const entry = { id: 1, at: "2026-09-10T12:00:00.000Z", kind: "assistant", text: "Actual output", truncated: false };
  const batch = { runId: "00000000-0000-4000-8000-000000000192", entries: [entry], cursor: 1, firstId: 1, truncated: false, done: false };
  it("accepts visible literal output while rejecting internal metadata and unknown channels", () => {
    expect(SetupTranscriptBatchSchema.parse(batch)).toEqual(batch);
    expect(SetupTranscriptBatchSchema.safeParse({ ...batch, entries: [{ ...entry, text: '<script>alert("plain text")</script>' }] }).success).toBe(true);
    for (const changed of [{ ...entry, kind: "reasoning" }, { ...entry, session_id: "private" }, { ...entry, usage: {} }]) {
      expect(SetupTranscriptBatchSchema.safeParse({ ...batch, entries: [changed] }).success).toBe(false);
    }
  });
  it("bounds pages and individual output before browser parsing", () => {
    expect(SetupTranscriptBatchSchema.safeParse({ ...batch, entries: Array(33).fill(entry) }).success).toBe(false);
    expect(SetupTranscriptBatchSchema.safeParse({ ...batch, entries: [{ ...entry, text: "x".repeat(4097) }] }).success).toBe(false);
    expect(SetupTranscriptBatchSchema.safeParse({ ...batch, cursor: Infinity }).success).toBe(false);
    expect(SetupTranscriptBatchSchema.safeParse({ ...batch, runId: "provider-session-id" }).success).toBe(false);
  });
});

describe("setup per-subsystem coverage", () => {
  const coverage = {
    phase: "subsystems", total: 2, done: 1, skipped: 0,
    subsystems: [{ path: "src/router", state: "done" }, { path: "src/jsx", state: "running" }],
  };

  it("accepts bounded per-subsystem progress and keeps it optional on a run", async () => {
    const { SetupPopulationCoverageSchema, SetupRunSchema } = await import("./setup.js");
    expect(SetupPopulationCoverageSchema.parse(coverage)).toEqual(coverage);
    const run = {
      status: "running", mode: "code-repo", stage: "needs_population", populated: false, ready: false, selectedTools: ["claude"],
      prompt: null, populationTool: null, populationCompleted: false, commitCommands: [], anchorNotes: [],
      message: "Running", progress: null, error: null, startedAt: null, finishedAt: null,
    };
    expect(SetupRunSchema.safeParse(run).success).toBe(true);
    expect(SetupRunSchema.safeParse({ ...run, populationCoverage: coverage }).success).toBe(true);
  });

  it("rejects unknown states, extra fields and unbounded lists", async () => {
    const { SetupPopulationCoverageSchema } = await import("./setup.js");
    expect(SetupPopulationCoverageSchema.safeParse({ ...coverage, subsystems: [{ path: "src/x", state: "lost" }] }).success).toBe(false);
    expect(SetupPopulationCoverageSchema.safeParse({ ...coverage, prompt: "private" }).success).toBe(false);
    expect(SetupPopulationCoverageSchema.safeParse({ ...coverage, subsystems: Array(65).fill(coverage.subsystems[0]) }).success).toBe(false);
  });
});
