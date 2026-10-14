/**
 * Merging MEX's hook entries into a Claude Code `settings.json`.
 *
 * Pure: text in, text out. Every entry MEX writes carries the marker argument
 * {@link MEX_HOOK_MARKER} on its command line, and that marker is the only
 * thing that makes an entry MEX's. Install adds or updates exactly the marked
 * entries and `remove` deletes exactly them; every other key, group and hook
 * in the file is left as the user wrote it (order and indentation included).
 */

export const MEX_HOOK_MARKER = "--mex-managed";
export const HOOK_TIMEOUT_SECONDS = 30;

export interface HookSpec {
  event: "UserPromptSubmit" | "PostToolUse";
  /** Tool-name matcher; absent for events that have none. */
  matcher?: string;
  label: string;
}

/** The entries MEX installs. The command is the same for all; the host's payload says which event it is. */
export const HOOK_SPECS: readonly HookSpec[] = [
  { event: "UserPromptSubmit", label: "UserPromptSubmit" },
  { event: "PostToolUse", matcher: "Read", label: "PostToolUse Read" },
  { event: "PostToolUse", matcher: "Edit|Write|MultiEdit", label: "PostToolUse Edit|Write|MultiEdit" },
  { event: "PostToolUse", matcher: "Grep", label: "PostToolUse Grep" },
  { event: "PostToolUse", matcher: "Bash", label: "PostToolUse Bash" },
];

export function isManagedCommand(command: unknown): boolean {
  return typeof command === "string" && /(^|\s)--mex-managed(\s|$)/.test(command);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

function parseSettings(text: string | null): Json {
  if (text === null || text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new SettingsError(`settings.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); MEX will not rewrite it.`);
  }
  if (!isObject(value)) throw new SettingsError("settings.json is not a JSON object; MEX will not rewrite it.");
  if (value["hooks"] !== undefined && !isObject(value["hooks"])) {
    throw new SettingsError('settings.json has a "hooks" value that is not an object; MEX will not rewrite it.');
  }
  return value;
}

/** Indentation and line ending of the existing file, so a merge does not reformat it. */
function detectStyle(text: string | null): { indent: string | number; eol: string; bom: boolean } {
  if (text === null) return { indent: 2, eol: "\n", bom: false };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]+)"/.exec(text.replace(/\r\n/g, "\n"))?.[1];
  return { indent: indent ?? 2, eol, bom: text.startsWith("﻿") };
}

function serialize(settings: Json, style: ReturnType<typeof detectStyle>): string {
  const body = JSON.stringify(settings, null, style.indent).replace(/\n/g, style.eol);
  return `${style.bom ? "﻿" : ""}${body}${style.eol}`;
}

interface Group extends Json {
  matcher?: unknown;
  hooks?: unknown;
}

function groupsOf(hooks: Json, event: string): Group[] {
  const value = hooks[event];
  return Array.isArray(value) ? (value as Group[]) : [];
}

const managedHooksIn = (group: Group): Json[] =>
  Array.isArray(group.hooks) ? (group.hooks as unknown[]).filter((hook): hook is Json => isObject(hook) && isManagedCommand(hook["command"])) : [];

function desiredHook(command: string): Json {
  return { type: "command", command, timeout: HOOK_TIMEOUT_SECONDS };
}

export interface SettingsPlan {
  action: "create" | "update" | "noop" | "remove" | "conflict";
  /** The file's text after the change; null when no change is made. */
  text: string | null;
  /** How many MEX entries the file holds after the change. */
  entries: number;
  message?: string;
}

/**
 * Install or update MEX's entries.
 *
 * An existing marked hook under a group with the matching matcher is updated in
 * place. Any other marked hook (an older install with different matchers) is
 * dropped, and missing entries are appended as groups of their own; a user's
 * group is never mixed with ours.
 */
export function planInstall(current: string | null, command: string): SettingsPlan {
  let settings: Json;
  try {
    settings = parseSettings(current);
  } catch (error) {
    return { action: "conflict", text: null, entries: 0, message: (error as Error).message };
  }
  const before = JSON.stringify(settings);
  const next = structuredClone(settings);
  const hooks: Json = isObject(next["hooks"]) ? next["hooks"] : {};
  next["hooks"] = hooks;

  const kept = new Set<unknown>();
  for (const spec of HOOK_SPECS) {
    const group = groupsOf(hooks, spec.event).find((g) => isObject(g) && g.matcher === spec.matcher && managedHooksIn(g).length > 0);
    if (group === undefined) continue;
    const hook = managedHooksIn(group)[0]!;
    hook["type"] = "command";
    hook["command"] = command;
    hook["timeout"] = HOOK_TIMEOUT_SECONDS;
    kept.add(hook);
  }
  stripManaged(hooks, kept);
  for (const spec of HOOK_SPECS) {
    const present = groupsOf(hooks, spec.event).some((g) => isObject(g) && g.matcher === spec.matcher && managedHooksIn(g).some((h) => kept.has(h)));
    if (present) continue;
    const entry: Json = spec.matcher === undefined ? { hooks: [desiredHook(command)] } : { matcher: spec.matcher, hooks: [desiredHook(command)] };
    if (!Array.isArray(hooks[spec.event])) hooks[spec.event] = [];
    (hooks[spec.event] as unknown[]).push(entry);
  }

  if (JSON.stringify(next) === before) return { action: "noop", text: null, entries: HOOK_SPECS.length };
  return { action: current === null ? "create" : "update", text: serialize(next, detectStyle(current)), entries: HOOK_SPECS.length };
}

/** Delete every marked hook (except those in `keep`); drop the groups, events and `hooks` object that this leaves empty. */
function stripManaged(hooks: Json, keep: ReadonlySet<unknown> = new Set()): number {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const remaining: unknown[] = [];
    for (const group of groups as unknown[]) {
      if (!isObject(group) || !Array.isArray(group["hooks"])) {
        remaining.push(group);
        continue;
      }
      const inner = (group["hooks"] as unknown[]).filter((hook) => {
        const managed = isObject(hook) && isManagedCommand(hook["command"]);
        if (managed && !keep.has(hook)) {
          removed += 1;
          return false;
        }
        return true;
      });
      // A group that held only MEX's hooks goes with them; one that held a user's hook stays.
      if (inner.length > 0 || (group["hooks"] as unknown[]).length === 0) remaining.push({ ...group, hooks: inner });
    }
    if (remaining.length > 0) hooks[event] = remaining;
    else delete hooks[event];
  }
  return removed;
}

/** Remove MEX's entries and nothing else. */
export function planRemove(current: string | null): SettingsPlan {
  let settings: Json;
  try {
    settings = parseSettings(current);
  } catch (error) {
    return { action: "conflict", text: null, entries: 0, message: (error as Error).message };
  }
  if (current === null || !isObject(settings["hooks"])) return { action: "noop", text: null, entries: 0 };
  const next = structuredClone(settings);
  const hooks = next["hooks"] as Json;
  const removed = stripManaged(hooks);
  if (removed === 0) return { action: "noop", text: null, entries: 0 };
  if (Object.keys(hooks).length === 0) delete next["hooks"];
  return { action: "remove", text: serialize(next, detectStyle(current)), entries: removed };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface EntryStatus {
  label: string;
  state: "installed" | "missing" | "outdated";
  command: string | null;
}

export interface SettingsStatus {
  parseError: string | null;
  entries: EntryStatus[];
  /** Marked hooks outside the expected entries (an older install). */
  strays: number;
  /** Hooks in the file that are not MEX's. */
  userHooks: number;
  /** The command the installed entries use, when they all agree. */
  command: string | null;
}

export function inspectSettings(current: string | null, expectedCommand: string | null): SettingsStatus {
  let settings: Json;
  try {
    settings = parseSettings(current);
  } catch (error) {
    return { parseError: (error as Error).message, entries: [], strays: 0, userHooks: 0, command: null };
  }
  const hooks: Json = isObject(settings["hooks"]) ? settings["hooks"] : {};
  const claimed = new Set<unknown>();
  const entries: EntryStatus[] = HOOK_SPECS.map((spec) => {
    const group = groupsOf(hooks, spec.event).find((g) => isObject(g) && g.matcher === spec.matcher && managedHooksIn(g).length > 0);
    if (group === undefined) return { label: spec.label, state: "missing", command: null };
    const hook = managedHooksIn(group)[0]!;
    claimed.add(hook);
    const command = hook["command"] as string;
    return { label: spec.label, state: expectedCommand !== null && command !== expectedCommand ? "outdated" : "installed", command };
  });
  let strays = 0;
  let userHooks = 0;
  for (const event of Object.keys(hooks)) {
    for (const group of groupsOf(hooks, event)) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks as unknown[]) {
        if (!isObject(hook)) continue;
        if (isManagedCommand(hook["command"])) strays += claimed.has(hook) ? 0 : 1;
        else userHooks += 1;
      }
    }
  }
  const commands = new Set(entries.map((e) => e.command).filter((c): c is string => c !== null));
  return { parseError: null, entries, strays, userHooks, command: commands.size === 1 ? [...commands][0]! : null };
}

// ---------------------------------------------------------------------------
// A small line diff for --dry-run
// ---------------------------------------------------------------------------

/**
 * A unified-style diff of two texts with two lines of context. Settings files
 * are small, so a plain longest-common-subsequence table is enough.
 */
export function renderDiff(path: string, before: string | null, after: string | null): string {
  const a = before === null ? [] : before.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const b = after === null ? [] : after.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: " " | "+" | "-"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i += 1;
      j += 1;
    } else if (j < b.length && (i === a.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      ops.push({ kind: "+", line: b[j]! });
      j += 1;
    } else {
      ops.push({ kind: "-", line: a[i]! });
      i += 1;
    }
  }
  const CONTEXT = 2;
  const show = ops.map((op, index) => op.kind !== " " || ops.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((near) => near.kind !== " "));
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];
  let gap = false;
  ops.forEach((op, index) => {
    if (!show[index]) {
      gap = true;
      return;
    }
    if (gap && out.length > 2) out.push("...");
    gap = false;
    out.push(`${op.kind}${op.line}`);
  });
  return out.join("\n");
}
