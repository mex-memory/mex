import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  ErrorScreen,
  HeartbeatPanel,
  Summary,
  TimelinePanel,
  eventActivityBars,
  progressBar,
  type DashboardData,
} from "../src/tui.js";

const h = React.createElement;

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    report: {
      score: 100,
      issues: [],
      filesChecked: 3,
      timestamp: "2026-05-14T00:00:00.000Z",
    },
    heartbeat: {
      ok: true,
      staleFiles: [],
      memoryCleanupDue: false,
      oldDailyMemoryFiles: [],
    },
    events: [],
    ...overrides,
  };
}

describe("TUI components", () => {
  it("renders healthy dashboard summary", () => {
    const app = render(h(Summary, { data: data(), notice: null }));
    expect(app.lastFrame()).toContain("Drift");
    expect(app.lastFrame()).toContain("100/100");
    expect(app.lastFrame()).toContain("Heartbeat OK");
    expect(app.lastFrame()).toContain("████");
  });

  it("renders drift warnings and errors in summary", () => {
    const app = render(h(Summary, {
      data: data({
        report: {
          score: 77,
          issues: [
            { code: "MISSING_PATH", severity: "error", file: "ROUTER.md", line: null, message: "missing" },
            { code: "STALE_FILE", severity: "warning", file: "context/stack.md", line: null, message: "stale" },
          ],
          filesChecked: 4,
          timestamp: "2026-05-14T00:00:00.000Z",
        },
      }),
      notice: null,
    }));
    expect(app.lastFrame()).toContain("1 error · 1 warning");
  });

  it("renders heartbeat stale files", () => {
    const app = render(h(HeartbeatPanel, {
      data: data({
        heartbeat: {
          ok: false,
          staleFiles: [{ file: "context/architecture.md", days: 12 }],
          memoryCleanupDue: false,
          oldDailyMemoryFiles: [],
        },
      }),
    }));
    expect(app.lastFrame()).toContain("context/architecture.md");
    expect(app.lastFrame()).toContain("12 days");
  });

  it("renders timeline entries in provided order", () => {
    const app = render(h(TimelinePanel, {
      data: data({
        events: [
          { timestamp: "2026-05-14T00:00:00.000Z", kind: "decision", message: "newer", files: [], cwd: "." },
          { timestamp: "2026-05-01T00:00:00.000Z", kind: "note", message: "older", files: [], cwd: "." },
        ],
      }),
    }));
    const frame = app.lastFrame() ?? "";
    expect(frame.indexOf("newer")).toBeLessThan(frame.indexOf("older"));
  });

  it("renders timeline empty state", () => {
    const app = render(h(TimelinePanel, { data: data() }));
    expect(app.lastFrame()).toContain("No events yet");
  });

  it("builds progress bars for status rows", () => {
    expect(progressBar(50, 10)).toBe("█████░░░░░");
    expect(progressBar(200, 4)).toBe("████");
  });

  it("builds event activity bars oldest to newest", () => {
    const bars = eventActivityBars([
      { timestamp: "2026-05-12T10:00:00.000Z", kind: "decision", message: "one", files: [], cwd: "." },
      { timestamp: "2026-05-14T10:00:00.000Z", kind: "note", message: "two", files: [], cwd: "." },
      { timestamp: "2026-05-14T11:00:00.000Z", kind: "risk", message: "three", files: [], cwd: "." },
    ], 3, new Date("2026-05-14T12:00:00.000Z"));
    expect(bars).toBe("▅▁█");
  });

  it("renders no-scaffold error screen", () => {
    const app = render(h(ErrorScreen, { message: "No .mex/ scaffold found. Run: mex setup" }));
    expect(app.lastFrame()).toContain("could not start");
    expect(app.lastFrame()).toContain("mex setup");
  });
});
