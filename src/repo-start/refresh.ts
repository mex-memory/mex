/**
 * Keeping setup's free reads current. The hook asks at session start (at most
 * once per checkout every 30 minutes) by writing one small request under
 * `<record directory>/refresh-pending/`. Node turns it into a `setup-refresh`
 * job that re-reads what bare `mex` reads: package files (commands), rule
 * files, and the agents' own memory (hints). Removals were already caught by
 * each entry's checks; this is what brings additions in, with no model and no
 * repository command. Rule files rebuild between sessions, so new commands
 * and rules reach the agents from the next session.
 */
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { queueJob } from "../record/background.js";
import { registerJobKind } from "../record/jobs.js";
import type { RecordWriter } from "../record/index.js";
import { readBoundedTextFile } from "../knowledge/files.js";
import { shortHash } from "../record/project.js";

export const REFRESH_PENDING_DIRECTORY = "refresh-pending";
export const REFRESH_STAMP_DIRECTORY = "refresh-stamps";
const Request = z.object({
  version: z.literal(1),
  project_id: z.string().regex(/^[gf]-[a-f0-9]{24}$/u),
  checkout: z.string().max(4096).refine(isAbsolute),
}).strict();

export interface RefreshParams { checkout: string; }

/** Whether a request is waiting (one stat; the background loop checks it often). */
export function setupRefreshPending(recordDirectory: string): boolean {
  try { return readdirSync(join(recordDirectory, REFRESH_PENDING_DIRECTORY)).some(name => name.endsWith(".json")); }
  catch { return false; }
}

/** The hook asks again only after this file is 30 minutes old. */
function stamp(recordDirectory: string, checkout: string): void {
  try {
    const directory = join(recordDirectory, REFRESH_STAMP_DIRECTORY), file = join(directory, shortHash(checkout));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (existsSync(file)) { const now = new Date(); utimesSync(file, now, now); } else writeFileSync(file, "", { mode: 0o600 });
  } catch { /* without a stamp the hook asks again; the job is cheap and idempotent */ }
}

/** Queue a refresh for every waiting request, then remove the emptied folder. */
export function queuePendingSetupRefresh(writer: RecordWriter): number {
  const directory = join(writer.location.directory, REFRESH_PENDING_DIRECTORY);
  try { if (!lstatSync(directory).isDirectory()) return 0; } catch { return 0; }
  let names: string[] = [];
  try { names = readdirSync(directory).filter(name => name.endsWith(".json")); } catch { return 0; }
  let queued = 0;
  for (const name of names.slice(0, 256)) {
    const file = join(directory, name);
    const text = readBoundedTextFile(file, 16 << 10);
    try { unlinkSync(file); } catch { continue; }
    if (text === undefined) continue;
    let request: z.infer<typeof Request>;
    try { request = Request.parse(JSON.parse(text)); } catch { continue; }
    stamp(writer.location.directory, request.checkout);
    try { queueJob(writer, { kind: "setup-refresh", projectId: request.project_id, params: { checkout: request.checkout } }); queued++; } catch { /* a later start asks again */ }
  }
  // An empty folder would wake the background process at every session start.
  try { rmdirSync(directory); } catch { /* a request arrived meanwhile */ }
  return queued;
}

/**
 * Re-read package files, rule files and agent memory, as bare `mex` does. The
 * rule files rebuild between sessions, and only when a read changed something.
 */
export async function refreshSetup(checkout: string, projectId: string, env: NodeJS.ProcessEnv = process.env): Promise<{ commands: number; ruleFiles: boolean; hints: number; rebuilt: boolean }> {
  const { readRecipes, readRules } = await import("./command.js");
  const { readRuleFiles } = await import("../knowledge/rule-cache.js");
  const recipes = await readRecipes(checkout, projectId, env);
  let commands = 0;
  if (recipes) {
    const { saveSetupRecipes } = await import("./recipe-entries.js");
    try { commands = saveSetupRecipes(recipes, { projectPath: checkout, env }).saved; } catch { /* the next refresh retries */ }
  }
  const signature = (cache?: { files: ReadonlyArray<{ path: string; hash: string }> }) => (cache?.files ?? []).map(file => `${file.path}:${file.hash}`).sort().join("\n");
  let before = "";
  try { before = signature(readRuleFiles({ projectPath: checkout })); } catch { /* no earlier scan */ }
  await readRules(checkout);
  let ruleFiles = false;
  try { ruleFiles = signature(readRuleFiles({ projectPath: checkout })) !== before; } catch { ruleFiles = true; }
  let hints = 0;
  try {
    const { refreshHints } = await import("../knowledge/hints.js");
    const refreshed = refreshHints({ projectPath: checkout });
    hints = (refreshed.imported ?? 0) + (refreshed.expired ?? 0);
  } catch { /* the next refresh retries */ }
  const rebuilt = commands > 0 || ruleFiles || hints > 0;
  if (rebuilt) {
    try {
      const { queueNativeRebuild } = await import("../knowledge/native-queue.js");
      queueNativeRebuild(checkout);
    } catch { /* the next refresh or mex run rebuilds them */ }
  }
  return { commands, ruleFiles, hints, rebuilt };
}

/** Bare `mex` just did these reads: a session starting now need not ask again. */
export function stampSetupRefresh(recordDirectory: string, checkout: string): void { stamp(recordDirectory, checkout); }

registerJobKind<RefreshParams, Record<string, never>>({
  name: "setup-refresh",
  label: "Repo refresh",
  scope: "project",
  // Each read compares with what is stored and writes only differences.
  sideEffects: "idempotent",
  async runBatch({ params, writer, job }) {
    const { automaticWorkEnabled } = await import("../controls/index.js");
    if (!job.project_id || !existsSync(params.checkout) || !automaticWorkEnabled(writer, job.project_id)) return { checkpoint: {}, done: true, results: 0, summary: "Nothing to refresh" };
    // Only what setup read is refreshed: a checkout bare mex never ran in has nothing to refresh.
    const { readFactFile } = await import("./facts.js");
    if (!readFactFile(writer.location, job.project_id, "setup.json")) return { checkpoint: {}, done: true, results: 0, summary: "Setup hasn't run here; nothing to refresh" };
    const done = await refreshSetup(params.checkout, job.project_id);
    return { checkpoint: {}, done: true, results: done.commands, summary: done.rebuilt ? `${done.commands} commands, ${done.ruleFiles ? "rule files" : "no rule-file"} changes, ${done.hints} hints changed` : "Nothing new since the last read" };
  },
});
