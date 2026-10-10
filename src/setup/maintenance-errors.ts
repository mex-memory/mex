import { GraphCandidateProcessError } from "../graph/candidate-process.js";
import { IndexInUseError, IndexPathError } from "../wiki/index/dbfile.js";
import { WikiSourceReadError } from "../wiki/index/source-read.js";
import { WIKI_DIAGNOSTICS, type WikiDiagnostic } from "../wiki/model/diagnostic.js";
import { SetupError, classifySetupFileSystemError } from "./errors.js";
import type { SetupWikiFinalizationStage } from "./wiki-finalize.js";

type SetupMaintenancePhase = "graph" | "grounding" | "wiki";

const PHASE_LABELS: Record<SetupMaintenancePhase, string> = {
  graph: "Code graph setup",
  grounding: "Grounding finalization",
  wiki: "Wiki finalization",
};

/** Closed codes select authored advice; exception text remains terminal-only. */
const RECOVERY_BY_CODE: Readonly<Record<string, string>> = {
  GRAPH_INDEX_MISSING: "The code graph is missing. Run `mex graph rebuild`, then retry setup.",
  GRAPH_INDEX_NOT_REFRESHABLE: "The code graph needs a rebuild. Run `mex graph rebuild`, resolve any reported problems, then retry setup.",
  GRAPH_INDEX_NOT_REPAIRABLE: "The code graph cannot be repaired safely. Run `mex graph rebuild`, then retry setup.",
  GRAPH_MAINTENANCE_LOCKED: "Another graph operation is active. Wait for it to finish, then retry setup.",
  GRAPH_MAINTENANCE_GATE_STALE: "An interrupted graph operation left .mex/graph.db.lock.gate behind. Verify no MEX process is running before removing that gate, then retry setup.",
  GRAPH_MAINTENANCE_CANCELLED: "Graph maintenance was interrupted. Retry setup when ready.",
  GRAPH_MAINTENANCE_PATH_UNSAFE: "A graph database or maintenance path is unsafe. Check .mex for redirected or conflicting paths, correct them, then retry setup.",
  GRAPH_MAINTENANCE_RACE: "The graph or project files changed during maintenance. Wait for other writers to finish, then retry setup.",
  GRAPH_CANDIDATE_INVALID: "The rebuilt graph failed validation. Run `mex graph rebuild` to inspect its diagnostics, resolve the reported problems, then retry setup.",
  GRAPH_PUBLICATION_FAILED: "The graph could not be published safely and may need recovery. Keep any .mex/graph.db recovery files and inspect `mex graph status` before retrying setup.",
  GRAPH_SOURCE_STAGING_FAILED: "Source files could not be read or parsed safely. Check `mex graph rebuild` diagnostics, correct the reported files, then retry setup.",
  WIKI_MAINTENANCE_LOCKED: "Another Wiki operation is active. Wait for it to finish, then retry setup.",
  WIKI_CORPUS_LIMIT_EXCEEDED: "The Wiki exceeds a file, directory, or size safety limit. Reduce oversized content or exclude unrelated files using wiki.exclude in .mex/config.json, then retry setup.",
  WIKI_INDEX_RECOVERY_REQUIRED: "The Wiki index could not be published and recovery files were retained. Keep the .mex/wiki.db recovery files and inspect them before retrying setup.",
  OPERATION_INTERRUPTED: "Wiki files changed or maintenance was interrupted. Wait for other writers to finish, then retry setup.",
};

/** Expected maintenance failures only. Unknown exceptions retain the Hub fallback. */
export function classifySetupMaintenanceError(
  error: unknown,
  phase: SetupMaintenancePhase,
): SetupError | null {
  if (error instanceof SetupError) return error;
  if (!(error instanceof Error)) return null;
  const label = PHASE_LABELS[phase];
  let recovery: string | undefined;
  if ("code" in error && typeof error.code === "string" && Object.hasOwn(RECOVERY_BY_CODE, error.code)) {
    recovery = RECOVERY_BY_CODE[error.code];
  } else if (error instanceof GraphCandidateProcessError) {
    recovery = error.category === "compatibility"
      ? "The graph worker could not use the current index. Run `mex graph rebuild` with the current MEX installation, then retry setup."
      : error.category === "staging"
        ? RECOVERY_BY_CODE.GRAPH_SOURCE_STAGING_FAILED
        : error.category === "unsafe"
          ? RECOVERY_BY_CODE.GRAPH_MAINTENANCE_PATH_UNSAFE
          : error.category === "cancelled"
            ? RECOVERY_BY_CODE.GRAPH_MAINTENANCE_CANCELLED
            : graphWorkerRecovery(error);
  } else if (error instanceof IndexInUseError) {
    recovery = "The Wiki index is busy or changed during publication. Close other processes using it, then retry setup.";
  } else if (error instanceof IndexPathError || error instanceof WikiSourceReadError) {
    recovery = "A Wiki file or index path could not be read safely. Check .mex for unreadable, redirected, or conflicting paths, correct them, then retry setup.";
  } else {
    recovery = sqliteRecovery(error);
  }
  if (recovery !== undefined) {
    return new SetupError(`${label} failed: ${error.message}`, {
      cause: error,
      userMessage: `${label} could not finish. ${recovery}`,
    });
  }
  return classifySetupFileSystemError(error, `${label} could not finish.`);
}

function graphWorkerRecovery(error: GraphCandidateProcessError): string {
  if (error.diagnostic?.resourceFailure === "heap-limit") {
    return "The graph worker reached Node's JavaScript heap limit. Retry setup with a larger heap using NODE_OPTIONS=--max-old-space-size=<MB>, sized for your available memory.";
  }
  switch (error.diagnostic?.reason) {
    case "entrypoint-missing":
      return "The graph worker is missing from this MEX installation. Rebuild MEX if running from source, or reinstall it, then retry setup.";
    case "spawn":
      return "The graph worker could not start. Check the Node runtime and execution permissions, then retry setup.";
    case "startup-timeout":
      return "The graph worker did not start before its startup deadline. Retry setup; if this repeats, check the Node runtime and MEX installation.";
    case "build-timeout":
      return "The graph worker exceeded its build time limit. Review the last reported phase and worker diagnostics before retrying setup.";
    case "protocol":
      return "The graph worker returned an invalid response. Rebuild MEX if running from source, or reinstall it, then retry setup.";
    case "ipc-disconnected":
      return "Setup lost communication with the graph worker. Check the worker diagnostics, then retry setup.";
    case "observer":
      return "Setup could not process a graph worker update. Retry setup; if this repeats, report the terminal diagnostics.";
    case "exit": {
      const diagnostic = error.diagnostic;
      const status = diagnostic.signal
        ? "The graph worker was terminated by a signal."
        : Number.isSafeInteger(diagnostic.exitCode) && diagnostic.exitCode !== null
          ? `The graph worker exited with status ${diagnostic.exitCode}.`
          : "The graph worker exited without completing the build.";
      return `${status} Check the worker diagnostics, then retry setup.`;
    }
    default:
      return "The graph worker could not complete the build. Check the worker diagnostics or run `mex graph rebuild`, then retry setup.";
  }
}

function sqliteRecovery(error: Error): string | undefined {
  if (!("code" in error) || typeof error.code !== "string") return undefined;
  const code = error.code;
  // node:sqlite reports numeric SQLite result codes behind ERR_SQLITE_ERROR.
  // The low byte identifies the primary result, including extended codes.
  const primary = code === "ERR_SQLITE_ERROR" && "errcode" in error
    && typeof error.errcode === "number" && Number.isSafeInteger(error.errcode) && error.errcode >= 0
    ? error.errcode & 0xff : undefined;
  if (["SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_BUSY", "ERR_SQLITE_LOCKED"].includes(code)
    || primary === 5 || primary === 6) {
    return "The local database is busy. Wait for other MEX or database processes to finish, then retry setup.";
  }
  if (["SQLITE_FULL", "ERR_SQLITE_FULL"].includes(code) || primary === 13) {
    return "The local database ran out of storage. Free disk space or increase the quota, then retry setup.";
  }
  if (["SQLITE_READONLY", "ERR_SQLITE_READONLY"].includes(code) || primary === 8) {
    return "The local database is read-only. Check the checkout and database permissions, then retry setup.";
  }
  return undefined;
}

/** Select registry-owned remediation, never a diagnostic's raw message or override. */
export function setupWikiFailureMessage(
  stage: SetupWikiFinalizationStage,
  diagnostics: readonly WikiDiagnostic[],
): string {
  const label = stage === "plan" ? "Wiki migration planning"
    : stage === "migration" ? "Wiki migration"
      : stage === "index" ? "Wiki indexing" : "Wiki validation";
  const diagnostic = diagnostics.find((entry) => entry.severity === "error" && Object.hasOwn(WIKI_DIAGNOSTICS, entry.code));
  if (!diagnostic) return `${label} could not finish. Review the .mex files and retry setup after correcting the problem.`;
  const location = safeScaffoldPath(diagnostic.file ?? diagnostic.location?.file);
  const subject = `${diagnostic.code}${location === null ? "" : ` in ${location}`}`;
  const remediation = diagnostic.code === "WRITE_SCOPE_VIOLATION"
    ? "Check the affected file and wiki.readOnly rules in .mex/config.json. Preserve protected files or intentionally update their configuration."
    : diagnostic.code === "WIKI_INDEX_MISSING"
      ? "The Wiki index is missing. Setup can rebuild it on retry."
    : diagnostic.code === "WIKI_INDEX_REBUILD_REQUIRED"
      ? "Close other processes using the Wiki index before retrying. If the problem persists, run `mex wiki rebuild-index` to inspect its diagnostics."
      : WIKI_DIAGNOSTICS[diagnostic.code].remediation;
  const retry = " Retry setup after correcting this problem.";
  const detail = `${label} could not finish (${subject}). ${remediation}`;
  const available = 512 - retry.length;
  return `${detail.length > available ? `${detail.slice(0, available - 1)}…` : detail}${retry}`;
}

function safeScaffoldPath(path: string | undefined): string | null {
  if (path === undefined || path.length > 160 || /[\u0000-\u001f\u007f]/u.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return normalized.startsWith(".mex/") ? normalized : `.mex/${normalized}`;
}
