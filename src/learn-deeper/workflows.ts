import { z } from "zod";
import { openRecordReadOnly, type RecordWriter } from "../record/index.js";
import { origin, type PinnedTree } from "./git.js";
import { object, rows, type ForgeClient } from "./forge.js";
import type { Repository } from "./source.js";

const KEY = "learning.deep.github-workflows";
const WORKFLOW = /^\.github\/workflows\/[\w.-]+\.ya?ml$/u;
const Status = z.object({ slug: z.string().max(220), observed: z.number(), disabled: z.array(z.string().regex(WORKFLOW)).max(64) }).strict();
export type WorkflowStatus = z.infer<typeof Status>;

export async function readGitHubWorkflows(client: ForgeClient, tree: PinnedTree, repo: Repository, now: number): Promise<WorkflowStatus | undefined> {
  if (repo.host !== "github.com" || !tree.hasWorkflows()) return undefined;
  const page = await client.get(`/repos/${repo.slug}/actions/workflows?per_page=64`, true);
  if (!page) return undefined;
  const workflows = rows(object(page.value)?.workflows);
  const disabled = workflows.filter(workflow => typeof workflow.state === "string" && workflow.state.startsWith("disabled_")
    && typeof workflow.path === "string" && WORKFLOW.test(workflow.path) && tree.has(workflow.path)).map(workflow => workflow.path as string);
  return Status.parse({ slug: repo.slug, observed: now, disabled });
}

export function saveGitHubWorkflows(writer: RecordWriter, project: string, status: WorkflowStatus): void {
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(project, KEY, JSON.stringify(status));
}

/** The free setup path reads only a recent, origin-bound observation. */
export async function disabledWorkflows(root: string, project: string, now = Date.now()): Promise<ReadonlySet<string> | undefined> {
  const reader = openRecordReadOnly();
  try {
    const raw = reader?.setting(project, KEY);
    if (!raw || raw.length > 16 << 10) return undefined;
    const parsed = Status.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.observed > now || now - parsed.data.observed > 7 * 86_400_000) return undefined;
    const repo = await origin(root);
    if (repo?.host === "github.com" && repo.slug === parsed.data.slug) return new Set(parsed.data.disabled);
    return undefined;
  } catch { return undefined; }
  finally { reader?.close(); }
}
