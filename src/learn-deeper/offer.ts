import { createInterface } from "node:readline";
import { automaticWorkEnabled, checkoutOn } from "../controls/index.js";
import { nativeBinary } from "../knowledge/check.js";
import { knowledgeProject } from "../knowledge/context.js";
import { CEILING_WAIT, recordedModelSpend, tokenCount } from "../model-runner/consent.js";
import { planWindow, type PlanWindow } from "../model-runner/budget-policy.js";
import type { ModelAgent, ModelSetup } from "../model-runner/index.js";
import { agentName, detectAgents, modelAgent, runnableAgents, type AgentStatus, type RunnableAgent } from "../model-runner/agents.js";
import { ensureBackground, markPending, queueJob } from "../record/background.js";
import { openHooksReadOnly, openRecord, openRecordReadOnly, type CheckoutRow, type RecordReader } from "../record/index.js";
import { ownerPid, processAlive, requestJob, type JobRow } from "../record/jobs.js";
import { ownUsageStatus, ownUsageTotals, refreshOwnUsage, usageWindows } from "../record/own-usage.js";
import { detectCaller } from "../repo-start/caller.js";
import { confirmAnalysis } from "../repo-start/analysis-screen.js";
import { listNames, MARGIN, Rich, RICH_MIN_COLUMNS } from "../repo-start/rich.js";
import { screenMode, wrap } from "../repo-start/screen.js";
import { select } from "../repo-start/select.js";
import { basename } from "node:path";
import { ForgeClient, hostToken, SourceError } from "./forge.js";
import { origin, PinnedTree, repoPath, revision } from "./git.js";
import { hosts } from "./hosts.js";
import { DEEP_ANALYSIS, estimateMinutes, LEARN_COMMAND, LEARN_KIND, Plan, quoteCeiling,
  reviewWindow, type LearningPlan } from "./plan.js";
import { censusLine, estimateCensus } from "./harvest/estimate.js";
import { procedureEstimate } from "./procedures.js";
import { previewHarvest, planHarvest } from "./harvest/index.js";
import { harvestClient, savedCursor } from "./pipeline.js";

type Print = (line: string) => void;
type Confirm = (lines: readonly string[], details: readonly string[]) => Promise<boolean>;

interface OfferOptions {
  root: string;
  projectId: string;
  write: Print;
  screenWrite?: Print;
  interactive: boolean;
  modelSetup?: ModelSetup;
  explicit?: boolean;
  dryRun?: boolean;
  sessions?: boolean;
  weekly?: boolean;
  rich?: Rich;
  agent?: string;
  confirm?: Confirm;
}

const count = (n: number) => n.toLocaleString("en-US");
const counted = (n: number, singular: string, plural: string) => `${count(n)} ${n === 1 ? singular : plural}`;

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

function showJob(job: JobRow, write: Print): void {
  if (job.state === "running") {
    const pid = job.owner ? ownerPid(job.owner) : undefined;
    if (pid === undefined || (pid !== process.pid && !processAlive(pid))) {
      write("Deep analysis: interrupted. The background process will check saved work when it starts. Run `mex jobs` to check progress.");
      return;
    }
  }
  write(`Deep analysis: ${job.state} · ${job.reason ?? job.progress ?? "see `mex jobs`"}`);
}

function configuredAgent(reader: RecordReader | undefined, project: string): string | undefined {
  return reader?.setting(project, "learning.agent") ?? reader?.setting("global", "learning.agent");
}

/** The read-only rule check currently supports the Claude Code and Codex tool runners. */
export function chooseAgent(project: string): "claude" | "codex" | undefined {
  const reader = openRecordReadOnly();
  try {
    const selected = configuredAgent(reader, project);
    const available = runnableAgents(detectAgents()).filter(status => status.id === "claude-code" || status.id === "codex");
    const agent = available.find(status => status.id === selected) ?? available[0];
    if (agent?.id === "claude-code" || agent?.id === "codex") return modelAgent(agent.id);
  } finally { reader?.close(); }
}

function saveAgent(agent: AgentStatus, scope: string): void {
  const writer = openRecord();
  try {
    writer.db.prepare(`INSERT INTO settings(scope,key,value) VALUES(?,'learning.agent',?)
      ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`).run(scope, agent.id);
  } finally { writer.close(); }
}

export function setAnalysisAgent(value: string, projectPath?: string): string {
  const agent = detectAgents({ includeSessions: false }).find(status => status.id === value);
  if (!agent) throw new Error(`Unknown agent "${value}". Use an agent id shown by \`mex learn --help\`.`);
  const project = projectPath ? knowledgeProject({ projectPath }) : undefined;
  if (project) {
    const reader = openRecordReadOnly();
    try {
      if (!reader?.get("SELECT 1 FROM checkouts WHERE path=? AND project_id=?", project.root, project.projectId)) {
        throw new Error("Run `mex` here to register this repo first.");
      }
    } finally { reader?.close(); }
  }
  saveAgent(agent, project?.projectId ?? "global");
  return agent.name;
}

export async function pickAnalysisAgent(statuses: AgentStatus[], options: {
  rich?: Rich; write: Print; preferred?: string; read?: () => Promise<string>;
}): Promise<RunnableAgent | null> {
  const available = runnableAgents(statuses);
  const unavailable = statuses.filter(status => status.installed && !status.runner.ok);
  const missing = statuses.filter(status => !status.installed);
  const { rich, write, read } = options;
  const title = "Which agent should run it?";
  const also = missing.length ? `MEX also supports ${missing.length} more ${missing.length === 1 ? "agent" : "agents"}: ${listNames(missing.map(status => status.name))}` : undefined;
  const chosen = await select([...available, ...unavailable].map(status => ({
    value: status,
    label: status.name,
    note: status.runner.ok
      ? `${status.runner.models}${status === available[0] && status.sessions7d > 0 ? " · you use it most" : ""}`
      : status.runner.reason,
    disabled: !status.runner.ok,
  })), {
    title: [rich ? `${MARGIN}${rich.bold(title)}` : title],
    footer: also ? rich?.text([also], true) ?? [also] : [],
    rich: rich ?? null,
    focus: available.findIndex(status => status.id === options.preferred),
    ...(read ? { read } : {}),
    ...(rich ? {} : { write: text => { for (const line of text.trimEnd().split("\n")) write(line); } }),
  });
  if (chosen) {
    write(rich ? `${MARGIN}${rich.bold(title)}  ${rich.paint("ok", "✓")} ${chosen.name}` : `${title} ${chosen.name}`);
    write("");
  }
  return available.find(status => status === chosen) ?? null;
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

function usageShare(reader: RecordReader, agent: ModelAgent, estimate: number): string | undefined {
  const today = new Date(), start = new Date(today.getTime() - 6 * 86_400_000);
  const tokens = ownUsageTotals(reader, start.toISOString(), today.toISOString())
    .filter(row => row.agent === agent).reduce((total, row) => total + tokenCount(row), 0);
  const partial = ownUsageStatus(reader).find(status => status.agent === agent)?.status === "partial";
  return tokens ? `about ${(100 * estimate / tokens).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}% of your ${partial ? "usage read so far" : "recorded use"} in the past week`
    : undefined;
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
  if (process.env.MEX_OFF === "1") return;
  if (options.sessions) {
    // Past-session learning has its own deferred bucket (D7): learn deeper reads reviews, past fixes and docs.
    write("Past-session learning isn't available yet. Run `mex learn` without --sessions to learn from reviews, past fixes and docs.");
    return;
  }
  const reader = openRecordReadOnly();
  if (!reader) return;
  let plan: LearningPlan;
  try {
    const checkout = reader.get<CheckoutRow>("SELECT state,off_until FROM checkouts WHERE path=? AND project_id=?", root, projectId);
    if (!checkout || !checkoutOn(checkout) || reader.setting("global", "enabled") === "false") {
      if (options.explicit) write("Deep analysis later: MEX is off here. Run `mex on` to turn it back on.");
      return;
    }
    const window = reviewWindow();
    const old = options.dryRun ? undefined : latestJob(reader, projectId);
    if (old && (!options.explicit || !["done", "done with gaps", "cancelled"].includes(old.state))) {
      if (options.explicit || !["done", "done with gaps", "cancelled"].includes(old.state)) showJob(old, write);
      return;
    }
    const repo = await origin(root);
    if (!repo) {
      if (options.explicit) write("Deep analysis needs a GitHub or GitLab remote.");
      return;
    }
    if (!options.dryRun && !options.interactive) { write(`To approve learning from reviews and docs, run \`${LEARN_COMMAND}\` in a terminal.`); return; }
    // Test suites can disable the offer without changing what scripts are told.
    if (process.env.MEX_SETUP_BACKGROUND_AGENTS === "0" && !options.confirm && !options.dryRun) return;
    const agents = detectAgents();
    const available = runnableAgents(agents);
    const preferred = options.agent ?? configuredAgent(reader, projectId);
    let selected = available.find(status => status.id === preferred) ?? available[0];
    if (!options.dryRun && options.agent && selected?.id !== options.agent) {
      const unavailable = agents.find(status => status.id === options.agent);
      const why = unavailable && !unavailable.runner.ok ? unavailable.runner.reason : "its CLI was not found";
      write(`Deep analysis can't run through ${unavailable?.name ?? options.agent}: ${why}.`);
      return;
    }
    if (!options.dryRun && (!selected || !nativeBinary())) {
      write(selected
        ? "Deep analysis later: MEX's native checker isn't installed. Reinstall MEX, then run `mex learn`."
        : "Deep analysis runs through an agent's command-line tool. Install Claude Code, Codex, Copilot CLI or Gemini CLI, then run `mex learn`.");
      if (!selected) for (const status of agents) {
        if (status.installed && !status.runner.ok) write(`${status.name}: ${status.runner.reason}.`);
      }
      return;
    }
    // A preview without an installed runner uses Codex, which has measured learning runs.
    let agent: LearningPlan["agent"] = selected?.id ?? "codex";
    const head = await revision(root);
    const tree = head && await PinnedTree.open(root, head);
    if (!head || !tree) { write("Deep analysis later: the current Git revision couldn't be read."); return; }
    const forge = new ForgeClient(repo, await hostToken(root, repo));
    const access = await hosts[repo.host].access(forge);
    // GitLab review mining comes in 0.9.1; its repos still learn from local history and contributor docs.
    const issues = reader.setting(projectId, "learning.deep.issues") === "true";
    const cursor = savedCursor(reader, projectId);
    const harvestDeps = { client: repo.host === "github.com" ? harvestClient(forge, access.source) : undefined, tree };
    const scanned = await planHarvest({ checkout: root, head, source: access.source, agent, ...window, issues }, harvestDeps, cursor);
    let harvest = await previewHarvest(scanned, harvestDeps, cursor);
    const census = harvest.census!;
    // Reprice the preview when the user chooses a different runner.
    const inventoryFor = (chosen: LearningPlan["agent"]) => {
      const { total: estimate, ceiling } = estimateCensus(census, chosen);
      return { ...harvest, agent: chosen, estimate, ceiling };
    };
    const pulls = harvest.inventory.bands.reduce((sum, band) => sum + (band.source === "issue" ? 0 : band.count), 0);
    const closedIssues = harvest.inventory.bands.reduce((sum, band) => sum + (band.source === "issue" ? band.count : 0), 0);
    const local = harvest.inventory.local;
    const fixes = local.revert.length + local.cause.length;
    const docs = local.adr.length + local.doc.length;
    const procedures = reader.setting(projectId, "learning.procedures") === "true";
    const hasSources = census.triageBatches > 0 || census.docBatches > 0 || procedures;
    const forecast = () => {
      const extra = procedures ? procedureEstimate(agent) : 0;
      return {
        estimate: hasSources ? Math.max(1, harvest.estimate + extra) : 0,
        ceiling: hasSources ? Math.max(1, harvest.ceiling + quoteCeiling(extra)) : 0,
        gaps: harvest.gaps.map(gap => gap.slice(0, 180)).slice(0, 12),
      };
    };
    let { estimate, ceiling, gaps } = forecast();
    const quote = [censusLine(census), `Estimate ${count(estimate)} tokens · ceiling ${count(ceiling)} tokens.`];
    if (procedures) quote.push("Includes an estimate for up to five cheap procedure calls within the 3% automatic allowance.");
    const sources = [
      `Counted ${counted(pulls, "merged or closed pull request", "merged or closed pull requests")}, ${counted(fixes, "revert or past fix", "reverts and past fixes")}, and ${counted(docs, "doc or decision record", "docs and decision records")}.`,
      ...(issues ? [`Counted ${counted(closedIssues, "closed issue", "closed issues")} for the issues trial.`] : []),
      ...gaps.map(gap => `Source gap: ${gap}`),
    ];
    if (options.dryRun) {
      write(harvest.inventory.bands.length
        ? "Deep analysis dry run. Read review history and local Git history. Spent no tokens."
        : "Deep analysis dry run. Read local Git history. Spent no tokens.");
      if (!selected && hasSources) write("The estimate assumes Codex because no supported model runner is installed.");
      for (const line of [...quote, ...sources]) write(line);
      return;
    }
    if (!hasSources) {
      write("Deep analysis found no sources to learn from here · $0, nothing started.");
      for (const line of [...quote, ...sources]) write(line);
      return;
    }
    const name = basename(root);
    const otherSources = [
      ...(local.revert.length ? [counted(local.revert.length, "reverted fix", "reverted fixes")] : []),
      ...(local.cause.length ? [counted(local.cause.length, "past fix", "past fixes")] : []),
      ...(docs ? [counted(docs, "contributor doc", "contributor docs")] : []),
      ...(closedIssues ? [counted(closedIssues, "closed issue", "closed issues")] : []),
    ];
    const inventory = pulls ? [counted(pulls, "pull request with its reviews and discussions", "pull requests with their reviews and discussions"), ...otherSources] : otherSources;
    const introduction = `MEX can read ${name}'${name.endsWith("s") ? "" : "s"} history and learn the rules your team keeps repeating${pulls ? " in reviews" : ""}${inventory.length ? `: ${new Intl.ListFormat("en").format(inventory)}` : ""}. It runs in the background through your agent, so you can keep working.`;
    const screenWrite = options.screenWrite ?? write;
    const showChoice = !options.agent && !options.confirm;
    if (showChoice) {
      const rich = options.rich;
      const intro = rich ? [...rich.section(DEEP_ANALYSIS.toUpperCase()), ...rich.text([introduction]), ""]
        : [DEEP_ANALYSIS, ...wrap(introduction, screenMode().width, 0), ""];
      for (const line of intro) screenWrite(line);
      const picked = await pickAnalysisAgent(agents, { rich, write: screenWrite, preferred });
      if (!picked) {
        write("Deep analysis not started · `mex learn` starts it any time");
        return;
      }
      selected = picked;
      saveAgent(picked, projectId);
      const chosen = picked.id;
      if (chosen !== agent) {
        agent = chosen;
        harvest = inventoryFor(agent);
        ({ estimate, ceiling, gaps } = forecast());
      }
    }
    const setup = options.modelSetup ?? "mixed";
    plan = Plan.parse({ checkout: root, head, origin: repo, source: access.source, visibility: access.visibility, agent,
      setup, ...window, preferred: preferredFolders(projectId, root), pulls: [], docs: [], sessions: [], refresh: options.weekly !== false,
      gaps, estimate, ceiling, harvest,
      ...(procedures ? { procedures: true } : {}) });
    refreshUsageForQuote();
    const minutes = estimateMinutes(estimate);
    const runner = modelAgent(agent);
    const share = usageShare(reader, runner, estimate);
    const nameOfAgent = agentName(agent);
    const models = selected?.runner.ok ? selected.runner.models : "";
    const notices: string[] = [];
    if (forge.anonymous) notices.push(`Fetching slowly without a ${repo.host === "github.com" ? "GitHub" : "GitLab"} login. Sign in with \`${repo.host === "github.com" ? "gh" : "glab"} auth login\` to speed it up.`);
    if (plan.visibility === "private") notices.push("Review and doc excerpts from this private repo will be sent to your selected agent account. Start only if your organization allows it.");
    const windows = usageWindows(reader).filter(item => item.agent === runner && Date.parse(item.observed_at) <= Date.now()).map(item => ({
      usedPercent: item.used_percent, status: item.status as PlanWindow["status"], resetsAt: item.resets_at,
    }));
    if (planWindow(windows, Date.now()).blocked) notices.push("Your agent's usage window needs to reset before model work can start.");
    const duration = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
    const details = [
      ["What it reads", `${(pulls ? [`${counted(pulls, "pull request", "pull requests")} (reviews, discussions, descriptions)`, ...otherSources] : otherSources).join(", ")} · last 18 months`],
      ["What it found", censusLine(census)],
      ["Agent", `${nameOfAgent} · ${models}`],
      ["Time", `about ${duration} (estimated) · in the background`],
      ["Usage", `about ${count(estimate)} tokens of your plan (estimated) · it pauses before a call that may exceed the ${count(ceiling)} token ceiling${share ? ` · ${share}` : ""}`],
      ["Rules", "each is checked against the code, then goes live in your sessions as a trial · ones agents keep ignoring are dropped · nothing is shared"],
      ["Afterwards", plan.refresh
        ? "looks for new reviews every 7–14 days when idle, within 3% of your plan · `mex learn --no-weekly` for this run only"
        : "weekly refresh is off for this run"],
      ["Stop it", "`mex cancel` at any time"],
      ...gaps.map(gap => ["Source gap", gap] as const),
    ] as const;
    const confirmed = await (options.confirm
      ? options.confirm([introduction, ...notices], details.map(([label, value]) => `${label}: ${value}`))
      : confirmAnalysis({ rich: options.rich, write: screenWrite, introduction: showChoice ? undefined : introduction,
        agent: showChoice ? undefined : nameOfAgent, showTitle: !showChoice, notices, details }));
    if (!confirmed) {
      write("Deep analysis not started · `mex learn` starts it any time");
      return;
    }
  } catch (error) {
    write(`Deep analysis later: ${error instanceof SourceError ? error.message : "the quote could not be prepared."} Run \`${LEARN_COMMAND}\` to try again.`);
    return;
  } finally { reader.close(); }

  await import("./job.js");
  const writer = openRecord();
  try {
    const current = writer.checkout(root);
    if (current?.path !== root || current.project_id !== projectId || !checkoutOn(current) || !automaticWorkEnabled(writer, projectId)) {
      write("Deep analysis later: MEX is off here or the checkout registration changed."); return;
    }
    const queued = queueJob(writer, { kind: LEARN_KIND, projectId, params: plan, tokensEstimate: plan.estimate });
    const started = ensureBackground({ home: writer.location.home });
    write(queued.existing ? "Deep analysis is already queued or running. See `mex jobs`."
      : `Deep analysis: ${!started.started && started.reason === "disabled" ? "queued · run `mex jobs run` to continue" : `started with ${agentName(plan.agent)} · in the background`}`);
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
  const harvestCeiling = plan.harvest?.ceiling;
  // Recover the original estimate from the saved floor(1.5 × estimate) so
  // repeated raises still add the original allowance, including procedures.
  const increment = typeof harvestCeiling === "number" && Number.isSafeInteger(harvestCeiling) && harvestCeiling >= 0
    ? quoteCeiling(Math.ceil(harvestCeiling / 1.5) + (plan.procedures ? procedureEstimate(plan.agent) : 0))
    : quoteCeiling(plan.estimate);
  const ceiling = Math.max(spent, plan.ceiling) + increment;
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

export async function runLearnCommand(options: { raiseCeiling?: boolean; modelSetup?: string; dryRun?: boolean; sessions?: boolean; weekly?: boolean; agent?: string }): Promise<void> {
  const project = knowledgeProject({ projectPath: process.cwd() });
  const interactive = !options.dryRun && detectCaller() === "person";
  if (options.modelSetup !== undefined && !["mixed", "best-only"].includes(options.modelSetup)) throw new Error("Use --model-setup mixed or --model-setup best-only.");
  const reader = openRecordReadOnly();
  try {
    if (!reader?.get("SELECT 1 FROM checkouts WHERE path=? AND project_id=?", project.root, project.projectId)) throw new Error("Run `mex` here to register this repo first.");
  } finally { reader?.close(); }
  if (options.raiseCeiling) {
    if (options.dryRun || options.sessions !== undefined || options.weekly === false || options.agent) throw new Error("Use --raise-ceiling by itself to resume the existing quote.");
    if (!interactive) { console.log("Run `mex learn --raise-ceiling` in a terminal to review and approve a new limit."); return; }
    await raiseCeiling(project.root, project.projectId, console.log);
  } else {
    if (options.agent !== undefined) {
      if (options.dryRun) throw new Error("Set the agent without --dry-run, or use the existing setting for a preview.");
      const name = setAnalysisAgent(options.agent, project.root);
      if (!interactive) console.log(`Deep analysis agent set to ${name} for this repo.`);
    }
    const mode = screenMode();
    const rich = interactive && !mode.plain && !mode.ascii && (mode.width ?? 100) >= RICH_MIN_COLUMNS ? new Rich(process.env, Math.min(mode.width ?? 100, 100)) : undefined;
    await offerLearning({ root: project.root, projectId: project.projectId, write: console.log, interactive, rich, agent: options.agent,
      modelSetup: options.modelSetup as ModelSetup | undefined, explicit: true, dryRun: options.dryRun, sessions: options.sessions, weekly: options.weekly });
  }
}
