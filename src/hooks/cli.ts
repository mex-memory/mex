/**
 * `mex hooks`: thin adapters over the install module.
 *
 * Plain text by default, one JSON object under `--json`. A refusal (a settings
 * file that is not JSON, no scaffold, an unsupported tool) is a nonzero exit
 * with the reason, never a partial write.
 */

import type { ResolveOptions } from "./command.js";
import {
  applyHooksPlan,
  assertSupportedTool,
  hooksStatus,
  HooksError,
  planHooksInstall,
  planHooksRemove,
  renderPlanDiff,
  type HooksPlan,
  type HooksStatus,
} from "./install.js";

export interface HooksIo {
  write: (line: string) => void;
  writeError: (line: string) => void;
  setExitCode: (code: number) => void;
  cwd: string;
  /** How to find the hook command; tests only. */
  resolve?: ResolveOptions;
}

export interface HooksFlags {
  tool?: string;
  dryRun?: boolean;
  json?: boolean;
}

const HOOKS_JSON_SCHEMA_VERSION = 1;

function fail(io: HooksIo, flags: HooksFlags, error: unknown): void {
  const code = error instanceof HooksError ? error.code : "HOOKS_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  io.setExitCode(1);
  if (flags.json) {
    io.write(JSON.stringify({ schemaVersion: HOOKS_JSON_SCHEMA_VERSION, ok: false, data: {}, diagnostics: [{ code, severity: "error", message }] }));
  } else {
    io.writeError(`error: ${message}`);
  }
}

function ok(io: HooksIo, flags: HooksFlags, data: unknown, human: string): void {
  if (flags.json) io.write(JSON.stringify({ schemaVersion: HOOKS_JSON_SCHEMA_VERSION, ok: true, data, diagnostics: [] }));
  else io.write(human);
}

function summarize(plan: HooksPlan, dryRun: boolean): string {
  const changes = [plan.settings, plan.instructions].filter((c) => c.action !== "noop");
  if (changes.length === 0) {
    return plan.operation === "install" ? "MEX hooks for Claude Code are already installed; nothing to change." : "No MEX hooks were found; nothing to remove.";
  }
  const lines: string[] = [];
  if (plan.operation === "install") {
    lines.push(dryRun ? "Would install MEX hooks for Claude Code." : "Installed MEX hooks for Claude Code.");
    if (plan.command) lines.push("Command: " + plan.command.command + " (" + (plan.command.kind === "bin" ? "the mex-hook bin on PATH" : "the built hook bundle; no mex-hook on PATH") + ")");
  } else {
    const noun = plan.entries === 1 ? "entry" : "entries";
    lines.push((dryRun ? "Would remove" : "Removed") + " MEX hooks for Claude Code (" + plan.entries + " " + noun + ").");
  }
  const WOULD = { create: "would create", update: "would update", remove: "would delete" } as const;
  const DID = { create: "created", update: "updated", remove: "deleted" } as const;
  for (const change of changes) {
    const action = change.action as "create" | "update" | "remove";
    lines.push("  " + (dryRun ? WOULD[action] : DID[action]) + " " + change.relative);
  }
  return lines.join("\n");
}

export function runHooksInstall(io: HooksIo, flags: HooksFlags = {}): void {
  try {
    assertSupportedTool(flags.tool);
    const plan = planHooksInstall(io.cwd, io.resolve);
    const dryRun = flags.dryRun === true;
    if (!dryRun) applyHooksPlan(plan);
    const diff = dryRun ? renderPlanDiff(plan) : "";
    ok(
      io,
      flags,
      {
        dryRun,
        command: plan.command,
        settings: { path: plan.settings.relative, action: plan.settings.action },
        instructions: { path: plan.instructions.relative, action: plan.instructions.action },
        ...(dryRun ? { diff } : {}),
      },
      `${summarize(plan, dryRun)}${dryRun && diff !== "" ? `\n\n${diff}` : ""}`,
    );
  } catch (error) {
    fail(io, flags, error);
  }
}

export function runHooksRemove(io: HooksIo, flags: HooksFlags = {}): void {
  try {
    assertSupportedTool(flags.tool);
    const plan = planHooksRemove(io.cwd);
    const dryRun = flags.dryRun === true;
    if (!dryRun) applyHooksPlan(plan);
    const diff = dryRun ? renderPlanDiff(plan) : "";
    ok(
      io,
      flags,
      {
        dryRun,
        removed: plan.entries,
        settings: { path: plan.settings.relative, action: plan.settings.action },
        instructions: { path: plan.instructions.relative, action: plan.instructions.action },
        ...(dryRun ? { diff } : {}),
      },
      `${summarize(plan, dryRun)}${dryRun && diff !== "" ? `\n\n${diff}` : ""}`,
    );
  } catch (error) {
    fail(io, flags, error);
  }
}

const STATE_TEXT: Record<HooksStatus["state"], string> = {
  installed: "installed",
  partial: "partly installed (some entries are missing: run `mex hooks install`)",
  outdated: "installed, but the hook command differs from the one install would write now (run `mex hooks install` to update it)",
  broken: "installed, but the hook command no longer resolves (run `mex hooks install` to repair it)",
  none: "not installed",
  unreadable: "unreadable settings file",
};

function describeStatus(status: HooksStatus): string {
  const lines = [`MEX hooks for Claude Code: ${STATE_TEXT[status.state]}`];
  if (status.settings.parseError) lines.push(`  ${status.settings.parseError}`);
  if (status.installed) {
    const how =
      status.installed.kind === "bin"
        ? `mex-hook bin on PATH${status.installed.target ? ` (${status.installed.target})` : " (not found on PATH now)"}`
        : status.installed.kind === "node"
          ? `node with the hook bundle ${status.installed.target}${status.installed.exists ? "" : " (missing)"}`
          : "an unrecognised command";
    lines.push(`  command: ${status.installed.command}`, `  runs:    ${how}`);
  }
  lines.push(
    status.available
      ? `  install would use: ${status.available.kind === "bin" ? "the mex-hook bin" : "node with the hook bundle"} (${status.available.target})`
      : "  install would use: nothing (neither mex-hook on PATH nor dist/hook.js was found)",
  );
  for (const entry of status.settings.entries) lines.push(`  ${entry.state.padEnd(9)} ${entry.label}`);
  if (status.settings.strays > 0) lines.push(`  ${status.settings.strays} extra MEX entr${status.settings.strays === 1 ? "y" : "ies"} from an older install (install removes them)`);
  if (status.settings.userHooks > 0) lines.push(`  ${status.settings.userHooks} hook${status.settings.userHooks === 1 ? "" : "s"} of your own, never touched`);
  lines.push(`  CLAUDE.md block: ${status.instructionsPresent ? "present" : "absent"}`);
  return lines.join("\n");
}

export function runHooksStatus(io: HooksIo, flags: HooksFlags = {}): void {
  try {
    assertSupportedTool(flags.tool);
    const status = hooksStatus(io.cwd, io.resolve);
    ok(io, flags, status, describeStatus(status));
  } catch (error) {
    fail(io, flags, error);
  }
}
