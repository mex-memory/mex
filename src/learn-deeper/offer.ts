import { createInterface } from "node:readline";
import { isCliAvailable } from "../cli-tools.js";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { nativeBinary } from "../knowledge/check.js";
import { knowledgeProject } from "../knowledge/context.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import { planWindow, type PlanWindow } from "../model-runner/budget-policy.js";
import type { ModelAgent, ModelSetup } from "../model-runner/index.js";
import { ensureBackground, markPending, queueJob } from "../record/background.js";
import { openHooksReadOnly, openRecord, openRecordReadOnly, type CheckoutRow, type RecordReader } from "../record/index.js";
import { describeJob, listJobs, requestJob, type JobRow } from "../record/jobs.js";
import { ownUsageStatus, ownUsageTotals, refreshOwnUsage, usageWindows } from "../record/own-usage.js";
import { detectCaller } from "../repo-start/caller.js";
import { ForgeClient, hostToken, SourceError } from "./forge.js";
import { origin, PinnedTree, repoPath, revision } from "./git.js";
import { hosts } from "./hosts.js";
import { BACKFILL_PULLS_PER_BATCH, LEARN_COMMAND, LEARN_KIND, MAX_DOCS, MAX_PULLS, orderBackfillPulls, Plan, quoteCeiling, quoteTokens,
  reviewWindow, type LearningPlan } from "./plan.js";
import { importsEnabled, previewImport, type ImportFile } from "./session-import.js";

type Print = (line: string) => void;
type Confirm = (lines: readonly string[], details: readonly string[]) => Promise<boolean>;

interface OfferOptions {
  root: string;
  projectId: string;
  write: Print;
  interactive: boolean;
  modelSetup?: ModelSetup;
  explicit?: boolean;
  dryRun?: boolean;
  sessions?: boolean;
  weekly?: boolean;
  confirm?: Confirm;
}

const count = (n: number) => n.toLocaleString("en-US");
function importCount(files: ImportFile[]): string {
  const messages = files.reduce((n, file) => n + file.messages, 0);
  return `${count(files.length)} past ${files.length === 1 ? "session" : "sessions"} and ${count(messages)} eligible ${messages === 1 ? "prompt" : "prompts"}`;
}

/** EOF and Ctrl+C close the offer without authorizing it. An Enter answer is explicit. */
async function askEnter(lines: readonly string[], details: readonly string[], write: Print): Promise<boolean> {
  for (const line of lines) write(line);
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await new Promise<string | undefined>(resolve => {
        const closed = () => resolve(undefined);
        reader.once("close", closed);
        reader.question(details.length ? "[Enter] Start  [d] Details " : "[Enter] Approve ", value => {
          reader.removeListener("close", closed); resolve(value);
        });
      });
      if (answer === undefined) return false;
      if (!answer.trim() || /^y(?:es)?$/iu.test(answer.trim())) return true;
      if (answer.trim().toLowerCase() !== "d" || !details.length) return false;
      for (const line of details) write(line);
    }
  } finally { reader.close(); }
}

function latestJob(reader: RecordReader, project: string): JobRow | undefined {
  return reader.get<JobRow>(`SELECT * FROM jobs WHERE kind=? AND project_id=?
    ORDER BY CASE WHEN state IN ('done','done with gaps','cancelled') THEN 1 ELSE 0 END,created_at DESC LIMIT 1`, LEARN_KIND, project);
}

function showJob(reader: RecordReader, job: JobRow, write: Print): void {
  const item = listJobs(reader, 500).find(item => item.id === job.id);
  if (item) write(describeJob(item));
  else write(`Learn deeper: ${job.state}. ${job.reason ?? "See `mex jobs --all`."}`);
}

/** The agent used most in the last 7 days, in this project first and then anywhere on this machine. */
export function chooseAgent(project: string): ModelAgent | undefined {
  const hooks = openHooksReadOnly();
  let used: ModelAgent[] = [];
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const ranked = (where: string, ...args: string[]) => hooks?.all<{ agent: string }>(`SELECT agent FROM sessions WHERE ${where}last_seen_at>=?
      AND agent IN ('claude-code','codex') GROUP BY agent ORDER BY count(*) DESC,max(last_seen_at) DESC`, ...args, since)
      .map(row => row.agent === "claude-code" ? "claude" : "codex") ?? [];
    used = [...ranked("project_id=? AND ", project), ...ranked("")];
  } catch { /* an unavailable history cannot choose the runner */ }
  finally { hooks?.close(); }
  return [...new Set<ModelAgent>([...used, "claude", "codex"])].find(agent => isCliAvailable(agent));
}

function preferredFolders(project: string, checkout: string): string[] {
  const hooks = openHooksReadOnly();
  try {
    const touched = hooks?.all<{ path: string }>(`SELECT path FROM epoch_files WHERE project_id=? AND checkout=?
      GROUP BY path ORDER BY count(*) DESC,path LIMIT 24`, project, checkout) ?? [];
    const folders = touched.map(row => row.path.split("/").slice(0, -1).slice(0, 2).join("/")).filter(repoPath);
    return [...new Set(folders)].slice(0, 12);
  } catch { return []; }
  finally { hooks?.close(); }
}

function usageShare(reader: RecordReader, agent: ModelAgent, estimate: number): string {
  const today = new Date(), start = new Date(today.getTime() - 6 * 86_400_000);
  const tokens = ownUsageTotals(reader, start.toISOString(), today.toISOString())
    .filter(row => row.agent === agent).reduce((total, row) => total + tokenCount(row), 0);
  const partial = ownUsageStatus(reader).find(status => status.agent === agent)?.status === "partial";
  return tokens ? `about ${(100 * estimate / tokens).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}% of your ${partial ? "usage read so far" : "recorded use"} in the past week`
    : "recent usage is unavailable, so a share of your plan can't be estimated yet";
}

function refreshUsageForQuote(): void {
  try {
    const writer = openRecord();
    try { refreshOwnUsage(writer, { maxBytes: 512 << 10, maxFiles: 12, maxDiscoveryEntries: 256 }); }
    finally { writer.close(); }
  } catch { /* A usage reading failure leaves the quote's share unavailable. */ }
}

export async function offerLearning(options: OfferOptions): Promise<void> {
  const { root, projectId, write } = options;
  // Test suites disable live model runs. Keep their free setup independent of host credentials as well.
  if ((process.env.MEX_SETUP_BACKGROUND_AGENTS === "0" && !options.confirm && !options.dryRun) || process.env.MEX_OFF === "1") return;
  const reader = openRecordReadOnly();
  if (!reader) return;
  let plan: LearningPlan;
  try {
    const checkout = reader.get<CheckoutRow>("SELECT state,off_until FROM checkouts WHERE path=? AND project_id=?", root, projectId);
    if (!checkout || !checkoutOn(checkout) || reader.setting("global", "enabled") === "false") {
      if (options.explicit) write("Learn deeper later: MEX is off here. Run `mex on` to turn it back on.");
      return;
    }
    const window = reviewWindow();
    // Past-session import is off unless asked for with --sessions, like the inactive session-import producer.
    const preview = () => options.sessions !== true ? { files: [], gaps: [] } : previewImport({ checkout: root, project: projectId, window, store: reader });
    if (options.dryRun) {
      const { files, gaps } = preview();
      write(options.sessions !== true ? "Past-session import is off. Add --sessions to preview it."
        : !importsEnabled(reader, projectId) ? "Past-session capture is off for this preview."
        : `Past-session dry run found ${importCount(files)} for this checkout. Preview only · $0.`);
      gaps.forEach(write);
      return;
    }
    const old = latestJob(reader, projectId);
    if (old && (!options.explicit || !["done", "done with gaps", "cancelled"].includes(old.state))) {
      if (options.explicit || !["done", "done with gaps", "cancelled"].includes(old.state)) showJob(reader, old, write);
      return;
    }
    const repo = await origin(root);
    if (!repo) {
      if (options.explicit) write("Learn deeper needs a github.com or gitlab.com origin remote.");
      return;
    }
    if (!options.interactive) { write(`To approve learning from reviews and docs, run \`${LEARN_COMMAND}\` in a terminal.`); return; }
    const agent = chooseAgent(projectId);
    if (!agent || !nativeBinary()) {
      write(`Learn deeper later: ${agent ? "MEX's native checker isn't installed, so learned rules can't be checked. Reinstall MEX, then run" : "Claude Code or Codex is needed on PATH. Then run"} \`${LEARN_COMMAND}\`.`);
      return;
    }
    const head = await revision(root);
    const tree = head && await PinnedTree.open(root, head);
    if (!head || !tree) { write("Learn deeper later: the current Git revision couldn't be read."); return; }
    const { files: sessions, gaps: importGaps } = preview();
    const client = new ForgeClient(repo, await hostToken(root, repo));
    const inventory = await hosts[repo.host].inventory(client, window, MAX_PULLS);
    const preferred = preferredFolders(projectId, root);
    const near = (path: string) => preferred.some(folder => path.startsWith(folder + "/"));
    const docs = tree.docs().sort((a, b) => Number(near(b)) - Number(near(a)));
    if (!inventory.pulls.length && !docs.length && !sessions.length) {
      write("Learn deeper found no recent merged changes, docs or eligible sessions in its source window.");
      importGaps.forEach(write); return;
    }
    const gaps: string[] = [];
    gaps.push(...importGaps);
    if (inventory.more) gaps.push("Some merged changes were outside the source scan limit.");
    if (docs.length > MAX_DOCS) gaps.push("Some docs were outside the source scan limit.");
    const setup = options.modelSetup ?? "best-only";
    const estimate = quoteTokens(inventory.pulls.length, Math.min(docs.length, MAX_DOCS), agent, setup, sessions, BACKFILL_PULLS_PER_BATCH);
    plan = Plan.parse({ checkout: root, head, origin: repo, source: inventory.source, visibility: inventory.visibility, agent,
      setup, ...window, preferred, pulls: orderBackfillPulls(inventory.pulls), pullsPerBatch: BACKFILL_PULLS_PER_BATCH,
      docs: docs.slice(0, MAX_DOCS), sessions, refresh: options.weekly !== false,
      gaps, estimate, ceiling: quoteCeiling(estimate) });
    refreshUsageForQuote();
    const minutes = Math.max(1, Math.ceil(estimate / 12_000));
    const share = usageShare(reader, agent, estimate);
    const topics = sessions.length ? "past reviews, docs, and sessions" : "past reviews and docs";
    const lines = [`Learn from ${topics} using your agent plan?`,
      `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} · ${share}.`,
      `Estimate ${count(estimate)} tokens · ceiling ${count(plan.ceiling)} tokens.`];
    if (inventory.anonymous) lines.push(`Fetching slowly without a ${repo.host === "github.com" ? "GitHub" : "GitLab"} login. Sign in with \`${repo.host === "github.com" ? "gh" : "glab"} auth login\` to speed it up.`);
    if (plan.visibility === "private") lines.push("Review and doc excerpts from this private repo will be sent to your selected agent account. Start only if your organization allows it.");
    if (sessions.length) lines.push(`Past-session dry run found ${importCount(sessions)} for this checkout. Eligible typed excerpts go to your selected agent account.`,
      "For reviews and docs alone, decline and run `mex learn` without --sessions.");
    if (plan.refresh) lines.push("After this run, MEX checks for new reviews and docs every 7–14 days when idle, signed in, and within the 3% automatic allowance. Use `mex learn --no-weekly` for a one-time run.");
    lines.push(...importGaps);
    const windows = usageWindows(reader).filter(item => item.agent === agent && Date.parse(item.observed_at) <= Date.now()).map(item => ({
      usedPercent: item.used_percent, status: item.status as PlanWindow["status"], resetsAt: item.resets_at,
    }));
    if (planWindow(windows, Date.now()).blocked) lines.push("Your agent's usage window needs to reset before model work can start.");
    const details = [`Counted ${plan.pulls.length} merged changes and ${plan.docs.length} docs in the approved source scan. A small sample of closed issues and commit messages may supply context.`,
      `Agent: ${agent === "claude" ? "Claude Code" : "Codex"} · ${plan.setup === "mixed" ? "cheap filter, best writer" : "best model"}.`,
      "Historical docs are screened out during the scan.",
      "Checked rules reach your sessions as learned, not shared. See `mex jobs` for progress and pause or cancel."];
    if (!await (options.confirm ?? ((lines, details) => askEnter(lines, details, write)))(lines, details)) return;
  } catch (error) {
    write(`Learn deeper later: ${error instanceof SourceError ? error.message : "the quote could not be prepared."} Run \`${LEARN_COMMAND}\` to try again.`);
    return;
  } finally { reader.close(); }

  await import("./job.js");
  const writer = openRecord();
  try {
    const current = writer.checkout(root);
    if (current?.path !== root || current.project_id !== projectId || !checkoutOn(current) || !automaticWorkEnabled(writer, projectId)) {
      write("Learn deeper later: MEX is off here or the checkout registration changed."); return;
    }
    const queued = queueJob(writer, { kind: LEARN_KIND, projectId, params: plan, tokensEstimate: plan.estimate });
    const started = ensureBackground({ home: writer.location.home });
    write(queued.existing ? "Learn deeper is already queued or running. See `mex jobs`."
      : `Learn deeper queued. ${!started.started && started.reason === "disabled" ? "Run `mex jobs run` to continue." : "See `mex jobs` for progress."}`);
  } finally { writer.close(); }
}

async function raiseCeiling(root: string, project: string, write: Print): Promise<void> {
  const reader = openRecordReadOnly();
  let job: JobRow | undefined;
  try { job = reader && latestJob(reader, project); } finally { reader?.close(); }
  if (!job || job.state !== "waiting" || job.reason !== CEILING_WAIT) {
    write("There's no learning job waiting for a higher ceiling here."); return;
  }
  const plan = Plan.parse(JSON.parse(job.params));
  const writer = openRecord();
  let spent: number;
  try { spent = recordedModelSpend(writer, job.id); } finally { writer.close(); }
  const ceiling = Math.max(spent, plan.ceiling) + quoteCeiling(plan.estimate);
  if (!await askEnter([`Raise the learning ceiling from ${count(plan.ceiling)} to ${count(ceiling)} tokens?`,
    `This job has already used or reserved ${count(spent)} tokens. It will continue from its saved batch.`], [], write)) return;
  await import("./job.js");
  const current = openRecord();
  try {
    if (current.checkout(root)?.project_id !== project) throw new Error("The checkout registration changed. Review a new quote.");
    const params = JSON.stringify({ ...plan, ceiling });
    const resumed = requestJob(current, job.id, "resume", { state: "waiting", params: job.params, reason: CEILING_WAIT }, params);
    if (resumed.state !== "queued" || resumed.params !== params) throw new Error("The learning job changed. Review a new ceiling.");
    markPending(current);
    ensureBackground({ home: current.location.home });
    write("Ceiling approved. See `mex jobs` for progress.");
  } finally { current.close(); }
}

export async function runLearnCommand(options: { raiseCeiling?: boolean; modelSetup?: string; dryRun?: boolean; sessions?: boolean; weekly?: boolean }): Promise<void> {
  const project = knowledgeProject({ projectPath: process.cwd() });
  const interactive = detectCaller() === "person";
  if (options.modelSetup !== undefined && !["mixed", "best-only"].includes(options.modelSetup)) throw new Error("Use --model-setup mixed or --model-setup best-only.");
  const reader = openRecordReadOnly();
  try {
    if (!reader?.get("SELECT 1 FROM checkouts WHERE path=? AND project_id=?", project.root, project.projectId)) throw new Error("Run `mex` here to register this repo first.");
  } finally { reader?.close(); }
  if (options.raiseCeiling) {
    if (options.dryRun || options.sessions !== undefined || options.weekly === false) throw new Error("Use --raise-ceiling by itself to resume the existing quote.");
    if (!interactive) { console.log("Run `mex learn --raise-ceiling` in a terminal to review and approve a new limit."); return; }
    await raiseCeiling(project.root, project.projectId, console.log);
  } else await offerLearning({ root: project.root, projectId: project.projectId, write: console.log, interactive,
    modelSetup: options.modelSetup as ModelSetup | undefined, explicit: true, dryRun: options.dryRun, sessions: options.sessions, weekly: options.weekly });
}
