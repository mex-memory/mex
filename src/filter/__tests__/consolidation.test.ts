import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, renameSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { createFilterKind, type FilterCandidate, type FilterDependencies } from "../job.js";
import { consolidateNext } from "../consolidation.js";
import { privacyHolds, repoVocabulary } from "../privacy.js";
import { snapshotNotes, publishNotes, recoverNotes } from "../../knowledge/personal-store.js";
import { readEntryFile, personalReadGuard } from "../../knowledge/files.js";
import { parseEntry, serializeEntry, type KnowledgeEntry } from "../../knowledge/entry.js";
import { entryLabel } from "../../knowledge/labels.js";
import { saveTombstone } from "../../knowledge/state.js";
import { note } from "../../knowledge/store.js";
import { enqueueJob, registerJobKind, runOneBatch, type JobRow } from "../../record/jobs.js";
import { hash, position } from "../../judge/evidence.js";
import { ModelWaitError } from "../../model-runner/index.js";

let base: string, root: string, home: string, project: string, writer: RecordWriter, job: JobRow, deps: FilterDependencies;
const usage = { input: 100, cache_write: 0, cache_read: 0, output: 10, model: "fake", estimated: false };
const params = () => ({ checkout: root, agent: "codex" as const });
const old = "2026-11-12T12:00:00.000Z", recent = "2026-11-14T12:00:00.000Z";
function candidate(text = "Tests use vitest.", session = "s1", at = old): FilterCandidate {
  return { source_id: "m1", quote: text, text, one_line: text, label: "lasting", kind: "rule", scope: ["**"], private: false,
    checks: [], needs_checks: true, source: { session, row: 1, at, marks: "", delivered: [], private_tag: false } };
}
function entry(id: string, text: string): KnowledgeEntry {
  const c = candidate(text); return { text, mex: { id, kind: c.kind, scope: c.scope, one_line: c.one_line, checks: [], evidence: "person",
    source: { type: "person", ref: "mex note 2026-11-12", quote: text }, created: "2026-11-12", status: "active" } };
}
function explicitCandidate(id: string, noteHash: string): FilterCandidate {
  const c = candidate();
  c.source = { ...c.source, session: null, row: null, note_id: id, note_hash: noteHash };
  c.checks = [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" }, saw: { value: "vitest" }, files: { "package.json": hash(readFileSync(join(root, "package.json"), "utf8")) } }];
  c.needs_checks = false;
  return c;
}
function batch(key: string, candidates: FilterCandidate[]) {
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `filter.batch.${key}`, JSON.stringify({ version: 1, phase: "complete", input_hash: key,
    position: { head: null, branch: null }, answers: candidates.map(({ checks, needs_checks, source, ...c }) => ({ ...c, checks: [] })), candidates, model: "fake", tokens: 110 }));
}
function grouping(groups: unknown[]) { deps.model = vi.fn(async () => ({ selectedModel: "fake", usage, text: JSON.stringify({ groups }) })); }
async function apply() { return consolidateNext(writer, project, params(), job, deps, await position(root)); }
function notes() { return [...snapshotNotes(writer, project).files.values()].map(parseEntry); }
function readyJob() {
  registerJobKind(createFilterKind(deps));
  job = enqueueJob(writer, { kind: "filter", projectId: project, params: params() }).job;
  writer.db.prepare("UPDATE jobs SET state='running',owner='fixture' WHERE id=?").run(job.id);
  job = { ...job, state: "running", owner: "fixture" };
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-consolidation-"))); root = join(base, "repo"); home = join(base, "home"); mkdirSync(root);
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"},"description":"Tests use vitest. Sasha uses build.example.net and sasha@example.net."}\n');
  writer = openRecord({ home, projectPath: root, isNetwork: () => false }); project = writer.checkout(root)!.project_id;
  deps = { model: vi.fn(async () => { throw new Error("unexpected model call"); }), recordChecks: vi.fn(async () => undefined), clock: Date.now };
  readyJob();
});
afterEach(() => { writer.close(); vi.restoreAllMocks(); rmSync(base, { recursive: true, force: true }); });

it("drains a completed staged batch through the filter before finishing, without a live model", async () => {
  batch("a".repeat(64), [candidate()]); grouping([{ members: [0], target: null, relation: "duplicate" }]);
  registerJobKind(createFilterKind(deps)); writer.db.prepare("UPDATE jobs SET state='queued',owner=NULL WHERE id=?").run(job.id);
  await runOneBatch(writer, "worker", { only: new Set([job.id]) });
  expect(notes()).toHaveLength(1); expect(notes()[0]!.mex.source.quote).toBe("Tests use vitest.");
  expect(writer.setting(project, `filter.note.${notes()[0]!.mex.id}`)).toBe(hash(serializeEntry(notes()[0]!)));
  expect(JSON.parse(writer.setting(project, `learning.note.${notes()[0]!.mex.id}`)!)).toMatchObject({ sources: [{ quote: "Tests use vitest.", label: "lasting", source: { session: "s1", row: 1, at: old } }] });
  await apply(); expect(deps.model).toHaveBeenCalledTimes(1);
});
it("keeps the context proof when a plain repeat replaces the observation from the same session", async () => {
  const first = candidate();
  first.quote = "yes, 2";
  first.source.reply_context_hash = hash("The second option uses vitest.");
  batch("a".repeat(64), [first]); grouping([{ members: [0], target: null, relation: "duplicate" }]);
  await apply();
  const id = notes()[0]!.mex.id;
  const repeat = candidate(first.text, first.source.session!, recent);
  repeat.source.row = 2;
  batch("b".repeat(64), [repeat]); grouping([{ members: [0], target: id, relation: "duplicate" }]);
  await apply();
  const meta = JSON.parse(writer.setting(project, `learning.note.${id}`)!);
  expect(meta.sources).toEqual([{ quote: repeat.quote, label: "lasting", source: repeat.source }]);
  expect(meta.context_source).toEqual({ quote: first.quote, label: "lasting", source: first.source });
});
it("classifies an explicit note under its original id and retains recorded checks", async () => {
  const original = note({ text: "Tests use vitest." }, { home, projectPath: root }, new Date(old));
  const id = original.entry.mex.id, before = snapshotNotes(writer, project);
  const c = explicitCandidate(id, hash(before.files.get(id)!));
  batch("b".repeat(64), [c]); grouping([{ members: [0], target: id, relation: "duplicate" }]);
  await apply(); expect(notes()).toHaveLength(1); expect(notes()[0]!.mex).toMatchObject({ id, checks: c.checks });
});
it.each(["deferred", "legacy unchecked"])("keeps a %s explicit note byte-for-byte while consolidating its sibling", async state => {
  const original = note({ text: "Keep the project test script." }, { home, projectPath: root }, new Date(old));
  const id = original.entry.mex.id, raw = snapshotNotes(writer, project).files.get(id)!;
  const sibling = candidate("Tests use vitest.", "s2", recent);
  const candidates = [sibling];
  if (state === "deferred") {
    writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `filter.note-retry.${id}`, JSON.stringify({ hash: hash(raw), failures: 1 }));
  } else {
    candidates.push({ ...candidate(), source_id: id, source: { ...candidate().source, note_id: id, note_hash: hash(raw), session: null, row: null } });
  }
  batch("e".repeat(64), candidates); grouping([{ members: [0], target: null, relation: "duplicate" }]);
  expect(await apply()).toMatchObject({ results: 1 });
  expect(deps.model).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.not.stringContaining(id) }));
  const after = snapshotNotes(writer, project).files;
  expect(after.get(id)).toBe(raw);
  expect(after.size).toBe(2);
});
it("merges duplicates and preserves a later correction with both dates and a current label", async () => {
  const original = note({ text: "Tests use the old runner." }, { home, projectPath: root }, new Date(old));
  batch("c".repeat(64), [candidate("Tests use vitest.", "s2", recent), candidate("Tests use vitest.", "s3", recent)]);
  grouping([{ members: [0, 1], target: original.entry.mex.id, relation: "correction" }]);
  await apply(); const all = notes(), active = all.filter(e => e.mex.status === "active"), retired = all.filter(e => e.mex.status === "retired");
  expect(active).toHaveLength(1); expect(active[0]!.mex.id).toBe(original.entry.mex.id); expect(active[0]!.text).toBe("Tests use vitest.");
  expect(retired).toHaveLength(1); expect(retired[0]!.mex).toMatchObject({ created: "2026-11-12", retired: { at: "2026-11-14" } });
  expect(retired[0]!.mex.source.quote).toBe("Tests use the old runner."); expect(entryLabel(active[0]!, "personal")).toBe("[you said, 14 Nov]");
  await apply(); expect(notes()).toHaveLength(2); expect(deps.model).toHaveBeenCalledTimes(1);
});
it("does not replace a newer statement with an older batch", async () => {
  const n = note({ text: "Newer statement." }, { home, projectPath: root }, new Date(recent));
  batch("d".repeat(64), [candidate("Older statement.")]); grouping([{ members: [0], target: n.entry.mex.id, relation: "correction" }]);
  await apply(); expect(notes()).toEqual([n.entry]);
});
it("retires an existing duplicate while preserving its source and privacy hold", async () => {
  const a = note({ text: "Tests use vitest." }, { home, projectPath: root }, new Date(old));
  const b = note({ text: "Use the vitest runner." }, { home, projectPath: root }, new Date(old));
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `learning.note.${b.entry.mex.id}`, JSON.stringify({ at: old, holds: ["model-private"], sessions: ["before"] }));
  batch("7".repeat(64), [candidate("Tests use vitest.", "after", recent)]); grouping([{ members: [0], target: a.entry.mex.id, duplicates: [b.entry.mex.id], relation: "duplicate" }]);
  await apply(); expect(notes().filter(e => e.mex.status === "active")).toHaveLength(1);
  expect(notes().find(e => e.mex.id === b.entry.mex.id)!.mex).toMatchObject({ status: "retired", source: b.entry.mex.source });
  expect(JSON.parse(writer.setting(project, `learning.note.${a.entry.mex.id}`)!)).toMatchObject({ holds: ["model-private"], sessions: ["before", "after"] });
});
it("keeps continuity and unknown delivered context in bounded pending data and releases staging capacity", async () => {
  const continuity = candidate("Continue the migration."); continuity.label = "next-session";
  const echo = candidate(); echo.source.delivered = ["mx_absent00"];
  const key = "8".repeat(64); batch(key, [continuity, echo]); grouping([{ members: [0], target: null, relation: "duplicate" }, { members: [1], target: null, relation: "duplicate" }]);
  await apply(); expect(notes()).toHaveLength(0); expect(writer.setting(project, `filter.batch.${key}`)).toBeUndefined();
  expect(JSON.parse(writer.setting(project, `learning.pending.${key}`)!)).toMatchObject({ candidates: [continuity, echo] });
});
it("keeps an edited explicit note intact and releases the old source batch", async () => {
  const n = note({ text: "Tests use vitest." }, { home, projectPath: root }, new Date(old));
  const c = explicitCandidate(n.entry.mex.id, hash("outdated bytes"));
  const key = "9".repeat(64); batch(key, [c]); await apply();
  expect(notes()).toEqual([n.entry]); expect(writer.setting(project, `filter.batch.${key}`)).toBeUndefined(); expect(deps.model).not.toHaveBeenCalled();
  expect(JSON.parse(writer.setting(project, `learning.pending.${key}`)!)).toMatchObject({ reason: "source-note-changed" });
});
it.each(["duplicate", "omitted", "unknown", "note-id"])("rejects %s grouping without touching the live notes", async failure => {
  const n = note({ text: "Tests use vitest." }, { home, projectPath: root }, new Date(old)), before = snapshotNotes(writer, project);
  const c = failure === "note-id" ? explicitCandidate(n.entry.mex.id, hash(before.files.get(n.entry.mex.id)!)) : candidate();
  batch("e".repeat(64), [c]);
  grouping(failure === "omitted" ? [] : [{ members: failure === "duplicate" ? [0, 0] : [0], target: failure === "unknown" ? "mx_unknown0" : null, relation: "duplicate" }]);
  await expect(apply()).rejects.toThrow(); expect(snapshotNotes(writer, project)).toEqual(before);
});
it("keeps privacy holds personal even when the model says false", async () => {
  const c = candidate("Morgan uses hidden.corp.example and morgan@hidden.corp.example."); c.source.private_tag = true;
  batch("f".repeat(64), [c]); grouping([{ members: [0], target: null, relation: "duplicate" }]); await apply();
  const e = notes()[0]!; expect(JSON.parse(writer.setting(project, `learning.note.${e.mex.id}`)!)).toMatchObject({ holds: ["new-email", "new-host", "new-name", "private-tag"] });
  expect(existsSync(join(root, ".mex", "learned"))).toBe(false);
  expect(privacyHolds(candidate("Sasha uses build.example.net and sasha@example.net."), repoVocabulary(root))).toEqual([]);
});
it("rejects secrets before model or publication", async () => {
  batch("1".repeat(64), [candidate("password=example_not_a_real_secret_123")]);
  await expect(apply()).rejects.toThrow("possible secret"); expect(notes()).toHaveLength(0); expect(deps.model).not.toHaveBeenCalled();
});
it("never exposes malformed private model output in job errors", async () => {
  batch("a1".repeat(32), [candidate()]); deps.model = vi.fn(async () => ({ usage, selectedModel: "fake", text: "private invalid content" }));
  await expect(apply()).rejects.toThrow("did not return valid grouping");
  try { await apply(); } catch (error) { expect(String(error)).not.toContain("private invalid content"); }
  expect(notes()).toHaveLength(0);
});
it("records unsure once, ignores same-session repeats, then promotes an independent session", async () => {
  const first = candidate(); first.label = "unsure";
  batch("2".repeat(64), [first]); grouping([{ members: [0], target: null, relation: "duplicate" }]); await apply(); expect(notes()).toHaveLength(0);
  const key = String(writer.db.prepare("SELECT key FROM settings WHERE key LIKE 'learning.seen.%'").get()!.key).slice("learning.seen.".length);
  batch("3".repeat(64), [first]); grouping([{ members: [0], target: `seen:${key}`, relation: "duplicate" }]); await apply(); expect(notes()).toHaveLength(0);
  batch("4".repeat(64), [{ ...first, source: { ...first.source, session: "s2", at: recent } }]); await apply(); expect(notes()).toHaveLength(1);
  expect(writer.db.prepare("SELECT key FROM settings WHERE key LIKE 'learning.seen.%'").all()).toHaveLength(0);
});
it("does not attribute pasted messages or delivered-note echoes to a person", async () => {
  const n = note({ text: "Tests use vitest." }, { home, projectPath: root }, new Date(old));
  const pasted = candidate(); pasted.source.marks = "pasted";
  const echo = candidate(); echo.source.delivered = [n.entry.mex.id];
  batch("5".repeat(64), [pasted, echo]); grouping([{ members: [0, 1], target: n.entry.mex.id, relation: "duplicate" }]);
  await apply(); expect(notes()).toEqual([n.entry]); expect(writer.setting(project, `learning.note.${n.entry.mex.id}`)).toBeUndefined();
});
it("does not relearn a forgotten claim under a new id", async () => {
  saveTombstone(writer, project, entry("mx_forgot00", "Tests use vitest."), { reason: "Forgotten", by: "mex forget", at: "2026-11-14" });
  batch("b1".repeat(32), [candidate()]); await apply(); expect(notes()).toHaveLength(0); expect(deps.model).not.toHaveBeenCalled();
});
it("leaves candidates replayable across a cap hold and checks consent again after a model call", async () => {
  batch("6".repeat(64), [candidate()]); deps.model = vi.fn(async () => { throw new ModelWaitError("cap"); });
  await expect(apply()).rejects.toBeInstanceOf(ModelWaitError); expect(notes()).toHaveLength(0);
  deps.model = vi.fn(async () => { writer.db.prepare("UPDATE checkouts SET state='off'").run(); return { usage, selectedModel: "fake", text: JSON.stringify({ groups: [{ members: [0], target: null, relation: "duplicate" }] }) }; });
  await expect(apply()).rejects.toThrow("consent"); expect(notes()).toHaveLength(0);
  writer.db.prepare("UPDATE checkouts SET state='on'").run(); await apply(); expect(notes()).toHaveLength(1); expect(deps.model).toHaveBeenCalledTimes(1);
});

it.each(["prepared", "backed-up", "swapped"] as const)("rolls back failed publication at %s, including SQL metadata", phase => {
  const n = note({ text: "Original notes." }, { home, projectPath: root }, new Date(old));
  const before = snapshotNotes(writer, project), files = new Map(before.files); files.set(n.entry.mex.id, serializeEntry(entry(n.entry.mex.id, "Replacement notes.")));
  expect(() => publishNotes(writer, project, before, files, () => { writer.db.prepare("INSERT INTO settings VALUES(?, 'test-receipt','yes')").run(project); }, { step: at => { if (at === phase) throw new Error("injected"); } })).toThrow("injected");
  expect(snapshotNotes(writer, project)).toEqual(before); expect(writer.setting(project, "test-receipt")).toBeUndefined();
});
it("keeps old notes intact when the SQL commit fails after the swap", () => {
  note({ text: "Original notes." }, { home, projectPath: root }, new Date(old));
  const before = snapshotNotes(writer, project), files = new Map(before.files); files.set("mx_another0", serializeEntry(entry("mx_another0", "Another note.")));
  expect(() => publishNotes(writer, project, before, files, () => { throw new Error("metadata failure"); })).toThrow("metadata failure");
  expect(snapshotNotes(writer, project)).toEqual(before);
});
it("reuses its paid grouping after a publication rollback", async () => {
  const key = "0".repeat(64); batch(key, [candidate()]); grouping([{ members: [0], target: null, relation: "duplicate" }]);
  writer.db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON settings WHEN new.key='learning.publication' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END");
  await expect(apply()).rejects.toThrow("injected commit failure"); expect(notes()).toHaveLength(0);
  writer.db.exec("DROP TRIGGER fail_publication"); await apply(); expect(notes()).toHaveLength(1); expect(deps.model).toHaveBeenCalledTimes(1);
});
it("withholds readers after a committed process interruption and finishes recovery once", () => {
  const before = snapshotNotes(writer, project), files = new Map([["mx_another0", serializeEntry(entry("mx_another0", "Another note."))]]);
  const check = personalReadGuard(join(home, "projects", project, "notes"));
  publishNotes(writer, project, before, files, () => {}, { step: phase => { if (phase === "committed") throw new Error("interruption"); } });
  expect(() => snapshotNotes(writer, project)).toThrow("consolidated"); expect(check).toThrow();
  expect(recoverNotes(writer, project)).toBe(true); expect(recoverNotes(writer, project)).toBe(false); expect(notes()).toHaveLength(1);
  expect(check).toThrow("changed");
});
it.each(["prepared", "backed-up", "swapped"])("recovers a dead writer before commit at %s", phase => {
  note({ text: "Original notes." }, { home, projectPath: root }, new Date(old));
  const before = snapshotNotes(writer, project), parent = join(home, "projects", project), stage = join(parent, `.notes-stage-${"a".repeat(24)}`), backup = join(parent, `.notes-backup-${"a".repeat(24)}`);
  mkdirSync(stage); writeFileSync(join(stage, "mx_another0.md"), serializeEntry(entry("mx_another0", "New note.")));
  // Obtain the exact staged digest through the same public snapshot interface.
  renameSync(join(parent, "notes"), backup); renameSync(stage, join(parent, "notes")); const after = snapshotNotes(writer, project); renameSync(join(parent, "notes"), stage); renameSync(backup, join(parent, "notes"));
  writeFileSync(join(parent, "notes.pending"), JSON.stringify({ version: 1, id: "a".repeat(24), before: before.digest, after: after.digest, hadNotes: true })); writeFileSync(join(parent, "notes.revision"), "a".repeat(24));
  if (phase !== "prepared") renameSync(join(parent, "notes"), backup);
  if (phase === "swapped") renameSync(stage, join(parent, "notes"));
  expect(() => readEntryFile(join(parent, "notes", [...before.files.keys()][0]! + ".md"))).toThrow("consolidated");
  recoverNotes(writer, project); expect(snapshotNotes(writer, project)).toEqual(before);
});
it("refuses stale or redirected stores without losing a note", () => {
  const before = snapshotNotes(writer, project); note({ text: "Concurrent note." }, { home, projectPath: root }, new Date(old));
  expect(() => publishNotes(writer, project, before, new Map(), () => {})).toThrow("changed"); expect(notes()).toHaveLength(1);
  const directory = join(home, "projects", project, "notes"); symlinkSync(join(root, "package.json"), join(directory, "mx_redirect0.md"));
  expect(() => snapshotNotes(writer, project)).toThrow("regular file"); expect(readFileSync(join(root, "package.json"), "utf8")).toContain("vitest");
});
