/**
 * The whole producer path, for tests: a proposal goes through the producer
 * gate into the personal store, the native evaluator stores its verdict, and
 * the Go delivery side loads the entry from its snapshot and says what it
 * would send. The joined fixture test reuses this.
 */
import { spawnSync } from "node:child_process";
import { runNative } from "../check.js";
import { knowledgeProject } from "../context.js";
import { propose, type GateResult, type Proposal } from "../gate.js";

export interface ProducerPathOptions { projectPath: string; home: string; binary: string; }
export interface Delivered { id: string; verdict: string; form: string; text?: string; }
export interface ProducerPath { results: GateResult[]; verdicts: Map<string, string>; delivered: Delivered[]; }

function nativeRequest({ projectPath, home }: ProducerPathOptions) {
  const project = knowledgeProject({ projectPath, home });
  return { checkout: project.root, project_id: project.projectId, mex_home: project.location.home, record_directory: project.location.directory };
}

/** Store verdicts for every entry and ask delivery what it would send for these ids. */
export function deliver(ids: string[], options: ProducerPathOptions): Pick<ProducerPath, "verdicts" | "delivered"> {
  const request = nativeRequest(options);
  const report = runNative(options.binary, { action: "evaluate", ...request, store: true });
  const verdicts = new Map((report.items ?? []).filter(item => item.level === "personal").map(item => [item.id, item.verdict as string]));
  const probe = spawnSync(options.binary, ["--delivery-probe"], { input: JSON.stringify({ ...request, entries: ids }), encoding: "utf8",
    windowsHide: true, timeout: 60_000, env: { ...process.env, MEX_BACKGROUND: "1" } });
  const answer = JSON.parse(probe.stdout.trim().split("\n").at(-1) ?? "{}") as { ok?: boolean; error?: string; results?: Delivered[] };
  if (!answer.ok) throw new Error(`delivery probe failed: ${answer.error ?? probe.stderr}`);
  return { verdicts, delivered: answer.results ?? [] };
}

export async function throughProducerPath(proposals: Proposal[], options: ProducerPathOptions): Promise<ProducerPath> {
  const results = await propose(proposals, { projectPath: options.projectPath, home: options.home, env: { ...process.env, MEX_HOOK_BINARY: options.binary } });
  const ids = results.flatMap(result => result.status === "accepted" ? [result.entryId] : []);
  return { results, ...deliver(ids, options) };
}
