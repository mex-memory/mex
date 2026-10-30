/**
 * Setup binds each ordinary scoped freshness proof to the graph file and HEAD
 * for the population phase. Every apply proves its linked source bytes again;
 * no source verdict is reused across batches. Only the persisted-structure audit
 * is reused while its exact database identity holds. Nothing stays open between
 * batches; configuration and linked sources are proved every time.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadFreshGraphReadSession } from "../graph/read-session.js";
import { inspectGraphStatusWithFreshObservation, type InternalGraphFreshObservationToken } from "../graph/status.js";

export interface SetupGraphFreshness {
  readonly loadFresh: typeof loadFreshGraphReadSession;
  /** Whether the graph or HEAD changed during this population phase. */
  readonly changed: boolean;
}

/** The graph file as the reader binds it, and Git HEAD. */
export function graphIdentity(projectRoot: string, dbPath = resolve(projectRoot, ".mex", "graph.db")): string | null {
  let file: string;
  try {
    const stats = statSync(dbPath);
    file = JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]);
  } catch {
    return null;
  }
  let head = "none";
  try {
    head = execFileSync("git", ["rev-parse", "--verify", "-q", "HEAD"], {
      cwd: projectRoot, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim() || "none";
  } catch { /* an unborn branch has no HEAD; that is an identity too */ }
  return `${file}|${head}`;
}

export function createSetupGraphFreshness(projectRoot: string, dependencies: {
  readonly loadFull?: typeof loadFreshGraphReadSession;
} = {}): SetupGraphFreshness {
  const root = resolve(projectRoot);
  const load = dependencies.loadFull ?? loadFreshGraphReadSession;
  let previous: string | null | undefined;
  let audited: Pick<InternalGraphFreshObservationToken, "canonicalDbPath" | "databaseIdentity"> | null = null;
  let changed = false;
  const loadFresh: typeof loadFreshGraphReadSession = async (projectRootArg, options = {}) => {
    const dbPath = options.dbPath ?? resolve(projectRootArg, ".mex", "graph.db");
    const identity = graphIdentity(root, dbPath);
    if (previous !== undefined && identity !== previous) {
      changed = true;
      audited = null;
    }
    previous = identity;
    const inspect = options.inspectObservation ?? inspectGraphStatusWithFreshObservation;
    const loaded = await load(projectRootArg, {
      ...options,
      inspectObservation: async requested => {
        // The inspector skips only persisted invariants, and only when it
        // proves the opened database is still this exact audited identity.
        // Its sidecar, engine, config and scoped source checks still run.
        const inspection = await inspect({ ...requested, ...(audited ? { auditedDatabase: audited } : {}) });
        const token = inspection.freshObservation ?? inspection.degradedObservation?.token;
        if (token) audited = { canonicalDbPath: token.canonicalDbPath, databaseIdentity: token.databaseIdentity };
        return inspection;
      },
    });
    const session = loaded.session;
    if (session === null) return loaded;
    const revalidate = session.revalidateFreshness.bind(session);
    session.revalidateFreshness = async () => {
      const identityFailure = () => {
        if (graphIdentity(root, dbPath) === identity) return null;
        changed = true;
        audited = null;
        return {
          valid: false,
          code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
          message: "The graph database or HEAD changed while a setup batch was being applied.",
          graphStatus: session.graphStatus,
        };
      };
      const before = identityFailure();
      if (before) return before;
      const validation = await revalidate();
      return identityFailure() ?? validation;
    };
    return loaded;
  };
  return { loadFresh, get changed() { return changed; } };
}
