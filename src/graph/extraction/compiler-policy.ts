// Which compiler builds a repository's TypeScript/JavaScript graph.
//
// tsrs serves TypeScript 7.1's API by default. A project tsrs cannot build
// (a crash, an API call that fails, no binary for this machine) moves to tsgo,
// and a project tsgo cannot build moves to the in-process 5.9 compiler, each
// with the reason recorded. tsrs is checked against tsgo once per MEX release,
// in CI, on a fixed set of real repositories (see `compareServersOnRepository`
// and `scripts/graph-compiler-parity.ts --servers`); users never build twice.
// `MEX_GRAPH_COMPILER` pins one choice: `tsrs`, `tsgo` or `typescript-5.9`
// (`auto`, the default, is tsrs with its fallbacks).
//
// Loaded on demand: graph reads never import a compiler.

import { createRequire } from "node:module";
import type { CompilerExtractionOptions, CompilerExtractionResult, ProjectCompiler } from "./compiler.js";
import type { CompilerParityReport } from "./compiler-parity.js";
import type { TypeScriptApiServer } from "./compiler-api.js";

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

export interface GraphCompilers {
  /** What the extraction options need; nothing for 5.9. */
  options: Pick<CompilerExtractionOptions, "selectCompiler">;
  /** Changes whenever a different compiler would build this repository. */
  identity: string;
  /** The server chosen, for Health. */
  description: string;
}

/** Load the compilers for one extraction. */
export async function loadGraphCompilers(choice: GraphCompilerChoice): Promise<GraphCompilers> {
  const versions = pinnedCompilerVersions();
  if (choice === "typescript-5.9") {
    return { options: {}, identity: `typescript-${versions.typescript59}`, description: `TypeScript ${versions.typescript59}` };
  }
  const api = await import("./compiler-api.js");
  const tsgo = new api.ApiProjectCompiler(api.tsgoServer());
  let primary: ProjectCompiler = tsgo;
  let description = `tsgo ${versions.typescript7}`;
  if (choice !== "tsgo") {
    try {
      primary = new api.ApiProjectCompiler(await api.loadTsrsServer(), tsgo);
      description = `tsrs ${versions.tsrs}`;
    } catch (error) {
      // No tsrs package or binary for this machine: tsgo builds everything.
      description = `tsgo ${versions.typescript7} (tsrs could not be loaded: ${error instanceof Error ? error.message : String(error)})`;
    }
  }
  const server = primary === tsgo ? `tsgo:${versions.typescript7}` : `tsrs:${versions.tsrs}`;
  return {
    options: { selectCompiler: () => primary },
    identity: `${server}+typescript-${versions.typescript59}`,
    description,
  };
}

/** What one repository's comparison of tsrs with tsgo found. */
export interface ServerComparison {
  tsrs: string;
  tsgo: string;
  /** True when tsrs gave exactly tsgo's nodes, edges and imports, and failed on no project. */
  agrees: boolean;
  /** Why not, in plain words. */
  reason?: string;
  report?: CompilerParityReport;
  timings: { tsgoMs: number; tsrsMs: number };
}

/**
 * The release check for tsrs: one repository extracted by tsgo and by tsrs
 * from the same bytes, compared node by node and edge by edge. It also shows
 * that the tsrs binary runs and that every API call the extractor makes
 * answers. CI runs it on a fixed set of repositories before a release pins a
 * tsrs version.
 */
export async function compareServersOnRepository(
  root: string,
  /** Test seam: the servers to compare. */
  servers?: { tsrs?: TypeScriptApiServer; tsgo?: TypeScriptApiServer },
): Promise<ServerComparison> {
  const versions = pinnedCompilerVersions();
  const base = { tsrs: versions.tsrs, tsgo: versions.typescript7 };
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
  const timings = { tsgoMs: 0, tsrsMs: 0 };
  let tsrs: TypeScriptApiServer;
  try {
    tsrs = servers?.tsrs ?? await api.loadTsrsServer();
  } catch (error) {
    return { ...base, agrees: false, reason: `tsrs could not be loaded (${firstLine(error)})`, timings };
  }
  const extract = (server: TypeScriptApiServer, candidates?: readonly string[]): CompilerExtractionResult => {
    const compiler = new api.ApiProjectCompiler(server);
    return buildTypeScriptExtraction(root, candidates, { readProjectFile, selectCompiler: () => compiler });
  };
  try {
    let started = performance.now();
    const reference = extract(servers?.tsgo ?? api.tsgoServer());
    timings.tsgoMs = Math.round(performance.now() - started);
    started = performance.now();
    const candidate = extract(tsrs, reference.files.map((file) => file.filePath));
    timings.tsrsMs = Math.round(performance.now() - started);
    const failures = Object.values(candidate.projectCompilerNotes).flat().filter((note) => / failed \(/u.test(note));
    if (failures.length > 0) return { ...base, agrees: false, reason: `tsrs failed on the repository: ${failures[0]}`, timings };
    const report = compareCompilerExtractions(reference, candidate);
    if (parityHolds(report)) return { ...base, agrees: true, report, timings };
    const edges = report.edges.onlyLeft.length + report.edges.onlyRight.length;
    const nodes = report.nodes.onlyLeft.length + report.nodes.onlyRight.length + report.nodeFieldDifferences.length;
    return {
      ...base, agrees: false, report, timings,
      reason: `tsrs and tsgo disagree on ${edges} of ${report.edges.left} edges, ${nodes} nodes and `
        + `${report.imports.differences.length} imports`,
    };
  } catch (error) {
    return { ...base, agrees: false, reason: `the comparison failed (${firstLine(error)})`, timings };
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/u)[0]!.slice(0, 300);
}
