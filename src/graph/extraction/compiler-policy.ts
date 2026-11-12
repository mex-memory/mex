// Which compiler builds a repository's TypeScript/JavaScript graph.
//
// TypeScript 7.1's API by default, served by tsrs when this repository passed
// the tsrs check, otherwise by tsgo; a project either server cannot extract
// falls back to the in-process 5.9 compiler on its own. `MEX_GRAPH_COMPILER`
// pins one choice: `tsrs`, `tsgo` or `typescript-5.9` (`auto` is the default).
//
// Loaded on demand: graph reads never import a compiler.

import { createRequire } from "node:module";
import { openRecordReadOnly, type RecordReader } from "../../record/index.js";
import { realPath } from "../../record/project.js";
import type { CompilerExtractionOptions, ProjectCompiler } from "./compiler.js";

export const GRAPH_COMPILER_ENV = "MEX_GRAPH_COMPILER";
export type GraphCompilerChoice = "auto" | "tsrs" | "tsgo" | "typescript-5.9";

export function graphCompilerChoice(env: NodeJS.ProcessEnv = process.env): GraphCompilerChoice {
  const value = env[GRAPH_COMPILER_ENV]?.trim().toLowerCase();
  if (!value || value === "auto") return "auto";
  if (value === "tsrs" || value === "tsgo") return value;
  if (value === "typescript-5.9" || value === "5.9" || value === "legacy") return "typescript-5.9";
  throw new Error(`${GRAPH_COMPILER_ENV} must be auto, tsrs, tsgo or typescript-5.9, not "${env[GRAPH_COMPILER_ENV]}".`);
}

const requireFromHere = createRequire(import.meta.url);

/** The compiler versions this MEX release pins, without loading any compiler. */
export function pinnedCompilerVersions(): { typescript59: string; typescript7: string; tsrs: string } {
  const version = (name: string): string => {
    try { return (requireFromHere(`${name}/package.json`) as { version: string }).version; } catch { return "missing"; }
  };
  return { typescript59: version("typescript"), typescript7: version("typescript-7"), tsrs: version("tsrs") };
}

/** The tsrs check's verdict for one repository and pair of compiler versions. */
export interface TsrsGateVerdict {
  tsrs: string;
  tsgo: string;
  /** `tsrs` when tsrs passed; `tsgo` when it did not. */
  server: "tsrs" | "tsgo";
  /** Why tsgo was chosen, in plain words. */
  reason?: string;
}

export interface GraphCompilers {
  /** What the extraction options need; nothing for 5.9. */
  options: Pick<CompilerExtractionOptions, "selectCompiler">;
  /** Changes whenever a different compiler would build this repository. */
  identity: string;
  /** The server chosen, for Health. */
  description: string;
}

/**
 * Load the compilers for one extraction. `verdict` is the stored tsrs check
 * for this repository, if any: `auto` uses tsrs only when it agreed with tsgo
 * for the pinned versions, and tsgo until the check has run.
 */
export async function loadGraphCompilers(
  choice: GraphCompilerChoice,
  verdict: TsrsGateVerdict | undefined,
): Promise<GraphCompilers> {
  const versions = pinnedCompilerVersions();
  if (choice === "typescript-5.9") {
    return { options: {}, identity: `typescript-${versions.typescript59}`, description: `TypeScript ${versions.typescript59}` };
  }
  const api = await import("./compiler-api.js");
  const tsgo = new api.ApiProjectCompiler(api.tsgoServer());
  const current = verdict && verdict.tsrs === versions.tsrs && verdict.tsgo === versions.typescript7 ? verdict : undefined;
  const useTsrs = choice === "tsrs" || (choice === "auto" && current?.server === "tsrs");
  let primary: ProjectCompiler = tsgo;
  let description = `tsgo ${versions.typescript7}`;
  if (useTsrs) {
    try {
      primary = new api.ApiProjectCompiler(await api.loadTsrsServer(), tsgo);
      description = `tsrs ${versions.tsrs}${current ? " (matches tsgo on this repository)" : ""}`;
    } catch (error) {
      description = `tsgo ${versions.typescript7} (tsrs could not be loaded: ${error instanceof Error ? error.message : String(error)})`;
    }
  } else if (choice === "auto" && current?.server === "tsgo") {
    description = `tsgo ${versions.typescript7} (${current.reason ?? "tsrs did not pass its check"})`;
  }
  return {
    options: { selectCompiler: () => primary },
    identity: `${useTsrs ? "tsrs" : "tsgo"}:${useTsrs ? versions.tsrs : versions.typescript7}+typescript-${versions.typescript59}`,
    description,
  };
}

/** Whether a stored verdict was reached with the compiler versions this release pins. */
export function verdictIsCurrent(verdict: TsrsGateVerdict | undefined): verdict is TsrsGateVerdict {
  if (!verdict) return false;
  const versions = pinnedCompilerVersions();
  return verdict.tsrs === versions.tsrs && verdict.tsgo === versions.typescript7;
}

/**
 * Where a repository's {@link TsrsGateVerdict} is kept: the local record's `settings`,
 * scope = project id. It outlives every graph rebuild and every worktree of
 * the repository shares it.
 */
export const TSRS_CHECK_SETTING = "typescript.server-check";

/** The verdict kept for the repository this checkout belongs to, if any. */
export function storedTsrsVerdict(root: string): TsrsGateVerdict | undefined {
  let reader: RecordReader | undefined;
  try {
    reader = openRecordReadOnly();
    if (!reader) return undefined;
    const checkout = reader.get<{ project_id: string }>("SELECT project_id FROM checkouts WHERE path=?", realPath(root));
    const value = checkout ? reader.setting(checkout.project_id, TSRS_CHECK_SETTING) : undefined;
    return value ? JSON.parse(value) as TsrsGateVerdict : undefined;
  } catch {
    return undefined;
  } finally {
    reader?.close();
  }
}

/** The background job that compares tsrs with tsgo on a whole repository. */
export const TSRS_FULL_CHECK_JOB = "typescript-server-check";

/**
 * The tsrs check: the whole repository extracted by tsgo and by tsrs from
 * the same bytes and compared node by node and edge by edge. It also proves
 * the tsrs binary exists for this machine and that every API call the
 * extractor makes answers. Runs once per repository and pair of compiler
 * versions, in the background process; tsgo builds the graph until it agrees.
 */
export async function checkTsrsOnRepository(
  root: string,
  /** Test seam: the servers to compare. */
  servers?: { tsrs?: import("./compiler-api.js").TypeScriptApiServer; tsgo?: import("./compiler-api.js").TypeScriptApiServer },
): Promise<TsrsGateVerdict> {
  const versions = pinnedCompilerVersions();
  const verdict = (server: "tsrs" | "tsgo", reason?: string): TsrsGateVerdict => ({
    tsrs: versions.tsrs, tsgo: versions.typescript7, server,
    ...(reason ? { reason } : {}),
  });
  const { readFileSync } = await import("node:fs");
  const api = await import("./compiler-api.js");
  const { buildTypeScriptExtraction } = await import("./compiler.js");
  const { compareCompilerExtractions, parityHolds } = await import("./compiler-parity.js");
  // Both servers read every file once, from the same bytes.
  const bytes = new Map<string, string | undefined>();
  const readProjectFile = (absolutePath: string): string | undefined => {
    if (!bytes.has(absolutePath)) {
      let text: string | undefined;
      try { text = readFileSync(absolutePath, "utf8"); } catch { text = undefined; }
      bytes.set(absolutePath, text);
    }
    return bytes.get(absolutePath);
  };
  let tsrs: Awaited<ReturnType<typeof api.loadTsrsServer>>;
  try {
    tsrs = servers?.tsrs ?? await api.loadTsrsServer();
  } catch (error) {
    return verdict("tsgo", `tsrs could not be loaded (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    const reference = buildTypeScriptExtraction(root, undefined, {
      readProjectFile, selectCompiler: (() => { const tsgo = new api.ApiProjectCompiler(servers?.tsgo ?? api.tsgoServer()); return () => tsgo; })(),
    });
    const candidates = reference.files.map((file) => file.filePath);
    const candidate = buildTypeScriptExtraction(root, candidates, {
      readProjectFile, selectCompiler: (() => { const server = new api.ApiProjectCompiler(tsrs); return () => server; })(),
    });
    const failures = Object.values(candidate.projectCompilerNotes).flat().filter((note) => / failed \(/u.test(note));
    if (failures.length > 0) return verdict("tsgo", `tsrs failed on the repository: ${failures[0]}`);
    const report = compareCompilerExtractions(reference, candidate);
    if (parityHolds(report)) return verdict("tsrs");
    const edges = report.edges.onlyLeft.length + report.edges.onlyRight.length;
    return verdict("tsgo", `tsrs and tsgo disagree on ${edges} of ${report.edges.left} edges in the full comparison`);
  } catch (error) {
    return verdict("tsgo", `the full tsrs comparison failed (${error instanceof Error ? error.message.split(/\r?\n/u)[0] : String(error)})`);
  }
}
