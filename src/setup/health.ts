import { resolve } from "node:path";
import { inventoryScaffold } from "../wiki/migration/inventory.js";
import { inspectSetupStatus } from "./headless.js";
import { describeUnfinishedSetup } from "./unfinished.js";

/**
 * What a rerun of `mex setup` still owes this checkout (#284).
 *
 * Setup is status-first: a rerun on a healthy checkout reports that it is set
 * up and does no work, a checkout missing only its commit goes straight to
 * the commit step, and anything else names what is missing before the
 * (already incremental) flow runs. Changed code is drift, not a setup
 * failure: it is reported with a pointer to `mex sync`.
 */
export interface SetupHealth {
  readonly mode: "code-repo" | "agent-memory";
  /** Nothing for setup to do. Drift may still be reported in `notes`. */
  readonly healthy: boolean;
  /** Everything is prepared; only the reviewed setup commit is missing. */
  readonly needsCommitOnly: boolean;
  /** What setup still has to do, one line each; empty when healthy. */
  readonly missing: readonly string[];
  /** "MEX is already set up here (N entities, M facts, graph current)." when healthy. */
  readonly summary: string;
  /** Drift and other non-blocking observations, each naming its next command. */
  readonly notes: readonly string[];
}

export async function assessSetupHealth(projectRoot: string): Promise<SetupHealth> {
  const root = resolve(projectRoot);
  const status = inspectSetupStatus(root);
  const missing: string[] = [];
  const notes: string[] = [];
  if (!status.hasScaffold) missing.push("The .mex/ scaffold has not been created.");
  else if (!status.populated) missing.push("Scaffold population is not finished.");
  const unfinished = describeUnfinishedSetup(root);
  if (unfinished !== null) missing.push(`MEX setup ${unfinished.done}/${unfinished.total}, not finished.`);

  // An agent-memory workspace has no code graph to describe.
  let graph: string | null = null;
  let committed = true;
  if (status.mode === "code-repo") {
    const observed = await observeGraph(root);
    graph = observed.label;
    if (observed.missing) missing.push(observed.missing);
    if (observed.note) notes.push(observed.note);
    const wiki = await observeWiki(root);
    if (wiki.missing) missing.push(wiki.missing);
    if (wiki.note) notes.push(wiki.note);
    const { hasCommittedHubIdentity } = await import("../hub/setup/readiness.js");
    committed = await hasCommittedHubIdentity(root);
  }

  // A finished but thin setup keeps saying what it lacks on every status rerun (#283).
  if (status.hasScaffold && status.populated && (status.mode === "code-repo" || status.mode === "agent-memory")) {
    const { populationWarning } = await import("./population-audit.js");
    const thin = await populationWarning(root, resolve(root, ".mex"), status.mode);
    if (thin) notes.push(thin);
  }
  const counts = countKnowledge(resolve(root, ".mex"));
  if (counts?.unfinishedFiles.length) missing.push(`Setup finalization still needs to fill placeholders in ${counts.unfinishedFiles.map(file => `.mex/${file}`).join(", ")}.`);
  const needsCommitOnly = status.mode === "code-repo" && missing.length === 0 && !committed;
  if (needsCommitOnly) missing.push("The setup has not been committed yet.");
  const healthy = missing.length === 0;
  const described = [
    ...(counts ? [
      `${counts.entities} ${counts.entities === 1 ? "entity" : "entities"}`,
      `${counts.facts} ${counts.facts === 1 ? "fact" : "facts"}`,
    ] : []),
    ...(graph ? [graph] : []),
  ].join(", ");
  return {
    mode: status.mode,
    healthy,
    needsCommitOnly,
    missing,
    summary: healthy ? `MEX is already set up here${described ? ` (${described})` : ""}.` : "",
    notes,
  };
}

/** One rerun-report block for the terminal; the Hub renders the same fields. */
export function describeSetupHealth(health: SetupHealth): string {
  return [
    health.summary,
    ...health.notes,
    "Nothing to do. Check memory health with `mex check`, repair knowledge drift with `mex sync`, or open the Hub with `mex hub`.",
    "Run `mex setup --force` to run the full setup again; authored files are always preserved.",
  ].filter(Boolean).join("\n");
}

async function observeGraph(root: string): Promise<{ label: string; missing?: string; note?: string }> {
  try {
    const { inspectGraphStatus } = await import("../graph/status.js");
    const graph = await inspectGraphStatus({ projectRoot: root });
    if (graph.status === "fresh") return { label: "graph current" };
    if (graph.status === "stale") {
      const changed = graph.changes.total;
      return {
        label: "graph behind the code",
        note: `${changed} source ${changed === 1 ? "file has" : "files have"} changed since the graph was built. Run \`mex sync\` to review knowledge the change may affect.`,
      };
    }
    if (graph.status === "degraded") {
      return { label: "graph partly indexed", note: "Some sources did not parse completely; `mex graph status` names them." };
    }
    return { label: "graph unavailable", missing: graph.status === "missing" ? "The code graph has not been built." : "The code graph needs a rebuild." };
  } catch {
    return { label: "graph unavailable", missing: "The code graph could not be inspected and needs a rebuild." };
  }
}

async function observeWiki(root: string): Promise<{ missing?: string; note?: string }> {
  try {
    const { findConfig } = await import("../config.js");
    const { createRepositoryWikiPort } = await import("../wiki/application-adapter.js");
    const config = findConfig(root);
    const wiki = createRepositoryWikiPort(root, {
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
    });
    const { state } = await wiki.inspectIndex();
    if (state === "fresh" || state === "degraded") return {};
    if (state === "stale") return { note: "The Wiki index is behind the knowledge files. Run `mex wiki rebuild-index` to update it." };
    if (state === "migration_required") return { missing: "The knowledge files need the Wiki migration." };
    return { missing: state === "missing" ? "The Wiki index has not been built." : "The Wiki index needs a rebuild." };
  } catch {
    return { missing: "The Wiki index could not be inspected and needs a rebuild." };
  }
}

function countKnowledge(mexDir: string): { entities: number; facts: number; unfinishedFiles: string[] } | null {
  try {
    const files = inventoryScaffold({ scaffoldRoot: mexDir }).files;
    const entities = files.flatMap((file) => file.parsed.entities.map((parsed) => parsed.entity));
    const required = new Set(["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md"]);
    const unfinishedFiles = files.filter(file => required.has(file.path) && /\[YYYY-MM-DD\]|\[Project Name\]/u.test(file.text)).map(file => file.path);
    return { entities: entities.length, facts: entities.filter((entity) => entity.type === "fact").length, unfinishedFiles };
  } catch {
    return null;
  }
}
