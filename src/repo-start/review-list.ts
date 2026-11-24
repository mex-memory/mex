/**
 * Review the rules a deep analysis run learned. Rules the evidence gate kept are already live as trials; they aren't
 * asked, and saving the review keeps them for good. At most five rules that wait for a person are asked: a tick keeps
 * one, and an unticked one keeps waiting. The replay shows rules that would have stopped an edit or appeared on a file touch.
 *
 * Only a person at a terminal is asked. Anyone else gets one line, and the next `mex` in a terminal asks.
 */
import { stripVTControlCharacters } from "node:util";
import type { KnowledgeEntry } from "../knowledge/entry.js";
import { tombstone } from "../knowledge/state.js";
import { openRecord, type RecordWriter } from "../record/index.js";
import { readKey } from "./keys.js";
import type { Rich } from "./rich.js";
import { multiSelect } from "./select.js";
import { readOutcome, type DeepOutcome } from "../learn-deeper/activity.js";
import type { ReviewRow } from "../learn-deeper/pipeline.js";
import { ASK_LIMIT } from "../learn-deeper/plan.js";
import { VERIFY_ESTIMATE } from "../learn-deeper/verify.js";
import { agentName } from "../model-runner/agents.js";
import type { ScreenMode } from "./screen.js";
import { renderNotes } from "./screen.js";

type Print = (line: string) => void;
export interface ReviewListContext {
  root: string;
  projectId: string;
  write: Print;
  rich?: Rich;
  mode: ScreenMode;
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  /** The MEX home; the default location when omitted. */
  home?: string;
  /** Tests: the keys a person would press. */
  keys?: () => Promise<string>;
  /** Tests: the model runner the verify pass uses. */
  model?: typeof import("../model-runner/index.js").runModel;
  outcome?: (jobId: string) => DeepOutcome | null;
}

type ReviewItem = {
  row: ReviewRow;
  entry: KnowledgeEntry;
  raw: string;
};
interface Pending { jobId: string; items: ReviewItem[] }
type Decision = "keep" | "wait" | "drop";

export async function listLearnedRules(projectPath: string, json = false): Promise<void> {
  const [{ knowledgeProject }, { readNotes }, { isLearnedEntry, parseEntry }] = await Promise.all([
    import("../knowledge/context.js"), import("../knowledge/personal-store.js"), import("../knowledge/entry.js"),
  ]);
  const project = knowledgeProject({ projectPath });
  const rules = [...readNotes(project.location.home, project.projectId).files.values()].flatMap(raw => {
    try {
      const { mex } = parseEntry(raw);
      return isLearnedEntry(mex) ? [{ id: mex.id, status: mex.status, rule: clean(mex.one_line, false) }] : [];
    } catch { return []; }
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (json) console.log(JSON.stringify({ ok: true, rules }));
  else if (!rules.length) console.log("No learned rules in this repo yet.");
  else for (const { id, status, rule } of rules) console.log(`${id}  ${status}  ${rule}`);
}

async function pending(writer: RecordWriter, projectId: string): Promise<Pending | undefined> {
  const [{ reviewRows, reviewRowsKey }, { snapshotNotes }, { parseEntry, isLearnedEntry }, { learnedRefused, learnedReviewedKey }] = await Promise.all([
    import("../learn-deeper/pipeline.js"), import("../knowledge/personal-store.js"), import("../knowledge/entry.js"), import("../knowledge/mutations.js")]);
  const jobs = writer.db.prepare(`SELECT id FROM jobs WHERE kind IN ('learn-deeper','learn-deeper-weekly') AND project_id=? AND state IN ('done','done with gaps','failed','cancelled')
    AND EXISTS (SELECT 1 FROM settings WHERE scope=jobs.project_id AND key=? || jobs.id AND value<>'[]')
    AND NOT EXISTS (SELECT 1 FROM settings WHERE scope=jobs.project_id AND key=? || jobs.id)
    ORDER BY finished_at DESC, id DESC`).all(projectId, reviewRowsKey(""), learnedReviewedKey("")) as Array<{ id: string }>;
  if (!jobs.length) return undefined;
  const notes = snapshotNotes(writer, projectId).files;
  for (const { id } of jobs) {
    const items: ReviewItem[] = [];
    for (const row of reviewRows(writer, projectId, id)) {
      const raw = notes.get(row.entryId);
      if (!raw || tombstone(writer, projectId, row.entryId)) continue;
      try {
        const entry = parseEntry(raw);
        if (entry.mex.status !== "retired" && isLearnedEntry(entry.mex) && !learnedRefused(writer, projectId, entry, raw)) items.push({ row, entry, raw });
      } catch { /* A malformed file cannot be reviewed. */ }
    }
    if (items.length) return { jobId: id, items };
  }
}

function clean(text: string, ascii: boolean): string {
  const plain = stripVTControlCharacters(text).replace(/[\t\r\n]/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ +/gu, " ").trim();
  return ascii ? plain.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^ -~]/gu, "?") : plain;
}

function wrap(line: string, width: number): string[] {
  const lines: string[] = [];
  while (line.length > width) {
    // Leave room for the continuation indent. Long source links can have no word break.
    const space = line.lastIndexOf(" ", width);
    const at = space > 4 ? space : width;
    lines.push(line.slice(0, at));
    line = "    " + line.slice(at).trimStart();
  }
  lines.push(line);
  return lines;
}

function reviewDetails({ entry, row }: ReviewItem, ascii: boolean, rich?: Rich): string[] {
  const claim = clean(entry.mex.one_line, ascii);
  const body = clean(entry.text, ascii);
  const reason = body === claim ? "" : body.startsWith(claim + " ") ? body.slice(claim.length + 1) : body;
  const why = reason || clean(entry.mex.source.label ?? "", ascii)
    || (row.proven ? "Proven on the code." : row.support >= 2 ? "Seen on several PRs." : "Seen on one PR.");
  const fix = clean(entry.mex.fix?.snippet ?? "", ascii);
  const ref = clean(row.link || entry.mex.source.ref, ascii);
  const pr = /\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/u.exec(ref);
  const source = clean(row.label, ascii);
  return [
    rich ? rich.dim(`Why: ${rich.codeTint(why)}`) : `Why: ${why}`,
    ...(fix ? [`Fix: ${fix.length > 120 ? fix.slice(0, 117) + "..." : fix}`] : []),
    rich ? `${pr ? rich.link(`PR #${pr[1]}`, ref) : rich.codeTint(ref)}${rich.dim(` · ${source}`)}`
      : `Source: ${pr ? `PR #${pr[1]} · ` : ""}${ref}${source ? ` · ${source}` : ""}`.replace(/·/gu, "-"),
  ];
}

/** Show the review list if a finished run waits for it. Returns how many rules were kept, waiting and dropped. */
export async function reviewLearned(context: ReviewListContext): Promise<{ kept: number; waiting: number; dropped: number } | undefined> {
  const at = context.home ? { home: context.home } : undefined;
  const writer = openRecord(at);
  let list: Pending | undefined;
  try { list = await pending(writer, context.projectId); } finally { writer.close(); }
  if (!list) return undefined;
  const width = Math.max(30, Math.min(80, context.mode.width ?? 80));
  const out = (lines: string[]) => {
    for (const line of lines.flatMap(line => wrap(line, width))) context.write(line);
  };
  if (!context.interactive || (!context.keys && !process.stdin.isTTY)) {
    const count = list.items.length;
    for (const line of renderNotes([`${count === 1 ? "1 learned rule waits" : `${count} learned rules wait`} for your review: run \`mex\` in a terminal.`], context.mode)) context.write(line);
    return undefined;
  }
  const outcome = context.outcome ? context.outcome(list.jobId) : readOutcome({ home: context.home }, list.jobId);
  const automatic = outcome ? list.items.filter(({ entry, row }) => row.status === "active" && entry.mex.status === "active") : [];
  // Rules the gate kept are live as trials. Only rules that wait for a person are asked: the best supported ones,
  // shown in the run's own order.
  const waiting = list.items.filter(item => !automatic.includes(item));
  const asked = new Set(!outcome ? waiting : [...waiting].sort((a, b) => b.row.support - a.row.support
    || Number(b.row.proven) - Number(a.row.proven) || a.row.entryId.localeCompare(b.row.entryId)).slice(0, ASK_LIMIT));
  const items = waiting.filter(item => asked.has(item));
  const later = waiting.length - items.length;
  const rich = context.rich;
  const counts = outcome
    ? `${outcome.learned} learned · ${automatic.length} passed the checks · ${items.length} to confirm`
    : `${list.items.length} learned · ${items.length} to confirm`;
  const title = rich ? rich.section("YOUR TEAM'S RULES", counts) : [`Your team's rules · ${counts}`.replace(/·/gu, "-"), ""];
  const replay = new Map<string, string[]>();
  try {
    const { pastEdits, wouldFire } = await import("../learn-deeper/would-fire.js");
    const fired = wouldFire(items.map(item => item.raw), await pastEdits(context.root), context.env);
    for (const item of fired) {
      const where = clean(`${item.commit.slice(0, 7)} ${item.path}${item.line ? `:${item.line}` : ""}`, context.mode.ascii);
      const lines = replay.get(item.entryId) ?? [];
      lines.push(`Would have ${item.kind === "show" ? "been shown" : "stopped an edit"} at ${where}.`);
      replay.set(item.entryId, lines);
    }
  } catch { /* A replay can be unavailable when git or the hook is missing. */ }

  const next = context.keys ?? (() => readKey());
  const rewrites = new Map<string, string>(), drops = new Set<string>();
  const canCheck = items.some(item => item.entry.mex.status === "proposed");
  const checkHint = `v check this rule against the code (about ${VERIFY_ESTIMATE / 1000}k tokens)`;
  const summary = outcome ? "Rules that passed the checks are live now, and saving keeps them. Tick the ones below your agents should also get."
    : "Tick the rules your agents should get.";
  const selected = !items.length ? [] : await multiSelect(items.map(item => {
    const claim = clean(item.entry.mex.one_line, context.mode.ascii);
    const details = [...reviewDetails(item, context.mode.ascii, rich), ...(replay.get(item.row.entryId) ?? []).slice(0, 1)];
    return { value: item, label: rich?.codeTint(claim) ?? claim, details, checked: item.entry.mex.status === "active" };
  }), {
    rich: rich ?? null,
    title: [...title, ...(rich ? rich.text([summary]) : [summary]), ""],
    hint: `↑↓ move · Space keep or leave waiting${canCheck ? ` · ${checkHint}` : ""} · Enter save`,
    plainHint: `Enter saves. Type a number to keep a rule or leave it waiting.${canCheck ? " v then a number checks a rule." : ""}`,
    ...(context.keys ? { read: next } : {}),
    ...(rich ? {} : { write: text => out(text.trimEnd().split("\n")) }),
    onCheck: canCheck ? async ({ value: item }) => {
      if (item.entry.mex.status !== "proposed") return undefined;
      const result = await verifyOne(context, item.entry, next, out, rewrites);
      if (result === "quit") return null;
      if (result === undefined) return undefined;
      if (result === "drop") drops.add(item.row.entryId);
      else drops.delete(item.row.entryId);
      return result === "keep";
    } : undefined,
  });
  if (!selected) return undefined;

  const [{ finishLearnedReview }, { queueNativeRebuild }] = await Promise.all([
    import("../knowledge/mutations.js"), import("../knowledge/native-queue.js")]);
  const options = { projectPath: context.root, ...(context.home ? { home: context.home } : {}) };
  const reviewed = [...automatic.map(item => ({ id: item.row.entryId, raw: item.raw, support: item.row.support, decision: "keep" as const })),
    ...items.map(item => ({ id: item.row.entryId, raw: item.raw, support: item.row.support,
    decision: selected.includes(item) ? "keep" as const : drops.has(item.row.entryId) ? "drop" as const : "wait" as const,
    ...(rewrites.get(item.row.entryId) ? { rewrite: rewrites.get(item.row.entryId) } : {}) }))];
  let result;
  try { result = finishLearnedReview(list.jobId, context.projectId, reviewed, options); }
  catch {
    out(["Could not save the review. Run mex to open it again."]);
    return undefined;
  }
  queueNativeRebuild(context.root, { local: true });
  const { kept, waiting: waits, dropped } = result;
  const still = waits + later;
  const saved = `${kept} ${kept === 1 ? "rule" : "rules"} kept`;
  const delivery = [still ? `${still} waiting` : "", dropped ? `${dropped} dropped` : "",
    kept ? "your agents get them from the next session" : ""].filter(Boolean).map(part => " · " + part).join("");
  const help = "`mex rules --learned` lists them all · `mex expand <id>` shows one with its evidence";
  const ids = [...automatic, ...selected].map(({ entry }) => {
    const claim = clean(entry.mex.one_line, context.mode.ascii);
    return rich ? `  ${rich.dim(entry.mex.id)}  ${rich.codeTint(claim)}` : `  ${entry.mex.id}  ${claim}`;
  });
  if (rich) {
    for (const line of rich.text([`${rich.paint("ok", "✓")} ${rich.bold(saved)}${rich.dim(delivery)}`, ...ids, rich.commands(help)])) context.write(line);
  } else out([saved + delivery.replace(/·/gu, "-"), ...ids, help.replace(/·/gu, "-")]);
  if (waits || dropped) {
    try {
      const [{ expandTeam }, { sessionsActive }, { reviewBoundaryNotes }, { openRecord }] = await Promise.all([
        import("../knowledge/team.js"), import("../learn-deeper/weekly-schedule.js"), import("../learn-deeper/review-policy.js"), import("../record/index.js")]);
      const shared = reviewed.filter(item => item.decision !== "keep").map(item => item.id).filter(id => {
        try { return !!expandTeam(id, options); } catch { return false; }
      });
      const record = openRecord(context.home ? { home: context.home, projectPath: context.root } : { projectPath: context.root });
      let sessionActive = false;
      try { sessionActive = sessionsActive(record, Date.now()); } finally { record.close(); }
      out(reviewBoundaryNotes(shared, sessionActive));
    } catch { /* The review is already saved. */ }
  }
  return result;
}

/** Queue the check's recommendation alongside the person's other decisions. */
async function verifyOne(context: ReviewListContext, entry: KnowledgeEntry, next: () => Promise<string>,
  out: (lines: string[]) => void, rewrites: Map<string, string>): Promise<Decision | "quit" | undefined> {
  const [{ chooseAgent }, { verifyRule, VERIFY_ESTIMATE, VERIFY_CEILING, VERIFY_TIMEOUT_MS }, { runModel, ModelRunError, ModelToolLimitError }, { gateEntry }, { references }] = await Promise.all([
    import("../learn-deeper/offer.js"), import("../learn-deeper/verify.js"), import("../model-runner/index.js"), import("../knowledge/gates.js"), import("../knowledge/references.js")]);
  const agent = chooseAgent(context.projectId);
  if (!agent) { out(["Checking a rule needs an agent's command-line tool, such as Claude Code or Codex."]); return undefined; }
  const claim = clean(entry.mex.one_line, context.mode.ascii);
  out([`Ask ${agentName(agent)} to check "${claim}"?`,
    `One read-only call with evidence from the checkout, up to ${VERIFY_TIMEOUT_MS / 60_000} minutes. About ${VERIFY_ESTIMATE.toLocaleString("en-US")} tokens, estimated. The ceiling is ${VERIFY_CEILING.toLocaleString("en-US")} tokens; an answer over it is discarded.`,
    "Enter checks it. q leaves the review. Any other key cancels the check."]);
  const consent = await next();
  if (consent === "q" || consent === "quit") return "quit";
  if (consent !== "enter") return undefined;
  let answer;
  try { answer = await verifyRule({ claim: entry.mex.one_line, why: entry.text, scope: entry.mex.scope }, context.root, agent, context.model ?? runModel); }
  catch (error) {
    if (error instanceof ModelToolLimitError || error instanceof ModelRunError && error.category === "timeout") {
      out(["The check reached its limit. Any partial answer was discarded."]);
    } else out(["The check couldn't run."]);
    return undefined;
  }
  if (!answer) { out(["The check returned no usable answer."]); return undefined; }
  const where = clean(answer.evidence.slice(0, 3).join(", "), context.mode.ascii);
  const source = references(context.root);
  if (answer.verdict === "keep") {
    try { gateEntry({ ...entry, mex: { ...entry.mex, status: "active" } }, source); }
    catch {
      out([`The check suggested keep (${where}), and the producer gate did not accept the rule. It stays waiting.`]);
      return undefined;
    }
    out([`Suggested decision: keep (${where}). Review it before saving.`]);
    return "keep";
  }
  if (answer.verdict === "drop") {
    out([`Suggested decision: drop (${where}). Saving retires the rule.`]);
    return "drop";
  }
  const suggested = answer.text?.trim();
  if (!suggested) { out([`The check suggested a rewrite (${where}) and gave no wording.`]); return undefined; }
  try {
    const text = suggested.replace(/\s+/gu, " ");
    gateEntry({ ...entry, text, mex: { ...entry.mex, one_line: text.slice(0, 1024), status: "proposed" } }, source);
    rewrites.set(entry.mex.id, text);
  } catch {
    out([`The check suggested a rewrite (${where}), and the producer gate did not accept that wording.`]);
    return undefined;
  }
  out([`Suggested wording is staged (${where}). Saving keeps it waiting until you tick it.`]);
  return "wait";
}
