import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupRun } from "../api/types";
import { SetupPopulationActivity } from "./SetupPopulationActivity";

const startedAt = "2026-09-10T10:00:00.000Z";
const baseRun: SetupRun = {
  status: "running", mode: "code-repo", stage: "needs_population", populated: false,
  ready: false, selectedTools: ["codex"], prompt: null, populationTool: "codex",
  populationCompleted: false, commitCommands: [], anchorNotes: [], message: "Populating MEX",
  progress: { step: "population", label: "Populate the scaffold" }, error: null,
  startedAt, finishedAt: null,
};

function activityRun(update: Partial<NonNullable<SetupRun["populationActivity"]>> = {}): SetupRun {
  return {
    ...baseRun,
    populationActivity: { tool: "codex", startedAt, lastActivityAt: null, events: [], totalEvents: 0, ...update },
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("setup population activity", () => {
  it("keeps time locally, reports genuine silence, and resumes the activity signal only on a new report", () => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const run = activityRun();
    const view = render(<SetupPopulationActivity run={run} />);
    expect(screen.getByText(/Running for 0s/)).toHaveTextContent("Waiting for the first activity report");
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the agent to report activity.");
    act(() => vi.advanceTimersByTime(89_000));
    expect(screen.getByText(/Running for 1m 29s/)).toBeVisible();
    expect(screen.queryByText(/No new activity reported for/)).toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/No new activity reported for 1m 30s/)).toHaveTextContent("Codex may still be working.");
    const announcement = screen.getByRole("status").textContent;
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("status").textContent).toBe(announcement);

    const at = new Date().toISOString();
    view.rerender(<SetupPopulationActivity run={activityRun({
      lastActivityAt: at, totalEvents: 1, events: [{ id: 1, at, kind: "reading", state: "running" }],
    })} />);
    expect(screen.queryByText(/No new activity reported for/)).toBeNull();
    expect(screen.getByText(/Last activity 0s ago/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Reading repository files");
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText(/Last activity 1s ago/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Reading repository files");
  });

  it("shows recent actions first and keeps older bounded reports available without claiming a complete history", () => {
    const view = render(<SetupPopulationActivity run={activityRun({
      totalEvents: 12,
      lastActivityAt: "2026-09-10T10:00:04.000Z",
      events: [
        { id: 8, at: startedAt, kind: "started", state: "completed" },
        { id: 9, at: "2026-09-10T10:00:01.000Z", kind: "reading", state: "completed" },
        { id: 10, at: "2026-09-10T10:00:02.000Z", kind: "writing", state: "completed", target: "architecture" },
        { id: 11, at: "2026-09-10T10:00:03.000Z", kind: "writing", state: "completed", target: "conventions" },
        { id: 12, at: "2026-09-10T10:00:04.000Z", kind: "running_command", state: "running" },
      ],
    })} />);
    const recent = within(screen.getByRole("list", { name: "Recent agent activity" })).getAllByRole("listitem");
    expect(recent).toHaveLength(3);
    expect(recent[0]).toHaveTextContent("Running a project command");
    expect(recent[1]).toHaveTextContent("Updated development conventions");
    expect(recent[2]).toHaveTextContent("Updated architecture notes");
    const history = view.container.querySelector("details")!;
    expect(history.open).toBe(false);
    fireEvent.click(screen.getByText("View earlier activity (2)"));
    expect(history.open).toBe(true);
    expect(screen.getByText("Showing the latest 5 activity reports.")).toBeVisible();
    expect(within(screen.getByRole("list", { name: "Earlier agent activity" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("clears its only clock interval when the population step leaves the page", () => {
    vi.useFakeTimers();
    const view = render(<SetupPopulationActivity run={activityRun()} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not substitute total setup duration for a missing population start", () => {
    render(<SetupPopulationActivity run={baseRun} />);
    expect(screen.getByText(/Starting background population/)).toBeVisible();
    expect(screen.queryByText(/Running for/)).toBeNull();
    expect(screen.queryByText(/No new activity reported for/)).toBeNull();
  });
});

describe("setup per-subsystem coverage", () => {
  it("shows how many subsystems are done, which are running, and which were skipped", () => {
    render(<SetupPopulationActivity run={{
      ...activityRun(),
      populationCoverage: {
        phase: "subsystems", total: 3, done: 1, skipped: 1,
        subsystems: [
          { path: "src/router", state: "done" },
          { path: "src/jsx", state: "skipped" },
          { path: "src/middleware", state: "running" },
        ],
      },
    }} />);
    expect(screen.getByText("1/3 subsystems done")).toBeVisible();
    expect(screen.getByText(/· 1 skipped/)).toBeVisible();
    const list = screen.getByRole("list", { name: "Subsystem progress" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "src/router/ done",
      "src/jsx/ skipped — rerun setup to retry",
      "src/middleware/ in progress",
    ]);
  });

  it("names the shared and final phases, and shows nothing for a single-session run", () => {
    const view = render(<SetupPopulationActivity run={{
      ...activityRun(),
      populationCoverage: { phase: "shared", total: 2, done: 0, skipped: 0, subsystems: [{ path: "src/a", state: "pending" }, { path: "src/b", state: "pending" }] },
    }} />);
    expect(screen.getByText(/Filling the shared files first/)).toBeVisible();
    view.unmount();
    render(<SetupPopulationActivity run={activityRun()} />);
    expect(screen.queryByRole("list", { name: "Subsystem progress" })).toBeNull();
  });
});
