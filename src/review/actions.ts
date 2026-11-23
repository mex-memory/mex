import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { openRecord, openRecordReadOnly, type RecordWriter } from "../record/index.js";
import { projectIdentity, realPath } from "../record/project.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { EntrySchema, KnowledgeError, serializeEntry, type KnowledgeEntry } from "../knowledge/entry.js";
import { editedEntry } from "../knowledge/mutations.js";
import { gateEntry } from "../knowledge/gates.js";
import { useConflict, type ObserveChecks } from "../knowledge/gate.js";
import { references } from "../knowledge/references.js";
import { prepareTeamWrite, applyTeamWrite, teamEntry, type TeamPreview } from "../knowledge/team.js";
import { publishNotes, readNotes } from "../knowledge/personal-store.js";
import { canonicalFileDiff } from "../team/artifacts/unified-diff.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";
import { hash, position, readSource, type Position } from "../judge/evidence.js";
import { withCheckoutPublication } from "../judge/publication.js";
import { recordChecks } from "../judge/native.js";
import { repositoryPolicy, sharingEnabled } from "../filter/repository.js";
import { backgroundEnvironment } from "../filter/environment.js";
import { learningMetadata } from "../filter/metadata.js";
import { verifySources } from "../filter/publication.js";
import { claimHash } from "../knowledge/state.js";
import { entryProducer } from "../knowledge/producers.js";
import { canonicalBytes, memberRevision, snapshotReview, type ReviewGroup } from "./queue.js";
import { legacyJudge, put, rows, storedItems, ReviewItem, REVIEW_VISIBLE } from "./state.js";

export type ReviewAction = "share" | "keep" | "edit" | "use";
export interface ReviewDependencies { repository: typeof repositoryPolicy; recordChecks: typeof recordChecks; clock: () => number; observeChecks?: ObserveChecks; }
const defaults: ReviewDependencies = { repository: repositoryPolicy, recordChecks, clock: Date.now };
const ShareIntent = z.object({ version: z.literal(1), root: z.string().max(4096), preview: z.object({ id: z.string(), action: z.literal("share"), revision: z.string(), diff: z.string().max(128 << 10), message: z.string() }).strict(),
  group: z.object({ id: z.string(), entry: EntrySchema, reason: z.string(), sources: z.number(), createdAt: z.string(), expiresAt: z.string(), checkedByModel: z.boolean(),
    members: z.array(z.object({ row: z.object({ id: z.string(), project_id: z.string(), entry_id: z.string(), reason: z.string(), state: z.literal("pending"), created_at: z.string() }).strict(), item: ReviewItem, revision: z.string() }).strict()).min(1).max(10000) }).strict() }).strict();
const intentKey = (revision: string) => `review.share.${revision.slice(7)}`;
export interface ReviewPreview { id: string; action: ReviewAction; revision: string; diff: string; message: string; conflict?: true; }
interface Prepared { preview: ReviewPreview; group: ReviewGroup; entry: KnowledgeEntry; team?: TeamPreview; at: Position; names?: string; notes: ReturnType<typeof readNotes>; }
const stale = () => new KnowledgeError("STALE_PREVIEW", "Review inputs changed; preview the action again.");
function trackedNames(root: string): string {
  return execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { env: backgroundEnvironment(), encoding: "utf8", timeout: 1500, maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] });
}
function choose(groups: ReviewGroup[], selector: string): ReviewGroup {
  const visible = groups.slice(0, REVIEW_VISIBLE);
  const group = /^[1-5]$/u.test(selector) ? visible[Number(selector) - 1] : visible.find(g => g.id === selector);
  if (!group) throw new KnowledgeError("NOT_FOUND", "That card is no longer in the visible Review queue. Run mex review again.");
  return group;
}
function groupRevision(group: ReviewGroup): string { return hash(JSON.stringify(group)); }
function sourceProof(writer: RecordWriter, project: string, group: ReviewGroup): void {
  for (const { item } of group.members) {
    if (item.source.producer !== "learning") continue;
    const meta = learningMetadata(writer, project, item.entry.mex.id), sources = meta.sources ?? [];
    const observations = verifySources(writer, project, item.entry, sources);
    if (!sources.some((s, i) => s.quote === item.entry.mex.source.quote && observations[i]?.verified && !observations[i]?.marked && !observations[i]?.delivered)) {
      throw new KnowledgeError("UNVERIFIED_SOURCE", "The original person quote is unavailable; the rule stays personal.");
    }
  }
}
async function prepare(selector: string, action: ReviewAction, text: string | undefined, options: KnowledgeOptions, deps: ReviewDependencies): Promise<Prepared> {
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) throw new KnowledgeError("NOT_FOUND", "There are no rules waiting for Review.");
  let group: ReviewGroup;
  try { group = choose(snapshotReview(reader, project.projectId, project.location.home, project.root, deps.clock()), selector); }
  finally { reader.close(); }
  if (group.upkeep) throw new KnowledgeError("INVALID_OPTION", "Use the action on this local Review card.");
  const notes = readNotes(project.location.home, project.projectId);
  let entry = group.entry, team: TeamPreview | undefined, names: string | undefined;
  const at = await position(project.root);
  if (group.conflict) {
    if (action !== "keep" && action !== "use") throw new KnowledgeError("INVALID_OPTION", "Use keep or use for a contradiction.");
    const path = `personal/notes/${entry.mex.id}.md` as RepoRelativePath;
    const diff = action === "use" ? canonicalFileDiff(path, notes.files.get(entry.mex.id) ?? null, serializeEntry(entry)) : "";
    const revision = hash(JSON.stringify([project.projectId, project.root, action, groupRevision(group), notes.digest, at]));
    const message = action === "keep" ? "Keep the current entries and dismiss this proposal." : "Save this proposal and retire the conflicting personal entries.";
    return { preview: { id: group.id, action, revision, diff, message, conflict: true }, group, entry, notes, at };
  }
  if (action === "use") throw new KnowledgeError("INVALID_OPTION", "Only a contradiction can be resolved with use.");
  if (action === "edit") {
    if (!text) throw new KnowledgeError("INVALID_ENTRY", "Supply the corrected rule in plain words.");
    entry = gateEntry(editedEntry(entry, { text }, new Date(deps.clock())), references(project.root));
    if (entry.mex.source.quote !== text) throw new KnowledgeError("UNVERIFIED_SOURCE", "The correction's quote changed during validation.");
  }
  if (action === "share") {
    if (projectIdentity(project.root).rootPath !== realPath(project.root)) throw stale();
    if (!(await deps.repository(project.root)).authorized) throw new KnowledgeError("TEAM_AUTHORITY", "Repository write access or a merged contribution could not be verified.");
    if (!entry.mex.checks.length || entry.mex.checks.some(c => c.kind === "legacy-grounding")) throw new KnowledgeError("CHECKS_REQUIRED", "The rule needs current code checks before it can be shared. Edit it or keep it personal.");
    // Re-observe the same targets. Never renew a failed claim with new baselines.
    names = trackedNames(project.root);
    const observed = await deps.recordChecks({ checkout: project.root, project_id: project.projectId, mex_home: project.location.home, record_directory: project.location.directory },
      entry.mex.checks.map(({ kind, role, target }) => ({ kind, role, target })));
    if (!observed || !isDeepStrictEqual(observed, entry.mex.checks) || trackedNames(project.root) !== names) throw new KnowledgeError("CHECKS_CHANGED", "The stored checks no longer hold on today's code; the rule stays personal.");
    team = prepareTeamWrite(entry, { ...options, projectPath: project.root }, entry.mex.source.quote);
    if (team.after !== serializeEntry(teamEntry(entry))) throw new KnowledgeError("UNVERIFIED_SOURCE", "The sharing gates changed the verified rule; edit it first.");
  }
  const after = serializeEntry(entry), path = `personal/notes/${entry.mex.id}.md`;
  const diff = team?.diff ?? canonicalFileDiff(path as RepoRelativePath, notes.files.get(entry.mex.id) ?? null, after);
  const revision = hash(JSON.stringify({ project: project.projectId, root: project.root, action, group: groupRevision(group), after, team, notes: notes.digest, at, names }));
  const message = action === "share" ? "Share this rule in the current working tree." : action === "keep" ? "Keep this rule personal; never ask about this claim again." : "Save this correction personally. Its checks must be recorded before sharing.";
  return { preview: { id: group.id, action, revision, diff, message }, group, entry, team, notes, at, names };
}
function finish(writer: RecordWriter, project: string, prepared: Pick<Prepared, "group" | "entry">, action: ReviewAction): void {
  const { group, entry } = prepared;
  if (action === "keep") put(writer, project, `review.keep.${claimHash(group.entry.text).slice(7)}`, { version: 1 });
  for (const { row, item } of group.members) {
    writer.db.prepare("UPDATE review SET state=? WHERE id=? AND project_id=? AND state='pending'").run(action === "share" ? "accepted" : "dismissed", row.id, project);
    // Legacy virtual offers have no row; closing their producer is sufficient.
    const raw = writer.setting(project, item.source.key);
    if (!raw) throw stale();
    const value = JSON.parse(raw);
    value.state = item.source.producer === "learning" ? "applied" : "discarded";
    put(writer, project, item.source.key, value);
    writer.db.prepare("DELETE FROM notices WHERE id=?").run(`${item.source.key}.preview`);
    if (item.source.producer === "learning" && typeof value.notice === "string") writer.db.prepare("DELETE FROM notices WHERE id=?").run(`${value.notice}.preview`);
  }
  if (action === "edit" || group.members.some(m => m.item.source.producer === "judge")) {
    writer.db.prepare("DELETE FROM settings WHERE scope=? AND key IN (?,?)").run(project, `learning.note.${entry.mex.id}`, `learning.offer.${entry.mex.id}`);
  }
}
async function recoverShare(selector: string, options: KnowledgeOptions, expected: string, deps: ReviewDependencies): Promise<ReviewPreview | undefined> {
  if (!/^sha256:[a-f0-9]{64}$/u.test(expected)) return undefined;
  const project = knowledgeProject(options), reader = openRecordReadOnly(options);
  if (!reader) return undefined;
  let intent: z.infer<typeof ShareIntent>;
  try {
    const row = reader.get<{ value: string | null }>("SELECT CASE WHEN length(CAST(value AS BLOB))<=262144 THEN value END value FROM settings WHERE scope=? AND key=?", project.projectId, intentKey(expected));
    if (!row?.value) return undefined;
    if (!sharingEnabled(reader, project.projectId, project.root)) throw stale();
    intent = ShareIntent.parse(JSON.parse(row.value));
  } finally { reader.close(); }
  if (intent.root !== project.root || intent.preview.revision !== expected || ![intent.preview.id, "1", "2", "3", "4", "5"].includes(selector)) throw stale();
  if (projectIdentity(project.root).rootPath !== realPath(project.root)) throw stale();
  const team = prepareTeamWrite(intent.group.entry, { ...options, projectPath: project.root }, intent.group.entry.mex.source.quote);
  if (team.before !== team.after) return undefined; // publication has not happened
  const checks = intent.group.entry.mex.checks, names = trackedNames(project.root);
  const observed = await deps.recordChecks({ checkout: project.root, project_id: project.projectId, mex_home: project.location.home, record_directory: project.location.directory }, checks.map(({ kind, role, target }) => ({ kind, role, target })));
  if (!checks.length || !isDeepStrictEqual(observed, checks) || !(await deps.repository(project.root)).authorized) throw stale();
  const at = await position(project.root), writer = openRecord(options);
  try {
    await withCheckoutPublication(project.root, at, () => {
      writer.db.exec("BEGIN IMMEDIATE");
      try {
        if (trackedNames(project.root) !== names || !sharingEnabled(writer, project.projectId, project.root)) throw stale();
        const pending = rows(writer, project.projectId), items = storedItems(writer, project.projectId);
        for (const member of intent.group.members) {
          const row = pending.find(row => row.id === member.row.id), item = row && (items.get(row.id) ?? legacyJudge(writer, row));
          // Virtual learning offers have no row. Their unchanged personal file
          // and producer are still required before accepting the recovery.
          if (member.row.id.startsWith("legacy.")) {
            if (!canonicalBytes(project.location.home, project.projectId, member.item)) throw stale();
          } else if (!row || !item || memberRevision(row, item) !== member.revision) throw stale();
          const raw = writer.setting(project.projectId, member.item.source.key), producer = raw && JSON.parse(raw);
          if (producer?.state !== "review") throw stale();
          if (!(member.item.source.level === "team" && member.item.source.checkout === project.root && member.item.source.path === join(project.root, team.path))
            && !canonicalBytes(project.location.home, project.projectId, member.item)) throw stale();
        }
        for (const check of checks) for (const [path, baseline] of Object.entries(check.files)) {
          const raw = readSource(project.root, path); if (raw === null || hash(raw) !== baseline) throw stale();
        }
        const fresh = prepareTeamWrite(intent.group.entry, { ...options, projectPath: project.root }, intent.group.entry.mex.source.quote);
        if (fresh.before !== team.after || fresh.after !== team.after) throw stale();
        sourceProof(writer, project.projectId, intent.group);
        finish(writer, project.projectId, { group: intent.group, entry: intent.group.entry }, "share");
        writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project.projectId, intentKey(expected)); writer.db.exec("COMMIT");
      } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
    });
    return intent.preview;
  } finally { writer.close(); }
}
/** Every mutation is bound to a freshly computed exact preview. */
export async function reviewAction(selector: string, action: ReviewAction, options: KnowledgeOptions,
  input: { text?: string; expect?: string; apply?: boolean } = {}, overrides: Partial<ReviewDependencies> = {}): Promise<{ applied: boolean; preview: ReviewPreview }> {
  const deps = { ...defaults, ...overrides };
  if (action === "share" && input.apply && input.expect) {
    const recovered = await recoverShare(selector, options, input.expect, deps);
    if (recovered) return { applied: true, preview: recovered };
  }
  const prepared = await prepare(selector, action, input.text, options, deps);
  if (!input.apply) return { applied: false, preview: prepared.preview };
  if (!input.expect || input.expect !== prepared.preview.revision) throw stale();
  const project = knowledgeProject(options);
  const validate = (writer: RecordWriter) => {
    const current = choose(snapshotReview(writer, project.projectId, project.location.home, project.root, deps.clock()), prepared.group.id);
    if (groupRevision(current) !== groupRevision(prepared.group)) throw stale();
    if (action === "share") {
      if (projectIdentity(project.root).rootPath !== realPath(project.root) || trackedNames(project.root) !== prepared.names) throw stale();
      for (const check of prepared.entry.mex.checks) for (const [path, baseline] of Object.entries(check.files)) {
        const raw = readSource(project.root, path); if (raw === null || hash(raw) !== baseline) throw stale();
      }
      sourceProof(writer, project.projectId, current);
    }
  };
  if (prepared.group.conflict) {
    const { conflict, id } = prepared.group;
    if (action === "use") {
      const result = useConflict(id, conflict, { ...options, now: new Date(deps.clock()), observeChecks: deps.observeChecks,
        validate: writer => {
          validate(writer);
          if (readNotes(project.location.home, project.projectId).digest !== prepared.notes.digest) throw stale();
        },
      });
      if (result.status !== "accepted") throw new KnowledgeError("PROPOSAL_WITHHELD", `The proposal could not be saved (${result.reason}).`);
    } else {
      const writer = openRecord(options);
      try {
        writer.db.exec("BEGIN IMMEDIATE");
        validate(writer);
        writer.db.prepare("UPDATE review SET state='dismissed' WHERE id=? AND project_id=? AND state='pending'").run(id, project.projectId);
        // Learn deeper stores a source proof for a proposal sent to Review. Keep drops the proposal, so its proof goes too,
        // unless a saved note or another open card still uses that id.
        const proposed = conflict.entry.mex.id;
        if (entryProducer(conflict.entry.mex) === "learn-deeper" && !readNotes(project.location.home, project.projectId).files.has(proposed)
          && !writer.db.prepare("SELECT 1 FROM review WHERE project_id=? AND entry_id=? AND state='pending'").get(project.projectId, proposed)) {
          writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project.projectId, `learning.deep.note.${proposed}`);
        }
        writer.db.exec("COMMIT");
      } finally { writer.close(); }
    }
    return { applied: true, preview: prepared.preview };
  }
  const writer = openRecord(options);
  try {
    if (action === "share") {
      // Permission is checked again after the potentially slow native evaluator.
      if (!(await deps.repository(project.root)).authorized) throw new KnowledgeError("TEAM_AUTHORITY", "Repository authority changed; the rule stays personal.");
      await withCheckoutPublication(project.root, prepared.at, () => {
        writer.db.exec("BEGIN IMMEDIATE");
        try {
          validate(writer);
          // Persist the approved output before filesystem publication. A crash
          // can acknowledge only these exact bytes, never invent a new diff.
          put(writer, project.projectId, intentKey(input.expect!), ShareIntent.parse({ version: 1, root: project.root, preview: prepared.preview, group: prepared.group }));
          writer.db.exec("COMMIT"); writer.db.exec("BEGIN IMMEDIATE"); validate(writer);
          applyTeamWrite(prepared.team!, prepared.team!.revision, { ...options, projectPath: project.root }, prepared.entry.mex.source.quote);
          finish(writer, project.projectId, prepared, action);
          writer.db.prepare("DELETE FROM settings WHERE scope=? AND key=?").run(project.projectId, intentKey(input.expect!)); writer.db.exec("COMMIT");
        } catch (error) { writer.db.exec("ROLLBACK"); throw error; }
      });
    } else {
      const files = new Map(prepared.notes.files); files.set(prepared.entry.mex.id, serializeEntry(prepared.entry));
      publishNotes(writer, project.projectId, prepared.notes, files, () => finish(writer, project.projectId, prepared, action), { validate: () => validate(writer) });
    }
    return { applied: true, preview: prepared.preview };
  } finally { writer.close(); }
}
