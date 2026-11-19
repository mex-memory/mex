import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { stripHidden } from "../knowledge/gates.js";
import { openHooksReadOnly, type RecordReader } from "../record/index.js";
import { recordLocation } from "../record/location.js";
import { absolutePath, realPath, shortHash } from "../record/project.js";
import { cleanSourceText, sourceDigest, validAt, type SessionSource, type SourceWindow } from "./source.js";

export const MAX_SESSIONS = 12;
export const SESSIONS_PER_BATCH = 2;
const MESSAGES_PER_SESSION = 8;
const FILE_BYTES = 768 << 10;
const IDLE_MS = 10 * 60_000;
const MAX_FILES = 64;
const MAX_DIRENTS = 2048;
const agentSchema = z.enum(["claude", "codex"]);
type Agent = z.infer<typeof agentSchema>;
const component = /^[A-Za-z0-9._-]+$/u;
const uuidFile = /^[a-f0-9-]{36}\.jsonl$/iu;
const rollout = /^rollout-[\dT-]+[a-f0-9-]{36}\.jsonl$/iu;
const datePart = [/^\d{4}$/u, /^\d{2}$/u, /^\d{2}$/u];
const interactiveCodex = new Set<unknown>([undefined, "cli", "vscode", "mcp", "appServer", "app-server"]);
const status = { claude: "Claude Code", codex: "Codex" };

export const ImportFile = z.object({ agent: agentSchema, path: z.array(z.string().max(255).regex(component))
  .min(2).max(5).refine(parts => parts.every(part => part !== "." && part !== "..")),
digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), messages: z.number().int().positive().max(MESSAGES_PER_SESSION) }).strict();
export type ImportFile = z.infer<typeof ImportFile>;
type Settings = Pick<RecordReader, "setting">;
type ImportOptions = { checkout: string; project: string; window: SourceWindow; store: Settings; home?: string; now?: number };
type State = { gaps: Set<string>; visited: number };

export function importsEnabled(store: Settings, project: string): boolean {
  return store.setting("global", "capture.enabled") !== "false" && store.setting(project, "capture.enabled") !== "false";
}

export const importedSourceKey = (id: string) => `learning.deep.import.${id}`;

function hostRoot(agent: Agent): string {
  return absolutePath(agent === "claude" ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    : process.env.CODEX_HOME ?? join(homedir(), ".codex"));
}

function* children(dir: string, state: State) {
  let handle;
  try { handle = opendirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      if (++state.visited > MAX_DIRENTS) { state.gaps.add("Some session files were outside the import scan limit."); break; }
      if (component.test(entry.name) && entry.name !== "." && entry.name !== "..") yield entry;
    }
  } finally { handle.closeSync(); }
}

function directories(root: string, parts: string[]): string {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || realPath(current) !== absolutePath(current)) throw new Error("Redirected transcript directory");
  }
  return current;
}

function* candidates(agent: Agent, root: string, checkout: string, state: State): Generator<string[]> {
  const files = function* (parts: string[], name: RegExp) {
    for (const entry of children(directories(root, parts), state)) {
      if (entry.isFile() && name.test(entry.name)) yield [...parts, entry.name];
    }
  };
  if (agent === "claude") {
    const comparable = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
    const prefix = comparable(checkout.replace(/[^A-Za-z0-9]/gu, "-"));
    for (const dir of children(directories(root, ["projects"]), state)) {
      const name = comparable(dir.name);
      if (dir.isDirectory() && (name === prefix || name.startsWith(`${prefix}-`))) yield* files(["projects", dir.name], uuidFile);
    }
    return;
  }
  const dated = function* (parts: string[], depth: number): Generator<string[]> {
    if (depth === datePart.length) { yield* files(parts, rollout); return; }
    // These lists are bounded. Start with recent dates so a large history can still import.
    const days = [...children(directories(root, parts), state)].filter(e => e.isDirectory() && datePart[depth]!.test(e.name));
    for (const entry of days.sort((a, b) => b.name.localeCompare(a.name))) yield* dated([...parts, entry.name], depth + 1);
  };
  for (const folder of ["sessions", "archived_sessions"]) {
    try { yield* (folder === "sessions" ? dated([folder], 0) : files([folder], rollout)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function readPrefix(path: string, now: number): { text: string; partial: boolean } | undefined {
  const expected = lstatSync(path, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error("Redirected transcript file");
  if (Number(expected.mtimeMs) > now - IDLE_MS || !expected.size) return undefined;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.mtimeNs !== expected.mtimeNs) {
      throw new Error("Transcript changed while loading");
    }
    const bytes = Buffer.alloc(Math.min(FILE_BYTES, Number(before.size)));
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (offset !== bytes.length || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("Transcript changed while loading");
    }
    const partial = before.size > BigInt(bytes.length);
    const end = partial ? Math.max(0, bytes.lastIndexOf(10)) : bytes.length;
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)), partial };
  } finally { closeSync(fd); }
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const idOf = (value: unknown) => typeof value === "string" && /^[a-z0-9_-]{1,128}$/iu.test(value) ? value : undefined;

function inCheckout(cwd: unknown, checkout: string): boolean {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
  try {
    let actual = realPath(cwd);
    const within = relative(checkout, actual);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return false;
    while (actual !== checkout) {
      try { lstatSync(join(actual, ".git")); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      actual = dirname(actual);
    }
    return true;
  } catch { return false; }
}

function claudeText(row: Record<string, unknown>): string | null | undefined {
  if (row.isMeta || row.isSidechain || row.toolUseResult || row.sourceToolAssistantUUID || row.isCompactSummary || row.isVisibleInTranscriptOnly
    || typeof row.entrypoint === "string" && /^(?:sdk|print|noninteractive)/iu.test(row.entrypoint)) return null;
  const message = record(row.message);
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const blocks = message.content.map(record);
  if (blocks.some(block => block?.type === "tool_result" || block?.type === "image" || block?.type === "document")) return null;
  if (!blocks.every(block => block?.type === "text" && typeof block.text === "string")) return undefined;
  return blocks.length === 1 ? blocks[0]!.text as string : null;
}

function safeTyped(text: string): string | undefined {
  if (text.length > 3000 || Array.from(text).length > 1500 || text.split("\n").length >= 20 || stripHidden(text) !== text
    || /^(?:\s*\/[^/\s]+(?:\s|$)|\s*<)/u.test(text)
    || /<\/?(?:system-reminder|environment_context|command-(?:name|message|args)|local-command[^ >]*|user-prompt-submit-hook|task-notification|channel)\b|\[Pasted (?:text|image)|\[(?:learned, not shared|personal, from|team, from|secret removed)/iu.test(text)
    || /(?:^|\n)\s*(?:diff --git |@@ -\d+|Traceback \(|at .+\(.+:\d+|File ".+", line \d+|\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/u.test(text)
    || /(?:^|[^\w])[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}\b|(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/iu.test(text)) return undefined;
  const safe = cleanSourceText(text);
  return safe && safe.length >= 12 ? safe : undefined;
}

/** Transcript text exists only while counting candidates or processing an approved batch. */
function decode(text: string, agent: Agent, options: ImportOptions, ignoreSession: (agent: Agent, id: string) => boolean) {
  const sources = new Map<string, SessionSource>();
  let session: string | undefined, local = false, recognized = false, changed = false, limited = false, mirroredUser = false, userEvent = false;
  const cwdMatches = new Map<unknown, boolean>();
  const matches = (cwd: unknown) => {
    if (!cwdMatches.has(cwd)) cwdMatches.set(cwd, inCheckout(cwd, options.checkout));
    return cwdMatches.get(cwd) ?? false;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = record(JSON.parse(line)); } catch { changed = true; continue; }
    if (!row) { changed = true; continue; }
    const payload = record(row.payload);
    if (agent === "codex" && row.type === "session_meta") {
      const id = idOf(payload?.id);
      if (!id || typeof payload?.cwd !== "string") { changed = true; break; }
      if (session && session !== id) { changed = true; break; }
      if (!session) {
        recognized = true;
        if (!matches(payload.cwd) || !interactiveCodex.has(payload.source) || payload.parent_thread_id
          || (payload.thread_source && payload.thread_source !== "user") || ignoreSession(agent, id)) break;
      }
      session = id; local = matches(payload.cwd);
    }
    if (agent === "codex" && local && row.type === "turn_context" && typeof payload?.cwd === "string" && !matches(payload.cwd)) {
      return { sources: [], changed: false, limited: false };
    }
    if (agent === "codex" && local && row.type === "response_item" && payload?.role === "user") mirroredUser = true;
    let typed: string | null | undefined;
    if (agent === "claude" && row.type === "user") {
      recognized = true;
      const id = idOf(row.sessionId);
      if (!id || typeof row.cwd !== "string") { changed = true; continue; }
      if (!matches(row.cwd)) continue;
      if (session && session !== id) { changed = true; break; }
      if (!session && ignoreSession(agent, id)) break;
      session = id; typed = claudeText(row);
    } else if (agent === "codex" && local && row.type === "event_msg" && payload?.type === "user_message") {
      userEvent = true;
      typed = payload.kind && payload.kind !== "plain" || Array.isArray(payload.images) && payload.images.length
        || Array.isArray(payload.local_images) && payload.local_images.length || Array.isArray(payload.text_elements) && payload.text_elements.length
        ? null : typeof payload.message === "string" ? payload.message : undefined;
    } else continue;
    if (typed === undefined || typeof row.timestamp !== "string") { changed = true; continue; }
    if (!session || !typed || !validAt(row.timestamp, options.window.since, options.window.until)) continue;
    const safe = safeTyped(typed);
    if (!safe) continue;
    const sessionKey = shortHash(`${agent}\0${session}`);
    const id = `session:${sessionKey}:${shortHash(safe)}`;
    if (sources.has(id)) continue;
    if (sources.size >= MESSAGES_PER_SESSION) { limited = true; break; }
    sources.set(id, { kind: "person", id, text: safe, at: new Date(row.timestamp).toISOString(), hash: sourceDigest(typed), session: sessionKey,
      link: `past session ${sessionKey}` });
  }
  // A novel shape in a file must never turn another row from it into evidence.
  return { sources: changed ? [] : [...sources.values()], changed: changed || (!!text.trim() && !recognized) || mirroredUser && !userEvent, limited };
}

function eligibleFiles(options: ImportOptions) {
  const hooks = openHooksReadOnly({ home: options.home });
  const location = recordLocation({ home: options.home, create: false });
  return {
    close: () => hooks?.close(),
    ignoreSession(agent: Agent, id: string) {
      if (hooks?.diagnostic) throw new Error("Incompatible capture journal");
      // MEX already saw these sessions. Exclude all their turns, including any echoed delivery.
      if (hooks?.get("SELECT 1 FROM sessions WHERE session_id=?", id)) return true;
      try { lstatSync(join(location.directory, "hook-paused", shortHash(`${agent === "claude" ? "claude-code" : agent}\0${id}`))); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return false;
    },
  };
}

function imported(agent: Agent, root: string, path: string[], options: ImportOptions, ignore: (agent: Agent, id: string) => boolean, gaps: Set<string>) {
  const full = join(directories(root, path.slice(0, -1)), path.at(-1)!);
  const body = readPrefix(full, options.now ?? Date.now());
  if (!body) return [];
  const parsed = decode(body.text, agent, options, ignore);
  if (parsed.changed) gaps.add(`${status[agent]} capture paused for unreadable past sessions.`);
  if (parsed.limited || body.partial && (parsed.sources.length || !body.text)) gaps.add("Some transcript text was outside the import scan limit.");
  return parsed.sources;
}

const fingerprint = (sources: SessionSource[]) => sourceDigest(JSON.stringify(sources.map(({ id, hash, at }) => [id, hash, at])));

export function previewImport(options: ImportOptions): { files: ImportFile[]; gaps: string[] } {
  const files: ImportFile[] = [];
  const seen = new Set<string>();
  const gaps = new Set<string>();
  if (!importsEnabled(options.store, options.project)) return { files, gaps: [] };
  let eligible;
  try { eligible = eligibleFiles(options); }
  catch { return { files, gaps: ["Past-session capture paused because the local capture record could not be read."] }; }
  try {
    for (const agent of agentSchema.options) {
      const state = { gaps, visited: 0 };
      try {
        const root = realPath(hostRoot(agent));
        let examined = 0;
        for (const path of candidates(agent, root, options.checkout, state)) {
          if (++examined > MAX_FILES || files.length >= MAX_SESSIONS) { gaps.add("Some session files were outside the import scan limit."); break; }
          let sources;
          try { sources = imported(agent, root, path, options, eligible.ignoreSession, gaps); }
          catch { gaps.add(`${status[agent]} capture paused for unreadable past sessions.`); continue; }
          const digest = fingerprint(sources);
          const messages = sources.filter(source => !options.store.setting(options.project, importedSourceKey(source.id))).length;
          if (!messages || seen.has(digest)) continue;
          seen.add(digest); files.push({ agent, path, digest, messages });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") gaps.add(`${status[agent]} capture paused for unreadable past sessions.`);
      }
    }
  } finally { eligible.close(); }
  return { files, gaps: [...gaps] };
}

export function readImport(files: ImportFile[], options: ImportOptions, gaps: Set<string>): SessionSource[] {
  if (!importsEnabled(options.store, options.project)) { gaps.add("Past-session capture is off here."); return []; }
  let eligible;
  try { eligible = eligibleFiles(options); }
  catch { gaps.add("Past-session capture paused because the local capture record could not be read."); return []; }
  const sources = new Map<string, SessionSource>();
  try {
    for (const file of files) {
      try {
        const result = imported(file.agent, realPath(hostRoot(file.agent)), file.path, options, eligible.ignoreSession, gaps);
        if (fingerprint(result) !== file.digest) { gaps.add("Some approved sessions changed or became unavailable after the preview."); continue; }
        for (const source of result) if (!options.store.setting(options.project, importedSourceKey(source.id))) sources.set(source.id, source);
      } catch { gaps.add(`${status[file.agent]} capture paused for unreadable past sessions.`); }
    }
  } finally { eligible.close(); }
  return [...sources.values()];
}
