/** `mex sync`: finish this checkout's ordinary, capped judge work in the foreground. */
import { join } from "node:path";
import { isCliAvailable } from "../cli-tools.js";
import { loadConfiguredAiTools } from "../config.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { openRecord, openRecordReadOnly, type CheckoutRow } from "../record/index.js";
import { blockedReason, ownerId, recoverInterruptedJobs, requestJob, runOneBatch, type JobRow } from "../record/jobs.js";
import { queueJob } from "../record/background.js";
import { judgeCandidates } from "./job.js";
import { evaluate } from "./native.js";
import { pendingJudgeRequest, type JudgeParams } from "./pending.js";

interface SyncDependencies {
  available?: typeof isCliAvailable;
  evaluate?: typeof evaluate;
  write?: (line: string) => void;
  clock?: () => number;
  budgetMs?: number;
}

function chooseAgent(root: string, preferred: JudgeParams["agent"] | undefined, available: typeof isCliAvailable): JudgeParams["agent"] | undefined {
  const active = (value?: string) => !!value?.trim() && value.trim() !== "0";
  const host = active(process.env.CODEX_THREAD_ID) ? "codex" : active(process.env.CLAUDECODE) ? "claude" : undefined;
  const choices = [host, preferred, ...loadConfiguredAiTools(join(root, ".mex")), "claude", "codex"];
  return [...new Set(choices)].find((agent): agent is JudgeParams["agent"] =>
    (agent === "claude" || agent === "codex") && available(agent));
}

/** No legacy scaffold is required. Dry runs neither open a writer nor queue work. */
export async function runJudgeSync(options: KnowledgeOptions & { dryRun?: boolean }, dependencies: SyncDependencies = {}): Promise<JobRow | undefined> {
  const write = dependencies.write ?? console.log;
  const project = knowledgeProject(options);
  const reader = openRecordReadOnly(options);
  let params: JudgeParams;
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    const registered = reader?.get<CheckoutRow>("SELECT * FROM checkouts WHERE path=? AND project_id=?", project.root, project.projectId);
    if (!registered) throw new Error("MEX is not registered here. Run `mex` first.");
    const pending = pendingJudgeRequest(project.location.directory, project.root);
    if (pending && pending.project_id !== project.projectId) throw new Error("The pending judge request belongs to another project.");
    const preferred = pending?.agent === "claude-code" ? "claude" : pending?.agent;
    const agent = chooseAgent(project.root, preferred, dependencies.available ?? isCliAvailable);
    params = { checkout: project.root, agent: agent ?? "claude", near: pending?.near ?? [] };
    // An exact hook request may supply session ownership. Never borrow another host's session.
    if (pending?.session_id && preferred === params.agent) params.sessionId = pending.session_id;
    const currentSession = process.env.CODEX_THREAD_ID?.trim();
    if (params.agent === "codex" && currentSession && currentSession.length <= 512 && currentSession !== "0") params.sessionId = currentSession;
    if (options.dryRun) {
      const report = await (dependencies.evaluate ?? evaluate)({ checkout: project.root, project_id: project.projectId,
        mex_home: project.location.home, record_directory: project.location.directory });
      const candidates = judgeCandidates(report, params, project.location.home, project.projectId, reader!);
      write(`Would run the knowledge judge: ${candidates.filter(c => !c.spare).length} changed or broken entries; ${candidates.filter(c => c.spare).length} complete entries with changed files, only with spare allowance.`);
      write("Free rule evidence and corrections run first. Cached judgments, safe evidence and the model cap determine which calls can run.");
      write(agent ? `Runner: ${agent}, cheap model, inside the cap.` : "Install Claude Code or Codex to run the judge.");
      write("Dry run: no job queued, model called or knowledge changed. Use `mex sync --deep` for the interactive session.");
      return undefined;
    }
    if (!agent) throw new Error("The judge needs Claude Code or Codex on PATH. Install one, then run `mex sync` again.");
  } finally { reader?.close(); }

  const writer = openRecord({ home: options.home, cache: options.cache, isNetwork: options.isNetwork });
  try {
    const checkout = writer.checkout(options.projectPath);
    if (checkout?.path !== project.root || checkout.project_id !== project.projectId) throw new Error("Checkout registration changed. Run `mex sync` again.");
    const self = ownerId("foreground");
    recoverInterruptedJobs(writer, self);
    const queued = queueJob(writer, { kind: "judge", projectId: project.projectId, params });
    const row = () => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(queued.job.id) as unknown as JobRow;
    const accepted = JSON.parse(queued.job.params) as JudgeParams;
    if (accepted.checkout !== project.root) {
      write("A knowledge judge job is unfinished in another checkout. Use `mex jobs` to finish or cancel it, then run `mex sync` here again.");
      return row();
    }
    // Retry a wait now; the job itself rechecks cap, consent and exact-preview admission.
    // A deliberate pause is retained, and a running job remains owned by its runner.
    if (queued.job.state === "waiting") requestJob(writer, queued.job.id, "resume", queued.job);
    const only = new Set([queued.job.id]);
    const clock = dependencies.clock ?? Date.now;
    const deadline = clock() + (dependencies.budgetMs ?? 10 * 60_000);
    if (row().state === "queued") write("Running the knowledge judge (cheap model, inside the cap)...");
    while (clock() < deadline && row().state === "queued") {
      const before = row().batch;
      if (await runOneBatch(writer, self, { only, immediate: true, onProgress: (_job, text) => write(text) }) === "idle") break;
      const summary = writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? AND batch=?").get(queued.job.id, before)?.summary;
      if (summary) write(String(summary));
    }
    const result = row();
    write(`Knowledge judge: ${result.state}; ${result.results} entries checked by model.`);
    const reason = result.reason ?? blockedReason({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never }, result);
    if (reason) write(reason);
    if (!["done", "done with gaps", "cancelled"].includes(result.state)) write("Use `mex jobs` for progress and pause/resume controls.");
    if (result.state === "done with gaps") write("Some entries remain unresolved. Use `mex check` and `mex review` to inspect them.");
    return result;
  } finally { writer.close(); }
}
