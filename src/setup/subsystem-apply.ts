/**
 * In-process application of the batch files per-subsystem setup sessions write.
 *
 * MEX applies each batch exactly as `mex wiki apply <file> --apply --json` would
 * (same command function: parsing, the Inbox Spec boundary, one atomic batch,
 * replay per opId). Each apply proves the batch's linked sources, configuration
 * and graph identity, and also binds Git HEAD for setup. The database is closed
 * after each apply. Applies are serialized: two batches never apply at once.
 *
 * Before applying, MEX checks the batch stays in its lane: create-entry
 * operations only, every opId under the unit's prefix (so one unit can never
 * replay another's), and every target file one the unit may write.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findConfig } from "../config.js";

/** One problem with a batch, in the form the fix prompt and the state file use. */
export interface BatchProblem {
  readonly code: string;
  readonly message: string;
}

export type BatchApplyOutcome =
  | { readonly kind: "applied"; readonly facts: number; readonly operations: number; readonly replayed: boolean; readonly warnings: readonly BatchProblem[] }
  | { readonly kind: "refused"; readonly problems: readonly BatchProblem[] }
  | { readonly kind: "missing" };

export interface BatchScope {
  /** Every opId must start with this. */
  readonly opIdPrefix: string;
  /** The Wiki files (relative to `.mex/`) the batch may write into. */
  readonly files: readonly string[];
}

export interface SetupBatchApplier {
  apply(batchFile: string, scope: BatchScope): Promise<BatchApplyOutcome>;
  /** End of the phase. `changed` is true when the graph or HEAD changed mid-phase. */
  close(): Promise<{ readonly changed: boolean }>;
}

const MAX_PROBLEMS = 200;

function problem(code: string, message: string): BatchProblem {
  return { code, message: message.slice(0, 2_000) };
}

/** Read and scope-check a batch file before the Wiki engine sees it. */
export function checkBatchFile(path: string, scope: BatchScope): { ok: true; envelopes: unknown[] } | { ok: false; problems: BatchProblem[] } | { ok: "missing" } {
  if (!existsSync(path)) return { ok: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [problem("MALFORMED_OPERATION", `The batch file is not valid JSON: ${reason}. Write one JSON array of operation envelopes.`)] };
  }
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const problems: BatchProblem[] = [];
  const allowed = new Set(scope.files);
  for (const [index, envelope] of envelopes.entries()) {
    const raw = typeof envelope === "object" && envelope !== null ? envelope as Record<string, unknown> : null;
    const opId = typeof raw?.["opId"] === "string" ? raw["opId"] : null;
    const label = `Operation ${index}${opId === null ? "" : ` (${opId})`}`;
    if (raw === null) {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: is not an operation envelope object.`));
      continue;
    }
    if (raw["type"] !== "create-entry") {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: setup batches hold create-entry operations only; found "${String(raw["type"])}".`));
    }
    if (opId === null || !opId.startsWith(scope.opIdPrefix) || opId.length === scope.opIdPrefix.length) {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: every opId must start with "${scope.opIdPrefix}" and be unique.`));
    }
    const payload = typeof raw["payload"] === "object" && raw["payload"] !== null ? raw["payload"] as Record<string, unknown> : null;
    const file = typeof payload?.["file"] === "string" ? payload["file"].replace(/\\/gu, "/").replace(/^\.mex\//u, "") : null;
    if (file === null || !allowed.has(file)) {
      problems.push(problem("SETUP_BATCH_SCOPE", `${label}: "file" must be ${[...allowed].map((entry) => `"${entry}"`).join(" or ")}; found ${file === null ? "none" : `"${file}"`}.`));
    }
    if (problems.length >= MAX_PROBLEMS) break;
  }
  const ids = envelopes.map((envelope) => (envelope as Record<string, unknown> | null)?.["opId"]).filter((id) => typeof id === "string");
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) problems.push(problem("SETUP_BATCH_SCOPE", `opId "${String(duplicate)}" is used twice; every opId must be unique.`));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, envelopes };
}

function factCount(envelopes: readonly unknown[], statuses: readonly { index: number; status: string }[]): number {
  const written = new Set(statuses.filter((entry) => ["applied", "replayed", "resumed"].includes(entry.status)).map((entry) => entry.index));
  return envelopes.filter((envelope, index) => written.has(index)
    && ((envelope as { payload?: { type?: unknown } } | null)?.payload?.type === "fact")).length;
}

/**
 * Create the applier for one population phase. Every batch gets a fresh scoped
 * proof; each apply opens and closes its own read of the database.
 */
export function createSetupBatchApplier(projectRoot: string, options: {
  readonly freshness?: import("./setup-graph-freshness.js").SetupGraphFreshness;
} = {}): SetupBatchApplier {
  const root = resolve(projectRoot);
  let queue: Promise<unknown> = Promise.resolve();
  let freshness = options.freshness;
  let port: import("../graph/application-adapter.js").RepositoryGraphPort | undefined;

  const graphPort = async () => {
    if (port !== undefined) return port;
    const { createSetupGraphFreshness } = await import("./setup-graph-freshness.js");
    freshness ??= createSetupGraphFreshness(root);
    const { createRepositoryGraphPort } = await import("../graph/application-adapter.js");
    port = createRepositoryGraphPort(root, { loadFreshSession: freshness.loadFresh });
    return port;
  };

  const applyNow = async (batchFile: string, scope: BatchScope): Promise<BatchApplyOutcome> => {
    const path = resolve(root, batchFile);
    const checked = checkBatchFile(path, scope);
    if (checked.ok === "missing") return { kind: "missing" };
    if (checked.ok === false) return { kind: "refused", problems: checked.problems };
    if (checked.envelopes.length === 0) return { kind: "applied", facts: 0, operations: 0, replayed: false, warnings: [] };
    const bridge = await graphPort();
    const config = findConfig(root);
    const lines: string[] = [];
    const { runApply } = await import("../wiki/cli/commands.js");
    await runApply({
      write: (line) => { lines.push(line); },
      setExitCode: () => undefined,
      scaffoldRoot: config.scaffoldRoot,
      projectRoot: config.projectRoot,
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
      enforceInboxSpecBoundary: true,
      groundingBridge: bridge,
    }, path, { apply: true, json: true });
    let envelope: {
      ok?: boolean;
      data?: { applied?: boolean; replayed?: boolean; operations?: Array<{ index: number; status: string }> };
      diagnostics?: Array<{ code?: string; severity?: string; message?: string }>;
    };
    try {
      envelope = JSON.parse(lines.join("\n"));
    } catch {
      return { kind: "refused", problems: [problem("SETUP_APPLY_OUTPUT", "MEX could not read the result of applying this batch.")] };
    }
    const diagnostics = (envelope.diagnostics ?? []).map((entry) => ({
      severity: entry.severity ?? "error",
      problem: problem(entry.code ?? "UNKNOWN", entry.message ?? ""),
    }));
    const operations = Array.isArray(envelope.data?.operations) ? envelope.data!.operations! : [];
    if (envelope.ok === true && (envelope.data?.applied === true || envelope.data?.replayed === true)) {
      return {
        kind: "applied",
        facts: factCount(checked.envelopes, operations),
        operations: checked.envelopes.length,
        replayed: envelope.data?.applied !== true,
        warnings: diagnostics.filter((entry) => entry.severity === "warning").map((entry) => entry.problem),
      };
    }
    const errors = diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.problem);
    return {
      kind: "refused",
      problems: errors.length > 0 ? errors.slice(0, MAX_PROBLEMS)
        : [problem("SETUP_APPLY_REFUSED", "The batch was not written, and the Wiki engine gave no reason.")],
    };
  };

  return {
    apply(batchFile, scope) {
      const result = queue.then(() => applyNow(batchFile, scope));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      await queue.catch(() => undefined);
      return { changed: freshness?.changed ?? false };
    },
  };
}
