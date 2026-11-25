import { createInterface } from "node:readline";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { knowledgeProject } from "../knowledge/context.js";
import { CEILING_WAIT, recordedModelSpend } from "../model-runner/consent.js";
import type { ModelSetup } from "../model-runner/index.js";
import { ensureBackground, markPending } from "../record/background.js";
import { openRecord, openRecordReadOnly, type CheckoutRow, type RecordReader } from "../record/index.js";
import { describeJob, listJobs, requestJob, type JobRow } from "../record/jobs.js";
import { detectCaller } from "../repo-start/caller.js";
import { SourceError } from "./forge.js";
import { origin } from "./git.js";
import { LEARN_COMMAND, LEARN_KIND, Plan, quoteCeiling, reviewWindow, type LearningPlan } from "./plan.js";
import { prepareLearningQuote } from "./quote.js";
import { queueLearning } from "./queue.js";

import { importsEnabled, previewImport, type ImportFile } from "./session-import.js";

export { chooseAgent } from "./quote.js";

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
    const quote = await prepareLearningQuote(reader, { ...options, refreshUsage: true }, repo, window);
    if (quote.state === "no-review-remote") return;
    if (quote.state === "unavailable") {
      const reason = quote.reason.startsWith("The current") ? "the" + quote.reason.slice(3) : quote.reason;
      write(quote.importGaps ? reason : "Learn deeper later: " + reason);
      quote.importGaps?.forEach(write);
      return;
    }
    ({ plan } = quote);
    const { agent, sessions, estimate } = plan;
    const { minutes, share, importGaps } = quote;
    const topics = sessions.length ? "past reviews, docs, and sessions" : "past reviews and docs";
    const lines = [`Learn from ${topics} using your agent plan?`,
      `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} · ${share}.`,
      `Estimate ${count(estimate)} tokens · ceiling ${count(plan.ceiling)} tokens.`];
    if (quote.anonymous) lines.push(`Fetching slowly without a ${repo.host === "github.com" ? "GitHub" : "GitLab"} login. Sign in with \`${repo.host === "github.com" ? "gh" : "glab"} auth login\` to speed it up.`);
    if (plan.visibility === "private") lines.push("Review and doc excerpts from this private repo will be sent to your selected agent account. Start only if your organization allows it.");
    if (sessions.length) lines.push(`Past-session dry run found ${importCount(sessions)} for this checkout. Eligible typed excerpts go to your selected agent account.`,
      "For reviews and docs alone, decline and run `mex learn` without --sessions.");
    if (plan.refresh) lines.push("After this run, MEX checks for new reviews and docs every 7–14 days when idle, signed in, and within the 3% automatic allowance. Use `mex learn --no-weekly` for a one-time run.");
    lines.push(...importGaps);
    if (quote.usageBlocked) lines.push("Your agent's usage window needs to reset before model work can start.");
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
    const queued = queueLearning(writer, projectId, plan);
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
