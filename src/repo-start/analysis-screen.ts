import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { readKey } from "./keys.js";
import { MARGIN, pad, Rich, wrapText } from "./rich.js";
import { screenMode, wrap } from "./screen.js";
import { TerminalBlock } from "./select.js";
import { DEEP_STAGES, type DeepActivity } from "../learn-deeper/activity.js";

type Print = (line: string) => void;
type Detail = readonly [label: string, value: string];

export async function confirmAnalysis(options: {
  rich?: Rich;
  write: Print;
  width?: number;
  introduction?: string;
  agent?: string;
  showTitle?: boolean;
  notices?: readonly string[];
  details: readonly Detail[];
  read?: () => Promise<string>;
  block?: TerminalBlock;
}): Promise<boolean> {
  const { rich, write, introduction, agent, notices = [], details } = options;
  const read = options.read ?? (() => readKey());
  const plainWidth = options.width ?? screenMode().width;
  if (rich) {
    if (options.showTitle !== false) for (const line of rich.section("DEEP ANALYSIS")) write(line);
    if (introduction) for (const line of rich.text([introduction])) write(line);
    if (agent) for (const line of rich.text([agent])) write(line);
    for (const line of rich.text(notices.map(line => rich.codeTint(line)), true)) write(line);
    if (introduction || notices.length) write("");
  } else {
    const lines = [options.showTitle !== false ? "Deep analysis" : undefined, introduction, agent, ...notices];
    for (const line of lines) if (line) for (const part of wrap(line, plainWidth, 2)) write(part);
  }
  const block = rich ? options.block ?? new TerminalBlock() : undefined;
  const table = () => details.flatMap(([label, value]) => {
    if (!rich) return wrap(`${label}: ${value}`, plainWidth, 2);
    const width = Math.max(20, Math.min(100, options.width ?? process.stdout.columns ?? 100) - MARGIN.length - 18);
    const text = label === "Afterwards" || label === "Stop it" ? rich.commands(value) : rich.codeTint(value);
    return wrapText(text, width).map((line, i) => `${MARGIN}${rich.dim(pad(i ? "" : label, 17))}${line}`);
  });
  let open = false;
  try {
    for (;;) {
      const keys: ReadonlyArray<readonly [string, string]> = [["Enter", "proceed"], open ? ["h", "hide details"] : ["d", "details"]];
      const lines = [...(open ? [...table(), ""] : []), rich?.keys(keys) ?? keys.map(([key, label]) => `[${key}] ${label}`).join("   ")];
      if (block) block.draw(lines);
      else for (const line of lines) write(line);
      const key = await read();
      if (key === "enter") return true;
      if (key === "quit") return false;
      if (key === "d") open = true;
      if (key === "h") open = false;
    }
  } finally { block?.clear(); }
}

export const WATCH_HINT = "Any key: keep it running in the background · `mex cancel`: stop it";
export const DETACH_HINT = "Run `mex` here to watch it and see your summary · `mex cancel` stops it";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
const count = (number: number) => number.toLocaleString("en-US");
const elapsed = (since: string, now: number) => Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) || 0;

export function activityCount(activity: DeepActivity): string {
  const amount = activity.total === undefined ? activity.done === undefined ? "" : count(activity.done)
    : `${activity.done === undefined ? "" : `${count(activity.done)} of `}${count(activity.total)}`;
  const unit = activity.total !== undefined && activity.unit === "sources" ? "" : activity.unit;
  return amount && `${amount}${unit ? ` ${clean(unit)}` : ""}`;
}

export function renderAnalysisActivity(root: string, activity: DeepActivity, options: {
  rich?: Rich; now?: number; status?: string;
} = {}): string[] {
  const now = options.now ?? Date.now();
  const { rich, status } = options;
  const repo = clean(basename(root));
  const agent = clean(activity.agent);
  const seconds = elapsed(activity.startedAt, now);
  const time = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const tokens = activity.tokens >= 1000 ? `${Math.round(activity.tokens / 1000)}k` : count(activity.tokens);
  const progress = activityCount(activity);
  const summary = `${time} · ${tokens} tokens${activity.tokensEstimated ? " (estimated)" : ""}`;
  const current = activity.current;
  const recent = activity.recent.slice(0, 3).map(item =>
    `${clean(item.subject)}${item.title ? ` ${clean(item.title)}` : ""} → ${clean(item.result)}`);
  if (!rich) {
    const stage = DEEP_STAGES[activity.stage] ?? "Running";
    const working = current ? `${agent} is working on ${clean(current.subject)}${current.title ? ` ${clean(current.title)}` : ""} (${elapsed(current.startedAt, now)}s)` : "";
    const completed = DEEP_STAGES.slice(0, activity.stage).flatMap((label, i) => activity.finished[i] ? [`  ${label} · ${clean(activity.finished[i])}`] : []);
    return [["Deep analysis", repo, agent, summary].filter(Boolean).join(" · "), ...completed,
      ...[[stage, progress].filter(Boolean).join(" "), status, working].filter((line): line is string => !!line),
      ...recent.map(item => `  ${item}`)];
  }
  const done = activity.done, total = activity.total;
  const barLength = done !== undefined && total ? Math.max(0, Math.min(12, Math.round(12 * done / total))) : undefined;
  const bar = barLength === undefined ? "" : `${rich.cmd("▰".repeat(barLength))}${rich.dim("▱".repeat(12 - barLength))}  `;
  const stages = DEEP_STAGES.map((stage, i) => {
    const result = activity.finished[i];
    if (i < activity.stage && result) return `${MARGIN}${rich.paint("ok", "✓")} ${pad(stage, 24)}${rich.dim(clean(result))}`;
    if (i !== activity.stage) return `${MARGIN}${rich.dim(`· ${stage}`)}`;
    return `${MARGIN}${rich.cmd(SPINNER[Math.floor(now / 250) % SPINNER.length]!)} ${pad(rich.bold(stage), 24)}${bar}${progress}`;
  });
  return [
    `${rich.pill("DEEP ANALYSIS", "paper")}  ${rich.bold(repo)}${agent ? rich.dim(` · ${agent}`) : ""}        ${rich.dim(summary)}`,
    "", ...stages, "",
    ...(status ? rich.text([status], true) : []),
    ...(current ? rich.text([`${rich.cmd(agent)} is working on ${rich.bold(clean(current.subject))}${current.title ? ` ${rich.dim(clean(current.title))}` : ""}  ${rich.dim(`${elapsed(current.startedAt, now)}s`)}`]) : []),
    ...recent.flatMap(item => rich.text([`  ✓ ${item}`], true)),
    "", ...rich.text([rich.commands(WATCH_HINT)]),
  ];
}
