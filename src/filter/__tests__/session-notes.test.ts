import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../../record/index.js";
import { hash } from "../../judge/evidence.js";
import { latestRelease, type LifetimeGit } from "../lifetime-git.js";
import { planSessionNotes, saveSessionNotes, sessionNoteHistory, sessionNoteQuotes, type NoteChanges } from "../session-notes.js";
import type { StageOneVerdict } from "../verdicts.js";

type Candidate = Extract<StageOneVerdict, { verdict: "candidate" }>;
const day = 86_400_000, start = Date.parse("2026-11-15T00:00:00Z");
const position = { branch: null, head: null };
const facts: LifetimeGit = { branches: new Map() };
let root: string, base: string, home: string, writer: RecordWriter, project: string;
let git: LifetimeGit;
const observe = async () => git;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-session-notes-")));
  root = join(base, "repo");
  home = join(base, "home");
  mkdirSync(root);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture");
  writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  project = writer.checkout(root)!.project_id;
  git = { ...facts };
});
afterEach(() => {
  writer.close();
  rmSync(base, { recursive: true, force: true });
});

function candidate(row: number, quote: string, lasts: Candidate["lasts"], marker: string | null, at = start, outcome: Candidate["outcome"] = "personal"): Candidate {
  return { id: "m" + row, verdict: "candidate", kind: "instruction", lasts, marker, reason: null, approval: null, outcome,
    at: new Date(at).toISOString(), message_hash: hash(quote), quote: { start: 0, end: quote.length, text: quote } };
}
function commit(changes: NoteChanges) {
  writer.db.exec("BEGIN IMMEDIATE");
  try {
    saveSessionNotes(writer, changes);
    writer.db.exec("COMMIT");
  } catch (error) {
    writer.db.exec("ROLLBACK");
    throw error;
  }
}
const observeVerdicts = async (session: string, verdicts: Candidate[], now = start) =>
  commit(await planSessionNotes(writer, project, root, now, { session, verdicts }, observe));
const sweep = async (now: number) => commit(await planSessionNotes(writer, project, root, now, undefined, observe));
const visible = (now: number) => sessionNoteQuotes(writer, project, position, now, git);

it("retires on a newer version tag and keeps the exact quote in history", async () => {
  const words = "For this release, keep uploads local.";
  git.release = "1.0.0";
  await observeVerdicts("s1", [candidate(1, words, "release", "For this release")]);
  expect(visible(start)).toMatchObject([{ lasts: "release", text: '[you said, 2026-11-15] "' + words + '"' }]);
  expect(latestRelease(["bench", "v0.9.2", "v1.0.0-beta.2", "1.0.0+build"])).toBe("1.0.0");
  await sweep(start + day);
  expect(visible(start + day)).toHaveLength(1);
  git.release = "1.1.0";
  expect(visible(start + 2 * day)).toEqual([]);
  expect(sessionNoteHistory(writer, project)[0]?.retired).toBeUndefined();
  await sweep(start + 2 * day);
  git.release = "1.0.0";
  expect(visible(start + 3 * day)).toEqual([]);
  expect(sessionNoteHistory(writer, project)).toMatchObject([{ quote: words, retired: { reason: "release-tag", at: start + 2 * day } }]);
});

it("uses the release tags at the typed timestamp when filtering after a new release", async () => {
  git = { ...facts, release: "1.1.0", tags: [{ name: "v1.0.0", time: start - day }, { name: "v1.1.0", time: start + day }] };
  await observeVerdicts("s1", [candidate(1, "For this release, keep uploads local.", "release", "For this release")], start + 2 * day);
  expect(visible(start + 2 * day)).toEqual([]);
  expect(sessionNoteHistory(writer, project)).toMatchObject([{ scope: { baseline: "1.0.0" }, retired: { reason: "release-tag" } }]);
});

it("recovers release evidence after an unavailable initial tag read", async () => {
  await observeVerdicts("s1", [candidate(1, "For this release, keep uploads local.", "release", "For this release")]);
  expect(visible(start)).toHaveLength(1);
  git = { ...facts, release: "1.1.0", tags: [{ name: "v1.0.0", time: start - day }, { name: "v1.1.0", time: start + day }] };
  await sweep(start + 2 * day);
  expect(sessionNoteHistory(writer, project)).toMatchObject([{ scope: { baseline: "1.0.0" }, retired: { reason: "release-tag" } }]);
});

it("expires a release note after exactly 60 days and leaves repo notes active", async () => {
  await observeVerdicts("s1", [
    candidate(1, "For this release, keep uploads local.", "release", "For this release"),
    candidate(2, "In this repo, use a dependency lockfile.", "repo", "In this repo"),
  ]);
  expect(visible(start + 60 * day - 1)).toHaveLength(2);
  expect(visible(start + 60 * day)).toMatchObject([{ lasts: "repo" }]);
  await sweep(start + 60 * day);
  expect(visible(start + 365 * day)).toHaveLength(1);
  expect(sessionNoteHistory(writer, project).find(note => note.scope.kind === "release")?.retired?.reason).toBe("release-age");
});

it("widens exact restatements, retains history, and projects global notes in a second project", async () => {
  const narrow = "For this release, keep uploads local.", broad = "In this repo, keep uploads local.";
  const everywhere = "Across all my projects, keep uploads local.";
  await observeVerdicts("s1", [candidate(1, narrow, "release", "For this release")]);
  await observeVerdicts("s2", [candidate(2, broad, "repo", "In this repo", start + day)], start + day);
  await observeVerdicts("s3", [candidate(3, everywhere, "all", "Across all my projects", start + 2 * day)], start + 2 * day);
  await observeVerdicts("s4", [candidate(4, narrow, "release", "For this release", start + 3 * day)], start + 3 * day);
  expect(visible(start + 365 * day)).toMatchObject([{ lasts: "all", text: '[you said, 2026-11-17] "' + everywhere + '"' }]);
  expect(sessionNoteHistory(writer, project).filter(note => note.retired?.reason === "restated")).toHaveLength(3);
  const other = join(base, "other");
  mkdirSync(other);
  const otherWriter = openRecord({ home, projectPath: other, isNetwork: () => false });
  const otherProject = otherWriter.checkout(other)!.project_id;
  otherWriter.close();
  const reader = openRecordReadOnly({ home })!;
  try {
    expect(sessionNoteHistory(reader, otherProject)).toMatchObject([{ quote: everywhere, scope: { kind: "all" } }]);
    expect(sessionNoteQuotes(reader, otherProject, position, start + 365 * day, facts)).toEqual(visible(start + 365 * day));
  } finally { reader.close(); }
});

it("keeps a same-session repeat from resetting the 30-day observation window", async () => {
  const words = "Keep uploads local.";
  const weak = (row: number, at: number) => candidate(row, words, "repo", null, at, "unsure");
  await observeVerdicts("s1", [weak(1, start)]);
  await observeVerdicts("s1", [weak(2, start + 10 * day)], start + 10 * day);
  await observeVerdicts("s2", [weak(3, start + 20 * day)], start + 20 * day);
  await observeVerdicts("s1", [weak(4, start + 25 * day)], start + 25 * day);
  await sweep(start + 50 * day - 1);
  expect(sessionNoteHistory(writer, project).filter(note => !note.retired)).toMatchObject([{ session: "s2", at: start + 20 * day }]);
  expect(visible(start + 29 * day)).toEqual([]);
  await sweep(start + 50 * day);
  expect(sessionNoteHistory(writer, project).filter(note => !note.retired)).toEqual([]);
  expect(sessionNoteHistory(writer, project).find(note => note.session === "s2")?.retired?.reason).toBe("seen-once");
});

it("keeps negation in the identity and requires it in the verbatim quote", async () => {
  await observeVerdicts("s1", [
    candidate(1, "Never send uploads.", "repo", "Never"),
    candidate(2, "Expose uploads.", "repo", "Never"),
  ]);
  await observeVerdicts("s2", [candidate(3, "Across all my projects, send uploads.", "all", "Across all my projects")]);
  const notes = sessionNoteHistory(writer, project);
  expect(notes.map(note => note.quote).sort()).toEqual(["Across all my projects, send uploads.", "Never send uploads."]);
  expect(notes.every(note => !note.retired)).toBe(true);
});

it("keeps notes private when the claimed branch position lacks capture proof", async () => {
  await observeVerdicts("s1", [candidate(1, "On this branch, keep uploads local.", "branch", "On this branch")]);
  expect(sessionNoteHistory(writer, project)).toMatchObject([{ scope: { kind: "seen" } }]);
  expect(visible(start)).toEqual([]);
});

it("rejects a stale retirement plan and keeps the earlier history intact", async () => {
  await observeVerdicts("s1", [candidate(1, "For this release, keep uploads local.", "release", "For this release")]);
  const earlier = await planSessionNotes(writer, project, root, start + 60 * day, undefined, observe);
  await sweep(start + 61 * day);
  expect(() => commit(earlier)).toThrow("Session note state changed");
  expect(sessionNoteHistory(writer, project)).toMatchObject([{ retired: { reason: "release-age", at: start + 61 * day } }]);
});
