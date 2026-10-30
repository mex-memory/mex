/**
 * Code named by where it is, resolved to the graph node it means.
 *
 * An agent that has just read `src/router.ts` knows a function is called
 * `parseBody`, or that the behaviour it describes sits on line 120. It does not
 * know the node id, and making it look one up costs a graph call per fact. So
 * an operation may name a grounding as `{file, symbol}` or `{file, line}`, and
 * this module turns that into the node id, against the same graph snapshot the
 * operation then derives the fingerprint and body hash from. What the Markdown
 * records is identical to a grounding named by id.
 *
 * ## Never a guess
 *
 * A name that matches nothing is refused with the nearest declarations in the
 * file; a name that matches several is refused with every candidate (id, kind,
 * lines, signature). The only preference applied is exactness: a symbol that is
 * the full qualified name of exactly one declaration wins over declarations it
 * merely ends with (`start` names the top-level `start`, not `Service.start`).
 *
 * ## Only code a grounding can be checked against
 *
 * A grounding is verified by its body hash, so only declarations with a body
 * are candidates. A name that matches only body-less declarations (a type
 * alias, an import) is refused with that reason rather than resolved to a node
 * no later check could ever confirm.
 */

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import {
  isCodeNameReference,
  type CodeNameReference,
  type GroundingRequest,
  type GroundingTarget,
} from "../model/grounding.js";
import type { CodeDeclaration, GroundingGraph } from "./adapter.js";

/** Candidates listed in one diagnostic. Enough to choose from, small enough to read. */
const MAX_LISTED_CANDIDATES = 8;

/** Node kinds that are never what a reader means by a named piece of code. */
const UNNAMED_KINDS = new Set(["file", "import", "export", "parameter"]);

export type CodeReferenceResolution =
  | { ok: true; groundings: GroundingRequest[] }
  | { ok: false; diagnostics: WikiDiagnostic[] };

/**
 * Resolve every code-name reference in `targets` to a node grounding; node
 * groundings pass through untouched. Every problem is reported, not only the
 * first, each at its index under `path`.
 */
export function resolveGroundingTargets(
  targets: readonly GroundingTarget[],
  graph: GroundingGraph | null,
  path = "groundsTo",
): CodeReferenceResolution {
  if (!targets.some(isCodeNameReference)) return { ok: true, groundings: targets as GroundingRequest[] };
  const diagnostics: WikiDiagnostic[] = [];
  const groundings: GroundingRequest[] = [];
  targets.forEach((target, index) => {
    if (!isCodeNameReference(target)) {
      groundings.push(target);
      return;
    }
    const resolved = resolveCodeReference(target, graph, `${path}[${index}]`);
    if (resolved.ok) {
      groundings.push({ node: resolved.node.id, ...(target.reason === undefined ? {} : { reason: target.reason }) });
    } else {
      diagnostics.push(resolved.diagnostic);
    }
  });
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, groundings };
}

/**
 * Normalize a caller's path to the graph's repository-relative POSIX form, or
 * return null for one that cannot name a file inside the repository.
 */
export function normalizeReferencePath(raw: string): string | null {
  let path = raw.trim().replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.startsWith("/") || /^[a-z]:/i.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  return path;
}

type ResolvedReference =
  | { ok: true; node: CodeDeclaration }
  | { ok: false; diagnostic: WikiDiagnostic };

/** Resolve one reference, or say exactly why not. */
export function resolveCodeReference(
  reference: CodeNameReference,
  graph: GroundingGraph | null,
  path = "groundsTo",
): ResolvedReference {
  const named = reference.symbol !== undefined ? `\`${reference.symbol}\` in ${reference.file}` : `line ${reference.line} of ${reference.file}`;
  const refuse = (code: "GROUNDING_NOT_FOUND" | "GROUNDING_AMBIGUOUS" | "GROUNDING_UNVERIFIED", message: string): ResolvedReference => ({
    ok: false,
    diagnostic: diagnostic(code, message, { path }),
  });
  if (graph === null) {
    return refuse("GROUNDING_UNVERIFIED", `Cannot resolve ${named}: no current code graph is available. Run \`mex graph\` to bring it up to date, then retry.`);
  }
  if (graph.declarationsInFile === undefined) {
    return refuse("GROUNDING_UNVERIFIED", `Cannot resolve ${named}: this code graph cannot look code up by file. Name the node by id instead.`);
  }
  const file = normalizeReferencePath(reference.file);
  if (file === null) {
    return refuse("GROUNDING_NOT_FOUND", `"${reference.file}" is not a repository-relative path. Write it from the repository root, for example \`src/app.ts\`.`);
  }
  const declarations = graph.declarationsInFile(file);
  if (declarations === null || declarations.length === 0) {
    const gap = graph.incompleteReason === undefined ? "" : ` ${graph.incompleteReason}`;
    return refuse(
      "GROUNDING_NOT_FOUND",
      `${file} is not in the code graph: it is not an indexed source file, is excluded, or could not be parsed.${gap} Check the path is repository-relative and that \`mex graph\` indexes it.`,
    );
  }
  const declared = declarations.filter((entry) => !UNNAMED_KINDS.has(entry.kind));
  return reference.symbol !== undefined
    ? resolveSymbol(file, reference.symbol, declared, refuse)
    : resolveLine(file, reference.line!, declared, refuse);
}

type Refuse = (code: "GROUNDING_NOT_FOUND" | "GROUNDING_AMBIGUOUS", message: string) => ResolvedReference;

/** `Router.add`, `Router::add`, `Router#add` and `module.add` all split the same way. */
function segmentsOf(name: string): string[] {
  return name.trim().split(/::|[.#]/).map((segment) => segment.trim()).filter((segment) => segment !== "");
}

function endsWith(whole: readonly string[], tail: readonly string[]): boolean {
  if (tail.length === 0 || tail.length > whole.length) return false;
  const offset = whole.length - tail.length;
  return tail.every((segment, index) => whole[offset + index] === segment);
}

/** The module names a file is known by: `router` for `src/router.ts`, and its dotted path. */
function moduleNamesOf(file: string): string[][] {
  const withoutExtension = file.replace(/\.[^./]+$/, "");
  const parts = withoutExtension.split("/");
  const names = [parts.slice(-1)];
  if (parts[parts.length - 1] === "__init__" || parts[parts.length - 1] === "index" || parts[parts.length - 1] === "mod") {
    names.push(parts.slice(-2, -1));
  }
  for (let start = 0; start < parts.length - 1; start += 1) names.push(parts.slice(start));
  return names.filter((name) => name.length > 0 && name.every((segment) => segment !== ""));
}

function resolveSymbol(
  file: string,
  symbol: string,
  declarations: readonly CodeDeclaration[],
  refuse: Refuse,
): ResolvedReference {
  const wanted = segmentsOf(symbol);
  // A leading module name (`router.parseBody`, `pkg.router.parseBody`) names
  // the file itself; it is accepted as a second reading of the same symbol.
  const readings = [wanted];
  for (const module of moduleNamesOf(file)) {
    if (wanted.length > module.length && module.every((segment, index) => wanted[index] === segment)) {
      readings.push(wanted.slice(module.length));
    }
  }
  const qualified = (entry: CodeDeclaration) => segmentsOf(entry.qualifiedName);
  const exact = declarations.filter((entry) => readings.some((reading) => sameSegments(qualified(entry), reading)));
  const suffix = declarations.filter((entry) => readings.some((reading) => endsWith(qualified(entry), reading)));
  for (const matches of [exact, suffix]) {
    if (matches.length === 0) continue;
    const bodied = matches.filter((entry) => entry.hasBody);
    if (bodied.length === 1) return { ok: true, node: bodied[0]! };
    if (bodied.length > 1) {
      return refuse(
        "GROUNDING_AMBIGUOUS",
        `\`${symbol}\` in ${file} names ${bodied.length} declarations; qualify it (for example \`${qualifiedExample(bodied)}\`) or use \`line\`. Candidates: ${listCandidates(bodied)}.`,
      );
    }
    return refuse(
      "GROUNDING_NOT_FOUND",
      `\`${symbol}\` in ${file} is a declaration with no body to check a claim against (${listCandidates(matches)}). Ground the function, method or class that implements the behaviour instead.`,
    );
  }
  const bodied = declarations.filter((entry) => entry.hasBody);
  const nearest = nearestByName(wanted[wanted.length - 1] ?? symbol, bodied);
  // No similar name: still say what the file does declare, so the claim can be re-grounded.
  const detail = nearest.length > 0 ? ` Nearest: ${listCandidates(nearest)}.`
    : bodied.length > 0 ? ` No similar name; the file declares: ${listCandidates(bodied)}.`
      : " The file declares no function, method or class a grounding can use.";
  return refuse("GROUNDING_NOT_FOUND", `No declaration named \`${symbol}\` in ${file}.${detail}`);
}

function resolveLine(
  file: string,
  line: number,
  declarations: readonly CodeDeclaration[],
  refuse: Refuse,
): ResolvedReference {
  const enclosing = declarations
    .filter((entry) => entry.hasBody && entry.startLine <= line && line <= entry.endLine)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || right.startLine - left.startLine);
  const innermost = enclosing[0];
  if (innermost !== undefined) {
    const span = innermost.endLine - innermost.startLine;
    const tied = enclosing.filter((entry) => entry.endLine - entry.startLine === span && entry.startLine === innermost.startLine);
    if (tied.length === 1) return { ok: true, node: innermost };
    return refuse(
      "GROUNDING_AMBIGUOUS",
      `Line ${line} of ${file} sits inside ${tied.length} declarations of the same extent; name one with \`symbol\`. Candidates: ${listCandidates(tied)}.`,
    );
  }
  const nearest = declarations
    .filter((entry) => entry.hasBody)
    .map((entry) => ({ entry, distance: line < entry.startLine ? entry.startLine - line : line - entry.endLine }))
    .sort((left, right) => left.distance - right.distance || left.entry.startLine - right.entry.startLine)
    .slice(0, 3)
    .map((entry) => entry.entry);
  return refuse(
    "GROUNDING_NOT_FOUND",
    `Line ${line} of ${file} is not inside any function, method or class.${nearest.length === 0 ? "" : ` Nearest: ${listCandidates(nearest)}.`}`,
  );
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function qualifiedExample(candidates: readonly CodeDeclaration[]): string {
  const deeper = candidates.find((entry) => segmentsOf(entry.qualifiedName).length > 1) ?? candidates[0]!;
  return segmentsOf(deeper.qualifiedName).join(".");
}

/** `Router.add (method, lines 3-5, (method: string): void) method:0a9e…` for each candidate. */
function listCandidates(candidates: readonly CodeDeclaration[]): string {
  const shown = candidates.slice(0, MAX_LISTED_CANDIDATES).map((entry) => {
    const signature = entry.signature === undefined ? "" : `, ${entry.signature.length > 80 ? `${entry.signature.slice(0, 77)}...` : entry.signature}`;
    return `${segmentsOf(entry.qualifiedName).join(".")} (${entry.kind}, lines ${entry.startLine}-${entry.endLine}${signature}) ${entry.id}`;
  });
  const more = candidates.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

/** Declarations whose name is closest to `name`: same name in another case, containment, then edit distance. */
function nearestByName(name: string, declarations: readonly CodeDeclaration[]): CodeDeclaration[] {
  const wanted = name.toLowerCase();
  return declarations
    .map((entry) => {
      const candidate = entry.name.toLowerCase();
      const score = candidate === wanted ? 0
        : candidate.includes(wanted) || wanted.includes(candidate) ? 1
          : 2 + editDistance(candidate, wanted, 12);
      return { entry, score };
    })
    .filter((entry) => entry.score <= 6)
    .sort((left, right) => left.score - right.score || left.entry.startLine - right.entry.startLine)
    .slice(0, 3)
    .map((entry) => entry.entry);
}

/** Levenshtein distance, capped so a long name costs bounded work. */
function editDistance(left: string, right: string, cap: number): number {
  if (Math.abs(left.length - right.length) > cap) return cap;
  const a = left.slice(0, 64);
  const b = right.slice(0, 64);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return Math.min(previous[b.length]!, cap);
}
