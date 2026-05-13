import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { stdin, stdout } from "node:process";
import type { DriftReport, MexConfig } from "./types.js";
import { findConfig } from "./config.js";
import { runDriftCheck } from "./drift/index.js";
import { checkHeartbeat, type HeartbeatResult } from "./heartbeat.js";
import { appendEvent, readEvents, type EventEntry, type EventKind } from "./events.js";

const h = React.createElement;

type View = "dashboard" | "check" | "heartbeat" | "doctor" | "timeline" | "log-kind" | "log-message" | "log-file" | "log-done";
type LoadState = "loading" | "ready" | "error";

export interface DashboardData {
  report: DriftReport;
  heartbeat: HeartbeatResult;
  events: EventEntry[];
}

interface AppState {
  view: View;
  selected: number;
  loadState: LoadState;
  data: DashboardData | null;
  error: string | null;
  logKind: EventKind;
  logMessage: string;
  logFile: string;
  notice: string | null;
}

const MENU = [
  "Refresh dashboard",
  "Run check summary",
  "Run heartbeat",
  "Run doctor summary",
  "View timeline",
  "Log event",
  "Exit",
] as const;

const EVENT_KINDS: EventKind[] = ["note", "decision", "risk", "todo"];

export function launchTui(): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log("mex TUI requires an interactive terminal. Run `mex commands` to list CLI commands.");
    return;
  }
  try {
    const config = findConfig();
    render(h(TuiApp, { config }));
  } catch (err) {
    render(h(ErrorScreen, { message: (err as Error).message }));
  }
}

export async function loadDashboard(config: MexConfig): Promise<DashboardData> {
  const report = await runDriftCheck(config);
  const heartbeat = checkHeartbeat(config);
  const events = readEvents(config).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { report, heartbeat, events };
}

function TuiApp({ config }: { config: MexConfig }) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>({
    view: "dashboard",
    selected: 0,
    loadState: "loading",
    data: null,
    error: null,
    logKind: "note",
    logMessage: "",
    logFile: "",
    notice: null,
  });

  const refresh = async (view: View = "dashboard", notice: string | null = null) => {
    setState((s) => ({ ...s, view, loadState: "loading", error: null, notice }));
    try {
      const data = await loadDashboard(config);
      setState((s) => ({ ...s, data, loadState: "ready", error: null, notice }));
    } catch (err) {
      setState((s) => ({ ...s, loadState: "error", error: (err as Error).message }));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useInput((input, key) => {
    if (input === "q" && state.view !== "log-message" && state.view !== "log-file") {
      exit();
      return;
    }
    if (key.escape) {
      setState((s) => ({ ...s, view: "dashboard", notice: null }));
      return;
    }

    if (state.view === "dashboard") {
      if (key.upArrow) {
        setState((s) => ({ ...s, selected: Math.max(0, s.selected - 1) }));
      } else if (key.downArrow) {
        setState((s) => ({ ...s, selected: Math.min(MENU.length - 1, s.selected + 1) }));
      } else if (key.return) {
        const action = MENU[state.selected];
        if (action === "Refresh dashboard") void refresh("dashboard", "Dashboard refreshed");
        if (action === "Run check summary") setState((s) => ({ ...s, view: "check", notice: null }));
        if (action === "Run heartbeat") setState((s) => ({ ...s, view: "heartbeat", notice: null }));
        if (action === "Run doctor summary") setState((s) => ({ ...s, view: "doctor", notice: null }));
        if (action === "View timeline") setState((s) => ({ ...s, view: "timeline", notice: null }));
        if (action === "Log event") setState((s) => ({ ...s, view: "log-kind", notice: null }));
        if (action === "Exit") exit();
      }
      return;
    }

    if (state.view === "log-kind") {
      const idx = EVENT_KINDS.indexOf(state.logKind);
      if (key.leftArrow || key.upArrow) {
        setState((s) => ({ ...s, logKind: EVENT_KINDS[(idx + EVENT_KINDS.length - 1) % EVENT_KINDS.length] }));
      } else if (key.rightArrow || key.downArrow) {
        setState((s) => ({ ...s, logKind: EVENT_KINDS[(idx + 1) % EVENT_KINDS.length] }));
      } else if (key.return) {
        setState((s) => ({ ...s, view: "log-message", logMessage: "", logFile: "" }));
      }
      return;
    }

    if (state.view === "log-message" || state.view === "log-file") {
      const field = state.view === "log-message" ? "logMessage" : "logFile";
      if (key.backspace || key.delete) {
        setState((s) => ({ ...s, [field]: s[field].slice(0, -1) }));
      } else if (key.return) {
        if (state.view === "log-message") {
          if (state.logMessage.trim().length > 0) setState((s) => ({ ...s, view: "log-file" }));
        } else {
          appendEvent(config, state.logMessage.trim(), {
            kind: state.logKind,
            files: state.logFile.trim() ? [state.logFile.trim()] : [],
          });
          void refresh("log-done", `Logged ${state.logKind}`);
        }
      } else if (input && !key.ctrl && !key.meta) {
        setState((s) => ({ ...s, [field]: s[field] + input }));
      }
    }
  });

  if (state.loadState === "loading" && !state.data) return h(Frame, { config }, h(Text, null, "Loading mex dashboard..."));
  if (state.loadState === "error") return h(Frame, { config }, h(Text, { color: "red" }, state.error ?? "Unknown error"));
  if (!state.data) return h(Frame, { config }, h(Text, null, "No dashboard data."));

  return h(Frame, { config },
    h(Summary, { data: state.data, notice: state.notice }),
    h(Box, { marginTop: 1 },
      h(Menu, { selected: state.selected, active: state.view === "dashboard" }),
      h(Box, { marginLeft: 4, flexDirection: "column" },
        h(ViewPanel, { state, data: state.data }),
      ),
    ),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "↑/↓ navigate · enter select · esc dashboard · q quit")),
  );
}

export function ErrorScreen({ message }: { message: string }) {
  return h(Box, { flexDirection: "column", paddingX: 1 },
    h(Text, { color: "red", bold: true }, "mex dashboard could not start"),
    h(Text, null, message),
    h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, "Run from a project root with a complete .mex scaffold, or run `mex setup`.")),
  );
}

function Frame({ config, children }: { config: MexConfig; children?: React.ReactNode }) {
  return h(Box, { flexDirection: "column", paddingX: 1 },
    h(Text, { bold: true, color: "cyan" }, "mex"),
    h(Text, { dimColor: true }, `Scaffold: ${config.scaffoldRoot}`),
    h(Box, { marginTop: 1, flexDirection: "column" }, children),
  );
}

export function Summary({ data, notice }: { data: DashboardData; notice: string | null }) {
  const errors = data.report.issues.filter((i) => i.severity === "error").length;
  const warnings = data.report.issues.filter((i) => i.severity === "warning").length;
  const scoreColor = data.report.score >= 80 ? "green" : data.report.score >= 50 ? "yellow" : "red";
  return h(Box, { flexDirection: "column" },
    notice ? h(Text, { color: "green" }, notice) : null,
    h(Text, null,
      h(Text, { color: scoreColor, bold: true }, `Drift ${data.report.score}/100`),
      `  ${errors} errors, ${warnings} warnings, ${data.report.filesChecked} files checked`,
    ),
    h(Text, null,
      h(Text, { color: data.heartbeat.ok ? "green" : "yellow", bold: true }, data.heartbeat.ok ? "Heartbeat OK" : "Heartbeat needs attention"),
      `  ${data.heartbeat.staleFiles.length} stale files`,
    ),
    h(Text, null, `Events ${data.events.length} logged · latest ${latestEvent(data.events)}`),
  );
}

function Menu({ selected, active }: { selected: number; active: boolean }) {
  return h(Box, { flexDirection: "column", width: 26 },
    ...MENU.map((item, idx) => h(Text, { key: item, color: active && idx === selected ? "cyan" : undefined },
      `${active && idx === selected ? "›" : " "} ${item}`,
    )),
  );
}

function ViewPanel({ state, data }: { state: AppState; data: DashboardData }) {
  if (state.view === "check") return h(CheckPanel, { data });
  if (state.view === "heartbeat") return h(HeartbeatPanel, { data });
  if (state.view === "doctor") return h(DoctorPanel, { data });
  if (state.view === "timeline") return h(TimelinePanel, { data });
  if (state.view === "log-kind") return h(LogKindPanel, { kind: state.logKind });
  if (state.view === "log-message") return h(Text, null, `Message: ${state.logMessage || "_"}`);
  if (state.view === "log-file") return h(Box, { flexDirection: "column" },
    h(Text, null, `Related file (optional): ${state.logFile || "_"}`),
    h(Text, { dimColor: true }, "Press enter to save."),
  );
  if (state.view === "log-done") return h(TimelinePanel, { data });
  return h(Text, { dimColor: true }, "Choose an action.");
}

function CheckPanel({ data }: { data: DashboardData }) {
  const issues = data.report.issues.slice(0, 8);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Check summary"),
    issues.length === 0
      ? h(Text, { color: "green" }, "No drift issues found.")
      : issues.map((i, idx) => h(Text, { key: `${i.file}-${idx}` }, `${i.severity.toUpperCase()} ${i.code} ${i.file}: ${i.message}`)),
  );
}

export function HeartbeatPanel({ data }: { data: DashboardData }) {
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Heartbeat"),
    data.heartbeat.ok ? h(Text, { color: "green" }, "HEARTBEAT_OK") : null,
    ...data.heartbeat.staleFiles.map((f) => h(Text, { key: f.file }, `Stale ${f.file} (${f.days} days)`)),
    data.heartbeat.memoryCleanupDue ? h(Text, null, "Memory cleanup is due.") : null,
    ...data.heartbeat.oldDailyMemoryFiles.map((f) => h(Text, { key: f }, `Old memory ${f}`)),
  );
}

function DoctorPanel({ data }: { data: DashboardData }) {
  const errors = data.report.issues.filter((i) => i.severity === "error").length;
  const warnings = data.report.issues.filter((i) => i.severity === "warning").length;
  const healthy = errors === 0 && data.heartbeat.ok;
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Doctor summary"),
    h(Text, { color: healthy ? "green" : "yellow" }, healthy ? "Scaffold looks healthy." : "Scaffold needs attention."),
    h(Text, null, `Drift ${data.report.score}/100 (${errors} errors, ${warnings} warnings)`),
    h(Text, null, data.heartbeat.ok ? "Heartbeat OK" : "Run `mex heartbeat` for details."),
    h(Text, null, `${data.events.length} logged events`),
  );
}

export function TimelinePanel({ data }: { data: DashboardData }) {
  const events = data.events.slice(0, 8);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Timeline"),
    events.length === 0
      ? h(Text, { dimColor: true }, "No events logged yet.")
      : events.map((e) => h(Text, { key: `${e.timestamp}-${e.message}` }, `${e.timestamp.slice(0, 10)} ${e.kind} ${e.message}`)),
  );
}

function LogKindPanel({ kind }: { kind: EventKind }) {
  const rendered = useMemo(() => EVENT_KINDS.map((k) => k === kind ? `[${k}]` : k).join("  "), [kind]);
  return h(Box, { flexDirection: "column" },
    h(Text, { bold: true }, "Log event"),
    h(Text, null, rendered),
    h(Text, { dimColor: true }, "Use left/right, then enter."),
  );
}

function latestEvent(events: EventEntry[]): string {
  if (!events.length) return "none";
  const e = events[0];
  return `${e.timestamp.slice(0, 10)} ${e.kind}`;
}
