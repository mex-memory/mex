/**
 * The learn-deeper review list (ticket part H): at the end of a run, the person sees what was learned
 * and keeps or drops each rule. Pre-ticked: rules corroborated by 2+ PRs or proven against the code that
 * prompted them. Unticked: one PR with a strong signal; they wait and are never delivered until ticked.
 * "Would have fired" shows, at $0, which rules would have stopped the person's own last commits.
 *
 * Only a person at a terminal is asked. Anyone else gets one line, and the next `mex` in a terminal asks.
 */
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
}

const reviewedKey = (jobId: string) => `learning.deep.reviewed.${jobId}`;

interface Pending { jobId: string; rows: import("../learn-deeper/pipeline.js").ReviewRow[]; files: Map<string, string> }

/** The newest finished learning run whose rules the person hasn't reviewed yet, with their entry files. */
async function pending(writer: RecordWriter, projectId: string): Promise<Pending | undefined> {
  const [{ reviewRows }, { snapshotNotes }, { parseEntry }] = await Promise.all([
    import("../learn-deeper/pipeline.js"), import("../knowledge/personal-store.js"), import("../knowledge/entry.js")]);
  const jobs = writer.db.prepare(`SELECT id FROM jobs WHERE kind='learn-deeper' AND project_id=? AND state IN ('done','done with gaps')
    ORDER BY finished_at DESC LIMIT 5`).all(projectId) as Array<{ id: string }>;
  const notes = snapshotNotes(writer, projectId).files;
  for (const { id } of jobs) {
    if (writer.setting(projectId, reviewedKey(id))) continue;
    const files = new Map<string, string>();
    const rows = reviewRows(writer, projectId, id).filter(row => {
      const raw = notes.get(row.entryId);
      if (!raw) return false;
      try {
        const status = parseEntry(raw).mex.status;
        if (status === "retired") return false;
        row.status = status;
      } catch { return false; }
      files.set(row.entryId, raw);
      return true;
    });
    if (rows.length) return { jobId: id, rows, files };
  }
  return undefined;
}

function rowLine(row: Pending["rows"][number], index: number, ticked: boolean): string {
  const mark = ticked ? "[x]" : "[ ]";
  const why = row.proven ? "proven on the code" : row.support >= 2 ? "seen on several PRs" : "one PR, waits for your tick";
  return `${mark} ${index + 1}. ${row.claim} · ${row.label || why}`;
}

/** Show the review list if a finished run waits for it. Returns how many rules were kept, waiting and dropped. */
export async function reviewLearned(context: ReviewListContext): Promise<{ kept: number; waiting: number; dropped: number } | undefined> {
  const at = context.home ? { home: context.home } : undefined;
  const writer = openRecord(at);
  let list: Pending | undefined;
  try { list = await pending(writer, context.projectId); } finally { writer.close(); }
  if (!list) return undefined;
  const out = (lines: string[]) => {
    if (context.rich) for (const line of context.rich.text(lines)) context.write(line);
    else for (const line of lines) context.write(line);
  };
  if (!context.interactive || (!context.keys && !process.stdin.isTTY)) {
    for (const line of renderNotes([`${list.rows.length === 1 ? "1 learned rule waits" : `${list.rows.length} learned rules wait`} for your review: run \`mex\` in a terminal.`], context.mode)) context.write(line);
    return undefined;
  }
  // Process rules are listed together after the code rules, as one group.
  const rows = [...list.rows.filter(row => row.route !== "process-rule"), ...list.rows.filter(row => row.route === "process-rule")].slice(0, 9);
  const ticked = rows.map(row => row.status === "active");
  const waiting = rows.filter(row => row.status === "proposed").length;
  out([`Learn deeper learned ${rows.length} ${rows.length === 1 ? "rule" : "rules"} from your team${waiting ? `; ${waiting} ${waiting === 1 ? "waits" : "wait"} for your tick` : ""}:`]);
  const render = () => out(rows.map((row, i) => (rows[i - 1]?.route !== "process-rule" && row.route === "process-rule" ? "Process rules:\n" : "") + rowLine(row, i, ticked[i]!)));
  render();
  try {
    const { pastEdits, wouldFire } = await import("../learn-deeper/would-fire.js");
    const fired = wouldFire(rows.map(row => list!.files.get(row.entryId)!), await pastEdits(context.root), context.env);
    if (fired.length) out(["Would have stopped your own last commits:", ...fired.map(item => {
      const index = rows.findIndex(row => row.entryId === item.entryId);
      return `  ${item.commit.slice(0, 7)} ${item.path}${item.line ? `:${item.line}` : ""} · rule ${index + 1}`;
    })]);
  } catch { /* the replay is a bonus; never block the list on it */ }
  out(["Enter keeps these ticks · 1-9 toggles one · d drops the unticked · q decides later"]);
  const next = context.keys ?? (() => readKey());
  let drop = false;
  for (;;) {
    const key = await next();
    if (key === "quit" || key === "q") return undefined; // nothing decided: the next `mex` asks again
    if (key === "enter") break;
    if (key === "d") { drop = true; break; }
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= rows.length) {
      ticked[n - 1] = !ticked[n - 1];
      out([rowLine(rows[n - 1]!, n - 1, ticked[n - 1]!)]);
    }
  }
  const [{ tickLearned, untickLearned, forget }, { queueNativeRebuild }] = await Promise.all([
    import("../knowledge/mutations.js"), import("../knowledge/native-queue.js")]);
  const options = { projectPath: context.root, ...(context.home ? { home: context.home } : {}) };
  let kept = 0, waits = 0, dropped = 0;
  for (const [i, row] of rows.entries()) {
    try {
      if (ticked[i]) {
        if (row.status === "proposed") tickLearned(row.entryId, options);
        kept++;
      } else if (drop) {
        forget(row.entryId, "Dropped on the learn-deeper review list", options);
        dropped++;
      } else {
        if (row.status === "active") untickLearned(row.entryId, options);
        waits++;
      }
    } catch { /* an entry changed meanwhile: leave it as it is now */ }
  }
  const done = openRecord(at);
  try {
    done.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
      .run(context.projectId, reviewedKey(list.jobId), new Date().toISOString());
  } finally { done.close(); }
  queueNativeRebuild(context.root, { local: true });
  out([`Kept ${kept}${waits ? `, ${waits} waiting` : ""}${dropped ? `, dropped ${dropped}` : ""}. Kept rules reach your agents at the edit or file they govern; \`mex recall <id>\` shows any of them.`]);
  return { kept, waiting: waits, dropped };
}
