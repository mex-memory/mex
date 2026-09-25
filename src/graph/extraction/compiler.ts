// Compiler-backed TypeScript/JavaScript graph extraction.
//
// This module deliberately sits beside the frozen tree-sitter extractor seam.
// It stages a whole TS/JS corpus before persistence, which lets the engine use
// the TypeScript checker for aliases, overloads, module resolution and calls
// without changing the Python/Rust extraction path.

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";
import { recordGraphPhase, timeGraphPhase } from "../phase-timing.js";

// v3 (#240): checker-rendered signatures no longer embed absolute module paths.
// v4 (#209): checker-rendered unions list their members in one canonical order.
export const TYPESCRIPT_COMPILER_EXTRACTOR_VERSION = "typescript-5.9-v4";
export const TYPESCRIPT_COMPILER_VERSION = ts.version;

export type CompilerSourceLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx";

export type CompilerNodeKind =
  | "file"
  | "module"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "property"
  | "variable"
  | "constant"
  | "enum"
  | "enum_member"
  | "type_alias"
  | "namespace";

export type CompilerReferenceKind =
  | "contains"
  | "calls"
  | "imports"
  | "exports"
  | "extends"
  | "implements"
  | "references"
  | "instantiates"
  | "overrides";

export type CompilerParseStatus = "ok" | "partial" | "failed";
export type CompilerResolutionStatus =
  | "resolved"
  | "ambiguous"
  | "unresolved";

export interface CompilerDiagnosticSummary {
  code: number;
  category: "warning" | "error" | "suggestion" | "message";
  message: string;
  start?: number;
  length?: number;
}

export interface CompilerSourceHealth {
  status: CompilerParseStatus;
  syntacticDiagnosticCount: number;
  semanticDiagnosticCount: number;
  /** Union of syntactic-error spans divided by the UTF-8 source byte length. */
  diagnosticByteCoverage: number;
  excludedDeclarationCount: number;
  diagnostics: CompilerDiagnosticSummary[];
}

export interface CompilerExtractedNode {
  id: string;
  identityKey: string;
  containerId?: string;
  kind: CompilerNodeKind;
  name: string;
  qualifiedName: string;
  declarationRole: string;
  filePath: string;
  language: CompilerSourceLanguage;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: "public" | "private" | "protected" | "internal";
  isExported: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
  /** All declarations represented by this node (overload sets are coalesced). */
  declarationSpans: Array<{
    startLine: number;
    endLine: number;
    startColumn: number;
    endColumn: number;
  }>;
}

export interface CompilerImportBinding {
  id: string;
  filePath: string;
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  resolvedFilePath?: string;
  targetId?: string;
  isTypeOnly: boolean;
  isNamespace: boolean;
  isDefault: boolean;
  line: number;
  column: number;
  confidence: 1;
  resolutionMethod: "typescript-import";
}

export interface CompilerReference {
  id: string;
  sourceId: string;
  targetId?: string;
  kind: CompilerReferenceKind;
  targetName: string;
  targetQualifiedName?: string;
  receiver?: string;
  qualifier?: string;
  candidates: string[];
  status: CompilerResolutionStatus;
  confidence: number;
  resolutionMethod:
    | "lexical-containment"
    | "typescript-symbol"
    | "typescript-signature"
    | "typescript-import"
    | "typescript-heritage"
    | "typescript-callback-parameter";
  provenance: "typescript-compiler" | "callback-synthesis";
  filePath: string;
  line: number;
  column: number;
  evidence: Record<string, unknown>;
}

export interface CompilerFileExtraction {
  filePath: string;
  language: CompilerSourceLanguage;
  projectId: string;
  health: CompilerSourceHealth;
  nodes: CompilerExtractedNode[];
  importBindings: CompilerImportBinding[];
  references: CompilerReference[];
}

export interface DiscoveredTypeScriptProject {
  id: string;
  configPath: string | null;
  projectReferences: string[];
  configuredFilePaths: string[];
  diagnostics: CompilerDiagnosticSummary[];
}

/**
 * A compiler input the containment policy declined to read.
 *
 * Reported rather than fatal. The resulting type graph is less complete for
 * the affected project, and a user has to be told that rather than left to
 * infer it from missing edges.
 */
export interface DeclinedCompilerInput {
  filePath: string;
  reason: "outside-project-corpus";
  message: string;
}

export interface CompilerExtractionResult {
  compilerVersion: string;
  extractorVersion: string;
  projects: DiscoveredTypeScriptProject[];
  files: CompilerFileExtraction[];
  /** Repository inputs whose exact bytes influenced config parsing or compiler facts. */
  semanticInputs: CompilerSemanticInput[];
  /** Config inputs outside the project corpus that were declined, not read. */
  declinedInputs: DeclinedCompilerInput[];
  /** One capture per extracted file, in `files` order, for incremental reuse (issue #209). */
  captures: CompilerFileCapture[];
  /** Per project: a digest of every program input that is visible without an import. */
  projectStates: Record<string, string>;
  /** Files captured from a live program in this run. */
  recaptured: number;
  /** Repository-relative paths whose previous capture was reused unchanged. */
  reused: string[];
}

/**
 * Everything the finishing pass needs from one file, as plain data. An
 * incremental refresh (issue #209) stores it and reuses it instead of
 * capturing an unaffected file again. Declaration locations inside the root
 * are stored root-relative (`./path:offset:kind`), so a capture is independent
 * of where the checkout lives.
 */
export interface CompilerFileCapture {
  filePath: string;
  language: CompilerSourceLanguage;
  projectId: string;
  health: CompilerSourceHealth;
  nodes: CompilerExtractedNode[];
  fileDraftId?: string;
  /** Declaration location → node id, for every declaration this file contributes. */
  locations: Array<[string, string]>;
  bindings: DeferredImportBinding[];
  captured: CapturedReference[];
  /** Module specifiers the import capture resolved; replayed when the capture is reused. */
  resolvedSpecifiers: string[];
  /** Corpus files this file's imports, references and type directives resolve to. */
  dependencies: string[];
  /** Corpus paths module resolution probed for this file and did not find. */
  failedLookups: string[];
  /** Its declarations are visible without an import: a script, a `.d.ts` or a global augmentation. */
  globalScope: boolean;
}

/**
 * Incremental extraction (issue #209). Every program is still created from
 * the same roots as a full extraction; only the files in `affected`, and files
 * without a previous capture, are captured from it. Every other owned file
 * reuses its previous capture, and the finishing pass runs over all of them.
 */
export interface CompilerIncrementalInput {
  /** Previous captures by repository-relative path. */
  previous: ReadonlyMap<string, CompilerFileCapture>;
  /** Repository-relative paths that must be captured again. */
  affected: ReadonlySet<string>;
  /** `projectStates` of the previous extraction. */
  projectStates: Readonly<Record<string, string>>;
}

/** A condition only a full extraction can honour; the caller extracts in full. */
export class CompilerIncrementalFallback extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CompilerIncrementalFallback";
  }
}

export interface CompilerStagedInput {
  filePath: string;
  source: string;
}

export interface CompilerSemanticInput {
  filePath: string;
  /** Exact UTF-8 hash, or null when a resolution/config probe observed absence. */
  contentHash: string | null;
}

export interface CompilerExtractionOptions {
  /** Additional options used only by the inferred program. */
  inferredCompilerOptions?: ts.CompilerOptions;
  /**
   * Immutable repository inputs supplied by the graph staging layer. The
   * compiler host always prefers these bytes to the live filesystem.
   * @internal
   */
  stagedInputs?: readonly CompilerStagedInput[];
  /**
   * Secure reader for repository inputs discovered indirectly (for example an
   * extended tsconfig). Results are cached for the complete extraction.
   * @internal
   */
  readProjectFile?: (absolutePath: string) => string | undefined;
  /**
   * Run the full per-file semantic type-check and record its diagnostics.
   * Off by default: `parse_status` derives from syntactic diagnostics alone,
   * and reference/signature extraction uses the checker lazily, so the full
   * semantic pass only adds diagnostics detail — at a wall-clock/RSS cost that
   * scales with the resolvable dependency surface (issue #140 observation 1/2).
   */
  semanticDiagnostics?: boolean;
  /** Test seam: replaces `ts.createProgram` to exercise program-crash isolation. */
  programFactory?: (options: ts.CreateProgramOptions) => ts.Program;
  /** Reuse unaffected files' previous captures (issue #209). */
  incremental?: CompilerIncrementalInput;
  /**
   * Test seam: the order the checker visits one project's files in. Output
   * must not depend on it (issue #209); the order-independence property test
   * permutes it. Must return a permutation of its input.
   */
  visitOrder?: (files: readonly string[]) => readonly string[];
}

interface ParsedProject {
  id: string;
  configPath: string;
  parsed: ts.ParsedCommandLine;
  diagnostics: ts.Diagnostic[];
}

interface RuntimeProject extends ParsedProject {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Project root that checker-rendered module paths are made relative to. */
  root: string;
  /** Call-site signature text, by the scope it was rendered in; see {@link renderCallSignature}. */
  callSignatureTexts: Map<ts.Node, Map<ts.Signature, string>>;
}

interface ErrorRange {
  start: number;
  end: number;
}

interface DraftNode {
  kind: CompilerNodeKind;
  name: string;
  qualifiedName: string;
  declarationRole: string;
  signature?: string;
  declarations: ts.Node[];
  symbol?: ts.Symbol;
  container?: DraftNode;
  filePath: string;
  language: CompilerSourceLanguage;
  docstring?: string;
  visibility?: "public" | "private" | "protected" | "internal";
  isExported: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
  identityBase?: string;
  identityKey?: string;
  id?: string;
}

interface FileContext {
  filePath: string;
  sourceFile: ts.SourceFile;
  project: RuntimeProject;
  language: CompilerSourceLanguage;
  health: CompilerSourceHealth;
  errorRanges: ErrorRange[];
  excludedDeclarationRanges: ErrorRange[];
  drafts: DraftNode[];
  fileDraft?: DraftNode;
  declarationDrafts: Map<ts.Node, DraftNode>;
  symbolDrafts: Map<ts.Symbol, DraftNode>;
  nodes: CompilerExtractedNode[];
}

interface PendingReference extends Omit<CompilerReference, "id"> {
  position: number;
  identityHint: string;
}

// ── Sequential capture (issue #140: one program alive at a time) ─────────────
//
// Cross-project reference linkage flows through declaration-location STRINGS
// (`declarationLocation`: absolute path + start offset + syntax kind), which
// are identical across programs for the same file bytes. That is what already
// made multi-program resolution work when every program was held concurrently —
// and it is exactly what lets each project's program be RELEASED after a
// capture pass: everything AST- or checker-derived (positions, texts, symbol
// declaration locations, polymorphism, invocation proofs) is computed while
// the program is alive, and only the string-keyed lookups into the corpus-wide
// location→id map are deferred to a final, compiler-free finishing pass. Peak
// memory becomes the largest single project instead of the sum of all of them.

export interface DeferredImportBinding {
  binding: Omit<CompilerImportBinding, "targetId">;
  /** Declaration locations of the imported symbol (alias-resolved). */
  targetLocations: readonly string[];
}

export type CapturedReference =
  | { form: "final"; position: number; identityHint: string; reference: Omit<CompilerReference, "id"> }
  | {
      form: "import"; position: number; line: number; column: number; sourceId: string;
      bindingId: string; moduleSpecifier: string; resolvedFilePath?: string;
    }
  | {
      form: "call"; position: number; line: number; column: number; sourceId: string;
      isNew: boolean; targetName: string; receiver?: string; polymorphic: boolean;
      candidateLocations: readonly string[]; expressionText: string; signatureText?: string;
    }
  | {
      form: "heritage"; position: number; line: number; column: number; sourceId: string;
      isImplements: boolean; targetName: string; targetLocations: readonly string[];
    }
  | {
      form: "identifier"; position: number; line: number; column: number; sourceId: string;
      text: string; receiver?: string; targetLocations: readonly string[];
    }
  | {
      form: "callback"; position: number; line: number; column: number;
      calleeLocations: readonly string[]; callbackDraftId?: string;
      callbackLocations: readonly string[]; parameterName: string; argumentIndex: number;
      wiringSite: string; argumentText: string;
    };

/** Everything retained for a file once its project's program is released. */
interface CapturedFile {
  filePath: string;
  language: CompilerSourceLanguage;
  projectId: string;
  health: CompilerSourceHealth;
  nodes: CompilerExtractedNode[];
  fileDraftId?: string;
  bindings: DeferredImportBinding[];
  captured: CapturedReference[];
  /** Declaration location → node id for this file's declarations. */
  locations: Array<[string, string]>;
  resolvedSpecifiers: string[];
}

/** Capture-time half of the old `idsForSymbol`: symbol → declaration locations. */
function declarationLocationsForSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): string[] {
  if (!symbol) return [];
  const resolved = canonicalSymbol(symbol, checker);
  // A union property's declarations come in the checker's type-id order;
  // sorted, the capture is a function of the code (issue #209).
  return [...new Set((resolved.declarations ?? []).map(declarationLocation))].sort(compareCodePoints);
}

/** Finish-time half: locations → the same sorted unique ids `idsForSymbol` produced. */
function idsForLocations(
  locations: readonly string[],
  locationIds: ReadonlyMap<string, string>,
): string[] {
  const ids = new Set<string>();
  for (const location of locations) {
    const id = locationIds.get(location);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".mex",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

/**
 * Find every tsconfig project below `rootDir`, including referenced projects.
 * The returned paths and file lists are repository-relative and deterministic.
 */
export function discoverTypeScriptProjects(
  rootDir: string,
  candidateFiles?: readonly string[],
): DiscoveredTypeScriptProject[] {
  const root = resolve(rootDir);
  const candidates = candidateFiles
    ? new Set(candidateFiles.map((file) => absoluteCandidate(root, file)))
    : undefined;
  return parseProjects(root, candidates).map((project) => ({
    id: project.id,
    configPath: relativePath(root, project.configPath),
    projectReferences: (project.parsed.projectReferences ?? [])
      .map((reference) => relativePath(root, ts.resolveProjectReferencePath(reference)))
      .sort(),
    configuredFilePaths: project.parsed.fileNames
      .map((file) => normalizedAbsolute(file))
      .filter((file) => !candidates || candidates.has(file))
      .filter((file) => withinRoot(root, file))
      .map((file) => relativePath(root, file))
      .sort(),
    diagnostics: project.diagnostics.map(summarizeDiagnostic),
  }));
}

/**
 * Build compiler programs and extract a complete staged TS/JS graph corpus.
 * Nothing is persisted here: callers can validate every invariant before a DB
 * transaction publishes the result.
 */
export function buildTypeScriptExtraction(
  rootDir: string,
  candidateFiles?: readonly string[],
  options: CompilerExtractionOptions = {},
  /** Internal construction observer; no source identity crosses this seam. */
  onFileCaptured?: (completed: number) => void,
): CompilerExtractionResult {
  const root = resolve(rootDir);
  const inputs = new CompilerInputLedger(root, options);
  const candidates = collectCandidates(root, candidateFiles, inputs);
  inputs.setCandidateFiles(candidates);
  const candidateSet = new Set(candidates);
  const parsedProjects = parseProjects(root, candidateSet, inputs);
  const createProgram = options.programFactory ?? ts.createProgram;
  const semanticDiagnostics = options.semanticDiagnostics ?? false;

  // Ownership priority: most specific config directory first, then path order —
  // the identical comparator the previous probe-every-program-then-sort
  // implementation applied per file. Processing projects in this global order
  // lets each candidate be claimed greedily by the FIRST containing project
  // (the same winner), without holding every program alive to compare.
  const processingOrder = [...parsedProjects].sort((left, right) => {
    const specificity = dirname(right.configPath).length - dirname(left.configPath).length;
    return specificity || left.configPath.localeCompare(right.configPath);
  });

  const claimed = new Set<string>();
  const poisonedFiles = new Set<string>();
  const crashedProjects = new Set<ParsedProject>();
  const locationIds = new Map<string, string>();
  const nodeById = new Map<string, CompilerExtractedNode>();
  const capturedByFile = new Map<string, CapturedFile>();
  const dependenciesByFile = new Map<string, FileDependencies>();
  const projectStates: Record<string, string> = {};
  const incremental = options.incremental;
  const rootPrefix = `${normalizedAbsolute(root)}/`;
  const reusedFiles: string[] = [];
  let recaptured = 0;

  // Stage one project's owned files while its program is alive; retain only
  // plain data. Nothing stored here references the program, checker, or AST.
  const processProject = (project: ParsedProject, program: ts.Program, owned: readonly string[]): void => {
    const runtime: RuntimeProject = {
      ...project, program, checker: program.getTypeChecker(), root, callSignatureTexts: new Map(),
    };
    for (const absoluteFile of owned) {
      const sourceFile = program.getSourceFile(absoluteFile);
      if (sourceFile) dependenciesByFile.set(absoluteFile, fileDependencies(program, sourceFile, root, candidateSet));
    }
    const state = projectInputState(program, root, candidateSet, dependenciesByFile);
    projectStates[project.id] = state;
    // Incremental extraction (issue #209): an unaffected file's capture is a
    // function of its own bytes, the files it imports (transitively) and the
    // inputs every file sees without an import. The caller puts every file
    // that imports a changed file into `affected`; this project's global and
    // external inputs are compared here, and any change extracts in full.
    const reused = new Map<string, CapturedFile>();
    if (incremental) {
      if (incremental.projectStates[project.id] !== state) {
        throw new CompilerIncrementalFallback("a global declaration or an external compiler input changed");
      }
      for (const absoluteFile of owned) {
        const filePath = relativePath(root, absoluteFile);
        const previous = incremental.previous.get(filePath);
        if (previous && previous.projectId !== project.id) {
          throw new CompilerIncrementalFallback("a file moved to another compiler project");
        }
        if (previous && !incremental.affected.has(filePath)) {
          // An unaffected file resolves exactly as before; anything else means
          // the affected set missed a dependency, and nothing is reused.
          const current = dependenciesByFile.get(absoluteFile);
          if (!current || !sameDependencies(current, previous)) {
            throw new CompilerIncrementalFallback("an unaffected file's module resolution changed");
          }
          reused.set(absoluteFile, restoreCapture(previous, rootPrefix));
          reusedFiles.push(filePath);
        }
      }
    }
    const contexts: FileContext[] = [];
    const visitOrder = options.visitOrder ? options.visitOrder(owned) : owned;
    if (visitOrder.length !== owned.length || !owned.every((file) => visitOrder.includes(file))) {
      throw new Error("A compiler visit order must be a permutation of the owned files.");
    }
    for (const absoluteFile of visitOrder) {
      if (reused.has(absoluteFile)) continue;
      const sourceFile = program.getSourceFile(absoluteFile);
      if (!sourceFile) continue;
      const filePath = relativePath(root, absoluteFile);
      const { health, ranges } = timeGraphPhase(
        "compiler.diagnostics",
        () => sourceHealth(program, sourceFile, semanticDiagnostics),
      );
      const context: FileContext = {
        filePath,
        sourceFile,
        project: runtime,
        language: languageForFile(filePath),
        health,
        errorRanges: ranges,
        excludedDeclarationRanges: [],
        drafts: [],
        declarationDrafts: new Map(),
        symbolDrafts: new Map(),
        nodes: [],
      };
      if (health.status !== "failed") {
        collectDrafts(context);
        if (health.status === "partial" && context.drafts.length <= 1) {
          health.status = "failed";
          context.drafts = [];
          context.fileDraft = undefined;
          context.declarationDrafts.clear();
          context.symbolDrafts.clear();
        }
      }
      contexts.push(context);
    }

    assignCanonicalIdentities(contexts);
    const contextLocations = new Map<FileContext, Array<[string, string]>>();
    for (const context of contexts) {
      const locations: Array<[string, string]> = [];
      for (const draft of context.drafts) {
        if (!draft.id) continue;
        for (const declaration of draft.declarations) {
          const location = declarationLocation(declaration);
          locationIds.set(location, draft.id);
          locations.push([location, draft.id]);
        }
      }
      contextLocations.set(context, locations);
      context.nodes = materializeNodes(context);
      for (const node of context.nodes) nodeById.set(node.id, node);
    }
    for (const captured of reused.values()) {
      for (const [location, id] of captured.locations) locationIds.set(location, id);
      for (const node of captured.nodes) nodeById.set(node.id, node);
    }
    for (const context of contexts) {
      const resolvedSpecifiers: string[] = [];
      const bindings = captureImportBindings(root, context, inputs, resolvedSpecifiers);
      capturedByFile.set(normalizedAbsolute(context.sourceFile.fileName), {
        filePath: context.filePath,
        language: context.language,
        projectId: runtime.id,
        health: context.health,
        nodes: context.nodes,
        fileDraftId: context.fileDraft?.id,
        bindings,
        captured: captureReferences(context, bindings),
        locations: contextLocations.get(context)!,
        resolvedSpecifiers,
      });
      recaptured++;
      onFileCaptured?.(capturedByFile.size);
    }
    for (const [absoluteFile, captured] of reused) {
      // Import capture resolves each specifier through the input ledger; the
      // same probes keep the recorded semantic inputs identical to a capture.
      const options = program.getCompilerOptions();
      for (const specifier of captured.resolvedSpecifiers) {
        ts.resolveModuleName(specifier, absoluteFile, options, inputs.moduleResolutionHost());
      }
      capturedByFile.set(absoluteFile, captured);
      onFileCaptured?.(capturedByFile.size);
    }
  };

  for (const project of processingOrder) {
    // Program creation parses every root file; a single malformed source (e.g.
    // a hostile test fixture) can hit a TS-internal assertion. Isolate the
    // failure to this project so its files fall back to tree-sitter extraction
    // instead of aborting the whole corpus (issue #140 follow-up finding).
    let program: ts.Program;
    const programStarted = performance.now();
    try {
      program = createProgram({
        rootNames: project.parsed.fileNames,
        // Never type-check library .d.ts or emit: extraction only needs the
        // checker's lazy symbol/type queries, not a full compile.
        options: { ...project.parsed.options, skipLibCheck: true, noEmit: true },
        projectReferences: project.parsed.projectReferences,
        host: inputs.compilerHost({ ...project.parsed.options, skipLibCheck: true, noEmit: true }),
      });
    } catch {
      crashedProjects.add(project);
      // Poison only files no healthier, more specific project has already
      // extracted — a crash cannot retroactively un-stage a good extraction.
      for (const file of project.parsed.fileNames) {
        const absolute = normalizedAbsolute(file);
        if (!claimed.has(absolute)) poisonedFiles.add(absolute);
      }
      continue;
    } finally {
      recordGraphPhase("compiler.program", performance.now() - programStarted);
    }
    const owned = candidates.filter((file) => {
      if (claimed.has(file) || poisonedFiles.has(file)) return false;
      try { return program.getSourceFile(file) !== undefined; }
      catch { return false; }
    });
    for (const file of owned) claimed.add(file);
    timeGraphPhase("compiler.capture", () => processProject(project, program, owned));
    // program goes out of scope here — the peak-memory point of the old
    // implementation (every program + checker alive simultaneously) is gone.
  }

  // Files from a crashed project stay out of the inferred program too — the
  // poison root file would crash it as well. They fall back to tree-sitter.
  const uncovered = candidates.filter((file) => !claimed.has(file) && !poisonedFiles.has(file));
  let inferredProject: ParsedProject | undefined;
  if (uncovered.length > 0) {
    const inferredOptions: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      ...options.inferredCompilerOptions,
    };
    try {
      const program = timeGraphPhase("compiler.program", () => createProgram({
        rootNames: uncovered,
        options: inferredOptions,
        host: inputs.compilerHost(inferredOptions),
      }));
      inferredProject = {
        id: "inferred",
        configPath: "",
        parsed: {
          options: inferredOptions,
          fileNames: uncovered,
          errors: [],
        },
        diagnostics: [],
      };
      timeGraphPhase("compiler.capture", () => processProject(inferredProject!, program, uncovered));
    } catch {
      // Poison among the uncovered roots: leave them all to tree-sitter.
    }
  }

  // ── Finishing pass: compiler-free. Resolve deferred declaration locations
  // against the now-complete corpus-wide location→id map, replaying exactly
  // the id/status/candidate logic the old concurrent implementation applied.
  const fileDraftIdByPath = new Map<string, string>();
  for (const captured of capturedByFile.values()) {
    if (captured.fileDraftId) fileDraftIdByPath.set(captured.filePath, captured.fileDraftId);
  }

  const finishStarted = performance.now();
  const files: CompilerFileExtraction[] = [];
  const captures: CompilerFileCapture[] = [];
  for (const absoluteFile of candidates) {
    const captured = capturedByFile.get(absoluteFile);
    if (!captured) continue;
    const dependencies = dependenciesByFile.get(absoluteFile)
      ?? { dependencies: [], failedLookups: [], globalScope: true };
    captures.push(portableCapture(captured, dependencies, rootPrefix));
    const importBindings: CompilerImportBinding[] = captured.bindings.map(({ binding, targetLocations }) => ({
      ...binding,
      targetId: idsForLocations(targetLocations, locationIds)[0],
    }));
    files.push({
      filePath: captured.filePath,
      language: captured.language,
      projectId: captured.projectId,
      health: captured.health,
      nodes: captured.nodes,
      importBindings,
      references: finishReferences(captured, importBindings, locationIds, nodeById, fileDraftIdByPath),
    } satisfies CompilerFileExtraction);
  }

  recordGraphPhase("compiler.finish", performance.now() - finishStarted);

  const summaryProjects: ParsedProject[] = [
    ...parsedProjects.filter((project) => !crashedProjects.has(project)),
    ...(inferredProject ? [inferredProject] : []),
  ];
  const projectSummaries: DiscoveredTypeScriptProject[] = summaryProjects.map((project) => ({
    id: project.id,
    configPath: project.configPath ? relativePath(root, project.configPath) : null,
    projectReferences: (project.parsed.projectReferences ?? [])
      .map((reference) => relativePath(root, ts.resolveProjectReferencePath(reference)))
      .sort(),
    configuredFilePaths: files
      .filter((file) => file.projectId === project.id)
      .map((file) => file.filePath)
      .sort(),
    diagnostics: project.diagnostics.map(summarizeDiagnostic),
  }));

  return {
    compilerVersion: ts.version,
    extractorVersion: TYPESCRIPT_COMPILER_EXTRACTOR_VERSION,
    projects: projectSummaries,
    files,
    semanticInputs: inputs.semanticInputs(),
    declinedInputs: inputs.declinedConfigInputs(),
    captures,
    projectStates,
    recaptured,
    reused: reusedFiles.sort(compareCodePoints),
  };
}

function sameDependencies(current: FileDependencies, previous: FileDependencies): boolean {
  return current.globalScope === previous.globalScope
    && current.dependencies.join("\n") === previous.dependencies.join("\n")
    && current.failedLookups.join("\n") === previous.failedLookups.join("\n");
}

interface FileDependencies {
  dependencies: string[];
  failedLookups: string[];
  globalScope: boolean;
}

interface ProgramResolutions {
  forEachResolvedModule?(
    callback: (resolution: { resolvedModule?: ts.ResolvedModuleFull; failedLookupLocations?: readonly string[] }) => void,
    file: ts.SourceFile,
  ): void;
  forEachResolvedTypeReferenceDirective?(
    callback: (resolution: {
      resolvedTypeReferenceDirective?: ts.ResolvedTypeReferenceDirective;
      failedLookupLocations?: readonly string[];
    }) => void,
    file: ts.SourceFile,
  ): void;
}

/**
 * The corpus files one file's compiler facts can depend on through module
 * resolution, and the corpus paths whose appearance would change a resolution.
 * Read from the program's own resolution cache, so it is exactly what the
 * checker used.
 */
function fileDependencies(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  root: string,
  candidates: ReadonlySet<string>,
): FileDependencies {
  const resolutions = program as ts.Program & ProgramResolutions;
  const dependencies = new Set<string>();
  const failedLookups = new Set<string>();
  const addTarget = (fileName: string | undefined): void => {
    if (!fileName) return;
    const absolute = normalizedAbsolute(fileName);
    if (candidates.has(absolute)) dependencies.add(relativePath(root, absolute));
  };
  const addFailed = (locations: readonly string[] | undefined): void => {
    for (const location of locations ?? []) {
      const absolute = normalizedAbsolute(location);
      if (withinRoot(root, absolute) && isCompilerSourceFile(absolute)) failedLookups.add(relativePath(root, absolute));
    }
  };
  if (!resolutions.forEachResolvedModule || !resolutions.forEachResolvedTypeReferenceDirective) {
    // Without the resolution cache nothing proves a file independent of others.
    return { dependencies: [], failedLookups: [], globalScope: true };
  }
  resolutions.forEachResolvedModule((resolution) => {
    addTarget(resolution.resolvedModule?.resolvedFileName);
    addFailed(resolution.failedLookupLocations);
  }, sourceFile);
  resolutions.forEachResolvedTypeReferenceDirective((resolution) => {
    addTarget(resolution.resolvedTypeReferenceDirective?.resolvedFileName);
    addFailed(resolution.failedLookupLocations);
  }, sourceFile);
  for (const reference of sourceFile.referencedFiles) {
    const absolute = normalizedAbsolute(resolve(dirname(sourceFile.fileName), reference.fileName));
    addTarget(absolute);
    if (!candidates.has(absolute)) addFailed([absolute]);
  }
  return {
    dependencies: [...dependencies].sort(compareCodePoints),
    failedLookups: [...failedLookups].sort(compareCodePoints),
    globalScope: isGlobalScopeSource(sourceFile),
  };
}

/**
 * Declarations another file can see without importing this one: a script
 * (neither an ES nor a CommonJS module), any declaration file, a global
 * augmentation, an ambient or augmenting `declare module "name"`, or a UMD
 * global. The source file must be bound, which creating the checker does.
 */
export function isGlobalScopeSource(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return true;
  // The binder records a CommonJS module; the parser records an ES module.
  const indicators = sourceFile as ts.SourceFile & { externalModuleIndicator?: unknown; commonJsModuleIndicator?: unknown };
  if (indicators.externalModuleIndicator === undefined && indicators.commonJsModuleIndicator === undefined) return true;
  return declaresGlobals(sourceFile);
}

/** The syntactic half of {@link isGlobalScopeSource}; needs no binding. */
export function declaresGlobals(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => ts.isNamespaceExportDeclaration(statement)
    || (ts.isModuleDeclaration(statement)
      && (ts.isStringLiteral(statement.name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0)));
}

/**
 * A digest of every input a program's files can see without importing it:
 * every global-scope corpus file and every non-corpus file (libraries,
 * dependencies, JSON) in the program, with their exact bytes. Corpus modules
 * are left out; they are tracked file by file.
 */
function projectInputState(
  program: ts.Program,
  root: string,
  candidates: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, FileDependencies>,
): string {
  const entries: string[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    const absolute = normalizedAbsolute(sourceFile.fileName);
    if (candidates.has(absolute)) {
      const global = dependencies.get(absolute)?.globalScope ?? isGlobalScopeSource(sourceFile);
      if (!global) continue;
    }
    entries.push(`${portableInputPath(root, absolute)}\u0000${sha256(sourceFile.text)}`);
  }
  entries.sort(compareCodePoints);
  return sha256(entries.join("\n"));
}

/** Root-relative inside the root; from the last `node_modules` segment outside it. */
function portableInputPath(root: string, absolute: string): string {
  if (withinRoot(root, absolute)) return relativePath(root, absolute);
  const segments = absolute.split("/");
  const dependencyRoot = segments.lastIndexOf("node_modules");
  return dependencyRoot >= 0 ? segments.slice(dependencyRoot).join("/") : absolute;
}

function mapCaptureLocations(
  captured: CapturedReference[],
  bindings: DeferredImportBinding[],
  locations: Array<[string, string]>,
  map: (location: string) => string,
): Pick<CompilerFileCapture, "captured" | "bindings" | "locations"> {
  const all = (values: readonly string[]): string[] => values.map(map);
  return {
    locations: locations.map(([location, id]) => [map(location), id]),
    bindings: bindings.map((entry) => ({ ...entry, targetLocations: all(entry.targetLocations) })),
    captured: captured.map((record): CapturedReference => {
      switch (record.form) {
        case "call": return { ...record, candidateLocations: all(record.candidateLocations) };
        case "heritage": return { ...record, targetLocations: all(record.targetLocations) };
        case "identifier": return { ...record, targetLocations: all(record.targetLocations) };
        case "callback": return {
          ...record,
          calleeLocations: all(record.calleeLocations),
          callbackLocations: all(record.callbackLocations),
        };
        default: return record;
      }
    }),
  };
}

function portableCapture(
  captured: CapturedFile,
  dependencies: FileDependencies,
  rootPrefix: string,
): CompilerFileCapture {
  return {
    filePath: captured.filePath,
    language: captured.language,
    projectId: captured.projectId,
    health: captured.health,
    nodes: captured.nodes,
    ...(captured.fileDraftId ? { fileDraftId: captured.fileDraftId } : {}),
    ...mapCaptureLocations(captured.captured, captured.bindings, captured.locations, (location) =>
      location.startsWith(rootPrefix) ? `./${location.slice(rootPrefix.length)}` : location),
    resolvedSpecifiers: captured.resolvedSpecifiers,
    ...dependencies,
  };
}

function restoreCapture(capture: CompilerFileCapture, rootPrefix: string): CapturedFile {
  return {
    filePath: capture.filePath,
    language: capture.language,
    projectId: capture.projectId,
    health: capture.health,
    nodes: capture.nodes,
    fileDraftId: capture.fileDraftId,
    ...mapCaptureLocations(capture.captured, capture.bindings, capture.locations, (location) =>
      location.startsWith("./") ? `${rootPrefix}${location.slice(2)}` : location),
    resolvedSpecifiers: capture.resolvedSpecifiers,
  };
}

/** Bounded like every other diagnostic channel; the list is deduplicated. */
const MAX_DECLINED_CONFIG_INPUTS = 100;

/**
 * Name a declined path by what the user can act on.
 *
 * TypeScript resolves a bare `extends` specifier by walking every ancestor
 * directory, so one unresolvable `extends "astro/tsconfigs/strict"` produces a
 * decline at `<root>/node_modules/...`, `<parent>/node_modules/...` and so on
 * up to the filesystem root. Reporting each rung is noise, and it puts absolute
 * paths from outside the repository — a user's home directory among them — into
 * build output.
 *
 * Keying on the dependency specifier collapses those rungs to the one fact
 * worth reporting: this package is not resolvable inside the project. Paths
 * with no `node_modules` segment are reported relative to the root instead.
 */
function reportableDeclinedPath(root: string, fileName: string): string {
  const absolute = normalizedAbsolute(absoluteCandidate(root, fileName));
  const segments = absolute.split("/");
  const lastDependencyRoot = segments.lastIndexOf("node_modules");
  if (lastDependencyRoot >= 0) return segments.slice(lastDependencyRoot).join("/");
  return normalizeRelative(relative(root, absolute)) || absolute;
}

/** Stable identity input shared with migration/invariant tests. */
export function canonicalCompilerIdentity(input: {
  filePath: string;
  kind: CompilerNodeKind;
  qualifiedName: string;
  declarationRole: string;
  signature?: string;
  ordinal?: number;
}): string {
  const base = [
    normalizeRelative(input.filePath),
    input.kind,
    normalizeQualifiedName(input.qualifiedName),
    normalizeSignature(input.declarationRole),
    normalizeSignature(input.signature ?? ""),
  ].join("\u0000");
  return input.ordinal === undefined ? base : `${base}\u0000ordinal:${input.ordinal}`;
}

export function generateCanonicalCompilerNodeId(
  kind: CompilerNodeKind,
  identityKey: string,
): string {
  return `${kind}:${sha256(identityKey).slice(0, 32)}`;
}

/**
 * Produce spelling-independent compiler tokens for fingerprinting extracted
 * nodes. Identifiers and literals are represented only by SyntaxKind, so a
 * rename or constant edit does not erase structural similarity. Overload spans
 * are scanned independently and joined with an explicit boundary token.
 */
export function normalizedCompilerTokens(
  source: string,
  nodes: readonly Pick<CompilerExtractedNode, "id" | "language" | "declarationSpans">[],
): Map<string, string[]> {
  const lineStarts = sourceLineStarts(source);
  return new Map(nodes.map((node) => {
    const tokens: string[] = [];
    const variant = node.language === "tsx" || node.language === "jsx"
      ? ts.LanguageVariant.JSX
      : ts.LanguageVariant.Standard;
    node.declarationSpans.forEach((span, index) => {
      if (index > 0) tokens.push("OverloadBoundary");
      const start = sourceOffset(lineStarts, span.startLine, span.startColumn, source.length);
      const end = sourceOffset(lineStarts, span.endLine, span.endColumn, source.length);
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        variant,
        source.slice(start, Math.max(start, end)),
      );
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        tokens.push(ts.SyntaxKind[token] ?? `SyntaxKind:${token}`);
      }
    });
    return [node.id, tokens];
  }));
}

type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => { files: string[]; directories: string[] },
  realpath: (path: string) => string,
) => string[];

/**
 * One immutable view of repository inputs for the complete compiler pass.
 * Project files are read at most once; explicitly staged bytes always win.
 * TypeScript libraries and ignored dependency/build directories retain the
 * compiler's normal filesystem behavior and do not become graph provenance.
 */
class CompilerInputLedger {
  private readonly root: string;
  private readonly staged = new Map<string, string>();
  private readonly cache = new Map<string, string | undefined>();
  private readonly observed = new Map<string, string | null>();
  private readonly knownPaths = new Set<string>();
  private readonly knownDirectories = new Set<string>();
  private readonly directoryFiles = new Map<string, Set<string>>();
  private readonly directoryChildren = new Map<string, Set<string>>();
  private readonly declinedConfigs = new Map<string, string>();
  /** Parsed source files shared by every program of one extraction; see {@link compilerHost}. */
  private readonly sourceFiles = new Map<string, ts.SourceFile>();
  private candidates: string[] = [];

  constructor(root: string, private readonly options: CompilerExtractionOptions) {
    this.root = resolve(root);
    for (const input of options.stagedInputs ?? []) {
      const absolute = absoluteCandidate(this.root, input.filePath);
      if (!withinRoot(this.root, absolute)) {
        throw new Error(`Compiler staged input escapes the project root: ${input.filePath}`);
      }
      const previous = this.staged.get(absolute);
      if (previous !== undefined && previous !== input.source) {
        throw new Error(`Compiler staged input has conflicting bytes: ${input.filePath}`);
      }
      this.staged.set(absolute, input.source);
      this.indexKnownFile(absolute);
    }
    this.knownDirectories.add(normalizedAbsolute(this.root));
  }

  hasStagedInput(fileName: string): boolean {
    return this.staged.has(absoluteCandidate(this.root, fileName));
  }

  setCandidateFiles(files: readonly string[]): void {
    this.candidates = [...files].map(normalizedAbsolute).sort(compareCodePoints);
    for (const file of this.candidates) this.indexKnownFile(file);
  }

  configFiles(): string[] {
    if (this.options.stagedInputs === undefined) return findConfigFiles(this.root);
    return [...this.staged.keys()]
      .filter((file) => /^tsconfig(?:\.[^.]+)?\.json$/u.test(file.split("/").at(-1) ?? ""))
      .sort(compareCodePoints);
  }

  readFile(fileName: string): string | undefined {
    const absolute = absoluteCandidate(this.root, fileName);
    const staged = this.staged.get(absolute);
    if (staged !== undefined) {
      this.observe(absolute, staged);
      return staged;
    }
    if (!withinRoot(this.root, absolute)) {
      return isAllowedCompilerDependency(absolute) ? ts.sys.readFile(fileName) : undefined;
    }
    if (!this.isProjectInput(absolute)) {
      return isAllowedCompilerDependency(absolute) ? ts.sys.readFile(fileName) : undefined;
    }
    if (this.cache.has(absolute)) return this.cache.get(absolute);
    const source = this.options.readProjectFile
      ? this.options.readProjectFile(absolute)
      : ts.sys.readFile(fileName);
    this.cache.set(absolute, source);
    if (source !== undefined) {
      this.indexKnownFile(absolute);
      this.observe(absolute, source);
    }
    else this.observeMissing(absolute);
    return source;
  }

  /**
   * Read one config input, or decline it.
   *
   * A config path outside the project root used to throw, which took the
   * entire build down: a `tsconfig.json` extending a package hoisted above the
   * root — any pnpm/yarn hoisted layout, or a monorepo sub-package indexed on
   * its own — made the repository un-indexable. `readFile` had always treated
   * the identical condition as a soft miss for *source* files; the two halves
   * of this class simply disagreed.
   *
   * The containment guard is unchanged and still declines. Declining now
   * returns "no such config", which is the honest answer for a file we will
   * not read, and is recorded so the degradation is reported rather than
   * silent. The type graph is less complete; the build finishes.
   */
  readConfigFile(fileName: string): string | undefined {
    const absolute = absoluteCandidate(this.root, fileName);
    if (!this.permitsConfigInput(absolute, fileName)) return undefined;
    return this.readFile(absolute);
  }

  /**
   * Answer TypeScript's existence probe for a config path.
   *
   * This is a probe, not a read request. The honest answer for a path we have
   * declined to read is `false`.
   */
  configFileExists(fileName: string): boolean {
    const absolute = absoluteCandidate(this.root, fileName);
    if (!this.permitsConfigInput(absolute, fileName)) return false;
    return this.fileExists(absolute);
  }

  /** Record and decline a config input the containment policy will not read. */
  private permitsConfigInput(absolute: string, fileName: string): boolean {
    if (!withinRoot(this.root, absolute)) {
      this.declineConfigInput(fileName, "escapes the project root");
      return false;
    }
    if (!this.isProjectInput(absolute) && !isAllowedCompilerDependency(absolute)) {
      this.declineConfigInput(fileName, "is outside the supported project corpus");
      return false;
    }
    return true;
  }

  private declineConfigInput(fileName: string, reason: string): void {
    const reported = reportableDeclinedPath(this.root, fileName);
    if (this.declinedConfigs.has(reported)) return;
    if (this.declinedConfigs.size >= MAX_DECLINED_CONFIG_INPUTS) return;
    this.declinedConfigs.set(
      reported,
      `TypeScript config ${reason} and was not read: ${reported}`,
    );
  }

  /** Record a referenced project outside the root, which we do not traverse. */
  declineProjectReference(referencePath: string): void {
    this.declineConfigInput(referencePath, "project reference escapes the project root");
  }

  /** Config inputs the containment policy declined, in deterministic order. */
  declinedConfigInputs(): DeclinedCompilerInput[] {
    return [...this.declinedConfigs.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([filePath, message]) => ({
        filePath,
        reason: "outside-project-corpus" as const,
        message,
      }));
  }

  fileExists(fileName: string): boolean {
    const absolute = absoluteCandidate(this.root, fileName);
    if (this.staged.has(absolute)) return true;
    if (!withinRoot(this.root, absolute)) {
      return isAllowedCompilerDependency(absolute) && ts.sys.fileExists(fileName);
    }
    if (!this.isProjectInput(absolute)) {
      return isAllowedCompilerDependency(absolute) && ts.sys.fileExists(fileName);
    }
    return this.readFile(absolute) !== undefined;
  }

  directoryExists(directoryName: string): boolean {
    const absolute = absoluteCandidate(this.root, directoryName);
    if (!withinRoot(this.root, absolute)) {
      return isAllowedCompilerDependency(absolute) && ts.sys.directoryExists(absolute);
    }
    if (!this.isProjectInput(absolute)) {
      return isAllowedCompilerDependency(absolute) && ts.sys.directoryExists(absolute);
    }
    return this.knownDirectories.has(absolute);
  }

  getDirectories(directoryName: string): string[] {
    const absolute = absoluteCandidate(this.root, directoryName);
    if (!withinRoot(this.root, absolute)) {
      return isAllowedCompilerDependency(absolute) ? ts.sys.getDirectories(absolute) : [];
    }
    if (!this.isProjectInput(absolute)) {
      return isAllowedCompilerDependency(absolute) ? ts.sys.getDirectories(absolute) : [];
    }
    return [...(this.directoryChildren.get(absolute) ?? [])]
      .map((name) => resolve(absolute, name))
      .sort(compareCodePoints);
  }

  readDirectory(
    rootDir: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
    depth?: number,
  ): string[] {
    // Treated exactly like a declined config read. A tsconfig `include` that
    // points above the project root describes files we will not walk, and the
    // honest answer for a directory we decline is "no matching files" — not an
    // exception that costs the whole repository its graph.
    if (!withinRoot(this.root, absoluteCandidate(this.root, rootDir))) {
      this.declineConfigInput(rootDir, "include escapes the project root");
      return [];
    }
    // TypeScript's matcher is intentionally used with a virtual directory tree
    // built only from the immutable candidate list. This preserves exact
    // tsconfig include/exclude semantics without consulting a racing checkout.
    const matchFiles = (ts as unknown as { matchFiles?: MatchFiles }).matchFiles;
    if (!matchFiles) {
      throw new Error("The pinned TypeScript compiler does not expose its deterministic file matcher.");
    }
    return matchFiles(
      rootDir,
      extensions,
      excludes,
      includes,
      ts.sys.useCaseSensitiveFileNames,
      this.root,
      depth,
      (directory) => this.virtualDirectoryEntries(directory),
      (path) => normalizedAbsolute(path),
    );
  }

  compilerHost(options: ts.CompilerOptions): ts.CompilerHost {
    const base = ts.createCompilerHost(options, true);
    const settings = sourceFileSettingsKey(options);
    const getSourceFile: ts.CompilerHost["getSourceFile"] = (
      fileName,
      languageVersionOrOptions,
      onError,
    ) => {
      const source = this.readFile(fileName);
      if (source === undefined) {
        onError?.(`Could not read compiler input ${fileName}.`);
        return undefined;
      }
      // A repository with several tsconfig projects parsed its shared sources
      // and every library once per project (issue #209). A parsed and bound
      // source file is shared between programs whose settings agree on every
      // option that affects parsing or binding: the rule TypeScript itself
      // applies when it reuses source files across programs. The bytes are
      // the ledger's, identical for the whole extraction.
      //
      // A declaration file (the libraries above all) is shared more widely.
      // Every other input its parse and bind read is in the key below: module
      // detection resolves to its own syntax in every mode, strict mode comes
      // from that alone, no implicit helper or JSX import is added to it, and
      // the remaining options the binder reads concern executable statements,
      // switches and labels, which a declaration file does not contain.
      const parse = typeof languageVersionOrOptions === "number"
        ? { languageVersion: languageVersionOrOptions }
        : languageVersionOrOptions;
      const key = [
        DECLARATION_FILE.test(fileName) ? "declaration" : settings,
        normalizedAbsolute(fileName),
        parse.languageVersion,
        parse.impliedNodeFormat ?? "",
        parse.jsDocParsingMode ?? "",
      ].join("\u0000");
      const shared = this.sourceFiles.get(key);
      if (shared && shared.text === source) return shared;
      const parsed = ts.createSourceFile(
        fileName,
        source,
        languageVersionOrOptions,
        true,
        scriptKindForFile(fileName),
      );
      this.sourceFiles.set(key, parsed);
      return parsed;
    };
    return {
      ...base,
      fileExists: (fileName) => this.fileExists(fileName),
      directoryExists: (directoryName) => this.directoryExists(directoryName),
      getDirectories: (directoryName) => this.getDirectories(directoryName),
      readFile: (fileName) => this.readFile(fileName),
      readDirectory: (rootDir, extensions, excludes, includes, depth) =>
        this.readDirectory(rootDir, extensions, excludes, includes, depth),
      getSourceFile,
      getSourceFileByPath: (fileName, _path, languageVersionOrOptions, onError) =>
        getSourceFile(fileName, languageVersionOrOptions, onError),
      realpath: (path) => this.isProjectInput(absoluteCandidate(this.root, path))
        ? absoluteCandidate(this.root, path)
        : (base.realpath?.(path) ?? path),
    };
  }

  moduleResolutionHost(): ts.ModuleResolutionHost {
    return {
      fileExists: (fileName) => this.fileExists(fileName),
      readFile: (fileName) => this.readFile(fileName),
      directoryExists: (directoryName) => this.directoryExists(directoryName),
      getDirectories: (directoryName) => this.getDirectories(directoryName),
      realpath: (path) => this.isProjectInput(absoluteCandidate(this.root, path))
        ? absoluteCandidate(this.root, path)
        : (ts.sys.realpath?.(path) ?? path),
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    };
  }

  semanticInputs(): CompilerSemanticInput[] {
    return [...this.observed.entries()]
      .map(([file, contentHash]) => ({ filePath: relativePath(this.root, file), contentHash }))
      .sort((left, right) => compareCodePoints(left.filePath, right.filePath));
  }

  private observe(absolute: string, source: string): void {
    const contentHash = sha256(source);
    const previous = this.observed.get(absolute);
    if (previous !== undefined && previous !== contentHash) {
      throw new Error(`Compiler input changed during extraction: ${relativePath(this.root, absolute)}`);
    }
    this.observed.set(absolute, contentHash);
  }

  private observeMissing(absolute: string): void {
    if (negativeProbeCoveredByCorpusPolicy(absolute)) return;
    if (!this.observed.has(absolute)) {
      this.observed.set(absolute, null);
      return;
    }
    if (this.observed.get(absolute) !== null) {
      throw new Error(`Compiler input changed during extraction: ${relativePath(this.root, absolute)}`);
    }
  }

  private isProjectInput(absolute: string): boolean {
    if (!withinRoot(this.root, absolute)) return false;
    const parts = relativePath(this.root, absolute).split("/");
    return !parts.some((part) => IGNORED_DIRECTORIES.has(part));
  }

  private virtualDirectoryEntries(directory: string): { files: string[]; directories: string[] } {
    const absoluteDirectory = normalizedAbsolute(directory);
    return {
      files: [...(this.directoryFiles.get(absoluteDirectory) ?? [])].sort(compareCodePoints),
      directories: [...(this.directoryChildren.get(absoluteDirectory) ?? [])].sort(compareCodePoints),
    };
  }

  private indexKnownFile(file: string): void {
    const absolute = normalizedAbsolute(file);
    if (this.knownPaths.has(absolute)) return;
    this.knownPaths.add(absolute);
    let directory = normalizedAbsolute(dirname(absolute));
    const fileNames = this.directoryFiles.get(directory) ?? new Set<string>();
    fileNames.add(basename(absolute));
    this.directoryFiles.set(directory, fileNames);
    while (withinRoot(this.root, directory)) {
      this.knownDirectories.add(directory);
      const parent = normalizedAbsolute(dirname(directory));
      if (parent === directory || !withinRoot(this.root, parent)) break;
      const children = this.directoryChildren.get(parent) ?? new Set<string>();
      children.add(basename(directory));
      this.directoryChildren.set(parent, children);
      directory = parent;
    }
  }
}

/** TypeScript's declaration file names, including `.d.<extension>.ts`. */
const DECLARATION_FILE = /\.d(\.[^./\\]+)?\.[cm]?ts$/iu;

/**
 * The compiler options a parsed and bound source file depends on: the set
 * TypeScript compares before reusing a source file in another program, plus
 * the options the program reads when it collects a file's implicit imports.
 */
function sourceFileSettingsKey(options: ts.CompilerOptions): string {
  const affecting = (ts as unknown as { sourceFileAffectingCompilerOptions?: ReadonlyArray<{ name: string }> })
    .sourceFileAffectingCompilerOptions;
  if (!affecting) return JSON.stringify(Object.entries(options).sort(([left], [right]) => compareCodePoints(left, right)));
  const names = [...new Set([...affecting.map((option) => option.name), "jsx", "jsxImportSource", "importHelpers"])]
    .sort(compareCodePoints);
  return JSON.stringify(names.map((name) => [name, options[name] ?? null]));
}

function parseProjects(
  root: string,
  candidates?: ReadonlySet<string>,
  inputs?: CompilerInputLedger,
): ParsedProject[] {
  const queue = inputs?.configFiles() ?? findConfigFiles(root);
  const seen = new Set<string>();
  const projects: ParsedProject[] = [];
  while (queue.length > 0) {
    const configPath = normalizedAbsolute(queue.shift()!);
    if (seen.has(configPath)) continue;
    seen.add(configPath);
    const diagnostics: ts.Diagnostic[] = [];
    const host: ts.ParseConfigFileHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      getCurrentDirectory: () => root,
      fileExists: inputs ? (fileName) => inputs.configFileExists(fileName) : ts.sys.fileExists,
      readDirectory: inputs
        ? (rootDir, extensions, excludes, includes, depth) =>
          inputs.readDirectory(rootDir, extensions, excludes, includes, depth)
        : ts.sys.readDirectory,
      readFile: inputs ? (fileName) => inputs.readConfigFile(fileName) : ts.sys.readFile,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed) continue;
    diagnostics.push(...parsed.errors);
    for (const reference of parsed.projectReferences ?? []) {
      const referencePath = normalizedAbsolute(ts.resolveProjectReferencePath(reference));
      // Same decision as a declined config read: a referenced project above
      // the root is not traversed, and is reported rather than fatal. A
      // sub-package of a monorepo indexed on its own routinely references its
      // siblings, and that must not make it un-indexable.
      if (!withinRoot(root, referencePath)) {
        inputs?.declineProjectReference(referencePath);
        continue;
      }
      if (!seen.has(referencePath)) queue.push(referencePath);
    }
    const includesCandidate = !candidates || parsed.fileNames.some((file) => candidates.has(normalizedAbsolute(file)));
    const isReferenced = projects.some((project) =>
      (project.parsed.projectReferences ?? []).some(
        (reference) => normalizedAbsolute(ts.resolveProjectReferencePath(reference)) === configPath,
      ),
    );
    if (includesCandidate || isReferenced || parsed.fileNames.length > 0) {
      projects.push({
        id: `config:${relativePath(root, configPath)}`,
        configPath,
        parsed,
        diagnostics,
      });
    }
  }
  return projects.sort((left, right) => left.configPath.localeCompare(right.configPath));
}

function findConfigFiles(root: string): string[] {
  const configs: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(resolve(directory, entry.name));
        continue;
      }
      if (entry.isFile() && /^tsconfig(?:\.[^.]+)?\.json$/u.test(entry.name)) {
        configs.push(resolve(directory, entry.name));
      }
    }
  };
  visit(root);
  return configs.sort();
}

function collectCandidates(
  root: string,
  supplied?: readonly string[],
  inputs?: CompilerInputLedger,
): string[] {
  if (supplied) {
    return [...new Set(supplied
      .map((file) => absoluteCandidate(root, file))
      .filter(isCompilerSourceFile)
      .filter((file) => inputs?.hasStagedInput(file) || (existsSync(file) && statSync(file).isFile())))]
      .sort();
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path);
      } else if (entry.isFile() && isCompilerSourceFile(path)) {
        files.push(normalizedAbsolute(path));
      }
    }
  };
  visit(root);
  return files.sort();
}

function collectDrafts(context: FileContext): void {
  const { sourceFile, project } = context;
  const fileDraft: DraftNode = {
    kind: "file",
    name: sourceFile.fileName.split(/[\\/]/u).at(-1) ?? context.filePath,
    qualifiedName: context.filePath,
    declarationRole: "source-file",
    declarations: [sourceFile],
    filePath: context.filePath,
    language: context.language,
    isExported: false,
  };
  context.fileDraft = fileDraft;
  context.drafts.push(fileDraft);
  context.declarationDrafts.set(sourceFile, fileDraft);

  const visit = (node: ts.Node): void => {
    const descriptor = declarationDescriptor(node, context);
    if (descriptor) addDraft(node, descriptor, context);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Map every declaration in an overload set to the one coalesced node.
  for (const draft of context.drafts) {
    for (const declaration of draft.declarations) context.declarationDrafts.set(declaration, draft);
    if (draft.symbol) context.symbolDrafts.set(canonicalSymbol(draft.symbol, project.checker), draft);
  }
}

interface DeclarationDescriptor {
  kind: CompilerNodeKind;
  name: string;
  role: string;
  symbol?: ts.Symbol;
}

function declarationDescriptor(node: ts.Node, context: FileContext): DeclarationDescriptor | null {
  const checker = context.project.checker;
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { kind: "function", name: node.name.text, role: "function", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { kind: "class", name: node.name.text, role: "class", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { kind: "interface", name: node.name.text, role: "interface", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isEnumDeclaration(node)) {
    return { kind: "enum", name: node.name.text, role: "enum", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isEnumMember(node)) {
    return { kind: "enum_member", name: propertyName(node.name), role: "enum-member", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { kind: "type_alias", name: node.name.text, role: "type-alias", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isModuleDeclaration(node)) {
    const name = node.name.text;
    return { kind: "namespace", name, role: "namespace", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    return { kind: "method", name: propertyName(node.name), role: "method", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isConstructorDeclaration(node)) {
    return { kind: "method", name: "constructor", role: "constructor" };
  }
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return { kind: "method", name: propertyName(node.name), role: "accessor", symbol: checker.getSymbolAtLocation(node.name) };
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    const callable = ts.isPropertyDeclaration(node) && node.initializer && isFunctionLikeValue(node.initializer);
    return {
      kind: callable ? "method" : "property",
      name: propertyName(node.name),
      role: callable ? "callable-property" : "property",
      symbol: checker.getSymbolAtLocation(node.name),
    };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const callable = node.initializer && isFunctionLikeValue(node.initializer);
    if (!callable && !isModuleVariable(node)) return null;
    return {
      kind: callable ? "function" : variableKind(node),
      name: node.name.text,
      role: callable ? "function-variable" : "variable",
      symbol: checker.getSymbolAtLocation(node.name),
    };
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !isNamedFunctionValue(node)) {
    const role = anonymousFunctionRole(node, context);
    return { kind: "function", name: `<callback:${role.label}>`, role: role.identity };
  }
  return null;
}

function addDraft(
  node: ts.Node,
  descriptor: DeclarationDescriptor,
  context: FileContext,
): void {
  const checker = context.project.checker;
  const symbol = descriptor.symbol ? canonicalSymbol(descriptor.symbol, checker) : undefined;
  if (symbol) {
    const existing = context.symbolDrafts.get(symbol);
    if (existing) {
      context.declarationDrafts.set(node, existing);
      return;
    }
  }
  const declarations = symbol?.declarations
    ?.filter((declaration) => declaration.getSourceFile() === context.sourceFile)
    .filter((declaration) => compatibleDeclaration(descriptor.kind, declaration)) ?? [node];
  const usableDeclarations = declarations.length > 0 ? declarations : [node];
  if (usableDeclarations.some((declaration) => intersectsRanges(declaration, context.errorRanges))) {
    context.health.excludedDeclarationCount++;
    for (const declaration of usableDeclarations) {
      context.excludedDeclarationRanges.push({
        start: declaration.getStart(context.sourceFile, false),
        end: declaration.getEnd(),
      });
    }
    return;
  }
  const container = closestDraft(node.parent, context) ?? context.fileDraft;
  const qualifiedName = [
    ...(container && container.kind !== "file" ? [container.qualifiedName] : []),
    descriptor.name,
  ].join("::");
  const signature = declarationSignature(symbol, usableDeclarations, checker, context.project.root);
  const representative = implementationDeclaration(usableDeclarations);
  const draft: DraftNode = {
    kind: descriptor.kind,
    name: descriptor.name,
    qualifiedName,
    declarationRole: descriptor.role,
    signature,
    declarations: usableDeclarations,
    symbol,
    container,
    filePath: context.filePath,
    language: context.language,
    docstring: symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)) || undefined : jsDocForNode(representative),
    visibility: visibilityOf(representative),
    isExported: isExported(representative, symbol, checker),
    isAsync: hasModifier(representative, ts.SyntaxKind.AsyncKeyword) || undefined,
    isStatic: hasModifier(representative, ts.SyntaxKind.StaticKeyword) || undefined,
    isAbstract: hasModifier(representative, ts.SyntaxKind.AbstractKeyword) || undefined,
    decorators: decoratorsOf(representative),
    typeParameters: typeParametersOf(representative),
    returnType: returnTypeOf(symbol, representative, checker, context.project.root),
  };
  context.drafts.push(draft);
  context.declarationDrafts.set(node, draft);
  for (const declaration of usableDeclarations) context.declarationDrafts.set(declaration, draft);
  if (symbol) context.symbolDrafts.set(symbol, draft);
}

function assignCanonicalIdentities(contexts: readonly FileContext[]): void {
  for (const context of contexts) {
    const groups = new Map<string, DraftNode[]>();
    for (const draft of context.drafts) {
      const base = canonicalCompilerIdentity({
        filePath: draft.filePath,
        kind: draft.kind,
        qualifiedName: draft.qualifiedName,
        declarationRole: draft.declarationRole,
        signature: draft.signature,
      });
      draft.identityBase = base;
      const entries = groups.get(base) ?? [];
      entries.push(draft);
      groups.set(base, entries);
    }
    for (const [base, entries] of groups) {
      entries.sort((left, right) => declarationStart(left) - declarationStart(right));
      entries.forEach((draft, index) => {
        draft.identityKey = entries.length === 1 ? base : `${base}\u0000ordinal:${index}`;
        draft.id = generateCanonicalCompilerNodeId(draft.kind, draft.identityKey);
      });
    }
  }
}

function materializeNodes(context: FileContext): CompilerExtractedNode[] {
  return context.drafts
    .filter((draft): draft is DraftNode & { id: string; identityKey: string } => Boolean(draft.id && draft.identityKey))
    .sort((left, right) => declarationStart(left) - declarationStart(right) || left.id.localeCompare(right.id))
    .map((draft) => {
      const declarations = draft.declarations.slice().sort((a, b) => a.getStart() - b.getStart());
      const first = declarations[0];
      const last = declarations.at(-1)!;
      const start = context.sourceFile.getLineAndCharacterOfPosition(first.getStart(context.sourceFile));
      const end = context.sourceFile.getLineAndCharacterOfPosition(last.getEnd());
      return {
        id: draft.id,
        identityKey: draft.identityKey,
        containerId: draft.container?.id,
        kind: draft.kind,
        name: draft.name,
        qualifiedName: draft.qualifiedName,
        declarationRole: draft.declarationRole,
        filePath: draft.filePath,
        language: draft.language,
        startLine: start.line + 1,
        endLine: end.line + 1,
        startColumn: start.character,
        endColumn: end.character,
        docstring: draft.docstring,
        signature: draft.signature,
        visibility: draft.visibility,
        isExported: draft.isExported,
        isAsync: draft.isAsync,
        isStatic: draft.isStatic,
        isAbstract: draft.isAbstract,
        decorators: draft.decorators,
        typeParameters: draft.typeParameters,
        returnType: draft.returnType,
        declarationSpans: declarations.map((declaration) => {
          const declarationStartPosition = context.sourceFile.getLineAndCharacterOfPosition(declaration.getStart(context.sourceFile));
          const declarationEndPosition = context.sourceFile.getLineAndCharacterOfPosition(declaration.getEnd());
          return {
            startLine: declarationStartPosition.line + 1,
            endLine: declarationEndPosition.line + 1,
            startColumn: declarationStartPosition.character,
            endColumn: declarationEndPosition.character,
          };
        }),
      };
    });
}

/**
 * Capture-time import extraction: identical to the old `extractImportBindings`
 * except the imported symbol resolves to declaration LOCATIONS, not ids — the
 * finishing pass maps them once every project has contributed to the map.
 */
function captureImportBindings(
  root: string,
  context: FileContext,
  inputs: CompilerInputLedger,
  resolvedSpecifiers: string[],
): DeferredImportBinding[] {
  const bindings: DeferredImportBinding[] = [];
  const checker = context.project.checker;
  const options = context.project.program.getCompilerOptions();
  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!referenceSyntaxIsTrusted(statement, context)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    resolvedSpecifiers.push(moduleSpecifier);
    const resolution = ts.resolveModuleName(
      moduleSpecifier,
      context.sourceFile.fileName,
      options,
      inputs.moduleResolutionHost(),
    ).resolvedModule;
    const resolvedFilePath = resolution && withinRoot(root, resolution.resolvedFileName)
      ? relativePath(root, resolution.resolvedFileName)
      : undefined;
    const add = (
      local: ts.Identifier,
      importedName: string,
      flags: { isDefault?: boolean; isNamespace?: boolean; isTypeOnly?: boolean } = {},
    ): void => {
      const symbol = checker.getSymbolAtLocation(local);
      const position = context.sourceFile.getLineAndCharacterOfPosition(local.getStart(context.sourceFile));
      const identity = [context.filePath, local.text, moduleSpecifier, importedName].join("\u0000");
      bindings.push({
        binding: {
          id: `import:${sha256(identity).slice(0, 32)}`,
          filePath: context.filePath,
          localName: local.text,
          importedName,
          moduleSpecifier,
          resolvedFilePath,
          isTypeOnly: Boolean(statement.importClause?.isTypeOnly || flags.isTypeOnly),
          isNamespace: Boolean(flags.isNamespace),
          isDefault: Boolean(flags.isDefault),
          line: position.line,
          column: position.character,
          confidence: 1,
          resolutionMethod: "typescript-import",
        },
        targetLocations: declarationLocationsForSymbol(symbol, checker),
      });
    };
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) add(clause.name, "default", { isDefault: true });
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      add(clause.namedBindings.name, "*", { isNamespace: true });
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        add(element.name, element.propertyName?.text ?? element.name.text, { isTypeOnly: element.isTypeOnly });
      }
    }
  }
  return bindings.sort((left, right) => left.binding.line - right.binding.line
    || left.binding.column - right.binding.column
    || left.binding.id.localeCompare(right.binding.id));
}

function captureReferences(
  context: FileContext,
  importBindings: readonly DeferredImportBinding[],
): CapturedReference[] {
  if (!context.fileDraft?.id) return [];
  const fileDraftId = context.fileDraft.id;
  const captured: CapturedReference[] = [];

  // Structural containment is compiler-proven and never inferred by name.
  for (const draft of context.drafts) {
    if (!draft.id || !draft.container?.id) continue;
    const position = declarationStart(draft);
    const point = lineColumn(context.sourceFile, position);
    captured.push({
      form: "final",
      position,
      identityHint: `contains:${draft.identityKey}`,
      reference: {
        sourceId: draft.container.id,
        targetId: draft.id,
        kind: "contains",
        targetName: draft.name,
        targetQualifiedName: draft.qualifiedName,
        candidates: [draft.id],
        status: "resolved",
        confidence: 1,
        resolutionMethod: "lexical-containment",
        provenance: "typescript-compiler",
        filePath: context.filePath,
        line: point.line,
        column: point.column,
        evidence: { declarationRole: draft.declarationRole },
      },
    });
  }

  for (const { binding } of importBindings) {
    captured.push({
      form: "import",
      position: context.sourceFile.getPositionOfLineAndCharacter(binding.line, binding.column),
      line: binding.line,
      column: binding.column,
      sourceId: fileDraftId,
      bindingId: binding.id,
      moduleSpecifier: binding.moduleSpecifier,
      resolvedFilePath: binding.resolvedFilePath,
    });
  }

  const visit = (node: ts.Node): void => {
    const trusted = referenceSyntaxIsTrusted(node, context);
    if (trusted && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      captureCallReference(node, context, captured);
      if (ts.isCallExpression(node)) {
        captureCallbackReferences(node, context, captured);
      }
    } else if (trusted && ts.isHeritageClause(node)) {
      captureHeritageReferences(node, context, captured);
    } else if (trusted && ts.isIdentifier(node) && shouldEmitIdentifierReference(node)) {
      captureIdentifierReference(node, context, captured);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(context.sourceFile, visit);
  return captured;
}

/**
 * Finishing pass for one file: compiler-free. Resolves the deferred
 * declaration locations against the corpus-wide location→id map and replays
 * exactly the id/status/candidate/skip logic the concurrent implementation
 * applied at emission time, then the original sort → ordinal → hash tail.
 */
function finishReferences(
  file: CapturedFile,
  importBindings: readonly CompilerImportBinding[],
  locationIds: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CompilerExtractedNode>,
  fileDraftIdByPath: ReadonlyMap<string, string>,
): CompilerReference[] {
  const bindingById = new Map(importBindings.map((binding) => [binding.id, binding]));
  const pending: PendingReference[] = [];
  for (const record of file.captured) {
    switch (record.form) {
      case "final": {
        pending.push({ ...record.reference, position: record.position, identityHint: record.identityHint });
        break;
      }
      case "import": {
        const binding = bindingById.get(record.bindingId);
        if (!binding) break;
        const targetFileId = binding.resolvedFilePath
          ? fileDraftIdByPath.get(normalizeRelative(binding.resolvedFilePath))
          : undefined;
        const targetId = targetFileId ?? binding.targetId;
        pending.push({
          sourceId: record.sourceId,
          targetId,
          kind: "imports",
          targetName: record.moduleSpecifier,
          targetQualifiedName: targetId ? nodeById.get(targetId)?.qualifiedName : undefined,
          candidates: targetId ? [targetId] : [],
          status: targetId ? "resolved" : "unresolved",
          confidence: targetId ? 1 : 0,
          resolutionMethod: "typescript-import",
          provenance: "typescript-compiler",
          filePath: file.filePath,
          line: record.line,
          column: record.column,
          evidence: { importBindingId: binding.id, resolvedFilePath: binding.resolvedFilePath },
          position: record.position,
          identityHint: `import:${binding.id}`,
        });
        break;
      }
      case "call": {
        const candidates = idsForLocations(record.candidateLocations, locationIds);
        const uniqueCandidate = !record.polymorphic && candidates.length === 1 ? candidates[0] : undefined;
        const ambiguous = !uniqueCandidate && (candidates.length > 0 || record.polymorphic);
        pending.push({
          sourceId: record.sourceId,
          targetId: uniqueCandidate,
          kind: record.isNew ? "instantiates" : "calls",
          targetName: record.targetName,
          targetQualifiedName: uniqueCandidate ? nodeById.get(uniqueCandidate)?.qualifiedName : undefined,
          receiver: record.receiver,
          qualifier: record.receiver,
          candidates,
          status: uniqueCandidate ? "resolved" : ambiguous ? "ambiguous" : "unresolved",
          confidence: uniqueCandidate ? 1 : ambiguous ? 0.75 : 0,
          resolutionMethod: "typescript-signature",
          provenance: "typescript-compiler",
          filePath: file.filePath,
          line: record.line,
          column: record.column,
          evidence: {
            expression: record.expressionText,
            signature: record.signatureText,
            polymorphic: record.polymorphic,
          },
          position: record.position,
          identityHint: `${record.targetName}:${record.receiver ?? ""}`,
        });
        break;
      }
      case "heritage": {
        const targetId = idsForLocations(record.targetLocations, locationIds)[0];
        pending.push({
          sourceId: record.sourceId,
          targetId,
          kind: record.isImplements ? "implements" : "extends",
          targetName: record.targetName,
          targetQualifiedName: targetId ? nodeById.get(targetId)?.qualifiedName : undefined,
          candidates: targetId ? [targetId] : [],
          status: targetId ? "resolved" : "unresolved",
          confidence: targetId ? 1 : 0,
          resolutionMethod: "typescript-heritage",
          provenance: "typescript-compiler",
          filePath: file.filePath,
          line: record.line,
          column: record.column,
          evidence: { heritage: record.isImplements ? "implements" : "extends" },
          position: record.position,
          identityHint: record.targetName,
        });
        break;
      }
      case "identifier": {
        const targetIds = idsForLocations(record.targetLocations, locationIds);
        const targetId = targetIds.length === 1 ? targetIds[0] : undefined;
        if (targetId === record.sourceId || targetIds.length === 0) break;
        pending.push({
          sourceId: record.sourceId,
          targetId,
          kind: "references",
          targetName: record.text,
          targetQualifiedName: targetId ? nodeById.get(targetId)?.qualifiedName : undefined,
          receiver: record.receiver,
          qualifier: record.receiver,
          candidates: targetIds,
          status: targetId ? "resolved" : "ambiguous",
          confidence: targetId ? 1 : 0.75,
          resolutionMethod: "typescript-symbol",
          provenance: "typescript-compiler",
          filePath: file.filePath,
          line: record.line,
          column: record.column,
          evidence: { expression: record.text },
          position: record.position,
          identityHint: `${record.text}:${record.receiver ?? ""}`,
        });
        break;
      }
      case "callback": {
        const calleeId = idsForLocations(record.calleeLocations, locationIds)[0];
        if (!calleeId) break;
        let callbackId = record.callbackDraftId;
        if (!callbackId) {
          const callbackIds = idsForLocations(record.callbackLocations, locationIds);
          callbackId = callbackIds.length === 1 ? callbackIds[0] : undefined;
        }
        if (!callbackId) break;
        pending.push({
          sourceId: calleeId,
          targetId: callbackId,
          kind: "calls",
          targetName: nodeById.get(callbackId)?.name ?? record.argumentText,
          targetQualifiedName: nodeById.get(callbackId)?.qualifiedName,
          candidates: [callbackId],
          status: "resolved",
          confidence: 0.85,
          resolutionMethod: "typescript-callback-parameter",
          provenance: "callback-synthesis",
          filePath: file.filePath,
          line: record.line,
          column: record.column,
          evidence: {
            parameterName: record.parameterName,
            argumentIndex: record.argumentIndex,
            wiringSite: record.wiringSite,
            callee: nodeById.get(calleeId)?.qualifiedName,
          },
          position: record.position,
          identityHint: `callback:${calleeId}:${record.parameterName}:${record.argumentIndex}:${callbackId}`,
        });
        break;
      }
    }
  }

  pending.sort((left, right) => left.position - right.position || left.kind.localeCompare(right.kind) || left.identityHint.localeCompare(right.identityHint));
  const occurrence = new Map<string, number>();
  return pending.map(({ position: _position, identityHint, ...reference }) => {
    const base = [reference.sourceId, reference.kind, normalizeSignature(identityHint)].join("\u0000");
    const ordinal = occurrence.get(base) ?? 0;
    occurrence.set(base, ordinal + 1);
    return {
      ...reference,
      id: `ref:${sha256(`${base}\u0000ordinal:${ordinal}`).slice(0, 32)}`,
    };
  });
}

function captureCallReference(
  node: ts.CallExpression | ts.NewExpression,
  context: FileContext,
  captured: CapturedReference[],
): void {
  const checker = context.project.checker;
  const expression = node.expression;
  const sourceId = enclosingSourceId(node, context);
  if (!sourceId) return;
  const calleeType = checker.getTypeAtLocation(expression);
  // A union-typed callee resolves to a signature the checker builds from
  // whichever member it created first, so both the resolved signature and
  // its declaration depend on file visit order. Such a call is described by
  // every member's signatures instead (issue #209).
  const unionCallee = calleeType.isUnion();
  const resolvedSignature = unionCallee ? undefined : checker.getResolvedSignature(node);
  const memberCallSignatures = unionCallee
    ? memberSignatures(
      checker,
      calleeType,
      ts.isNewExpression(node) ? ts.SignatureKind.Construct : ts.SignatureKind.Call,
    )
    : [];
  const signatureSymbol = resolvedSignature?.declaration
    ? symbolForDeclaration(resolvedSignature.declaration, checker)
    : undefined;
  const expressionSymbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  const callSignatures = unionCallee ? memberCallSignatures : calleeType.getCallSignatures();
  const candidateLocations = [...new Set(callSignatures
    .map((signature) => signature.declaration ? symbolForDeclaration(signature.declaration, checker) : undefined)
    .flatMap((symbol) => declarationLocationsForSymbol(symbol, checker))
    .concat(
      declarationLocationsForSymbol(signatureSymbol, checker),
      declarationLocationsForSymbol(expressionSymbol, checker),
    ))].sort(compareCodePoints);
  const polymorphic = ts.isPropertyAccessExpression(expression)
    && expression.expression.kind !== ts.SyntaxKind.ThisKeyword
    && expression.expression.kind !== ts.SyntaxKind.SuperKeyword
    && isPolymorphicReceiver(checker.getTypeAtLocation(expression.expression));
  const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression.getText(context.sourceFile) : undefined;
  const targetName = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.getText(context.sourceFile);
  // A chained call expression starts where its entire receiver chain starts;
  // use the actual callee token so semantic callsite uniqueness is real.
  const position = ts.isPropertyAccessExpression(expression)
    ? expression.name.getStart(context.sourceFile)
    : expression.getStart(context.sourceFile);
  const point = lineColumn(context.sourceFile, position);
  captured.push({
    form: "call",
    position,
    line: point.line,
    column: point.column,
    sourceId,
    isNew: ts.isNewExpression(node),
    targetName,
    receiver,
    polymorphic,
    candidateLocations,
    expressionText: expression.getText(context.sourceFile),
    signatureText: unionCallee
      ? canonicalSignatureSet(context.project, memberCallSignatures, node)
      : resolvedSignature
        ? portableCheckerText(
          renderCallSignature(context.project, resolvedSignature, node),
          context.project.root,
        )
        : undefined,
  });
}

function captureHeritageReferences(
  clause: ts.HeritageClause,
  context: FileContext,
  captured: CapturedReference[],
): void {
  const sourceId = enclosingSourceId(clause.parent, context);
  if (!sourceId) return;
  const checker = context.project.checker;
  for (const type of clause.types) {
    const symbol = checker.getSymbolAtLocation(type.expression);
    const targetName = type.expression.getText(context.sourceFile);
    const position = type.getStart(context.sourceFile);
    const point = lineColumn(context.sourceFile, position);
    captured.push({
      form: "heritage",
      position,
      line: point.line,
      column: point.column,
      sourceId,
      isImplements: clause.token === ts.SyntaxKind.ImplementsKeyword,
      targetName,
      targetLocations: declarationLocationsForSymbol(symbol, checker),
    });
  }
}

function captureIdentifierReference(
  identifier: ts.Identifier,
  context: FileContext,
  captured: CapturedReference[],
): void {
  const checker = context.project.checker;
  const symbol = checker.getSymbolAtLocation(identifier);
  const targetLocations = declarationLocationsForSymbol(symbol, checker);
  const sourceId = enclosingSourceId(identifier, context);
  if (!sourceId || targetLocations.length === 0) return;
  const position = identifier.getStart(context.sourceFile);
  const point = lineColumn(context.sourceFile, position);
  const parent = identifier.parent;
  const receiver = ts.isPropertyAccessExpression(parent) && parent.name === identifier
    ? parent.expression.getText(context.sourceFile)
    : undefined;
  captured.push({
    form: "identifier",
    position,
    line: point.line,
    column: point.column,
    sourceId,
    text: identifier.text,
    receiver,
    targetLocations,
  });
}

function captureCallbackReferences(
  call: ts.CallExpression,
  context: FileContext,
  captured: CapturedReference[],
): void {
  const checker = context.project.checker;
  const calleeType = checker.getTypeAtLocation(call.expression);
  // For a union-typed callee the checker's resolved signature depends on
  // file visit order; the callee is then its members' first declaration in
  // code order (portable path, start, kind), a choice the code alone decides.
  const declaration = calleeType.isUnion()
    ? firstDeclarationInCodeOrder(
      memberSignatures(checker, calleeType, ts.SignatureKind.Call)
        .map((signature) => signature.getDeclaration())
        .filter((candidate): candidate is ts.SignatureDeclaration => Boolean(candidate)),
      context.project.root,
    )
    : checker.getResolvedSignature(call)?.getDeclaration();
  if (!declaration || !ts.isFunctionLike(declaration)) return;
  const calleeSymbol = symbolForDeclaration(declaration, checker);
  const calleeLocations = declarationLocationsForSymbol(calleeSymbol, checker);
  if (calleeLocations.length === 0) return;
  const parameters = declaration.parameters;
  call.arguments.forEach((argument, index) => {
    const mapping = callbackParameterForArgument(parameters, index);
    if (!mapping || !parameterIsInvoked(
      mapping.parameter,
      declaration,
      checker,
      mapping.restArgumentIndex,
    )) return;
    const { parameter } = mapping;
    let callbackDraftId: string | undefined;
    let callbackLocations: string[] = [];
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      callbackDraftId = context.declarationDrafts.get(argument)?.id;
      if (!callbackDraftId) return;
    } else {
      callbackLocations = declarationLocationsForSymbol(checker.getSymbolAtLocation(argument), checker);
      if (callbackLocations.length === 0) return;
    }
    const position = argument.getStart(context.sourceFile);
    const point = lineColumn(context.sourceFile, position);
    captured.push({
      form: "callback",
      position,
      line: point.line,
      column: point.column,
      calleeLocations,
      callbackDraftId,
      callbackLocations,
      parameterName: parameter.name.getText(declaration.getSourceFile()),
      argumentIndex: index,
      wiringSite: call.getText(context.sourceFile),
      argumentText: argument.getText(context.sourceFile),
    });
  });
}

/**
 * Match an actual argument to its formal parameter without treating an
 * ordinary final parameter as variadic. For a real rest parameter, retain the
 * element offset so callback synthesis can require evidence for that specific
 * argument instead of claiming that every rest value is invoked.
 */
function callbackParameterForArgument(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  argumentIndex: number,
): { parameter: ts.ParameterDeclaration; restArgumentIndex?: number } | undefined {
  const restIndex = parameters.length - 1;
  const finalParameter = parameters[restIndex];
  if (finalParameter?.dotDotDotToken && argumentIndex >= restIndex) {
    return {
      parameter: finalParameter,
      restArgumentIndex: argumentIndex - restIndex,
    };
  }
  const parameter = parameters[argumentIndex];
  return parameter ? { parameter } : undefined;
}

function parameterIsInvoked(
  parameter: ts.ParameterDeclaration,
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
  restArgumentIndex?: number,
): boolean {
  const body = "body" in declaration ? declaration.body : undefined;
  if (!body || !ts.isIdentifier(parameter.name)) return false;
  const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
  if (!parameterSymbol) return false;
  let invoked = false;
  const visit = (node: ts.Node): void => {
    if (invoked) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const candidate = ts.isPropertyAccessExpression(expression)
        && (expression.name.text === "call" || expression.name.text === "apply")
        ? expression.expression
        : expression;
      if (restArgumentIndex === undefined) {
        if (ts.isIdentifier(candidate) && checker.getSymbolAtLocation(candidate) === parameterSymbol) {
          invoked = true;
          return;
        }
      } else if (ts.isElementAccessExpression(candidate)) {
        const element = candidate.argumentExpression;
        const index = element && ts.isNumericLiteral(element) ? Number(element.text) : Number.NaN;
        if (
          Number.isSafeInteger(index)
          && index === restArgumentIndex
          && ts.isIdentifier(candidate.expression)
          && checker.getSymbolAtLocation(candidate.expression) === parameterSymbol
        ) {
          invoked = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return invoked;
}

function sourceHealth(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  semanticDiagnostics: boolean,
): { health: CompilerSourceHealth; ranges: ErrorRange[] } {
  const syntactic = program.getSyntacticDiagnostics(sourceFile);
  // The full semantic pass type-checks the whole file (and everything it can
  // resolve). `status` never depends on it, so it is opt-in (issue #140).
  const semantic = semanticDiagnostics ? program.getSemanticDiagnostics(sourceFile) : [];
  const ranges = diagnosticRanges(sourceFile.text, syntactic);
  const coveredBytes = ranges.reduce((total, range) => total + Buffer.byteLength(sourceFile.text.slice(range.start, range.end), "utf8"), 0);
  const totalBytes = Math.max(1, Buffer.byteLength(sourceFile.text, "utf8"));
  const coverage = Math.min(1, coveredBytes / totalBytes);
  return {
    health: {
      status: syntactic.length === 0 ? "ok" : coverage <= 0.25 ? "partial" : "failed",
      syntacticDiagnosticCount: syntactic.length,
      semanticDiagnosticCount: semantic.length,
      diagnosticByteCoverage: coverage,
      excludedDeclarationCount: 0,
      diagnostics: [...syntactic, ...semantic].slice(0, 100).map(summarizeDiagnostic),
    },
    ranges,
  };
}

function diagnosticRanges(source: string, diagnostics: readonly ts.Diagnostic[]): ErrorRange[] {
  const ranges = diagnostics
    .filter((diagnostic): diagnostic is ts.Diagnostic & { start: number } => diagnostic.start !== undefined)
    .map((diagnostic) => ({
      start: Math.max(0, Math.min(source.length, diagnostic.start)),
      end: Math.max(0, Math.min(source.length, diagnostic.start + Math.max(1, diagnostic.length ?? 1))),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ErrorRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function intersectsRanges(node: ts.Node, ranges: readonly ErrorRange[]): boolean {
  const start = node.getStart(node.getSourceFile(), false);
  const end = node.getEnd();
  return ranges.some((range) => range.start < end && range.end > start);
}

function referenceSyntaxIsTrusted(node: ts.Node, context: FileContext): boolean {
  if (intersectsRanges(node, context.errorRanges)) return false;
  const start = node.getStart(context.sourceFile, false);
  const end = node.getEnd();
  return !context.excludedDeclarationRanges.some((range) => range.start <= start && range.end >= end);
}

function declarationSignature(
  symbol: ts.Symbol | undefined,
  declarations: readonly ts.Node[],
  checker: ts.TypeChecker,
  root: string,
): string | undefined {
  if (symbol) {
    const location = declarations[0];
    const type = checker.getTypeOfSymbolAtLocation(symbol, location);
    const signatures = [
      ...memberSignatures(checker, type, ts.SignatureKind.Call),
      ...memberSignatures(checker, type, ts.SignatureKind.Construct),
    ];
    const rendered = [...new Set(signatures.map((signature) => portableCheckerText(
      renderSignature(checker, signature, location),
      root,
    )))].sort();
    if (rendered.length > 0) return rendered.join(" | ");
    const typeText = portableCheckerText(renderType(checker, type, location), root);
    if (typeText && typeText !== "any") return typeText;
  }
  const headers = [...new Set(declarations.map(declarationHeader).filter(Boolean))].sort();
  return headers.length > 0 ? headers.join(" | ") : undefined;
}

// Canonical checker text (issue #209). The checker orders a union's members by
// internal type id, which follows the order types happened to be created in,
// so the same declaration rendered differently depending on which other files
// had been examined first; re-extracting a few files could not reproduce a full
// extraction. These render exactly as `typeToString` / `signatureToString` do,
// through the same node builder and printer options, except that each union's
// members are ordered by their own canonical text.
const typePrinter = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const signaturePrinter = ts.createPrinter({
  removeComments: true,
  omitTrailingSemicolon: true,
  newLine: ts.NewLineKind.LineFeed,
});
const CHECKER_TEXT_LIMIT = 2_000_000;
const RENDER_FLAGS = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.IgnoreErrors;

function renderType(checker: ts.TypeChecker, type: ts.Type, enclosing: ts.Node): string {
  const node = checker.typeToTypeNode(type, enclosing, RENDER_FLAGS);
  if (!node) return checker.typeToString(type, enclosing, ts.TypeFormatFlags.NoTruncation);
  return printCanonical(typePrinter, node, enclosing.getSourceFile());
}

function renderSignature(checker: ts.TypeChecker, signature: ts.Signature, enclosing: ts.Node): string {
  const node = checker.signatureToSignatureDeclaration(
    signature,
    ts.SyntaxKind.CallSignature,
    enclosing,
    RENDER_FLAGS | ts.NodeBuilderFlags.WriteTypeParametersInQualifiedName,
  );
  if (!node) return checker.signatureToString(signature, enclosing, ts.TypeFormatFlags.NoTruncation);
  return printCanonical(signaturePrinter, node, enclosing.getSourceFile()).replace(/;$/u, "");
}

function printCanonical(printer: ts.Printer, node: ts.Node, sourceFile: ts.SourceFile): string {
  const transformed = ts.transform(node, [(context) => {
    const visit = (current: ts.Node): ts.Node => {
      const visited = ts.visitEachChild(current, visit, context);
      if (ts.isTypeLiteralNode(visited)) {
        // A mapped or spread object type lists its properties in the type-id
        // order of its key literals. Members are ordered by name, stably, so
        // same-named overloads keep their order; unnamed call, construct and
        // index signatures stay first, in source order.
        const named = (member: ts.TypeElement): string => (member.name
          ? printer.printNode(ts.EmitHint.Unspecified, member.name, sourceFile)
          : "");
        return context.factory.updateTypeLiteralNode(visited, context.factory.createNodeArray(
          [...visited.members].sort((left, right) => compareCodePoints(named(left), named(right))),
        ));
      }
      if (!ts.isUnionTypeNode(visited) && !ts.isIntersectionTypeNode(visited)) return visited;
      const members = context.factory.createNodeArray(visited.types
        .map((member) => ({ member, text: printer.printNode(ts.EmitHint.Unspecified, member, sourceFile) }))
        .sort((left, right) => compareCodePoints(left.text, right.text))
        .map(({ member }) => member));
      // Intersections the checker derives from a union (a union signature's
      // parameters, a contextual type) inherit its type-id order too.
      return ts.isUnionTypeNode(visited)
        ? context.factory.updateUnionTypeNode(visited, members)
        : context.factory.updateIntersectionTypeNode(visited, members);
    };
    return (root) => visit(root);
  }]);
  try {
    // Checker text is single-line; the printer breaks only synthesized
    // multi-line literals, which the checker's own writer joins with spaces.
    const text = printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0]!, sourceFile)
      .replace(/\n\s*/gu, " ");
    return text.length >= CHECKER_TEXT_LIMIT ? `${text.slice(0, CHECKER_TEXT_LIMIT - 3)}...` : text;
  } finally {
    transformed.dispose();
  }
}

function declarationHeader(node: ts.Node): string {
  const source = node.getSourceFile();
  let end = node.getEnd();
  if (isFunctionLikeWithBody(node)) end = node.body.getStart(source);
  else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    end = node.members.pos;
  } else if (ts.isVariableDeclaration(node) && node.initializer) {
    end = node.initializer.getStart(source);
  } else if (ts.isPropertyDeclaration(node) && node.initializer) {
    end = node.initializer.getStart(source);
  }
  return normalizeSignature(source.text.slice(node.getStart(source), end).replace(/[={:]\s*$/u, ""));
}

function closestDraft(node: ts.Node | undefined, context: FileContext): DraftNode | undefined {
  for (let current = node; current && !ts.isSourceFile(current); current = current.parent) {
    const draft = context.declarationDrafts.get(current);
    if (draft) return draft;
  }
  return context.fileDraft;
}

function enclosingSourceId(node: ts.Node, context: FileContext): string | undefined {
  return closestDraft(node, context)?.id ?? context.fileDraft?.id;
}

function isPolymorphicReceiver(type: ts.Type): boolean {
  if (type.isUnionOrIntersection() || (type.flags & ts.TypeFlags.TypeParameter) !== 0) return true;
  const symbol = type.getSymbol();
  return Boolean(symbol && (symbol.flags & ts.SymbolFlags.Interface) !== 0);
}

function canonicalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function symbolForDeclaration(declaration: ts.Declaration, checker: ts.TypeChecker): ts.Symbol | undefined {
  const named = declaration as ts.NamedDeclaration;
  const symbol = named.name ? checker.getSymbolAtLocation(named.name) : checker.getSymbolAtLocation(declaration);
  if (symbol) return canonicalSymbol(symbol, checker);
  const parent = declaration.parent;
  if (ts.isClassLike(parent) && parent.name) return checker.getSymbolAtLocation(parent.name);
  return undefined;
}

function declarationLocation(node: ts.Node): string {
  return `${normalizedAbsolute(node.getSourceFile().fileName)}:${node.getStart(node.getSourceFile(), false)}:${node.kind}`;
}

function compatibleDeclaration(kind: CompilerNodeKind, declaration: ts.Declaration): boolean {
  if (kind === "function") return ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration);
  if (kind === "method") return ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration) || ts.isPropertyDeclaration(declaration);
  if (kind === "property") return ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration);
  return true;
}

function implementationDeclaration(declarations: readonly ts.Node[]): ts.Node {
  return declarations.find(isFunctionLikeWithBody)
    ?? declarations.find((declaration) => ts.isClassLike(declaration) && Boolean(declaration.members))
    ?? declarations.at(-1)!;
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return ts.isFunctionLike(node) && "body" in node && Boolean(node.body);
}

function anonymousFunctionRole(node: ts.ArrowFunction | ts.FunctionExpression, context: FileContext): { label: string; identity: string } {
  const parent = node.parent;
  if (ts.isCallExpression(parent)) {
    const index = parent.arguments.indexOf(node);
    const callee = normalizeSignature(parent.expression.getText(context.sourceFile)).slice(0, 80);
    return { label: `${callee}[${index}]`, identity: `callback-argument:${callee}:${index}` };
  }
  if (ts.isNewExpression(parent)) {
    const index = parent.arguments?.indexOf(node) ?? -1;
    const callee = normalizeSignature(parent.expression.getText(context.sourceFile)).slice(0, 80);
    return { label: `${callee}[${index}]`, identity: `constructor-callback:${callee}:${index}` };
  }
  const syntaxRole = ts.SyntaxKind[parent.kind] ?? "expression";
  return { label: syntaxRole, identity: `anonymous-callback:${syntaxRole}` };
}

function isNamedFunctionValue(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const parent = node.parent;
  return ts.isVariableDeclaration(parent)
    || ts.isPropertyDeclaration(parent)
    || ts.isPropertyAssignment(parent)
    || (ts.isFunctionExpression(node) && Boolean(node.name));
}

function isFunctionLikeValue(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isModuleVariable(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  return ts.isVariableStatement(statement)
    && (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent));
}

function variableKind(node: ts.VariableDeclaration): "constant" | "variable" {
  const declarationList = node.parent;
  return ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0
    ? "constant"
    : "variable";
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(name.getSourceFile());
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function visibilityOf(node: ts.Node): "public" | "private" | "protected" | "internal" | undefined {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return "private";
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return "protected";
  if (hasModifier(node, ts.SyntaxKind.PublicKeyword)) return "public";
  return undefined;
}

function isExported(node: ts.Node, symbol: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword)) return true;
  const sourceFile = node.getSourceFile();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  return Boolean(symbol && moduleSymbol && checker.getExportsOfModule(moduleSymbol).some((entry) => canonicalSymbol(entry, checker) === symbol));
}

function decoratorsOf(node: ts.Node): string[] | undefined {
  if (!ts.canHaveDecorators(node)) return undefined;
  const decorators = ts.getDecorators(node)?.map((decorator) => decorator.expression.getText(node.getSourceFile()));
  return decorators && decorators.length > 0 ? decorators : undefined;
}

function typeParametersOf(node: ts.Node): string[] | undefined {
  if (!("typeParameters" in node)) return undefined;
  const parameters = (node as ts.Node & { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
  const result = parameters?.map((parameter) => parameter.name.text);
  return result && result.length > 0 ? result : undefined;
}

function returnTypeOf(
  symbol: ts.Symbol | undefined,
  node: ts.Node,
  checker: ts.TypeChecker,
  root: string,
): string | undefined {
  if (!symbol || !ts.isFunctionLike(node)) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  // The first signature of each union member, never the checker's union
  // signature, whose first member depends on file visit order (issue #209).
  const members = type.isUnion() ? type.types : [type];
  const returns = [...new Set(members.flatMap((member) => {
    const signature = checker.getSignaturesOfType(member, ts.SignatureKind.Call)[0];
    return signature ? [portableCheckerText(renderType(checker, signature.getReturnType(), node), root)] : [];
  }))].sort(compareCodePoints);
  return returns.length > 0 ? returns.join(" | ") : undefined;
}

/**
 * A type's signatures of one kind, member by member for a union. The
 * checker's own union signature is built from whichever member it created
 * first, so it is not a function of the code (issue #209). Callers order the
 * result themselves.
 */
function memberSignatures(checker: ts.TypeChecker, type: ts.Type, kind: ts.SignatureKind): readonly ts.Signature[] {
  return type.isUnion()
    ? type.types.flatMap((member) => checker.getSignaturesOfType(member, kind))
    : checker.getSignaturesOfType(type, kind);
}

/** Distinct rendered signatures in canonical order, or undefined for none. */
function canonicalSignatureSet(
  project: RuntimeProject,
  signatures: readonly ts.Signature[],
  enclosing: ts.Node,
): string | undefined {
  const rendered = [...new Set(signatures.map((signature) =>
    portableCheckerText(renderCallSignature(project, signature, enclosing), project.root)))].sort(compareCodePoints);
  return rendered.length > 0 ? rendered.join(" | ") : undefined;
}

/**
 * A call's signature text, rendered once per signature and scope. How the
 * checker names a type in rendered text depends only on the symbols visible
 * from the call, which it looks up through the scopes (`locals`) enclosing it
 * up to the file; calls in the same innermost scope therefore render the same
 * signature identically. Verified exact over every call site of two real
 * repositories (116k calls, 47k repeats), where it saves most of the
 * rendering, which is the largest single cost of capture.
 */
function renderCallSignature(project: RuntimeProject, signature: ts.Signature, call: ts.Node): string {
  let scope: ts.Node = call.getSourceFile();
  for (let current = call.parent; current; current = current.parent) {
    if ((current as ts.Node & { locals?: unknown }).locals !== undefined) {
      scope = current;
      break;
    }
  }
  let texts = project.callSignatureTexts.get(scope);
  if (!texts) {
    texts = new Map();
    project.callSignatureTexts.set(scope, texts);
  }
  let text = texts.get(signature);
  if (text === undefined) {
    text = renderSignature(project.checker, signature, call);
    texts.set(signature, text);
  }
  return text;
}

/** The declaration that comes first in the code: portable path, then start, then kind. */
function firstDeclarationInCodeOrder<T extends ts.Node>(declarations: readonly T[], root: string): T | undefined {
  return declarations
    .map((declaration) => ({
      declaration,
      path: portableInputPath(root, normalizedAbsolute(declaration.getSourceFile().fileName)),
      start: declaration.getStart(declaration.getSourceFile()),
    }))
    .sort((left, right) => compareCodePoints(left.path, right.path)
      || left.start - right.start
      || left.declaration.kind - right.declaration.kind)[0]?.declaration;
}

function jsDocForNode(node: ts.Node): string | undefined {
  const comments = ts.getJSDocCommentsAndTags(node)
    .filter(ts.isJSDoc)
    .map((doc) => typeof doc.comment === "string" ? doc.comment : "")
    .filter(Boolean);
  return comments.length > 0 ? comments.join("\n") : undefined;
}

function shouldEmitIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ("name" in parent && (parent as ts.NamedDeclaration).name === node)
    || ts.isImportClause(parent)
    || ts.isImportSpecifier(parent)
    || ts.isNamespaceImport(parent)
    || ts.isExportSpecifier(parent)
    || ts.isPropertyAssignment(parent) && parent.name === node
    || ts.isPropertyAccessExpression(parent) && parent.name === node && (ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent))
    || (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node
    || ts.isTypeReferenceNode(parent)
    || ts.isExpressionWithTypeArguments(parent)
  ) return false;
  for (let current: ts.Node | undefined = parent; current && !ts.isStatement(current); current = current.parent) {
    if (ts.isTypeNode(current)) return false;
  }
  return true;
}

function sourceDiagnosticCategory(category: ts.DiagnosticCategory): CompilerDiagnosticSummary["category"] {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  if (category === ts.DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
}

function summarizeDiagnostic(diagnostic: ts.Diagnostic): CompilerDiagnosticSummary {
  return {
    code: diagnostic.code,
    category: sourceDiagnosticCategory(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    start: diagnostic.start,
    length: diagnostic.length,
  };
}

function lineColumn(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
  const point = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: point.line, column: point.character };
}

function sourceLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function sourceOffset(
  lineStarts: readonly number[],
  oneBasedLine: number,
  column: number,
  sourceLength: number,
): number {
  const lineStart = lineStarts[Math.max(0, oneBasedLine - 1)] ?? sourceLength;
  return Math.max(0, Math.min(sourceLength, lineStart + Math.max(0, column)));
}

function declarationStart(draft: DraftNode): number {
  return Math.min(...draft.declarations.map((declaration) => declaration.getStart(declaration.getSourceFile(), false)));
}

function languageForFile(filePath: string): CompilerSourceLanguage {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
  return "typescript";
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".json") return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function isCompilerSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const CHECKER_IMPORT_TYPE = /import\("([^"]*)"\)/gu;

/**
 * Normalise text rendered by the checker without any machine path (#240).
 *
 * `typeToString`/`signatureToString` print a type that is not in scope at the
 * rendering location as `import("<absolute module path>").Name`. That text is
 * part of canonical node identity and is shown to agents, so an absolute path
 * made ids depend on the checkout directory and leaked it into output. Every
 * checker render goes through here. The module is rewritten to:
 * - a package-relative path after the last `node_modules` (`pkg/dist/index`),
 *   wherever the dependency happens to be installed;
 * - a repo-relative `./` specifier inside the root (`./src/jsx/base`), which
 *   reads like an ordinary relative import from the repository root;
 * - `<external>/<file name>` for anything else outside the root, whose location
 *   is never stable across machines.
 * Specifiers the checker already printed bare or relative are left alone.
 * Every render passes `NoTruncation`: the checker spends its truncation budget
 * on the text with the absolute path still in it, so where it elides (`<...>`)
 * would otherwise depend on the length of the checkout path.
 */
export function portableCheckerText(value: string, root: string): string {
  return normalizeSignature(value.replace(
    CHECKER_IMPORT_TYPE,
    (_match, specifier: string) => `import("${portableModuleSpecifier(root, specifier)}")`,
  ));
}

function portableModuleSpecifier(root: string, specifier: string): string {
  if (!isAbsolute(specifier)) return specifier;
  const absolute = normalizedAbsolute(specifier);
  const segments = absolute.split("/");
  const dependencyRoot = segments.lastIndexOf("node_modules");
  if (dependencyRoot >= 0) return segments.slice(dependencyRoot + 1).join("/");
  if (withinRoot(root, absolute)) return `./${relativePath(root, absolute)}`;
  return `<external>/${basename(absolute)}`;
}

function normalizeQualifiedName(value: string): string {
  return value.split("::").map((part) => normalizeSignature(part)).join("::");
}

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizedAbsolute(value: string): string {
  return resolve(value).split(sep).join("/");
}

function absoluteCandidate(root: string, file: string): string {
  return normalizedAbsolute(isAbsolute(file) ? file : resolve(root, file));
}

function relativePath(root: string, file: string): string {
  return normalizeRelative(relative(root, file));
}

function withinRoot(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAllowedCompilerDependency(absolutePath: string): boolean {
  return normalizeRelative(absolutePath).split("/").includes("node_modules");
}

/** Future appearance of these paths is already detected by corpus/config status. */
function negativeProbeCoveredByCorpusPolicy(absolutePath: string): boolean {
  if (isCompilerSourceFile(absolutePath)) return true;
  const name = basename(absolutePath).toLowerCase();
  return name === "package.json"
    || /^tsconfig(?:\.[^.]+)?\.json$/u.test(name)
    || /^jsconfig(?:\.[^.]+)?\.json$/u.test(name);
}
