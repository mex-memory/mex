import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { assertUntracked, equalSnapshot, installPath, MAX_SETTINGS_BYTES, readSnapshot, replaceFile, samePath, snapshotBytes, type Snapshot } from "../install/files.js";
import { object, parseSettings, undoSettings } from "../install/settings.js";

export type CompactAgent = "claude-code" | "codex";
export type CompactChoice = "window" | "idle" | "post-turn";
export type CompactScope = "repo" | "user";

const codexKey = { window: "model_auto_compact_token_limit", "post-turn": "model_post_turn_compact_threshold_percent" } as const;

export function compactSettingsPath(agent: CompactAgent, scope: CompactScope, checkout: string, env = process.env): string {
  if (agent === "codex" && scope === "user") throw new Error("Select repo scope for Codex to limit the change to this checkout.");
  let path: string;
  if (scope === "repo") {
    path = agent === "codex" ? join(checkout, ".codex", "config.toml") : join(checkout, ".claude", "settings.local.json");
    const ignore = spawnSync("git", ["-C", checkout, "check-ignore", "-q", "--", relative(checkout, path)],
      { encoding: "utf8", timeout: 1500, windowsHide: true });
    if (ignore.status !== 0) throw new Error("The repo-local settings file must be Git-ignored. Use its local Git exclude file or Claude's user scope.");
    if (!samePath(path, installPath(path))) throw new Error("Repo-local compact settings path is redirected.");
  } else {
    const root = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    if (!isAbsolute(root)) throw new Error("CLAUDE_CONFIG_DIR must name an absolute directory.");
    path = installPath(join(root, "settings.json"));
  }
  assertUntracked(path);
  return path;
}

function child(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const old = value[key];
  if (old !== undefined && !object(old)) throw new Error(`Expected an object for ${key} in Claude settings.`);
  return value[key] = old ?? {};
}

// Preserve comments, order, and line endings. A parsed comparison verifies
// that an apparent assignment is really the intended top-level setting.
function editToml(text: string, key: string, value: number | undefined): string {
  const parsed = parseToml(text);
  const expected = Object.assign(Object.create(null) as typeof parsed, parsed);
  if (value === undefined) delete expected[key];
  else expected[key] = value;
  const attempt = (next: string): boolean => {
    try { return isDeepStrictEqual(parseToml(next), expected); } catch { return false; }
  };
  if (isDeepStrictEqual(parsed, expected)) return text;
  if (!Object.hasOwn(parsed, key)) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
    const next = `${bom}${key} = ${value}${newline}${text.slice(bom.length)}`;
    if (attempt(next)) return next;
  } else {
    const assignment = `(?:${key}|"${key}"|'${key}')`;
    const pattern = new RegExp(`^([ \\t]*${assignment}[ \\t]*=[ \\t]*)([+-]?[0-9][0-9A-Fa-f_xob]*)([ \\t]*(?:#[^\\r\\n]*)?)(\\r?\\n|$)`, "gm");
    for (const match of text.matchAll(pattern)) {
      const replacement = value === undefined ? "" : `${match[1]}${value}${match[3]}${match[4]}`;
      const next = text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
      if (attempt(next)) return next;
    }
  }
  throw new Error("The existing Codex compaction setting needs a plain top-level integer assignment.");
}

export function changeCompactSettings(before: Snapshot, agent: CompactAgent, model: string, choice: CompactChoice, value: number): Snapshot {
  const prior = snapshotBytes(before);
  let bytes: Buffer;
  if (agent === "claude-code") {
    const settings = parseSettings(prior);
    if (settings.autoCompactEnabled === false) throw new Error("Automatic compaction is disabled in this file.");
    const original = JSON.stringify(settings);
    if (choice === "window") child(child(settings, "modelSettings"), model).autoCompactWindow = value;
    else if (choice === "idle") {
      if (settings.idleCompaction === false) throw new Error("Idle compaction is disabled in this file.");
      child(settings, "env").CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = String(value);
    } else throw new Error("Post-turn compaction is available for Codex.");
    bytes = prior !== null && JSON.stringify(settings) === original ? prior : Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
  } else {
    if (choice === "idle") throw new Error("The idle threshold is available for Claude Code.");
    bytes = Buffer.from(editToml(prior?.toString("utf8") ?? "", codexKey[choice], value));
  }
  if (bytes.length > MAX_SETTINGS_BYTES) throw new Error("The resulting settings exceed the supported file size.");
  return { data: bytes.toString("base64"), mode: before.mode };
}

export interface SettingsChange {
  path: string;
  agent: CompactAgent;
  model: string;
  choice: CompactChoice;
  before: Snapshot;
  after: Snapshot;
}

/** Read the managed setting alone, leaving other settings outside the projection. */
export function recordedCompactValue(change: SettingsChange, bytes: Buffer | null): unknown {
  if (change.agent === "codex" && change.choice !== "idle") {
    return parseToml(bytes?.toString("utf8") ?? "")[codexKey[change.choice]];
  }
  const settings = parseSettings(bytes);
  if (change.choice === "idle") return object(settings.env) ? settings.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS : undefined;
  const model = object(settings.modelSettings) ? settings.modelSettings[change.model] : undefined;
  return object(model) ? model.autoCompactWindow : undefined;
}

/** Restore exact bytes in the usual case. Preserve unrelated subsequent edits. */
export function restoreCompactSettings(change: SettingsChange): void {
  const { path, before, after, agent, choice } = change;
  assertUntracked(path);
  const current = readSnapshot(path, MAX_SETTINGS_BYTES);
  if (equalSnapshot(current, before)) return;
  if (equalSnapshot(current, after)) {
    replaceFile(path, current, before);
    return;
  }
  const live = snapshotBytes(current), installed = snapshotBytes(after), old = snapshotBytes(before);
  if (!live || !installed) throw new Error("Compaction settings changed after acceptance. The current file was kept.");
  let bytes: Buffer;
  if (agent === "claude-code") {
    const value = (buffer: Buffer | null) => recordedCompactValue(change, buffer);
    if (isDeepStrictEqual(value(live), value(old))) return;
    bytes = undoSettings(live, old, installed);
  } else {
    if (choice === "idle") throw new Error("Invalid Codex compaction setting.");
    const key = codexKey[choice];
    const get = (buffer: Buffer | null) => recordedCompactValue(change, buffer);
    const previous = get(old), active = get(installed), value = get(live);
    if (value === previous) return;
    if (value !== active || (previous !== undefined && typeof previous !== "number")) {
      throw new Error("Compaction settings changed after acceptance. The current file was kept.");
    }
    bytes = Buffer.from(editToml(live.toString("utf8"), key, previous));
  }
  if (!live.equals(bytes)) replaceFile(path, current, { data: bytes.toString("base64"), mode: current.mode });
}
