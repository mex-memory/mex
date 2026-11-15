/** `mex sync`: finish this checkout's ordinary, capped judge work in the foreground. */
import { join } from "node:path";
import { isCliAvailable } from "../cli-tools.js";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { knowledgeProject, type KnowledgeOptions } from "../knowledge/context.js";
import { openRecord, openRecordReadOnly, type CheckoutRow } from "../record/index.js";
import { blockedReason, ownerId, recoverInterruptedJobs, requestJob, runOneBatch, type JobRow } from "../record/jobs.js";
import { ensureBackground, queueJob } from "../record/background.js";
import { judgeCandidates } from "./job.js";
import { evaluate } from "./native.js";
import { pendingJudgeRequest, type JudgeParams } from "./pending.js";
import { sessionWorkEnabled } from "./session.js";

interface SyncDependencies {
  available?: typeof isCliAvailable;
  evaluate?: typeof evaluate;
  write?: (line: string) => void;
  clock?: () => number;
  budgetMs?: number;
}

const active = (value?: string) => !!value?.trim() && value.trim() !== "0";
function currentHost(): JudgeParams["agent"] | undefined {
  return active(process.env.CODEX_THREAD_ID) ? "codex" : active(process.env.CLAUDECODE) ? "claude" : undefined;
}
function configuredAgents(root: string): JudgeParams["agent"][] {
  try {
    const directory = containedDirectory(root, [".mex"]);
    const text = directory && readBoundedTextFile(join(directory, "config.json"), 64 << 10);
    const value: unknown = text ? JSON.parse(text) : undefined;
    const tools = value && typeof value === "object" && !Array.isArray(value) ? (value as { aiTools?: unknown }).aiTools : undefined;
    return Array.isArray(tools) ? tools.filter((tool): tool is JudgeParams["agent"] => tool === "claude" || tool === "codex") : [];
  } catch { return []; } // Ignore an unsafe, oversized or unavailable optional selection.
}
function chooseAgent(root: string, preferred: JudgeParams["agent"] | undefined, available: typeof isCliAvailable): JudgeParams["agent"] | undefined {
  const host = currentHost();
  if (host) return available(host) ? host : undefined;
  const choices = [preferred, ...configuredAgents(root), "claude", "codex"];
  return [...new Set(choices)].find((agent): agent is JudgeParams["agent"] =>
    (agent === "claude" || agent === "codex") && available(agent));
}
function jobParams(job: JobRow): JudgeParams {
  const value = JSON.parse(job.params) as Partial<JudgeParams> | null;
  if (!value || typeof value.checkout !== "string" || (value.agent !== "claude" && value.agent !== "codex")) throw new Error("The existing judge job has invalid parameters.");
  return value as JudgeParams;
}

/** No legacy scaffold is required. Dry runs neither open a writer nor queue work. */
export async function runJudgeSync(options: KnowledgeOptions & { dryRun?: boolean }, dependencies: SyncDependencies = {}): Promise<JobRow | undefined> {
  const write = dependencies.write ?? console.log;
  const probed = new Map<string, boolean>();
  const available = (agent: string) => {
    if (!probed.has(agent)) probed.set(agent, (dependencies.available ?? isCliAvailable)(agent));
    return probed.get(agent)!;
  };
  const project = knowledgeProject(options);
  const reader = openRecordReadOnly(options);
  let params: JudgeParams;
  let selectedAgent: JudgeParams["agent"] | undefined;
  try {
    if (reader?.diagnostic) throw new Error(reader.diagnostic);
    const registered = reader?.get<CheckoutRow>("SELECT * FROM checkouts WHERE path=? AND project_id=?", project.root, project.projectId);
    if (!registered) throw new Error("MEX is not registered here. Run `mex` first.");
    const pending = pendingJudgeRequest(project.location.directory, project.root);
    if (pending && pending.project_id !== project.projectId) throw new Error("The pending judge request belongs to another project.");
    const preferred = pending?.agent === "claude-code" ? "claude" : pending?.agent;
    selectedAgent = chooseAgent(project.root, preferred, available);
    params = { checkout: project.root, agent: selectedAgent ?? currentHost() ?? "claude", near: pending?.near ?? [] };
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
      write(selectedAgent ? `Runner: ${selectedAgent}, cheap model, inside the cap.` : "Install the current host's CLI, or Claude Code or Codex in a standalone terminal, to run the judge.");
      write("Dry run: no job queued, model called or knowledge changed. Use `mex sync --deep` for the interactive session.");
      return undefined;
    }
    if (currentHost() && !sessionWorkEnabled({ location: project.location }, params.agent, params.sessionId)) {
      write("MEX is paused in this session. Resume it before running `mex sync`.");
      return undefined;
    }
  } finally { reader?.close(); }

  const writer = openRecord({ home: options.home, cache: options.cache, isNetwork: options.isNetwork });
  try {
    const checkout = writer.checkout(options.projectPath);
    if (checkout?.path !== project.root || checkout.project_id !== project.projectId) throw new Error("Checkout registration changed. Run `mex sync` again.");
    const self = ownerId("foreground");
    recoverInterruptedJobs(writer, self);
    const report = (job: JobRow) => {
      write(`Knowledge judge: ${job.state}; ${job.results} entries checked by model.`);
      const reason = job.reason ?? blockedReason({ all: (sql, ...args) => writer.db.prepare(sql).all(...args) as never }, job);
      if (reason) write(reason);
      if (!["done", "done with gaps", "cancelled"].includes(job.state)) write("Use `mex jobs` for progress and pause/resume controls.");
      if (job.state === "done with gaps") write("Some entries remain unresolved. Use `mex check` and `mex review` to inspect them.");
      return job;
    };
    const held = (job: JobRow) => {
      const accepted = jobParams(job);
      if (accepted.checkout !== project.root) {
        write("A knowledge judge job is unfinished in another checkout. Use `mex jobs` to finish or cancel it, then run `mex sync` here again.");
        return true;
      }
      if (job.state === "running" || job.state === "paused") return true;
      if (currentHost() && (accepted.agent !== params.agent || accepted.sessionId !== params.sessionId)) {
        write("The existing judge job belongs to another host or editing session. Use `mex jobs` to finish or cancel it before starting this session's judge.");
        return true;
      }
      if (!available(accepted.agent)) throw new Error(`The existing judge job uses ${accepted.agent}, which is not on PATH. Install it or cancel that job in \`mex jobs\` before starting another.`);
      return false;
    };
    const existing = writer.db.prepare("SELECT * FROM jobs WHERE kind='judge' AND project_id=? AND state NOT IN ('done','done with gaps','failed','cancelled') ORDER BY created_at LIMIT 1").get(project.projectId) as unknown as JobRow | undefined;
    if (existing && held(existing)) return report(existing);
    if (!existing && !selectedAgent) throw new Error(currentHost()
      ? `This session needs ${currentHost()} on PATH to run its judge. Run sync from a standalone terminal to select another installed host.`
      : "The judge needs Claude Code or Codex on PATH. Install one, then run `mex sync` again.");
    const queued = queueJob(writer, { kind: "judge", projectId: project.projectId, params });
    const row = () => writer.db.prepare("SELECT * FROM jobs WHERE id=?").get(queued.job.id) as unknown as JobRow;
    // A competing command can enqueue or change ownership after the first read.
    if (held(queued.job)) return report(row());
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
    const result = report(row());
    if (result.state === "queued" || result.state === "waiting") {
      try { ensureBackground({ home: writer.location.home, cache: options.cache }); } catch { /* work stays durable for the next command */ }
    }
    return result;
  } finally { writer.close(); }
}
