/**
 * Per-session memory of what was already shown.
 *
 * A packet should never repeat an entry the agent already has in its context.
 * The host gives every hook a session id; this module keys a small file on its
 * hash under `.mex/local/context-sessions/`. State is bounded (ids per
 * session, files per checkout, age) and a broken or foreign file reads as an
 * empty session: forgetting costs one repeated entry, never a failed prompt.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pruneDirectory, writeTextAtomic } from "./local-state.js";

export const SESSION_DIR_NAME = "context-sessions";
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_SHOWN_PER_SESSION = 512;
export const MAX_SESSION_FILES = 200;
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_FILE_BYTES = 64 * 1024;
const SESSION_SCHEMA_VERSION = 1;

interface SessionFile {
  schemaVersion: number;
  shown: string[];
  /** Characters of context injected in this session so far, across all events. */
  injectedChars?: number;
  updatedAt: string;
}

export const sessionDirOf = (localDir: string): string => join(localDir, SESSION_DIR_NAME);

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && !/[\0\r\n]/.test(value);
}

function sessionFileOf(localDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 40);
  return join(sessionDirOf(localDir), `${key}.json`);
}

/** Ids this session has already been shown. */
export function loadShown(localDir: string, sessionId: string): Set<string> {
  const path = sessionFileOf(localDir, sessionId);
  try {
    if (statSync(path).size > MAX_SESSION_FILE_BYTES) return new Set();
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionFile>;
    if (value.schemaVersion !== SESSION_SCHEMA_VERSION || !Array.isArray(value.shown)) return new Set();
    return new Set(value.shown.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** Characters injected in this session so far (0 for an unknown or damaged session). */
export function loadInjectedChars(localDir: string, sessionId: string): number {
  try {
    const path = sessionFileOf(localDir, sessionId);
    if (statSync(path).size > MAX_SESSION_FILE_BYTES) return 0;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionFile>;
    return value.schemaVersion === SESSION_SCHEMA_VERSION && typeof value.injectedChars === "number" && value.injectedChars > 0
      ? Math.floor(value.injectedChars)
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Record ids as shown and add `chars` to the session's injected total; keeps
 * only the newest ids and prunes stale session files.
 */
export function recordShown(localDir: string, sessionId: string, ids: readonly string[], now: Date = new Date(), chars = 0): void {
  if (ids.length === 0 && chars <= 0) return;
  const shown = [...new Set([...loadShown(localDir, sessionId), ...ids])].slice(-MAX_SHOWN_PER_SESSION);
  const file: SessionFile = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    shown,
    injectedChars: loadInjectedChars(localDir, sessionId) + Math.max(0, Math.floor(chars)),
    updatedAt: now.toISOString(),
  };
  writeTextAtomic(localDir, sessionFileOf(localDir, sessionId), `${JSON.stringify(file)}\n`);
  pruneDirectory(localDir, sessionDirOf(localDir), {
    maxAgeMs: SESSION_MAX_AGE_MS,
    maxFiles: MAX_SESSION_FILES,
    now: now.getTime(),
  });
}

// ---------------------------------------------------------------------------
// Source-file signatures
// ---------------------------------------------------------------------------
//
// A Bash call can change source files without any Edit hook seeing it, and the
// only way to find out is `git diff`, which costs a process start. This
// separate, per-session map remembers a size-and-mtime signature for the linked
// source files as of the last check, so a Bash call that changed nothing
// costs a handful of `stat` calls instead.

export const MAX_STATS_PER_SESSION = 2000;
const MAX_STATS_FILE_BYTES = 512 * 1024;

const statsFileOf = (localDir: string, sessionId: string): string =>
  sessionFileOf(localDir, sessionId).replace(/\.json$/, ".stat.json");

/** Signatures recorded for this session, `{ "<project-relative file>": "<size>:<mtimeMs>" }`. */
export function loadStats(localDir: string, sessionId: string): Record<string, string> {
  const path = statsFileOf(localDir, sessionId);
  try {
    if (statSync(path).size > MAX_STATS_FILE_BYTES) return {};
    const value = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: number; stats?: Record<string, unknown> };
    if (value.schemaVersion !== SESSION_SCHEMA_VERSION || typeof value.stats !== "object" || value.stats === null) return {};
    const out: Record<string, string> = {};
    for (const [file, signature] of Object.entries(value.stats)) if (typeof signature === "string") out[file] = signature;
    return out;
  } catch {
    return {};
  }
}

/** Merge signatures into the session's map; keeps the most recently written ones when it grows past the bound. */
export function recordStats(localDir: string, sessionId: string, stats: Readonly<Record<string, string>>, now: Date = new Date()): void {
  const entries = Object.entries(stats);
  if (entries.length === 0) return;
  const merged = { ...loadStats(localDir, sessionId), ...stats };
  const kept = Object.entries(merged).slice(-MAX_STATS_PER_SESSION);
  writeTextAtomic(localDir, statsFileOf(localDir, sessionId), `${JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, stats: Object.fromEntries(kept) })}\n`);
  pruneDirectory(localDir, sessionDirOf(localDir), { maxAgeMs: SESSION_MAX_AGE_MS, maxFiles: MAX_SESSION_FILES, now: now.getTime() });
}
