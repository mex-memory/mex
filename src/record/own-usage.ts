import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RecordWriter, RecordReader } from "./index.js";
import { addOwnUsage, object, reportedTokens, TOKEN_CLASSES, utcDay, ZERO, type Tokens } from "./usage.js";

type Agent = "claude" | "codex";
interface FileRow { path: string; agent: Agent; root: string; identity: string; offset: number; size: number; anchor: string; state: string; mtime: string; usage_lines: number; skipped_lines: number; problem_lines: number; failed: number; }
interface FileState { session?: string; dropping?: boolean; }
interface Frame { path: string; index: number; }
export interface OwnUsageStatus {
  agent: Agent; status: "readable" | "partial" | "unreadable"; files: number; bytes: number;
  pending: boolean; reason?: "missing" | "no-logs" | "unreadable" | "unknown-format" | "bounded";
  /** Lines seen in the tracked files: a rising problem count is how a log format change shows up. */
  usageLines?: number; skippedLines?: number; problemLines?: number; failedFiles?: number;
}
export interface OwnUsageOptions {
  claudeConfigDir?: string; codexHome?: string;
  /** Global across both agents, including anchor reads. Minimum 64 KiB to make progress on bounded lines. */
  maxBytes?: number; maxFiles?: number; maxDiscoveryEntries?: number;
  /** Only logs modified within this many days are discovered. Default 35 (the plan's 4-week base plus a week). */
  windowDays?: number;
  /** Test seam for the clock. */
  now?: Date;
}
export const OWN_USAGE_WINDOW_DAYS = 35;
/** Dedup rows are kept this many days past the window, so a late re-read inside the window never double counts. */
export const OWN_USAGE_MARGIN_DAYS = 7;
const DAY_MS = 86_400_000;
const MAX_LINE = 1024 * 1024;
const ANCHOR = 256;
function hash(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }
function getSetting<T>(db: DatabaseSync, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE scope='own-usage' AND key=?").get(key);
  try { return row ? JSON.parse(String(row.value)) as T : fallback; } catch { return fallback; }
}
function setSetting(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare("INSERT INTO settings VALUES('own-usage',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}
function safeChild(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

/** Discover incrementally without following links. Directory cursors survive restarts. */
function discover(db: DatabaseSync, agent: Agent, root: string, budget: number, since: number): boolean {
  const key = `scan.${agent}.${hash(Buffer.from(root))}`;
  const bases = agent === "claude" ? ["projects"] : ["sessions", "archived_sessions"];
  const frames = getSetting<Frame[]>(db, key, bases.map((path) => ({ path, index: 0 })));
  let visited = 0;
  while (frames.length && visited < budget) {
    const frame = frames[0]!;
    const directory = resolve(root, frame.path);
    if (!safeChild(root, directory)) { frames.shift(); continue; }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")); }
    catch { frames.shift(); continue; }
    // One directory listing per frame; metadata discovery is capped separately from log I/O.
    while (frame.index < entries.length && visited++ < budget) {
      const entry = entries[frame.index++]!, path = join(frame.path, entry.name);
      if (entry.isDirectory()) frames.push({ path, index: 0 });
      else if (entry.isFile() && (agent === "claude" ? entry.name.endsWith(".jsonl") : /^rollout-.*\.jsonl$/.test(entry.name))) {
        const file = resolve(root, path);
        // Old history is outside every budget window: never crawl it.
        try { if (statSync(file).mtimeMs < since) continue; } catch { continue; }
        db.prepare("INSERT INTO usage_files(path,agent,root) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET root=excluded.root").run(file, agent, root);
      }
    }
    if (frame.index >= entries.length) frames.shift();
  }
  const pending = frames.length > 0;
  setSetting(db, key, pending ? frames : bases.map((path) => ({ path, index: 0 })));
  return pending;
}

function response(db: DatabaseSync, agent: Agent, id: string, day: string, tokens: Tokens): void {
  const previous = db.prepare("SELECT * FROM usage_events WHERE agent=? AND event_id=?").get(agent, id) as unknown as (Tokens & { day: string }) | undefined;
  const targetDay = previous && previous.day < day ? previous.day : day;
  if (previous && targetDay !== previous.day) {
    const remove = { ...ZERO };
    for (const field of TOKEN_CLASSES) remove[field] = -previous[field];
    addOwnUsage(db, previous.day, agent, remove);
    addOwnUsage(db, targetDay, agent, previous);
  }
  const delta = { ...ZERO }, next = { ...tokens };
  for (const field of TOKEN_CLASSES) {
    next[field] = Math.max(tokens[field], previous?.[field] ?? 0);
    delta[field] = next[field] - (previous?.[field] ?? 0);
  }
  db.prepare(`INSERT INTO usage_events VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent,event_id) DO UPDATE SET
    day=excluded.day,input=excluded.input,cache_write=excluded.cache_write,cache_read=excluded.cache_read,output=excluded.output`)
    .run(agent, id, targetDay, next.input, next.cache_write, next.cache_read, next.output);
  if (TOKEN_CLASSES.some((k) => delta[k] > 0)) addOwnUsage(db, targetDay, agent, delta);
}

/** Daily cumulative endpoints make attribution independent of discovery order (including archives). */
function codexSnapshot(db: DatabaseSync, session: string, day: string, tokens: Tokens, horizon: string): void {
  db.prepare(`INSERT INTO usage_snapshots VALUES(?,?,?,?,?) ON CONFLICT(session_id,day) DO UPDATE SET
    input=max(input,excluded.input),cache_read=max(cache_read,excluded.cache_read),output=max(output,excluded.output)`)
    .run(session, day, tokens.input, tokens.cache_read, tokens.output);
  const snapshots = db.prepare("SELECT day,input,0 cache_write,cache_read,output FROM usage_snapshots WHERE session_id=? ORDER BY day").all(session) as unknown as Array<Tokens & { day: string }>;
  const high = { ...ZERO };
  for (const snapshot of snapshots) {
    const id = JSON.stringify([session, snapshot.day]);
    const previous = db.prepare("SELECT * FROM usage_events WHERE agent='codex' AND event_id=?").get(id) as unknown as Tokens | undefined;
    const contribution = { ...ZERO }, delta = { ...ZERO };
    for (const k of TOKEN_CLASSES) {
      contribution[k] = Math.max(0, snapshot[k] - high[k]);
      high[k] = Math.max(high[k], snapshot[k]);
      delta[k] = contribution[k] - (previous?.[k] ?? 0);
    }
    db.prepare(`INSERT INTO usage_events VALUES('codex',?,?,?,?,?,?) ON CONFLICT(agent,event_id) DO UPDATE SET
      input=excluded.input,cache_write=excluded.cache_write,cache_read=excluded.cache_read,output=excluded.output`)
      .run(id, snapshot.day, contribution.input, 0, contribution.cache_read, contribution.output);
    // Older days keep their snapshot as the session's baseline but no longer change totals.
    if (snapshot.day >= horizon && TOKEN_CLASSES.some((k) => delta[k] !== 0)) addOwnUsage(db, snapshot.day, "codex", delta);
  }
}

function windows(db: DatabaseSync, agent: Agent, event: Record<string, unknown>, timestamp: string): void {
  const payload = object(event.payload);
  const codex = object(payload?.rate_limits ?? event.rate_limits);
  const claude = object(event.rate_limit_info);
  const entries: Array<[string, Record<string, unknown>]> = [];
  if (agent === "codex" && codex) {
    for (const key of ["primary", "secondary"]) { const value = object(codex[key]); if (value) entries.push([key, value]); }
  }
  if (agent === "claude" && claude) {
    const key = typeof claude.rateLimitType === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(claude.rateLimitType) ? claude.rateLimitType : "plan";
    entries.push([key, claude]);
  }
  for (const [key, info] of entries) {
    const percent = agent === "codex" ? info.used_percent : typeof info.utilization === "number" ? info.utilization * 100 : undefined;
    const used = typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
    const reset = info.resets_at ?? info.resetsAt;
    const resets = typeof reset === "number" && reset >= 0 && reset <= 4_102_444_800 ? new Date(reset * 1000).toISOString() : null;
    const status = ["allowed", "allowed_warning", "rejected"].includes(String(info.status)) ? String(info.status) : null;
    if (used === null && resets === null && status === null) continue;
    db.prepare(`INSERT INTO usage_windows VALUES(?,?,?,?,?,?) ON CONFLICT(agent,window) DO UPDATE SET
      observed_at=excluded.observed_at,used_percent=excluded.used_percent,resets_at=excluded.resets_at,status=excluded.status
      WHERE excluded.observed_at>=usage_windows.observed_at`).run(agent, key, timestamp, used, resets, status);
  }
}

type LineKind = "usage" | "skipped" | "problem";
/**
 * Only usage-bearing lines can be problems. Agents add new line types often, so
 * any other line is skipped and counted, never treated as an unknown format.
 */
function consume(db: DatabaseSync, agent: Agent, line: Buffer, state: FileState, horizon: string): LineKind {
  let parsed: unknown;
  // A line that isn't JSON at all can't be told apart from a damaged usage line.
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { return "problem"; }
  const e = object(parsed);
  if (!e) return "skipped";
  const date = new Date(String(e.timestamp));
  const timestamp = Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  if (timestamp) windows(db, agent, e, timestamp);
  if (agent === "claude") {
    const message = object(e.message);
    if (e.type !== "assistant" || message?.usage === undefined) return "skipped";
    // Synthetic and API-error messages carry no billable observation.
    if (e.isSynthetic === true || e.isApiErrorMessage === true || message.model === "<synthetic>") return "skipped";
    const tokens = reportedTokens(message.usage, agent);
    const request = e.requestId ?? e.request_id ?? message.request_id;
    if (!tokens || !timestamp || typeof message.id !== "string" || typeof request !== "string") return "problem";
    const day = utcDay(timestamp);
    // Older than the dedup horizon: its dedup row may be gone, so counting it could double count.
    if (day < horizon) return "skipped";
    response(db, agent, JSON.stringify([message.id, request]), day, tokens);
    return "usage";
  }
  const payload = object(e.payload);
  if (e.type === "session_meta" && typeof payload?.id === "string") { state.session = payload.id; return "skipped"; }
  if (e.type !== "event_msg" || payload?.type !== "token_count") return "skipped";
  const info = object(payload.info);
  // Null info is a plan-window update, not zero usage.
  if (!info) return "skipped";
  const tokens = reportedTokens(info.total_token_usage, agent);
  if (!tokens || !timestamp || !state.session) return "problem";
  codexSnapshot(db, state.session, utcDay(timestamp), tokens, horizon);
  return "usage";
}

/** Atomic file batch: cursor, dedup keys, daily totals and plan snapshots commit together. No text is saved. */
function readFile(db: DatabaseSync, row: FileRow, budget: number, root: string, maxLine: number, horizon: string): { bytes: number; pending: boolean } {
  let fd: number | undefined;
  let bytes = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Do not use a stale cursor selected before another process committed its batch.
    row = db.prepare("SELECT * FROM usage_files WHERE path=?").get(row.path) as unknown as FileRow;
    if (!row) { db.exec("COMMIT"); return { bytes: 0, pending: false }; }
    if (!safeChild(root, realpathSync.native(row.path))) throw new Error("Log left its source root");
    fd = openSync(row.path, "r");
    const stat = fstatSync(fd), identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (!stat.isFile()) throw new Error("Not a regular log");
    let offset = row.offset, state: FileState = JSON.parse(row.state);
    const lines = { usage: row.usage_lines, skipped: row.skipped_lines, problem: row.problem_lines };
    const anchorStart = Math.max(0, offset - ANCHOR);
    const anchor = Buffer.alloc(offset - anchorStart);
    bytes += readSync(fd, anchor, 0, anchor.length, anchorStart);
    const prefix = Buffer.alloc(Math.min(ANCHOR, offset));
    bytes += readSync(fd, prefix, 0, prefix.length, 0);
    if (identity !== row.identity || stat.size < offset || (offset > 0 && `${hash(prefix)}:${hash(anchor)}` !== row.anchor)) {
      offset = 0; state = {}; lines.usage = 0; lines.skipped = 0; lines.problem = 0;
    }
    const size = Math.min(stat.size - offset, Math.max(0, budget - bytes - 2 * ANCHOR));
    const buffer = Buffer.alloc(size);
    const n = readSync(fd, buffer, 0, size, offset); bytes += n;
    let start = 0, committed = 0;
    while (start < n) {
      const newline = buffer.indexOf(10, start);
      if (newline < 0) {
        // Discard an oversized line through its eventual newline, without saving private fragments.
        if (state.dropping || n - start > maxLine) { if (!state.dropping) lines.problem++; state.dropping = true; committed = n; }
        break;
      }
      if (state.dropping || newline - start > maxLine) { if (!state.dropping) lines.problem++; state.dropping = false; }
      else if (newline > start) {
        lines[consume(db, row.agent, buffer.subarray(start, newline), state, horizon)]++;
      }
      committed = newline + 1; start = committed;
    }
    offset += committed;
    const tail = Buffer.alloc(Math.min(ANCHOR, offset));
    bytes += readSync(fd, tail, 0, tail.length, offset - tail.length);
    const head = Buffer.alloc(Math.min(ANCHOR, offset));
    bytes += readSync(fd, head, 0, head.length, 0);
    db.prepare(`UPDATE usage_files SET identity=?,offset=?,size=?,anchor=?,state=?,mtime=?,
      usage_lines=?,skipped_lines=?,problem_lines=?,failed=0 WHERE path=?`)
      .run(identity, offset, stat.size, `${hash(head)}:${hash(tail)}`, JSON.stringify(state), stat.mtime.toISOString(),
        lines.usage, lines.skipped, lines.problem, row.path);
    db.exec("COMMIT");
    return { bytes, pending: offset < stat.size };
  } catch (error) {
    db.exec("ROLLBACK");
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && row.identity && row.offset === row.size && !row.failed) {
      // Normal archive/pruning after a fully consumed file. Global dedup survives its cursor.
      db.prepare("DELETE FROM usage_files WHERE path=?").run(row.path);
    } else db.prepare("UPDATE usage_files SET failed=1,identity='' WHERE path=?").run(row.path);
    return { bytes, pending: false };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Bounded retention: daily totals stay; per-response dedup rows go once they are older than the horizon
 * (window plus margin), and fully read logs older than the window are forgotten.
 * A Codex session keeps all its snapshots while any of them is inside the horizon, because each day's
 * share is the difference from the previous snapshot.
 */
function prune(db: DatabaseSync, horizon: string, sinceIso: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM usage_events WHERE agent='claude' AND day<?").run(horizon);
    const old = "SELECT session_id FROM usage_snapshots GROUP BY session_id HAVING max(day)<?";
    db.prepare(`DELETE FROM usage_events WHERE agent='codex' AND json_extract(event_id,'$[0]') IN (${old})`).run(horizon);
    db.prepare(`DELETE FROM usage_snapshots WHERE session_id IN (${old})`).run(horizon);
    db.prepare("DELETE FROM usage_files WHERE identity!='' AND failed=0 AND offset=size AND mtime!='' AND mtime<?").run(sinceIso);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Explicit maintenance only: never called by a hook or an ordinary totals read. */
export function refreshOwnUsage(writer: RecordWriter, options: OwnUsageOptions = {}): OwnUsageStatus[] {
  const db = writer.db;
  for (const value of [options.maxFiles, options.maxBytes, options.maxDiscoveryEntries]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Usage work limits must be positive integers");
  }
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 64));
  const maxBytes = Math.max(64 * 1024, Math.floor(options.maxBytes ?? 4 * 1024 * 1024));
  const windowDays = options.windowDays ?? OWN_USAGE_WINDOW_DAYS;
  if (!Number.isSafeInteger(windowDays) || windowDays < 1) throw new Error("Usage window must be a positive number of days");
  const now = (options.now ?? new Date()).getTime();
  const since = now - windowDays * DAY_MS;
  const horizon = utcDay(new Date(since - OWN_USAGE_MARGIN_DAYS * DAY_MS).toISOString());
  const statuses: OwnUsageStatus[] = [];
  const roots: Array<[Agent, string]> = [
    ["claude", resolve(options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))],
    ["codex", resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"))],
  ];
  const valid: Array<[Agent, string]> = [];
  for (const [agent, candidate] of roots) {
    const status: OwnUsageStatus = { agent, status: "unreadable", files: 0, bytes: 0, pending: false };
    statuses.push(status);
    try {
      if (!statSync(candidate).isDirectory()) throw new Error("Not a folder");
      const root = realpathSync.native(candidate);
      valid.push([agent, root]);
      status.pending = discover(db, agent, root, Math.max(1, options.maxDiscoveryEntries ?? 4096), since);
    } catch { status.reason = "missing"; }
  }
  // One global round-robin cursor keeps either agent/large old files from starving the other.
  const last = getSetting(db, "last-file", "");
  const rootsFilter = valid.map(() => "(agent=? AND root=?)").join(" OR ") || "0";
  const args = valid.flatMap(([agent, root]) => [agent, root]);
  const ahead = db.prepare(`SELECT * FROM usage_files WHERE (${rootsFilter}) AND path>? ORDER BY path LIMIT ?`).all(...args, last, maxFiles + 1) as unknown as FileRow[];
  const behind = ahead.length > maxFiles ? [] : db.prepare(`SELECT * FROM usage_files WHERE (${rootsFilter}) AND path<=? ORDER BY path LIMIT ?`).all(...args, last, maxFiles + 1 - ahead.length) as unknown as FileRow[];
  const ordered = [...ahead, ...behind];
  let bytes = 0, files = 0;
  for (const row of ordered) {
    const status = statuses.find((s) => s.agent === row.agent)!;
    if (files >= maxFiles || maxBytes - bytes < 64 * 1024) continue;
    const result = readFile(db, row, maxBytes - bytes, row.root, Math.min(MAX_LINE, Math.floor(maxBytes / 2)), horizon);
    bytes += result.bytes; files++; status.files++; status.bytes += result.bytes; status.pending ||= result.pending;
    setSetting(db, "last-file", row.path);
  }
  prune(db, horizon, new Date(since).toISOString());
  for (const status of statuses) {
    const root = valid.find(([a]) => a === status.agent)?.[1];
    if (root) {
      const summary = db.prepare(`SELECT count(*) files,coalesce(sum(usage_lines),0) usage,
        coalesce(sum(skipped_lines),0) skipped,coalesce(sum(problem_lines),0) problems,coalesce(sum(failed),0) failed,
        coalesce(max(offset<size OR identity=''),0) pending FROM usage_files WHERE agent=? AND root=?`).get(status.agent, root)!;
      const files = Number(summary.files), usage = Number(summary.usage), problems = Number(summary.problems), failed = Number(summary.failed);
      status.pending ||= !!summary.pending;
      Object.assign(status, { usageLines: usage, skippedLines: Number(summary.skipped), problemLines: problems, failedFiles: failed });
      // Unreadable means no usage could be read at all; new line types alone never cause it.
      if (!files) { status.status = "unreadable"; status.reason = "no-logs"; }
      else if (!usage && (problems || failed)) { status.status = "unreadable"; status.reason = "unknown-format"; }
      else if (status.pending) { status.status = "partial"; status.reason = "bounded"; }
      else { status.status = "readable"; delete status.reason; }
    }
    setSetting(db, `status.${status.agent}`, status);
  }
  return statuses;
}

export function ownUsageTotals(reader: Pick<RecordReader, "all">, from: string, through: string): Array<Tokens & { day: string; agent: string; estimated: number }> {
  const start = utcDay(from), end = utcDay(through);
  if (start > end) throw new Error("Usage range starts after it ends");
  return reader.all("SELECT * FROM own_usage WHERE day BETWEEN ? AND ? ORDER BY day,agent", start, end);
}
export function ownUsageStatus(reader: Pick<RecordReader, "setting">): OwnUsageStatus[] {
  return (["claude", "codex"] as const).map((agent) => {
    try { const value = reader.setting("own-usage", `status.${agent}`); if (value) return JSON.parse(value) as OwnUsageStatus; } catch { /* no scan */ }
    return { agent, status: "unreadable", reason: "no-logs", files: 0, bytes: 0, pending: false };
  });
}
export function usageWindows(reader: Pick<RecordReader, "all">): Array<{ agent: string; window: string; observed_at: string; used_percent: number | null; resets_at: string | null; status: string | null }> {
  return reader.all("SELECT * FROM usage_windows ORDER BY agent,window");
}
