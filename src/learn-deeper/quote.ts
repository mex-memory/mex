import { isCliAvailable } from "../cli-tools.js";
import { nativeBinary } from "../knowledge/check.js";
import { tokenCount } from "../model-runner/consent.js";
import { planWindow, type PlanWindow } from "../model-runner/budget-policy.js";
import type { ModelAgent, ModelSetup } from "../model-runner/index.js";
import { openHooksReadOnly, openRecord, type RecordReader } from "../record/index.js";
import type { LocationOptions } from "../record/location.js";
import { ownUsageStatus, ownUsageTotals, refreshOwnUsage, usageWindows } from "../record/own-usage.js";
import { QUOTE_TOKENS_PER_MINUTE } from "../repo-start/steps.js";
import { ForgeClient, hostToken } from "./forge.js";
import { origin, PinnedTree, repoPath, revision } from "./git.js";
import { hosts } from "./hosts.js";
import { BACKFILL_PULLS_PER_BATCH, MAX_DOCS, MAX_PULLS, orderBackfillPulls, Plan, quoteCeiling, quoteTokens,
  reviewWindow, type LearningPlan } from "./plan.js";
import { previewImport } from "./session-import.js";
import type { Repository } from "./source.js";

interface LearningQuoteOptions {
  root: string;
  projectId: string;
  location?: LocationOptions;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  modelSetup?: ModelSetup;
  sessions?: boolean;
  weekly?: boolean;
  refreshUsage?: boolean;
}

export type LearningQuote =
  | { state: "no-review-remote" }
  | { state: "unavailable"; reason: string; importGaps?: string[] }
  | { state: "offered"; plan: LearningPlan; minutes: number; share: string; anonymous: boolean; usageBlocked: boolean; importGaps: string[] };

/** The agent used most in the last 7 days, in this project first and then anywhere on this machine. */
export function chooseAgent(project: string, location?: LocationOptions, now = Date.now()): ModelAgent | undefined {
  const hooks = openHooksReadOnly(location);
  let used: ModelAgent[] = [];
  try {
    const since = new Date(now - 7 * 86_400_000).toISOString();
    const ranked = (where: string, ...args: string[]) => hooks?.all<{ agent: string }>(`SELECT agent FROM sessions WHERE ${where}last_seen_at>=?
      AND agent IN ('claude-code','codex') GROUP BY agent ORDER BY count(*) DESC,max(last_seen_at) DESC`, ...args, since)
      .map(row => row.agent === "claude-code" ? "claude" : "codex") ?? [];
    used = [...ranked("project_id=? AND ", project), ...ranked("")];
  } catch { /* an unavailable history cannot choose the runner */ }
  finally { hooks?.close(); }
  return [...new Set<ModelAgent>([...used, "claude", "codex"])].find(agent => isCliAvailable(agent));
}

function preferredFolders(project: string, checkout: string, location?: LocationOptions): string[] {
  const hooks = openHooksReadOnly(location);
  try {
    const touched = hooks?.all<{ path: string }>(`SELECT path FROM epoch_files WHERE project_id=? AND checkout=?
      GROUP BY path ORDER BY count(*) DESC,path LIMIT 24`, project, checkout) ?? [];
    const folders = touched.map(row => row.path.split("/").slice(0, -1).slice(0, 2).join("/")).filter(repoPath);
    return [...new Set(folders)].slice(0, 12);
  } catch { return []; }
  finally { hooks?.close(); }
}

function usageShare(reader: RecordReader, agent: ModelAgent, estimate: number, now: number): string {
  const today = new Date(now), start = new Date(today.getTime() - 6 * 86_400_000);
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

/** The terminal and Hub quote the same pinned plan. Only inventory and local reads are needed. */
export async function prepareLearningQuote(
  reader: RecordReader, options: LearningQuoteOptions, knownOrigin?: Repository, window = reviewWindow(new Date((options.now ?? Date.now)())),
): Promise<LearningQuote> {
  const { root, projectId, location, env } = options;
  const clock = options.now ?? Date.now;
  const repo = knownOrigin ?? await origin(root);
  if (!repo) return { state: "no-review-remote" };
  const agent = chooseAgent(projectId, location, clock());
  if (!agent) return { state: "unavailable", reason: "Claude Code or Codex is needed on PATH. Then run `mex learn`." };
  if (!nativeBinary(env)) return { state: "unavailable", reason: "MEX's native checker isn't installed, so learned rules can't be checked. Reinstall MEX, then run `mex learn`." };
  const head = await revision(root);
  const tree = head && await PinnedTree.open(root, head);
  if (!head || !tree) return { state: "unavailable", reason: "The current Git revision couldn't be read." };
  const { files: sessions, gaps: importGaps } = options.sessions === true
    ? previewImport({ checkout: root, project: projectId, window, store: reader }) : { files: [], gaps: [] };
  const client = new ForgeClient(repo, await hostToken(root, repo, env));
  const inventory = await hosts[repo.host].inventory(client, window, MAX_PULLS);
  const preferred = preferredFolders(projectId, root, location);
  const near = (path: string) => preferred.some(folder => path.startsWith(folder + "/"));
  const docs = tree.docs().sort((a, b) => Number(near(b)) - Number(near(a)));
  if (!inventory.pulls.length && !docs.length && !sessions.length) {
    return { state: "unavailable", reason: "Learn deeper found no recent merged changes, docs or eligible sessions in its source window.", importGaps };
  }
  const gaps = [...importGaps];
  if (inventory.more) gaps.push("Some merged changes were outside the source scan limit.");
  if (docs.length > MAX_DOCS) gaps.push("Some docs were outside the source scan limit.");
  const setup = options.modelSetup ?? "best-only";
  const estimate = quoteTokens(inventory.pulls.length, Math.min(docs.length, MAX_DOCS), agent, setup, sessions, BACKFILL_PULLS_PER_BATCH);
  const plan = Plan.parse({ checkout: root, head, origin: repo, source: inventory.source, visibility: inventory.visibility, agent,
    setup, ...window, preferred, pulls: orderBackfillPulls(inventory.pulls), pullsPerBatch: BACKFILL_PULLS_PER_BATCH,
    docs: docs.slice(0, MAX_DOCS), sessions, refresh: options.weekly !== false, gaps, estimate, ceiling: quoteCeiling(estimate) });
  if (options.refreshUsage) refreshUsageForQuote();
  const minutes = Math.max(1, Math.ceil(estimate / QUOTE_TOKENS_PER_MINUTE));
  const at = clock();
  const share = usageShare(reader, agent, estimate, at);
  const windows = usageWindows(reader).filter(item => item.agent === agent && Date.parse(item.observed_at) <= at).map(item => ({
    usedPercent: item.used_percent, status: item.status as PlanWindow["status"], resetsAt: item.resets_at,
  }));
  return { state: "offered", plan, minutes, share, anonymous: inventory.anonymous, usageBlocked: planWindow(windows, at).blocked, importGaps };
}
