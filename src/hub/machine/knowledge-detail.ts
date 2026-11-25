import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MachineKnowledgeDetailSchema } from "@mex/hub-contracts/machine";
import { z } from "zod";
import { ENTRY_KINDS, parseEntry, type EntryCheck, type KnowledgeEntry } from "../../knowledge/entry.js";
import { containedDirectory, readEntryRevision } from "../../knowledge/files.js";
import { assertNoSecrets, stripHidden } from "../../knowledge/gates.js";
import { localHintReader } from "../../knowledge/hints.js";
import { savedByAgent, statementDate } from "../../knowledge/labels.js";
import { openHooksReadOnly, openRecordReadOnly, recordLocation, type RecordReader } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { checkoutCollation, knowledgeStatus } from "./home-snapshot.js";
import { knowledgeMissing, parseKnowledgeKey, repoMissing } from "./knowledge-list.js";
import { isRetired, midnight, registeredCheckout, representativeCheckout } from "./knowledge-snapshot.js";
import { knowledgePageUsage, noUse, useKey } from "./knowledge-usage.js";
import { boundedSetting, readStore } from "./read.js";

const git = promisify(execFile);
const dateTime = z.string().datetime({ offset: true });
const day = z.string().date();
export type KnowledgeDetail = z.infer<typeof MachineKnowledgeDetailSchema>;
export type ItemIdentity = ReturnType<typeof parseKnowledgeKey>;
type History = KnowledgeDetail["history"];

export interface KnowledgeTarget extends LocationOptions {
  home: string;
  repoId: string;
  checkout?: string;
  env?: NodeJS.ProcessEnv;
}

export function knowledgeTarget(
  reader: RecordReader | undefined, location: LocationOptions, repoId: string, now: number, env: NodeJS.ProcessEnv | undefined,
  checkout?: string,
): KnowledgeTarget {
  if (!reader?.project(repoId)) throw repoMissing();
  // An explicit checkout comes from a previously opened team note.
  if (checkout !== undefined) {
    if (!registeredCheckout(reader, repoId, checkout)) throw knowledgeMissing("That checkout is no longer registered or its folder is missing.");
  } else {
    const active = (): string | undefined => representativeCheckout(reader, undefined, repoId, now);
    try {
      checkout = readStore(openHooksReadOnly, location, (hooks) => representativeCheckout(reader, hooks, repoId, now));
    } catch { checkout = active(); }
  }
  return { ...location, home: recordLocation({ ...location, create: false }).home, repoId, checkout, env };
}

function teamFile(checkout: string, id: string) {
  let match: { file: string; path: string } | undefined;
  for (const folder of ["", ...ENTRY_KINDS]) {
    const parts = [".mex", "learned", ...(folder ? [folder] : [])];
    const directory = containedDirectory(checkout, parts);
    if (!directory) continue;
    const name = id + ".md";
    const file = join(directory, name);
    if (!lstatSync(file, { throwIfNoEntry: false })) continue;
    if (match) throw knowledgeMissing("This item appears in more than one team file.");
    match = { file, path: [...parts, name].join("/") };
  }
  return match;
}

export function readKnowledgeEntry(reader: RecordReader, target: KnowledgeTarget, { audience, id }: ItemIdentity, now: number) {
  if (isRetired(reader, target.repoId, id)) throw knowledgeMissing();
  const checkout = target.checkout;
  const local = audience !== "team" && containedDirectory(target.home, ["projects", target.repoId, audience === "hint" ? "hints" : "notes"]);
  const team = audience === "team" && checkout ? teamFile(checkout, id) : undefined;
  const file = local ? join(local, id + ".md") : team?.file;
  const snapshot = file && readEntryRevision(file);
  if (!snapshot) throw knowledgeMissing();
  const entry = parseEntry(snapshot.content);
  if (entry.mex.id !== id || entry.mex.status === "retired") throw knowledgeMissing();
  assertNoSecrets(entry);
  const hint = audience === "hint" && checkout
    ? localHintReader(reader, target.repoId, { ...target, projectPath: checkout }, now)(entry) : undefined;
  if (audience === "hint" && !hint) throw knowledgeMissing();
  return { ...snapshot, path: team?.path, entry: hint?.entry ?? entry, hint };
}

function checkTarget(check: EntryCheck): string {
  switch (check.kind) {
    case "key": return [check.target.file, check.target.pointer, check.target.member].filter(Boolean).join(" · ");
    case "command": return `${check.target.run} in ${check.target.file}`;
    case "section": return `${check.target.heading} in ${check.target.file}`;
    case "source": return "file" in check.target ? check.target.file : check.target.url;
    case "value":
    case "symbol": return `${check.target.symbol} in ${check.target.file}`;
    case "legacy-grounding": return check.target.file ?? check.target.node;
    case "pattern": return `${check.target.pattern} in ${check.target.scope}`;
    case "relation": return `${check.target.query} · ${check.target.from} → ${check.target.to}`;
  }
}

function sourceFor(entry: KnowledgeEntry, target: KnowledgeTarget, point: ReturnType<typeof readKnowledgeEntry>, learnedAt?: string): KnowledgeDetail["source"] {
  const { source } = entry.mex;
  if (point.hint) return { type: "agent-memory", agent: point.hint.origin, observations: point.hint.observations };
  if (point.path && target.checkout) return { type: "team", path: point.path, checkout: target.checkout };
  const at = midnight(statementDate(entry));
  const agent = savedByAgent(entry);
  if (agent) return { type: "recorded", description: `${agent} saved this note`, at };
  if (source.type === "person" && /^mex (?:note|edit) /u.test(source.ref)) {
    return { type: "note", at, edited: source.ref.startsWith("mex edit ") };
  }
  if (learnedAt || source.ref.startsWith("capture ")) return { type: "session", at: learnedAt ?? at, checkedByModel: !!source.model };
  const description: Record<typeof source.type, string> = {
    person: "A person supplied this note", docs: "Learned from documentation", review: "Learned from code review", ci: "Learned from CI",
    config: "Learned from repo configuration", "rule-file": "Learned from repo instructions",
    mined: "Learned from project activity", observed: "Learned from an observation", "agent-memory": "Learned from agent memory",
  };
  return { type: "recorded", at, description: description[source.type] };
}

const judgmentLabels = { "still-true": "still true", rewritten: "needs attention", "cannot-tell": "couldn’t tell" } as const;

function personalHistory(reader: RecordReader, target: KnowledgeTarget, entry: KnowledgeEntry, revision: string) {
  const history: History = [{ type: "added", at: midnight(entry.mex.created) }];
  const editDate = /^mex edit (\d{4}-\d{2}-\d{2})$/u.exec(entry.mex.source.ref)?.[1];
  if (day.safeParse(editDate).success) history.push({ type: "edited", at: midnight(editDate!) });
  const saved = boundedSetting(reader, target.repoId, "learning.note." + entry.mex.id, 512 << 10);
  let learnedAt: string | undefined;
  if (saved) {
    try {
      const at = dateTime.safeParse(JSON.parse(saved)?.at);
      if (at.success) {
        learnedAt = at.data;
        history.push({ type: "learned", at: learnedAt });
      }
    } catch { /* Ignore malformed learning metadata. */ }
  }
  const proof = boundedSetting(reader, target.repoId, "learning.deep.note." + entry.mex.id, 20_000);
  if (proof) {
    try {
      const { hash, evidenceDay } = JSON.parse(proof);
      const parsed = day.safeParse(evidenceDay);
      if (hash === "sha256:" + revision && parsed.success) history.push({ type: "evidence", at: midnight(parsed.data) });
    } catch { /* Ignore malformed or out-of-date evidence. */ }
  }
  const rows = reader.all<{ result: keyof typeof judgmentLabels; at: string }>(`
    SELECT result,at FROM (SELECT result,at FROM judgements WHERE project_id=? AND entry_id=? LIMIT 256)
    ORDER BY at DESC LIMIT 10`, target.repoId, entry.mex.id);
  for (const { result, at } of rows) {
    if (Object.hasOwn(judgmentLabels, result) && dateTime.safeParse(at).success) history.push({ type: "model-check", at, outcome: judgmentLabels[result] });
  }
  return { history, learnedAt };
}

async function gitHistory(checkout: string, path: string): Promise<History> {
  try {
    const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_COMMON_DIR: _common, GIT_INDEX_FILE: _index, ...env } = process.env;
    const { stdout } = await git("git", ["--no-pager", "--literal-pathspecs", "log", "--follow", "-n", "10",
      "--format=%x00%H%x00%aI%x00%aN", "-z", "--name-status", "--", path], {
      cwd: checkout, timeout: 2_000, maxBuffer: 64 << 10, windowsHide: true, encoding: "utf8",
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    });
    const fields = stdout.split("\0");
    const events: History = [];
    for (let index = 1; index + 3 < fields.length && events.length < 10; index++) {
      const [sha, at, actor, status] = fields.slice(index, index + 4);
      if (fields[index - 1] !== "" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha) || !dateTime.safeParse(at).success) continue;
      const action = status.trim() === "A" ? "added" : "edited";
      events.push({ type: "git", sha: sha.slice(0, 12), at, actor, action });
      index += 3;
    }
    return events;
  } catch { return []; }
}

export async function readKnowledgeItem(
  location: LocationOptions, key: string, now: number, env?: NodeJS.ProcessEnv, checkout?: string,
): Promise<KnowledgeDetail> {
  const identity = parseKnowledgeKey(key);
  const { repoId, audience, id } = identity;
  const sampled = readStore(openRecordReadOnly, location, (reader) => {
    const target = knowledgeTarget(reader, location, repoId, now, env, checkout);
    const point = readKnowledgeEntry(reader!, target, identity, now);
    const history = audience === "onlyYou" ? personalHistory(reader!, target, point.entry, point.revision)
      : { history: [{ type: "added", at: midnight(point.entry.mex.created) }] as History, learnedAt: undefined };
    return { target, point, ...history };
  });
  const { target, point, learnedAt } = sampled;
  const { mex, text } = point.entry;
  let cached: { verdict: string; checked_at: string } | undefined;
  if (target.checkout) {
    try {
      cached = readStore(openHooksReadOnly, location, (hooks) => hooks?.get(
        `SELECT verdict,checked_at FROM verdicts WHERE project_id=? AND checkout=? ${checkoutCollation} AND entry_id=?`, repoId, target.checkout!, id,
      ));
    } catch { /* No cached check status is available. */ }
  }
  const status = knowledgeStatus(cached?.verdict);
  const checkedAt = dateTime.safeParse(cached?.checked_at);
  const use = knowledgePageUsage(location, [identity], undefined, now);
  const tracked = point.path && target.checkout && await gitHistory(target.checkout, point.path);
  const history = tracked && tracked.length ? tracked : sampled.history;
  const evidence = mex.source.type === "person" ? mex.source.quote
    : audience !== "hint" ? mex.source.ref : undefined;
  return {
    ...identity, key, kind: mex.kind, status, revision: point.revision, checkout: audience === "team" ? target.checkout : undefined,
    oneLine: stripHidden(mex.one_line).trim() || mex.one_line, scope: mex.scope, text: stripHidden(text),
    source: sourceFor(point.entry, target, point, learnedAt), evidence: evidence && stripHidden(evidence),
    checks: mex.checks.map((check) => ({ kind: check.kind, target: stripHidden(checkTarget(check)).slice(0, 2048) || "Saved check",
      result: null, checkedAt: null })),
    checkSummary: { status, checkedAt: checkedAt.success ? checkedAt.data : null },
    ...(use.items.get(useKey(identity)) ?? noUse),
    useNote: use.partial,
    editBlocked: mex.status === "proposed" ? "This item is still proposed." : undefined,
    history,
  };
}
