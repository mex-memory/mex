/**
 * The learn-deeper review list (ticket part H): at the end of a run, the person sees what was learned
 * and keeps or drops each rule. Pre-ticked: rules corroborated by 2+ PRs or proven against the code that
 * prompted them. Unticked: one PR with a strong signal; they wait and are never delivered until ticked.
 * The replay shows rules that would have stopped an edit or appeared on a file touch.
 *
 * Only a person at a terminal is asked. Anyone else gets one line, and the next `mex` in a terminal asks.
 */
import { stripVTControlCharacters } from "node:util";
import type { KnowledgeEntry } from "../knowledge/entry.js";
import { tombstone } from "../knowledge/state.js";
import { openRecord, type RecordWriter } from "../record/index.js";
import { readKey } from "./keys.js";
import type { Rich } from "./rich.js";
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
}

type ReviewItem = {
  row: import("../learn-deeper/pipeline.js").ReviewRow;
  entry: KnowledgeEntry;
  raw: string;
};
interface Pending { jobId: string; items: ReviewItem[] }
type Decision = "keep" | "wait" | "drop";
const PAGE_SIZE = 5;

async function pending(writer: RecordWriter, projectId: string): Promise<Pending | undefined> {
  const [{ reviewRows, reviewRowsKey }, { snapshotNotes }, { parseEntry, isLearnedEntry }, { learnedRefused, learnedReviewedKey, learnedWaitingKey }] = await Promise.all([
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
      if (!raw || tombstone(writer, projectId, row.entryId)
        || (row.support < 2 && writer.setting(projectId, learnedWaitingKey(row.entryId)))) continue;
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

function rowLines({ entry, row }: ReviewItem, slot: number, index: number, decision: Decision, ascii: boolean): string[] {
  const mark = decision === "keep" ? "[x]" : decision === "drop" ? "[-]" : "[ ]";
  const claim = clean(entry.mex.one_line, ascii);
  const body = clean(entry.text, ascii);
  const reason = body === claim ? "" : body.startsWith(claim + " ") ? body.slice(claim.length + 1) : body;
  const why = clean(entry.mex.source.label ?? "", ascii)
    || (row.proven ? "Proven on the code." : row.support >= 2 ? "Seen on several PRs." : "Seen on one PR.");
  const fix = clean(entry.mex.fix?.snippet ?? "", ascii);
  return [
    `${mark} ${slot}. ${claim}${index === slot ? "" : ` (rule ${index})`}`,
    `    Why: ${reason || why}`,
    ...(fix ? [`    Fix: ${fix.length > 120 ? fix.slice(0, 117) + "..." : fix}`] : []),
    `    Source: ${clean(entry.mex.source.ref, ascii)}`,
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
  const items = [...list.items].sort((a, b) => Number(a.row.route === "process-rule") - Number(b.row.route === "process-rule"));
  const decisions: Decision[] = items.map(({ entry }) => entry.mex.status === "active" ? "keep" : "wait");
  const rewrites = new Map<string, string>();
  const waiting = decisions.filter(decision => decision === "wait").length;
  out([`Learn deeper learned ${items.length} ${items.length === 1 ? "rule" : "rules"} from your team.`,
    ...(waiting ? [`${waiting} ${waiting === 1 ? "waits" : "wait"} for your tick.`] : [])]);
  try {
    const { pastEdits, wouldFire } = await import("../learn-deeper/would-fire.js");
    const fired = wouldFire(items.map(item => item.raw), await pastEdits(context.root), context.env);
    for (const item of fired) {
      const index = items.findIndex(({ row }) => row.entryId === item.entryId);
      if (index < 0) continue;
      const where = clean(`${item.commit.slice(0, 7)} ${item.path}${item.line ? `:${item.line}` : ""}`, context.mode.ascii);
      out([`Rule ${index + 1} would have ${item.kind === "show" ? "been shown" : "stopped an edit"} at ${where}. Hypothetical replay of past commits, not an observed stop.`]);
    }
  } catch { /* A replay can be unavailable when git or the hook is missing. */ }

  const next = context.keys ?? (() => readKey());
  const quit = (key: string) => key === "quit" || key === "q";
  const pages = Math.ceil(items.length / PAGE_SIZE);
  let page = 0, drop = false;
  const renderRow = (index: number) => out(rowLines(items[index]!, index % PAGE_SIZE + 1, index + 1, decisions[index]!, context.mode.ascii));
  const renderPage = () => {
    const start = page * PAGE_SIZE;
    out([`Page ${page + 1} of ${pages}`]);
    for (let index = start; index < Math.min(start + PAGE_SIZE, items.length); index++) {
      if (items[index]!.row.route === "process-rule" && (index === start || items[index - 1]?.row.route !== "process-rule")) out(["Process rules"]);
      renderRow(index);
    }
    out([
      `1-${Math.min(PAGE_SIZE, items.length - start)} toggles a rule. q leaves without saving.`,
      ...(waiting ? ["v then a number checks a waiting rule."] : []),
      ...(page ? ["p goes back a page."] : []),
      page + 1 < pages ? "Enter goes to the next page." : "Enter saves all decisions. d drops all unticked rules and saves.",
    ]);
  };
  renderPage();
  for (;;) {
    const key = await next();
    if (quit(key)) return undefined;
    if (key === "p" && page > 0) { page--; renderPage(); continue; }
    if (key === "enter" && page + 1 < pages) { page++; renderPage(); continue; }
    if (page + 1 === pages && (key === "enter" || key === "d")) { drop = key === "d"; break; }
    if (key !== "v" && !/^[1-5]$/u.test(key)) continue;
    const pick = key === "v" ? await next() : key;
    if (quit(pick)) return undefined;
    if (!/^[1-5]$/u.test(pick)) continue;
    const index = page * PAGE_SIZE + Number(pick) - 1;
    const item = items[index];
    if (!item) continue;
    if (key === "v") {
      if (item.entry.mex.status !== "proposed") continue;
      const result = await verifyOne(context, item.entry, next, out, rewrites);
      if (result === "quit") return undefined;
      if (!result) continue;
      decisions[index] = result;
    } else decisions[index] = decisions[index] === "keep" ? "wait" : "keep";
    renderRow(index);
  }

  const [{ finishLearnedReview }, { queueNativeRebuild }] = await Promise.all([
    import("../knowledge/mutations.js"), import("../knowledge/native-queue.js")]);
  const options = { projectPath: context.root, ...(context.home ? { home: context.home } : {}) };
  const reviewed = items.map(({ row, raw }, i) => ({ id: row.entryId, raw, support: row.support,
    decision: drop && decisions[i] === "wait" ? "drop" as const : decisions[i]!,
    ...(rewrites.get(row.entryId) ? { rewrite: rewrites.get(row.entryId) } : {}) }));
  let result;
  try { result = finishLearnedReview(list.jobId, context.projectId, reviewed, options); }
  catch {
    out(["Could not save the review. Run mex to open it again."]);
    return undefined;
  }
  queueNativeRebuild(context.root, { local: true });
  const { kept, waiting: waits, dropped } = result;
  out([`Kept ${kept}${waits ? `, ${waits} waiting` : ""}${dropped ? `, dropped ${dropped}` : ""}. Use \`mex recall <id>\` to see a kept rule.`]);
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
  const [{ chooseAgent }, { verifyRule, VERIFY_ESTIMATE, VERIFY_CEILING, VERIFY_TURNS, VERIFY_TIMEOUT_MS }, { runModel, ModelRunError, ModelToolLimitError }, { gateEntry }, { references }] = await Promise.all([
    import("../learn-deeper/offer.js"), import("../learn-deeper/verify.js"), import("../model-runner/index.js"), import("../knowledge/gates.js"), import("../knowledge/references.js")]);
  const agent = chooseAgent(context.projectId);
  if (!agent) { out(["Checking a rule needs Claude Code or Codex on PATH."]); return undefined; }
  const claim = clean(entry.mex.one_line, context.mode.ascii);
  out([`Ask ${agent === "claude" ? "Claude Code" : "Codex"} to check "${claim}"?`,
    `Read-only, up to ${VERIFY_TURNS} ${agent === "codex" ? "tool calls" : "turns"} or ${VERIFY_TIMEOUT_MS / 60_000} minutes. About ${VERIFY_ESTIMATE.toLocaleString("en-US")} tokens, estimated. The ceiling is ${VERIFY_CEILING.toLocaleString("en-US")} tokens; an answer over it is discarded.`,
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
