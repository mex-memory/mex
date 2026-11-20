/**
 * The fail-pass job: reads a checkout's new journal rows since its cursor and
 * proposes the verified transitions through the producer gate. No model, no
 * repository command: it reads hooks.db and writes entries.
 *
 * It is its own job kind rather than a step of the memory filter: the filter
 * is a model job that waits for sign-in, usage windows and statement learning,
 * and runs only for some agents. This is cheap and runs for every agent.
 */
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { registerJobKind, type EnqueueOptions, type EnqueueResult, type JobKind, type JobRow } from "../record/jobs.js";
import { shortHash } from "../record/project.js";
import { filterAllowed } from "../filter/input.js";
import { propose, summarizeResults } from "./gate.js";
import type { Proposal } from "./gate-types.js";
import { findTransitions, transitionProposal, type JournalRow } from "./fail-pass.js";

export const FAIL_PASS_KIND = "fail-pass";
export const FAIL_PASS_LIMITS = { rows: 4096, sessionRows: 2000, scanIds: 20_000, checkouts: 64 } as const;
export interface FailPassParams { checkout: string; }
type Checkpoint = { batches: number };

export const cursorKey = (checkout: string) => `fail-pass.after.${shortHash(checkout)}`;
const OFF = "Waiting: capture or MEX is off here";
/** The same consent the filter reads: the checkout is on, automatic work and capture are on. */
const allowed = (writer: RecordWriter, project: string, checkout: string) => filterAllowed(writer, project, { checkout, agent: "codex" });
const put = (writer: RecordWriter, scope: string, key: string, value: string) =>
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value").run(scope, key, value);
const cursor = (writer: Pick<RecordWriter, "setting">, project: string, checkout: string) => {
  const n = Number(writer.setting(project, cursorKey(checkout)) ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export interface FailPassRead { proposals: Proposal[]; through: number; more: boolean; sessions: number; skipped: number; }
/**
 * New transitions in this checkout after the cursor. A session is read from its
 * start (bounded), so a failure before the cursor still pairs with a pass after
 * it; only transitions that completed after the cursor are proposed. Scripted
 * sessions and paused sessions never count. Subagent rows and MEX's own runs
 * are never in the journal (the hook leaves them out).
 */
export function readFailPass(writer: RecordWriter, project: string, checkout: string): FailPassRead | undefined {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return undefined;
    const after = cursor(writer, project, checkout);
    const page = hooks.all<{ id: number; session_id: string }>(`SELECT j.id,j.session_id FROM journal j JOIN sessions s ON s.session_id=j.session_id
      WHERE s.project_id=? AND s.checkout=? AND j.id>? AND j.kind IN ('command','edit') ORDER BY j.id LIMIT ?`, project, checkout, after, FAIL_PASS_LIMITS.rows);
    const through = page.at(-1)?.id ?? after;
    const proposals = new Map<string, Proposal>();
    let skipped = 0;
    const sessions = [...new Set(page.map(row => row.session_id))];
    for (const session of sessions) {
      const meta = hooks.get<{ agent: string; paused: number }>("SELECT agent,paused FROM sessions WHERE session_id=?", session);
      const scripted = hooks.get("SELECT 1 FROM journal WHERE session_id=? AND kind='typed' AND marks LIKE '%scripted%' LIMIT 1", session);
      if (!meta || meta.paused || scripted) { skipped++; continue; }
      const rows = hooks.all<JournalRow>(`SELECT id,kind,text,exit_code FROM journal WHERE session_id=? AND id<=? AND kind IN ('command','edit')
        ORDER BY id DESC LIMIT ?`, session, through, FAIL_PASS_LIMITS.sessionRows).reverse()
        .map(row => ({ ...row, id: Number(row.id), exit_code: row.exit_code === null ? null : Number(row.exit_code) }));
      for (const transition of findTransitions(rows)) {
        if (transition.pass.id <= after) continue;
        const proposal = transitionProposal(transition, meta.agent);
        proposals.set(proposal.key!, proposal);
      }
    }
    return { proposals: [...proposals.values()], through, more: page.length >= FAIL_PASS_LIMITS.rows, sessions: sessions.length, skipped };
  } finally { hooks?.close(); }
}

export function createFailPassKind(): JobKind<FailPassParams, Checkpoint> {
  return {
    name: FAIL_PASS_KIND, label: "Fail-to-pass capture", scope: "project", sideEffects: "idempotent",
    joins: (open, params) => { try { return (JSON.parse(open.params) as FailPassParams).checkout === params.checkout; } catch { return false; } },
    async runBatch({ writer, job, params, checkpoint }) {
      const project = job.project_id!, state = { batches: (checkpoint?.batches ?? 0) + 1 };
      if (!allowed(writer, project, params.checkout)) return { checkpoint: state, wait: OFF };
      const read = readFailPass(writer, project, params.checkout);
      if (!read) return { checkpoint: state, done: true, gaps: true, summary: "No compatible capture journal" };
      const owned = (gate: RecordWriter) => {
        if (!gate.db.prepare("SELECT 1 FROM jobs WHERE id=? AND owner=? AND state='running' AND request IS NULL").get(job.id, job.owner)) {
          throw new Error("Fail-to-pass job ownership changed; nothing was saved.");
        }
      };
      // The cursor moves in the same transaction as the entries.
      const results = await propose(read.proposals, { projectPath: params.checkout, home: writer.location.home,
        validate: owned, onAccepted: gate => { if (read.through > cursor(gate, project, params.checkout)) put(gate, project, cursorKey(params.checkout), String(read.through)); } });
      const summary = `${summarizeResults(results)} from ${read.sessions} session${read.sessions === 1 ? "" : "s"}${read.skipped ? ` (${read.skipped} scripted or paused skipped)` : ""}`;
      return { checkpoint: state, results: results.filter(r => r.status === "accepted").length, summary, done: !read.more,
        ...(read.more ? { progress: "reading later commands" } : {}) };
    },
    ready(job: JobRow, writer: RecordWriter) {
      try { return allowed(writer, job.project_id!, (JSON.parse(job.params) as FailPassParams).checkout); } catch { return false; }
    },
  };
}
registerJobKind(createFailPassKind());

/**
 * The background's cheap pass: queue a job for each checkout with command rows
 * newer than what was last queued. A bounded id window per pass; a checkout
 * whose job is already running keeps its rows for the next pass.
 */
export function queuePendingFailPass(writer: RecordWriter, queue: (writer: RecordWriter, options: EnqueueOptions) => EnqueueResult): number {
  const hooks = openHooksReadOnly({ home: writer.location.home });
  try {
    if (!hooks || hooks.diagnostic) return 0;
    const seen = Number(writer.setting("fail-pass", "queued.through") ?? 0) || 0;
    const top = Number(hooks.get<{ n: number | null }>("SELECT max(id) n FROM journal")?.n ?? 0);
    if (top <= seen) return 0;
    const end = Math.min(top, seen + FAIL_PASS_LIMITS.scanIds);
    const groups = hooks.all<{ project_id: string; checkout: string; first: number }>(`SELECT s.project_id,s.checkout,min(j.id) first FROM journal j
      JOIN sessions s ON s.session_id=j.session_id WHERE j.id>? AND j.id<=? AND j.kind='command' GROUP BY s.project_id,s.checkout ORDER BY first LIMIT ?`,
    seen, end, FAIL_PASS_LIMITS.checkouts);
    let through = groups.length === FAIL_PASS_LIMITS.checkouts ? Number(groups.at(-1)!.first) - 1 : end, queued = 0;
    for (const group of groups) {
      if (writer.checkout(group.checkout)?.project_id !== group.project_id || !allowed(writer, group.project_id, group.checkout)) continue;
      const result = queue(writer, { kind: FAIL_PASS_KIND, projectId: group.project_id, params: { checkout: group.checkout } satisfies FailPassParams });
      if (!result.existing) queued++;
      // A running job may have read before these rows arrived: look again next pass.
      else if (result.job.state === "running") through = Math.min(through, Number(group.first) - 1);
    }
    if (through > seen) put(writer, "fail-pass", "queued.through", String(through));
    return queued;
  } finally { hooks?.close(); }
}
