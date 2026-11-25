import { z } from "zod";
import type { RecordReader, RecordWriter } from "../record/index.js";
import type { Position } from "../judge/evidence.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import { KNOWLEDGE_LIMITS, KnowledgeError } from "../knowledge/entry.js";
import { claimHash, localSettings } from "../knowledge/state.js";
import { isVersion, newerVersion } from "../version-order.js";
import { capturedPositionAt, type SessionPosition } from "./input.js";
import { branchKey, latestRelease, NoteBranch, observeLifetimeGit, type LifetimeGit } from "./lifetime-git.js";
import { verbatimText, type StageOneVerdict } from "./verdicts.js";

const DAY = 86_400_000;
export const SEEN_ONCE_MS = 30 * DAY;
const RELEASE_MS = 60 * DAY;
const PREFIX = "learning.session-note.";
const NOTE_BYTES = 16 << 10;
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const Time = z.number().int().safe().nonnegative().max(8_640_000_000_000_000);
const Scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("seen") }).strict(),
  z.object({ kind: z.literal("branch"), origin: NoteBranch }).strict(),
  z.object({ kind: z.literal("release"), baseline: z.string().refine(isVersion).nullable().optional() }).strict(),
  z.object({ kind: z.literal("repo") }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
]);
const Reason = z.enum(["branch-merged", "release-tag", "release-age", "seen-once", "restated", "corrected", "one-off"]);
const Note = z.object({ version: z.literal(1), id: Digest, claim: Digest, scope: Scope, at: Time,
  session: z.string().min(1).max(512), row: z.string().regex(/^m[1-9]\d{0,15}$/u),
  quote: z.string().min(1).max(2400).refine(text => !!text.trim() && stripHidden(text) === text && !hasSecret(text)),
  corroborated: z.literal("host-memory").optional(),
  retired: z.object({ reason: Reason, at: Time, replacement: Digest.optional() }).strict().optional(),
}).strict();
export type SessionNote = z.infer<typeof Note>;
type Note = SessionNote;
type Scope = z.infer<typeof Scope>;
type Reason = z.infer<typeof Reason>;
type Candidate = Extract<StageOneVerdict, { verdict: "candidate" }>;
interface StoredNote { scope: string; key: string; value?: string; note: Note; }
interface NoteInput { session: string; sourcePosition?: SessionPosition; verdicts: readonly Candidate[]; corroborated?: ReadonlySet<string>; }
export type NoteChanges = Map<string, StoredNote>;
export const sessionNoteId = (project: string, session: string, id: string) => claimHash(JSON.stringify([project, session, id]));

function readNotes(store: RecordReader | RecordWriter, scope: string): StoredNote[] {
  return localSettings(store, scope, PREFIX, NOTE_BYTES).map(({ key, value }) => {
    try {
      const note = Note.parse(JSON.parse(value));
      if (key === PREFIX + note.id && (note.scope.kind === "all") === (scope === "global")) return { scope, key, value, note };
    } catch { /* Keep invalid local data private and report a fixed diagnostic. */ }
    throw new KnowledgeError("INVALID_STATE", "A session note record is invalid.");
  });
}

/** Returns both active and retired private proof, with the machine-wide notes visible to this profile. */
export function sessionNoteHistory(store: RecordReader | RecordWriter, project: string): Note[] {
  return [...readNotes(store, project), ...readNotes(store, "global")].map(row => row.note);
}

function expiry(note: Note, git: LifetimeGit, now: number): Reason | undefined {
  const scope = note.scope, age = now - note.at;
  switch (scope.kind) {
    case "seen": return age >= SEEN_ONCE_MS ? "seen-once" : undefined;
    case "branch": return git.branches.get(branchKey(scope.origin))?.merged ? "branch-merged" : undefined;
    case "release": {
      const newer = git.release && scope.baseline !== undefined && (scope.baseline === null || newerVersion(git.release, scope.baseline));
      return newer ? "release-tag" : age >= RELEASE_MS ? "release-age" : undefined;
    }
    default: return undefined;
  }
}

const order: Record<Scope["kind"], number> = { seen: 0, branch: 1, release: 2, repo: 3, all: 4 };

function sameClaim(a: Note, b: Note): boolean {
  if (a.claim !== b.claim) return false;
  return a.scope.kind !== "branch" || b.scope.kind !== "branch" || a.scope.origin.name === b.scope.origin.name;
}

/** Projection used by the delivery fixture and the later checked writer. Reading never changes history. */
export function sessionNoteQuotes(store: RecordReader | RecordWriter, project: string, at: Position, now: number, git: LifetimeGit) {
  const notes = sessionNoteHistory(store, project).filter(note => {
    if (note.retired || note.scope.kind === "seen" || note.at > now || expiry(note, git, now)) return false;
    if (note.scope.kind !== "branch") return true;
    const { origin } = note.scope;
    const state = git.branches.get(branchKey(origin));
    return at.branch === "refs/heads/" + origin.name && state?.matches === true && state.tip === at.head;
  }).sort((a, b) => order[b.scope.kind] - order[a.scope.kind] || b.at - a.at || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return notes.flatMap(note => {
    if (seen.has(note.claim)) return [];
    seen.add(note.claim);
    return [{ id: note.id, lasts: note.scope.kind, text: verbatimText(note.quote, new Date(note.at).toISOString()),
      ...(note.corroborated ? { corroborated: note.corroborated } : {}) }];
  });
}

function noteFromVerdict(project: string, source: NoteInput, verdict: Candidate): Note | undefined {
  if (verdict.lasts === "task") return;
  const id = sessionNoteId(project, source.session, verdict.id);
  const quote = verdict.quote.text;
  // Strip the verified scope phrase only at the edge of a quote. A restatement
  // with different claim text is left for Stage 2 to reconcile.
  let subject = quote.trim();
  const marker = verdict.marker?.replace(/[.,:;!?]+$/u, "");
  const changesClaim = marker && /^(?:never|not|we use)\b/iu.test(marker.trim());
  if (changesClaim && marker && !quote.includes(marker)) return;
  if (marker && !changesClaim && subject.startsWith(marker) && /^[\s,.:;!?]/u.test(subject.slice(marker.length)))
    subject = subject.slice(marker.length).replace(/^[\s,.:;!?]+/u, "");
  else if (marker && !changesClaim && subject.replace(/[.!?]+$/u, "").endsWith(" " + marker))
    subject = subject.replace(/[.!?]+$/u, "").slice(0, -(marker.length + 1));
  const claim = verdict.kind === "approval" ? id : claimHash(subject.replace(/[.!?]+$/u, "") || quote);
  const corroborated = source.corroborated?.has(verdict.id) ? "host-memory" : undefined;
  const lasts = corroborated ? "repo" : verdict.outcome === "personal" ? verdict.lasts : "seen";
  const origin = lasts === "branch" ? capturedPositionAt(source.sourcePosition, verdict.at) : undefined;
  let scope: Scope = { kind: "seen" };
  if (origin) scope = { kind: "branch", origin: { name: origin.branch, head: origin.head, unmerged_head: "" } };
  else if (lasts !== "branch") scope = { kind: lasts };
  return Note.parse({ version: 1, id, claim, scope, at: Date.parse(verdict.at), session: source.session, row: verdict.id, quote, corroborated });
}

/** Plan changes before the job transaction so Git work never holds the record lock. */
export async function planSessionNotes(writer: RecordWriter, project: string, checkout: string, now: number, source?: NoteInput,
  observe: typeof observeLifetimeGit = observeLifetimeGit): Promise<NoteChanges> {
  const incoming = source?.verdicts.flatMap(verdict => {
    const note = noteFromVerdict(project, source, verdict);
    return note ? [note] : [];
  }) ?? [];
  const projectRows = readNotes(writer, project);
  const globalRows = incoming.length ? readNotes(writer, "global") : [];
  const rows = new Map([...projectRows, ...globalRows].map(row => [row.note.id, row]));
  const relevant = [...projectRows.filter(row => !row.note.retired).map(row => row.note), ...incoming];
  const git: LifetimeGit = project.startsWith("g-") || writer.checkout(checkout)?.provisional || relevant.some(note => note.scope.kind === "branch")
    ? await observe(checkout, relevant.flatMap(note => note.scope.kind === "branch" ? [note.scope.origin] : []),
      relevant.some(note => note.scope.kind === "release")) : { branches: new Map() };
  const changes: NoteChanges = new Map();
  const stage = (note: Note) => {
    const existing = rows.get(note.id);
    const row = existing ? { ...existing, note } : { scope: note.scope.kind === "all" ? "global" : project, key: PREFIX + note.id, note };
    rows.set(note.id, row);
    changes.set(note.id, row);
  };
  const retire = (note: Note, reason: Reason, replacement?: string) => stage({ ...note, retired: { reason, at: now, replacement } });

  const withReleaseBaseline = (note: Note): Note => {
    if (note.scope.kind !== "release" || note.scope.baseline !== undefined || git.release === undefined) return note;
    // A release can ship between the typed message and the finished-session job.
    const baseline = git.tags ? latestRelease(git.tags.filter(tag => tag.time <= note.at).map(tag => tag.name)) : git.release;
    return { ...note, scope: { ...note.scope, baseline } };
  };
  const withObservedTip = (note: Note): Note => {
    if (note.scope.kind !== "branch") return note;
    const { origin } = note.scope;
    const tip = git.branches.get(branchKey(origin))?.unmerged_head;
    return tip && tip !== origin.unmerged_head ? { ...note, scope: { ...note.scope, origin: { ...origin, unmerged_head: tip } } } : note;
  };
  for (const row of projectRows) {
    if (row.note.retired) continue;
    const note = withReleaseBaseline(row.note);
    const reason = expiry(note, git, now);
    if (reason) retire(note, reason);
    else {
      const observed = withObservedTip(note);
      if (observed !== row.note) stage(observed);
    }
  }

  for (let note of incoming.sort((a, b) => a.at - b.at || Number(a.row.slice(1)) - Number(b.row.slice(1)))) {
    if (rows.has(note.id)) continue;
    note = withReleaseBaseline(note);
    const reason = expiry(note, git, now);
    if (reason) { retire(note, reason); continue; }
    note = withObservedTip(note);
    const claims = [...rows.values()].map(row => row.note).filter(other => sameClaim(other, note));
    const related = claims.filter(other => !other.retired);
    const wider = related.find(other => order[other.scope.kind] > order[note.scope.kind]);
    const equal = related.find(other => {
      if (other.scope.kind !== note.scope.kind) return false;
      // A reused branch name needs a new source position, even for the same words.
      if (other.scope.kind === "branch") return git.branches.get(branchKey(other.scope.origin))?.matches !== false;
      return other.scope.kind !== "seen" || other.at >= note.at;
    });
    const sameSession = note.scope.kind === "seen" && claims.find(other => other.scope.kind === "seen" && other.session === note.session);
    const keep = wider ?? equal ?? sameSession;
    if (keep) { retire(note, "restated", keep.id); continue; }
    for (const other of related) retire(other, "restated", note.id);
    stage(note);
  }
  // The existing scan limits apply to history as well as to live notes.
  for (const scope of [project, "global"]) {
    const stored = [...rows.values()].filter(row => row.scope === scope);
    if (stored.length > KNOWLEDGE_LIMITS.entries || stored.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.note)), 0) > KNOWLEDGE_LIMITS.scanBytes)
      throw new KnowledgeError("STORE_LIMIT", "Local session note history exceeds its limit.");
  }
  return changes;
}

/** Apply with the owning filter batch or maintenance transaction. */
export function saveSessionNotes(writer: RecordWriter, changes: NoteChanges): void {
  if (!changes.size) return;
  const put = writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
  for (const row of changes.values()) {
    if (writer.setting(row.scope, row.key) !== row.value) throw new Error("Session note state changed during the filter batch.");
    const data = JSON.stringify(Note.parse(row.note));
    if (Buffer.byteLength(data) > NOTE_BYTES) throw new KnowledgeError("STORE_LIMIT", "A session note exceeds its size limit.");
    put.run(row.scope, row.key, data);
  }
}

/** Stage 2 changes the active projection and keeps the typed source in history. */
export function settleSessionNotes(writer: RecordWriter, project: string, ids: ReadonlyMap<string, { reason: "one-off" | "corrected" | "restated"; replacement?: string }>,
  promoted: ReadonlyMap<string, Note["corroborated"]>, now: number): void {
  if (!ids.size && !promoted.size) return;
  const changes: NoteChanges = new Map();
  for (const row of [...readNotes(writer, project), ...readNotes(writer, "global")]) {
    if (row.note.retired) continue;
    const retired = ids.get(row.note.id);
    if (retired) changes.set(row.note.id, { ...row, note: { ...row.note, retired: { ...retired, at: now } } });
    else if (promoted.has(row.note.id) && row.note.scope.kind === "seen")
      changes.set(row.note.id, { ...row, note: { ...row.note, scope: { kind: "repo" }, corroborated: promoted.get(row.note.id) } });
  }
  saveSessionNotes(writer, changes);
}
