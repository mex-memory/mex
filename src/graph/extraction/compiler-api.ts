// TypeScript/JavaScript graph extraction through TypeScript 7.1's public API.
//
// TypeScript 7 runs as its own process (tsgo, or tsrs, a port that serves the
// same API); MEX is a client of that API and never reaches into compiler
// internals. This module implements the extraction pass's `ProjectSession`
// seam, so a project's files are captured into exactly the shapes the 5.9
// session produces and every later stage (finishing pass, staging, storage)
// is shared.
//
// Speed comes from two places. The compiler itself is several times faster,
// and every checker question is batched: a file's symbols are fetched in one
// request, and each call's chain of questions runs side by side with every
// other call of the file, one round trip per step. Locations are resolved only
// inside the corpus, so library declaration files are never sent back.

import { createRequire } from "node:module";
import { dirname } from "node:path";
import ts from "typescript";
import * as ast from "typescript-7/ast";
import { serverFS, type FileSystemCallbacks } from "typescript-7/fs";
import {
  API,
  NodeBuilderFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
  type Checker,
  type NodeHandle,
  type Program,
  type Project,
  type Signature as ApiSignature,
  type Symbol as ApiSymbol,
  type Type as ApiType,
  type UnionType as ApiUnionType,
} from "typescript-7/sync";
import { recordGraphPhase, timeGraphPhase } from "../phase-timing.js";
import {
  CompilerFallback,
  canonicalCompilerIdentity,
  generateCanonicalCompilerNodeId,
  internalCompilerHelpers as helpers,
  portableCheckerText,
  type CaptureSink,
  type CapturedFile,
  type CapturedReference,
  type CompilerDiagnosticSummary,
  type CompilerExtractedNode,
  type CompilerImportBinding,
  type CompilerInputLedger,
  type CompilerNodeKind,
  type CompilerReference,
  type CompilerSourceHealth,
  type CompilerSourceLanguage,
  type DeferredImportBinding,
  type FileDependencies,
  type ProjectCompiler,
  type ProjectOpenRequest,
  type ProjectSession,
} from "./compiler.js";

type Node = ast.Node;
type SourceFile = ast.SourceFile;
type API7 = InstanceType<typeof API>;

/** A TypeScript 7.1 API server: its name, version and how to start it. */
export interface TypeScriptApiServer {
  readonly name: "tsgo" | "tsrs";
  readonly version: string;
  /** Directories the server reads its own library files from. */
  readonly libraryDirectories: readonly string[];
  /** The server package's own filesystem sentinels; each package defines its own. */
  readonly serverFS: typeof serverFS;
  start(options: { cwd: string; fs: FileSystemCallbacks }): API7;
}

const requireFromHere = createRequire(import.meta.url);

/** Microsoft's TypeScript 7 compiler (Go), pinned by this MEX release. */
export function tsgoServer(): TypeScriptApiServer {
  const manifest = requireFromHere.resolve("typescript-7/package.json");
  const version = (requireFromHere(manifest) as { version: string }).version;
  const directories = [dirname(manifest)];
  try {
    const platform = `@typescript/typescript-${process.platform}-${process.arch}/package.json`;
    directories.push(dirname(createRequire(manifest).resolve(platform)));
  } catch {
    // The platform package is optional; the server reports a missing binary itself.
  }
  return {
    name: "tsgo",
    version,
    libraryDirectories: directories.map(helpers.normalizedAbsolute),
    serverFS,
    start: ({ cwd, fs }) => new API({ cwd, fs }),
  };
}

/**
 * tsrs, a Rust port of TypeScript 7 that serves the same API. It ships its own
 * copy of the API client, built from the same TypeScript commit, and is loaded
 * on demand: callers that may use it call {@link loadTsrsServer} first.
 */
export async function loadTsrsServer(): Promise<TypeScriptApiServer> {
  const manifest = requireFromHere.resolve("tsrs/package.json");
  const version = (requireFromHere(manifest) as { version: string }).version;
  const client = await import("tsrs/sync") as unknown as { API: typeof API };
  const fsModule = await import("tsrs/fs") as unknown as { serverFS: typeof serverFS };
  const directories = [dirname(manifest)];
  try {
    const platform = `@tsrs/${process.platform}-${process.arch}/package.json`;
    directories.push(dirname(createRequire(manifest).resolve(platform)));
  } catch {
    // No binary for this platform: starting the server fails and the caller falls back.
  }
  return {
    name: "tsrs",
    version,
    libraryDirectories: directories.map(helpers.normalizedAbsolute),
    serverFS: fsModule.serverFS,
    start: ({ cwd, fs }) => new client.API({ cwd, fs }),
  };
}

/** Builds each project's program on one TypeScript 7.1 API server per extraction. */
export class ApiProjectCompiler implements ProjectCompiler {
  readonly supportsReuse = true;
  private api: API7 | undefined;
  private ledger: CompilerInputLedger | undefined;
  private snapshot: { dispose(): void } | undefined;
  private readonly prepared = new Map<string, Program>();

  /**
   * @param fallback Builds a project this server cannot: every failure of
   * this server moves that project there, with the reason recorded.
   */
  constructor(readonly server: TypeScriptApiServer, readonly fallback?: ProjectCompiler) {}

  get name(): string {
    return `${this.server.name}-${this.server.version}`;
  }

  /**
   * One snapshot holds every project's program, so the server parses a file
   * shared by several projects once and builds the programs in parallel.
   * The staged sources travel with it as a filesystem layer: the server reads
   * them without asking back for each file.
   */
  prepare(requests: readonly ProjectOpenRequest[]): void {
    if (requests.length === 0) return;
    try {
      const api = this.apiFor(requests[0]!);
      const createSnapshot = api.createSnapshot as unknown as (params: unknown) => {
        dispose(): void;
        operation: { createdPrograms?: readonly Program[] };
      };
      const snapshot = createSnapshot.call(api, {
        fileSystem: stagedLayer(requests[0]!.inputs),
        createPrograms: requests.map((request) => ({
          rootFiles: request.rootNames.map(helpers.normalizedAbsolute),
          compilerOptions: translateCompilerOptions(request.options).options,
          options: programOptions(request),
        })),
      });
      this.snapshot = snapshot;
      const programs = snapshot.operation.createdPrograms ?? [];
      requests.forEach((request, index) => {
        const program = programs[index];
        if (program) this.prepared.set(request.project.id, program);
      });
    } catch {
      // Each project is built on its own when it is opened.
      this.prepared.clear();
    }
  }

  open(request: ProjectOpenRequest): ProjectSession {
    const api = this.apiFor(request);
    const prepared = this.prepared.get(request.project.id);
    if (prepared) {
      this.prepared.delete(request.project.id);
      return this.checked(request, api, prepared);
    }
    const program = api.createProgram(
      request.rootNames.map(helpers.normalizedAbsolute),
      translateCompilerOptions(request.options).options,
      programOptions(request),
    );
    return this.checked(request, api, program);
  }

  /**
   * A project whose options had to be translated is checked before it is
   * used: if TypeScript 7 leaves an import unresolved that 5.9 resolves with
   * the project's own options, the project is extracted by 5.9 instead.
   */
  private checked(request: ProjectOpenRequest, api: API7, program: Program): ApiProjectSession {
    const translation = translateCompilerOptions(request.options);
    const session = new ApiProjectSession(this.name, request, api, program, translation.changes);
    if (!translation.affectsResolution) return session;
    const lost = timeGraphPhase("compiler.api.translationCheck", () => session.importsLostByTranslation());
    if (lost.length > 0) {
      session.release();
      const [first] = lost;
      throw new CompilerFallback(
        `${translation.changes.join(", ")} leaves ${lost.length} import${lost.length === 1 ? "" : "s"} unresolved `
        + `that TypeScript 5.9 resolves (for example '${first!.specifier}' in ${first!.filePath})`,
      );
    }
    return session;
  }

  close(): void {
    this.prepared.clear();
    try { this.snapshot?.dispose(); } catch { /* released with the server */ }
    this.snapshot = undefined;
    try { this.api?.close(); } catch { /* the server may already be gone */ }
    this.api = undefined;
    this.ledger = undefined;
  }

  private apiFor(request: ProjectOpenRequest): API7 {
    if (this.api && this.ledger === request.inputs) return this.api;
    this.close();
    this.ledger = request.inputs;
    this.api = this.server.start({
      cwd: request.root,
      fs: ledgerFileSystem(request.root, request.inputs, this.server.libraryDirectories, this.server.serverFS),
    });
    return this.api;
  }
}

/**
 * The server reads the repository through MEX's input ledger, so staged
 * bytes win, the containment policy holds and every input is recorded, as
 * with the 5.9 compiler host. Dependencies and the server's own libraries
 * are read by the server directly.
 */
function ledgerFileSystem(
  root: string,
  ledger: CompilerInputLedger,
  libraryDirectories: readonly string[],
  sentinels: typeof serverFS,
): FileSystemCallbacks {
  const serverFS = sentinels;
  const isServerLibrary = (path: string): boolean =>
    libraryDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`));
  type Route = "ledger" | "os" | "declined";
  const route = (path: string): Route => {
    const absolute = helpers.normalizedAbsolute(path);
    if (isServerLibrary(absolute)) return "os";
    if (ledger.isProjectInputPath(absolute) || ledger.hasStagedInput(absolute)) return "ledger";
    return helpers.isAllowedCompilerDependency(absolute) ? "os" : "declined";
  };
  return {
    readFile: (fileName) => {
      const target = route(fileName);
      return target === "os" ? serverFS.useOS : target === "ledger" ? ledger.readFile(fileName) : undefined;
    },
    fileExists: (fileName) => {
      const target = route(fileName);
      return target === "os" ? serverFS.useOS : target === "ledger" ? ledger.fileExists(fileName) : false;
    },
    directoryExists: (directoryName) => {
      const absolute = helpers.normalizedAbsolute(directoryName);
      if (isServerLibrary(absolute)) return serverFS.useOS;
      if (!helpers.withinRoot(root, absolute)) {
        return helpers.isAllowedCompilerDependency(absolute) ? serverFS.useOS : false;
      }
      return ledger.isProjectInputPath(absolute) ? ledger.directoryExists(absolute) : serverFS.useOS;
    },
    getAccessibleEntries: (directoryName) => {
      const absolute = helpers.normalizedAbsolute(directoryName);
      if (helpers.withinRoot(root, absolute) && ledger.isProjectInputPath(absolute)) {
        return { ...ledger.directoryEntries(absolute), symlinks: undefined };
      }
      if (isServerLibrary(absolute) || helpers.isAllowedCompilerDependency(absolute)) return serverFS.useOS;
      return { files: [], directories: [], symlinks: undefined };
    },
    realpath: (path) => {
      const absolute = helpers.normalizedAbsolute(path);
      return ledger.isProjectInputPath(absolute) ? serverFS.identity : serverFS.useOS;
    },
    stat: serverFS.fakeStat,
    writeFile: serverFS.noop,
    removeFile: serverFS.noop,
  };
}

function programOptions(request: ProjectOpenRequest): { projectReferences: Array<{ path: string; circular?: boolean }> } | undefined {
  const references = request.project.parsed.projectReferences;
  if (!references?.length) return undefined;
  return {
    projectReferences: references.map((reference) => ({
      path: helpers.normalizedAbsolute(ts.resolveProjectReferencePath(reference)),
      ...(reference.circular ? { circular: true } : {}),
    })),
  };
}

/** The staged repository bytes as a filesystem layer over the host. */
function stagedLayer(ledger: CompilerInputLedger): { kind: "layer"; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const [path, source] of ledger.stagedInputs()) files[path] = source;
  return { kind: "layer", files };
}

/** 5.9's parsed options as the 7.1 API's raw options: same enum values, no config objects. */
export function rawCompilerOptions(options: ts.CompilerOptions): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || OMITTED_OPTIONS.has(name)) continue;
    if (typeof value === "object" && value !== null && !Array.isArray(value) && name !== "paths") continue;
    raw[name] = value;
  }
  return raw;
}

const OMITTED_OPTIONS = new Set(["configFile", "configFilePath", "project", "build", "help", "all", "version", "watch"]);

/** 5.9 options TypeScript 7 removed and that change nothing the graph records. */
const REMOVED_WITHOUT_EFFECT = [
  "downlevelIteration", "outFile", "out", "charset", "importsNotUsedAsValues", "preserveValueImports",
  "keyofStringsOnly", "suppressExcessPropertyErrors", "suppressImplicitAnyIndexErrors", "noImplicitUseStrict",
  "noStrictGenericChecks", "alwaysStrict",
] as const;

export interface CompilerOptionsTranslation {
  /** Raw options TypeScript 7.1 accepts. */
  options: Record<string, unknown>;
  /** What was changed, in words, for Health. */
  changes: string[];
  /** Whether a change can make an import resolve differently, so the result must be checked. */
  affectsResolution: boolean;
}

/**
 * Translate a project's options in memory to ones TypeScript 7 accepts, as
 * close to 5.9's meaning as 7 allows. The repository's tsconfig is never
 * changed. Module resolution, module kind and target are made explicit,
 * because 7's defaults differ from 5.9's.
 */
export function translateCompilerOptions(options: ts.CompilerOptions): CompilerOptionsTranslation {
  const raw = rawCompilerOptions(options);
  const changes: string[] = [];
  let affectsResolution = false;
  const resolution = effectiveModuleResolution(options);
  let moduleKind = effectiveModuleKind(options);
  if (resolution === ts.ModuleResolutionKind.Node10 || resolution === ts.ModuleResolutionKind.Classic) {
    changes.push(`moduleResolution ${resolution === ts.ModuleResolutionKind.Classic ? "classic" : "node10"} → bundler`);
    raw.moduleResolution = ts.ModuleResolutionKind.Bundler;
    affectsResolution = true;
    if (!BUNDLER_MODULE_KINDS.has(moduleKind)) {
      changes.push(`module ${ts.ModuleKind[moduleKind]?.toLowerCase() ?? moduleKind} → preserve`);
      moduleKind = ts.ModuleKind.Preserve;
    }
  } else {
    raw.moduleResolution = resolution;
    if (moduleKind === ts.ModuleKind.None || moduleKind === ts.ModuleKind.AMD
      || moduleKind === ts.ModuleKind.UMD || moduleKind === ts.ModuleKind.System) {
      changes.push(`module ${ts.ModuleKind[moduleKind]!.toLowerCase()} → esnext`);
      moduleKind = ts.ModuleKind.ESNext;
      affectsResolution = true;
    }
  }
  raw.module = moduleKind;
  const target = effectiveTarget(options);
  if (target < ts.ScriptTarget.ES2015) {
    changes.push(`target ${ts.ScriptTarget[target]?.toLowerCase() ?? target} → es2015`);
    raw.target = ts.ScriptTarget.ES2015;
  } else {
    raw.target = target;
  }
  if (typeof options.baseUrl === "string") {
    // 5.9 resolves `paths` against `baseUrl` and then tries every bare
    // specifier under `baseUrl`; 7 has no `baseUrl`, so both become paths.
    const base = helpers.normalizedAbsolute(options.baseUrl);
    const paths: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      paths[pattern] = targets.map((target) => helpers.absoluteCandidate(base, target));
    }
    if (!paths["*"]) paths["*"] = [`${base}/*`];
    raw.paths = paths;
    delete raw.baseUrl;
    // Every target is absolute now; the base only has to exist.
    raw.pathsBasePath = base;
    changes.push("baseUrl → paths");
    affectsResolution = true;
  }
  if (options.esModuleInterop === false) changes.push("esModuleInterop false → true");
  if (options.allowSyntheticDefaultImports === false) changes.push("allowSyntheticDefaultImports false → true");
  delete raw.esModuleInterop;
  delete raw.allowSyntheticDefaultImports;
  for (const name of REMOVED_WITHOUT_EFFECT) {
    if (raw[name] === undefined) continue;
    if (name !== "alwaysStrict" || raw[name] === false) changes.push(`${name} removed`);
    delete raw[name];
  }
  return { options: raw, changes, affectsResolution };
}

// 5.9's defaults, which TypeScript 7 changed; written out because 5.9 does not
// export them.
function effectiveTarget(options: ts.CompilerOptions): ts.ScriptTarget {
  if (options.target !== undefined) return options.target;
  if (options.module === ts.ModuleKind.Node16) return ts.ScriptTarget.ES2022;
  if (options.module === ts.ModuleKind.NodeNext) return ts.ScriptTarget.ESNext;
  return ts.ScriptTarget.ES5;
}

function effectiveModuleKind(options: ts.CompilerOptions): ts.ModuleKind {
  if (options.module !== undefined) return options.module;
  return effectiveTarget(options) >= ts.ScriptTarget.ES2015 ? ts.ModuleKind.ES2015 : ts.ModuleKind.CommonJS;
}

function effectiveModuleResolution(options: ts.CompilerOptions): ts.ModuleResolutionKind {
  if (options.moduleResolution !== undefined) return options.moduleResolution;
  switch (effectiveModuleKind(options)) {
    case ts.ModuleKind.CommonJS: return ts.ModuleResolutionKind.Node10;
    case ts.ModuleKind.Node16: return ts.ModuleResolutionKind.Node16;
    case ts.ModuleKind.NodeNext: return ts.ModuleResolutionKind.NodeNext;
    case ts.ModuleKind.Preserve: return ts.ModuleResolutionKind.Bundler;
    default: return ts.ModuleResolutionKind.Classic;
  }
}

const BUNDLER_MODULE_KINDS = new Set<number>([
  ts.ModuleKind.ES2015, ts.ModuleKind.ES2020, ts.ModuleKind.ES2022, ts.ModuleKind.ESNext, ts.ModuleKind.Preserve,
]);

// 7.1's syntax kinds are numbered differently from 5.9's. Declaration
// locations name 5.9's kind, so a location reads the same whichever compiler
// built the project, and projects on either compiler link to each other.
let kindMap: Map<number, number> | undefined;
function legacyKind(kind: ast.SyntaxKind): string {
  if (!kindMap) {
    kindMap = new Map();
    for (const [name, value] of Object.entries(ast.SyntaxKind)) {
      if (typeof value !== "number" || kindMap.has(value)) continue;
      const legacy = (ts.SyntaxKind as unknown as Record<string, number | undefined>)[name];
      if (typeof legacy === "number") kindMap.set(value, legacy);
    }
  }
  const legacy = kindMap.get(kind);
  return legacy === undefined ? `7:${kind}` : String(legacy);
}

const K = ast.SyntaxKind;

const FUNCTION_LIKE_KINDS = new Set<number>([
  K.FunctionDeclaration, K.MethodDeclaration, K.Constructor, K.GetAccessor, K.SetAccessor,
  K.FunctionExpression, K.ArrowFunction, K.MethodSignature, K.CallSignature, K.ConstructSignature,
  K.IndexSignature, K.FunctionType, K.ConstructorType, K.JSDocSignature,
]);
const CLASS_LIKE_KINDS = new Set<number>([K.ClassDeclaration, K.ClassExpression]);

function isFunctionLike(node: Node | undefined): boolean {
  return Boolean(node && FUNCTION_LIKE_KINDS.has(node.kind));
}

function isFunctionLikeWithBody(node: Node): node is Node & { body: Node } {
  return isFunctionLike(node) && Boolean((node as { body?: Node }).body);
}

function isClassLike(node: Node | undefined): node is ast.ClassDeclaration | ast.ClassExpression {
  return Boolean(node && CLASS_LIKE_KINDS.has(node.kind));
}

function isStringLiteralLike(node: Node | undefined): node is ast.StringLiteral | ast.NoSubstitutionTemplateLiteral {
  return Boolean(node && (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral));
}

function nodeText(node: Node, sourceFile: SourceFile): string {
  return sourceFile.text.slice(node.getStart(sourceFile), node.end);
}

function modifierKinds(node: Node): ast.SyntaxKind[] {
  const modifiers = (node as { modifiers?: readonly Node[] }).modifiers;
  return modifiers ? modifiers.map((modifier) => modifier.kind) : [];
}

function hasModifier(node: Node, kind: ast.SyntaxKind): boolean {
  return modifierKinds(node).includes(kind);
}

interface ErrorRange { start: number; end: number }

interface DraftNode {
  kind: CompilerNodeKind;
  name: string;
  qualifiedName: string;
  declarationRole: string;
  signature?: string;
  declarations: Node[];
  symbol?: ApiSymbol;
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

interface DeclarationDescriptor {
  kind: CompilerNodeKind;
  name: string;
  role: string;
  /** The node whose symbol names this declaration. */
  symbolNode?: Node;
  declarations?: Node[];
}

/** What one call's checker questions returned, before locations are resolved. */
interface CallFacts {
  node: ast.CallExpression | ast.NewExpression;
  calleeType: ApiType;
  /** Signatures of the callee's union members or value alternatives; null when neither applies. */
  memberSignatures: readonly ApiSignature[] | null;
  /** Union members' call signatures only, for callback synthesis (5.9 parity). */
  unionCallSignatures: readonly ApiSignature[] | null;
  resolvedSignature?: ApiSignature;
  callSignatures: readonly ApiSignature[];
  polymorphic: boolean;
}

class ApiProjectSession implements ProjectSession {
  readonly supportsReuse = true;
  private readonly checker: Checker;
  private readonly project: Project;
  private readonly sourceFiles = new Set<string>();
  private readonly corpusByKey = new Map<string, string>();
  private readonly locationCache = new Map<number, string[]>();
  private readonly aliasCache = new Map<number, ApiSymbol>();
  private readonly invokedCache = new Map<string, boolean>();
  private readonly declarationSymbols = new Map<string, ApiSymbol | undefined>();
  private translatedOptions: ts.CompilerOptions | undefined;
  private cachedResolution: ts.ModuleResolutionCache | undefined;
  private released = false;

  constructor(
    readonly compiler: string,
    private readonly request: ProjectOpenRequest,
    private readonly api: API7,
    private readonly program: Program,
    /** How the project's options were translated for TypeScript 7, if they were. */
    readonly notes: readonly string[] = [],
  ) {
    this.project = program.getProject();
    this.checker = this.project.checker;
    const { root, inputs, candidates } = request;
    for (const candidate of candidates) this.corpusByKey.set(program.getCanonicalFileName(candidate), candidate);
    for (const fileName of program.getSourceFileNames()) {
      const absolute = helpers.normalizedAbsolute(fileName);
      this.sourceFiles.add(absolute);
      // The server reads a file once for every program it builds; record the
      // read for each project, as the 5.9 compiler host does.
      if (helpers.withinRoot(root, absolute) && inputs.isProjectInputPath(absolute)) inputs.readFile(absolute);
    }
  }

  hasSourceFile(absoluteFile: string): boolean {
    return this.sourceFiles.has(helpers.normalizedAbsolute(absoluteFile));
  }

  /**
   * The corpus files a file's imports, type references and `/// <reference>`
   * paths resolve to, and the corpus paths whose appearance would change a
   * resolution. TypeScript 7.1's API reports where an import resolves but not
   * where it looked, so the lookups are replayed with 5.9's resolver under
   * the project's translated options: the two compilers resolve modules the
   * same way, and the replay reads through the same input ledger.
   */
  fileDependencies(absoluteFile: string): FileDependencies | undefined {
    const absolute = helpers.normalizedAbsolute(absoluteFile);
    if (!this.hasSourceFile(absolute)) return undefined;
    const sourceFile = this.program.getSourceFile(absolute);
    if (!sourceFile) return undefined;
    const { root, candidates } = this.request;
    const dependencies = new Set<string>();
    const failedLookups = new Set<string>();
    const addTarget = (fileName: string | undefined): void => {
      if (!fileName) return;
      const target = helpers.normalizedAbsolute(fileName);
      if (candidates.has(target)) dependencies.add(helpers.relativePath(root, target));
    };
    const addFailed = (locations: readonly string[] | undefined): void => {
      for (const location of locations ?? []) {
        if (location.includes("/node_modules/")) continue;
        const target = helpers.normalizedAbsolute(location);
        if (helpers.withinRoot(root, target) && helpers.isCompilerSourceFile(target)) failedLookups.add(helpers.relativePath(root, target));
      }
    };
    const options = this.legacyOptions;
    const host = this.request.inputs.moduleResolutionHost();
    for (const node of sourceFile.imports) {
      if (!isStringLiteralLike(node)) continue;
      const resolution = ts.resolveModuleName(node.text, absolute, options, host, this.resolutionCache);
      addTarget(resolution.resolvedModule?.resolvedFileName);
      addFailed((resolution as { failedLookupLocations?: readonly string[] }).failedLookupLocations);
    }
    for (const directive of sourceFile.typeReferenceDirectives) {
      const resolution = ts.resolveTypeReferenceDirective(directive.fileName, absolute, options, host);
      addTarget(resolution.resolvedTypeReferenceDirective?.resolvedFileName);
      addFailed((resolution as { failedLookupLocations?: readonly string[] }).failedLookupLocations);
    }
    for (const reference of sourceFile.referencedFiles) {
      const target = helpers.normalizedAbsolute(helpers.absoluteCandidate(dirname(absolute), reference.fileName));
      addTarget(target);
      if (!candidates.has(target)) addFailed([target]);
    }
    return {
      dependencies: [...dependencies].sort(helpers.compareCodePoints),
      failedLookups: [...failedLookups].sort(helpers.compareCodePoints),
      globalScope: isGlobalScopeFile(sourceFile),
    };
  }

  /**
   * A digest of every input a file can see without importing it: global-scope
   * corpus files and every file outside the corpus (libraries, dependencies),
   * with their exact bytes, as the 5.9 session computes it.
   */
  inputState(dependencies: ReadonlyMap<string, FileDependencies>): { state: string; inputs: string[] } {
    const { root, candidates, inputs } = this.request;
    const entries: Array<{ absolute: string; text: string }> = [];
    for (const absolute of this.sourceFiles) {
      if (candidates.has(absolute)) {
        const global = dependencies.get(absolute)?.globalScope;
        if (global === false) continue;
        if (global === undefined) {
          const sourceFile = this.program.getSourceFile(absolute);
          if (sourceFile && !isGlobalScopeFile(sourceFile)) continue;
        }
      }
      const text = inputs.readFile(absolute) ?? this.serverText(absolute);
      if (text === undefined) continue;
      entries.push({ absolute, text });
    }
    return {
      state: helpers.projectStateDigest(root, entries),
      inputs: entries.map(({ absolute }) => helpers.withinRoot(root, absolute) ? helpers.relativePath(root, absolute) : absolute)
        .sort(helpers.compareCodePoints),
    };
  }

  /** Package manifests that decide how this program's files are read (module format, resolution). */
  packageManifests(): string[] {
    const { root } = this.request;
    const files = [...this.sourceFiles];
    const metadata = this.api.batch(...files.map((file) => this.program.getSourceFileMetadata.gen(file)));
    const manifests = new Set<string>();
    for (const entry of metadata) {
      const directory = entry?.packageJsonDirectory;
      if (!directory) continue;
      const manifest = helpers.normalizedAbsolute(`${directory}/package.json`);
      if (helpers.withinRoot(root, manifest) && !manifest.includes("/node_modules/")) {
        manifests.add(helpers.relativePath(root, manifest));
      }
    }
    return [...manifests];
  }

  /** What an importer can observe of a file: the SHA-256 of its declaration emit. */
  declarationSignature(filePath: string): string | undefined {
    const absolute = helpers.absoluteCandidate(this.request.root, filePath);
    if (!this.hasSourceFile(absolute)) return undefined;
    try {
      const output = timeGraphPhase("compiler.signatures", () => this.program.getDeclarationEmit([absolute]));
      const texts = [...output.outputFiles.values()].map((file) => file.text);
      if (texts.length === 0) return undefined;
      return helpers.sha256Base64(texts.join("\u0000"));
    } catch {
      return undefined;
    }
  }

  replayResolution(absoluteFile: string, specifier: string): void {
    ts.resolveModuleName(specifier, absoluteFile, this.legacyOptions, this.request.inputs.moduleResolutionHost(), this.resolutionCache);
  }

  /** The translated options, read back as 5.9 options for its resolver. */
  private get legacyOptions(): ts.CompilerOptions {
    return this.translatedOptions ??= translateCompilerOptions(this.request.options).options as ts.CompilerOptions;
  }

  private get resolutionCache(): ts.ModuleResolutionCache {
    return this.cachedResolution ??= ts.createModuleResolutionCache(
      this.request.root, (fileName) => fileName, this.legacyOptions,
    );
  }

  /** A library file's text, for files the ledger leaves to the server. */
  private serverText(absolute: string): string | undefined {
    try {
      return this.program.getSourceFile(absolute)?.text;
    } catch {
      return undefined;
    }
  }

  /**
   * Imports of the project's own files that TypeScript 7 leaves unresolved
   * while 5.9, with the project's untranslated options, resolves them.
   */
  importsLostByTranslation(): Array<{ filePath: string; specifier: string }> {
    const { root, inputs, options, rootNames, candidates } = this.request;
    const files = rootNames.map(helpers.normalizedAbsolute).filter((file) => candidates.has(file));
    const host = inputs.moduleResolutionHost();
    const cache = ts.createModuleResolutionCache(root, (fileName) => fileName, options);
    const lost: Array<{ filePath: string; specifier: string }> = [];
    for (const file of files) {
      const sourceFile = this.program.getSourceFile(file);
      if (!sourceFile) continue;
      const specifiers = sourceFile.imports.filter((node) => isStringLiteralLike(node)) as ast.StringLiteral[];
      if (specifiers.length === 0) continue;
      const resolved = this.api.batch(...specifiers.map((specifier) =>
        this.program.getResolvedModuleFromModuleSpecifier.gen(specifier, sourceFile.fileName)));
      specifiers.forEach((specifier, index) => {
        if (resolved[index]?.resolvedFileName) return;
        const legacy = ts.resolveModuleName(specifier.text, file, options, host, cache).resolvedModule;
        if (legacy) lost.push({ filePath: helpers.relativePath(root, file), specifier: specifier.text });
      });
    }
    return lost;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.locationCache.clear();
    this.aliasCache.clear();
    this.invokedCache.clear();
    this.declarationSymbols.clear();
    try { this.program.dispose(); } catch { /* released with the server */ }
    // The client keeps every syntax tree it fetched; the next project fetches its own.
    try { this.api.clearSourceFileCache(); } catch { /* nothing cached */ }
  }

  capture(files: readonly string[], sink: CaptureSink): void {
    const captures: FileCapture[] = [];
    for (const absoluteFile of files) {
      const sourceFile = this.program.getSourceFile(absoluteFile);
      if (!sourceFile) continue;
      captures.push(timeGraphPhase("compiler.api.drafts", () => new FileCapture(this, absoluteFile, sourceFile)));
    }
    // Identities are assigned per file, as in the 5.9 session.
    for (const capture of captures) capture.assignIdentities();
    for (const capture of captures) {
      for (const [location, id] of capture.locations) sink.location(location, id);
      for (const node of capture.nodes) sink.node(node);
    }
    for (const capture of captures) {
      const capturedFile = helpers.normalizedAbsolute(capture.sourceFile.fileName);
      sink.dependencySignatures(capturedFile);
      sink.file(capturedFile, timeGraphPhase("compiler.api.references", () => capture.finish()));
    }
  }

  // ── Shared checker helpers ────────────────────────────────────────────────

  get root(): string { return this.request.root; }
  get projectId(): string { return this.request.project.id; }
  get inputs(): CompilerInputLedger { return this.request.inputs; }
  get typeChecker(): Checker { return this.checker; }
  get apiProject(): Project { return this.project; }
  get server(): API7 { return this.api; }
  get apiProgram(): Program { return this.program; }

  /** Follow aliases for every symbol given, in one batch for the uncached ones. */
  canonicalize(symbols: Iterable<ApiSymbol | undefined>): void {
    const pending = new Map<number, ApiSymbol>();
    for (const symbol of symbols) {
      if (!symbol || !(symbol.flags & SymbolFlags.Alias) || this.aliasCache.has(symbol.id)) continue;
      pending.set(symbol.id, symbol);
    }
    if (pending.size === 0) return;
    const list = [...pending.values()];
    const aliased = this.api.batch(...list.map((symbol) => this.checker.getAliasedSymbol.gen(symbol)));
    list.forEach((symbol, index) => this.aliasCache.set(symbol.id, aliased[index] ?? symbol));
  }

  canonical(symbol: ApiSymbol): ApiSymbol;
  canonical(symbol: ApiSymbol | undefined): ApiSymbol | undefined;
  canonical(symbol: ApiSymbol | undefined): ApiSymbol | undefined {
    if (!symbol || !(symbol.flags & SymbolFlags.Alias)) return symbol;
    let aliased = this.aliasCache.get(symbol.id);
    if (!aliased) {
      try { aliased = this.checker.getAliasedSymbol(symbol); } catch { aliased = symbol; }
      this.aliasCache.set(symbol.id, aliased);
    }
    return aliased;
  }

  /** The corpus file a declaration handle points into, or undefined. */
  corpusFile(handle: NodeHandle): string | undefined {
    return this.corpusByKey.get(handle.path);
  }

  resolveHandle(handle: NodeHandle | undefined): Node | undefined {
    if (!handle) return undefined;
    try { return handle.resolve(this.project); } catch { return undefined; }
  }

  /** Declaration locations of a symbol inside the corpus, sorted; aliases followed. */
  locations(symbol: ApiSymbol | undefined): string[] {
    if (!symbol) return [];
    const resolved = this.canonical(symbol);
    const cached = this.locationCache.get(resolved.id);
    if (cached) return cached;
    const locations = new Set<string>();
    for (const handle of resolved.declarations ?? []) {
      if (!this.corpusFile(handle)) continue;
      const node = this.resolveHandle(handle);
      if (node) locations.add(declarationLocation(node));
    }
    const sorted = [...locations].sort(helpers.compareCodePoints);
    this.locationCache.set(resolved.id, sorted);
    return sorted;
  }

  /**
   * The symbols of declarations: their name's symbol, or the enclosing
   * class's for a constructor, aliases followed. Fetched in one request for
   * every handle not seen before, and cached for the project.
   */
  symbolsForDeclarations(handles: readonly (NodeHandle | undefined)[]): (ApiSymbol | undefined)[] {
    const pending = new Map<string, Node>();
    for (const handle of handles) {
      if (!handle) continue;
      const key = handleKey(handle);
      if (this.declarationSymbols.has(key) || pending.has(key)) continue;
      const declaration = this.resolveHandle(handle);
      const name = declaration ? (declaration as { name?: Node }).name : undefined;
      const target = name ?? (declaration && isClassLike(declaration.parent) ? declaration.parent.name : undefined);
      if (target) pending.set(key, target);
      else this.declarationSymbols.set(key, undefined);
    }
    if (pending.size > 0) {
      const keys = [...pending.keys()];
      const symbols = this.checker.getSymbolAtLocation([...pending.values()]);
      this.canonicalize(symbols);
      keys.forEach((key, index) => this.declarationSymbols.set(key, this.canonical(symbols[index])));
    }
    return handles.map((handle) => handle ? this.declarationSymbols.get(handleKey(handle)) : undefined);
  }

  /** Whether a function-like declaration's body invokes one of its parameters (see the 5.9 session). */
  parameterIsInvoked(
    declaration: Node,
    parameter: ast.ParameterDeclaration,
    restArgumentIndex: number | undefined,
  ): boolean {
    const key = `${declarationLocation(declaration)}|${parameter.pos}|${restArgumentIndex ?? ""}`;
    const cached = this.invokedCache.get(key);
    if (cached !== undefined) return cached;
    const body = (declaration as { body?: Node }).body;
    let invoked = false;
    if (body && parameter.name.kind === K.Identifier) {
      const parameterName = (parameter.name as ast.Identifier).text;
      const candidates: Node[] = [];
      const visit = (node: Node): void => {
        if (node.kind === K.CallExpression) {
          const expression = (node as ast.CallExpression).expression;
          const candidate = expression.kind === K.PropertyAccessExpression
            && ["call", "apply"].includes(((expression as ast.PropertyAccessExpression).name as ast.Identifier).text)
            ? (expression as ast.PropertyAccessExpression).expression
            : expression;
          if (restArgumentIndex === undefined) {
            if (candidate.kind === K.Identifier && (candidate as ast.Identifier).text === parameterName) {
              candidates.push(candidate);
            }
          } else if (candidate.kind === K.ElementAccessExpression) {
            const access = candidate as ast.ElementAccessExpression;
            const element = access.argumentExpression;
            const index = element && element.kind === K.NumericLiteral ? Number((element as ast.NumericLiteral).text) : Number.NaN;
            if (Number.isSafeInteger(index) && index === restArgumentIndex
              && access.expression.kind === K.Identifier
              && (access.expression as ast.Identifier).text === parameterName) {
              candidates.push(access.expression);
            }
          }
        }
        node.forEachChild(visit);
      };
      body.forEachChild(visit);
      if (candidates.length > 0) {
        const symbols = this.checker.getSymbolAtLocation([parameter.name, ...candidates]);
        const parameterSymbol = symbols[0];
        invoked = Boolean(parameterSymbol && symbols.slice(1).some((symbol) => symbol?.id === parameterSymbol.id));
      }
    }
    this.invokedCache.set(key, invoked);
    return invoked;
  }
}

/**
 * Declarations another file can see without importing this one: a script,
 * a declaration file, `declare global`, `declare module "name"` or a UMD
 * global (5.9's `isGlobalScopeSource`).
 */
function isGlobalScopeFile(sourceFile: SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return true;
  if (sourceFile.externalModuleIndicator === undefined) return true;
  return sourceFile.statements.some((statement) => statement.kind === K.NamespaceExportDeclaration
    || (statement.kind === K.ModuleDeclaration && (
      isStringLiteralLike((statement as ast.ModuleDeclaration).name as Node)
      || ((statement as ast.ModuleDeclaration).name as Node).kind === K.Identifier
        && ((statement as ast.ModuleDeclaration).name as ast.Identifier).text === "global"
        && (statement as ast.ModuleDeclaration).keyword !== K.NamespaceKeyword)));
}

function handleKey(handle: NodeHandle): string {
  return `${handle.path}#${handle.index}`;
}

function declarationLocation(node: Node): string {
  const sourceFile = node.getSourceFile();
  return `${helpers.normalizedAbsolute(sourceFile.fileName)}:${node.getStart(sourceFile, false)}:${legacyKind(node.kind)}`;
}

/** One file's capture: drafts first, references once the whole project has drafts. */
class FileCapture {
  readonly filePath: string;
  readonly language: CompilerSourceLanguage;
  readonly health: CompilerSourceHealth;
  private readonly errorRanges: ErrorRange[];
  private readonly excludedDeclarationRanges: ErrorRange[] = [];
  private drafts: DraftNode[] = [];
  private fileDraft: DraftNode | undefined;
  private readonly declarationDrafts = new Map<Node, DraftNode>();
  private readonly symbolDrafts = new Map<number, DraftNode>();
  private readonly symbols = new Map<Node, ApiSymbol | undefined>();
  private readonly locals = new LocalScopes();
  locations: Array<[string, string]> = [];
  nodes: CompilerExtractedNode[] = [];

  constructor(readonly session: ApiProjectSession, absoluteFile: string, readonly sourceFile: SourceFile) {
    this.filePath = helpers.relativePath(session.root, absoluteFile);
    this.language = helpers.languageForFile(this.filePath);
    const { health, ranges } = sourceHealth(session.apiProgram, sourceFile, absoluteFile);
    this.health = health;
    this.errorRanges = ranges;
    if (health.status !== "failed") {
      this.collectDrafts();
      if (health.status === "partial" && this.drafts.length <= 1) {
        health.status = "failed";
        this.drafts = [];
        this.fileDraft = undefined;
        this.declarationDrafts.clear();
        this.symbolDrafts.clear();
      }
    }
  }

  private get checker(): Checker { return this.session.typeChecker; }

  // ── Symbols ───────────────────────────────────────────────────────────────

  /**
   * The symbol of every node the capture asks about, in one request: names of
   * declarations, callees, heritage targets, import bindings and identifiers
   * that can become references. Identifiers inside type annotations are
   * never references, so they are not asked about.
   */
  private loadSymbols(): void {
    const nodes: Node[] = [];
    const visit = (node: Node): void => {
      const kind = node.kind;
      if (kind === K.Identifier || kind === K.PrivateIdentifier) {
        if (wantsSymbol(node) && !(kind === K.Identifier && this.locals.shadows(node as ast.Identifier))) nodes.push(node);
      } else if ((kind === K.StringLiteral || kind === K.NumericLiteral) && isDeclarationName(node)) {
        nodes.push(node);
      } else if (kind === K.CallExpression || kind === K.NewExpression) {
        const callee = (node as ast.CallExpression).expression;
        if (callee.kind !== K.Identifier && callee.kind !== K.PropertyAccessExpression) nodes.push(callee);
      } else if (kind === K.ExpressionWithTypeArguments) {
        const expression = (node as ast.ExpressionWithTypeArguments).expression;
        if (expression.kind === K.PropertyAccessExpression) nodes.push(expression);
      }
      node.forEachChild(visit);
    };
    this.sourceFile.forEachChild(visit);
    if (nodes.length === 0) return;
    const symbols = timeGraphPhase("compiler.api.symbols", () => this.checker.getSymbolAtLocation(nodes));
    nodes.forEach((node, index) => this.symbols.set(node, symbols[index]));
    this.session.canonicalize(symbols);
    recordGraphPhase("compiler.api.symbolQueries", nodes.length);
  }

  symbolAt(node: Node | undefined): ApiSymbol | undefined {
    if (!node) return undefined;
    if (this.symbols.has(node)) return this.symbols.get(node);
    // A name a local shadows resolves to that local, never to a graph node.
    if (node.kind === K.Identifier && node.getSourceFile() === this.sourceFile
      && this.locals.shadows(node as ast.Identifier)) return undefined;
    let symbol: ApiSymbol | undefined;
    try { symbol = this.checker.getSymbolAtLocation(node); } catch { symbol = undefined; }
    this.symbols.set(node, symbol);
    return symbol;
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  private collectDrafts(): void {
    this.loadSymbols();
    const sourceFile = this.sourceFile;
    const fileDraft: DraftNode = {
      kind: "file",
      name: sourceFile.fileName.split(/[\\/]/u).at(-1) ?? this.filePath,
      qualifiedName: this.filePath,
      declarationRole: "source-file",
      declarations: [sourceFile],
      filePath: this.filePath,
      language: this.language,
      isExported: false,
    };
    this.fileDraft = fileDraft;
    this.drafts.push(fileDraft);
    this.declarationDrafts.set(sourceFile, fileDraft);
    const pendingDetails: DraftNode[] = [];
    const visit = (node: Node): void => {
      const descriptor = this.declarationDescriptor(node);
      if (descriptor) {
        const draft = this.addDraft(node, descriptor);
        if (draft) pendingDetails.push(draft);
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    for (const draft of this.drafts) {
      for (const declaration of draft.declarations) this.declarationDrafts.set(declaration, draft);
      if (draft.symbol) this.symbolDrafts.set(this.session.canonical(draft.symbol).id, draft);
    }
    timeGraphPhase("compiler.api.details", () => this.loadDraftDetails(pendingDetails));
  }

  private declarationDescriptor(node: Node): DeclarationDescriptor | null {
    switch (node.kind) {
      case K.FunctionDeclaration: {
        const name = (node as ast.FunctionDeclaration).name;
        return name ? { kind: "function", name: name.text, role: "function", symbolNode: name } : null;
      }
      case K.ClassDeclaration: {
        const name = (node as ast.ClassDeclaration).name;
        return name ? { kind: "class", name: name.text, role: "class", symbolNode: name } : null;
      }
      case K.InterfaceDeclaration: {
        const name = (node as ast.InterfaceDeclaration).name;
        return { kind: "interface", name: name.text, role: "interface", symbolNode: name };
      }
      case K.EnumDeclaration: {
        const name = (node as ast.EnumDeclaration).name;
        return { kind: "enum", name: name.text, role: "enum", symbolNode: name };
      }
      case K.EnumMember: {
        const name = (node as ast.EnumMember).name;
        return { kind: "enum_member", name: propertyName(name, this.sourceFile), role: "enum-member", symbolNode: name };
      }
      case K.TypeAliasDeclaration: {
        const name = (node as ast.TypeAliasDeclaration).name;
        return { kind: "type_alias", name: name.text, role: "type-alias", symbolNode: name };
      }
      case K.ModuleDeclaration: {
        const name = (node as ast.ModuleDeclaration).name as Node;
        return { kind: "namespace", name: (name as ast.Identifier).text, role: "namespace", symbolNode: name };
      }
      case K.MethodDeclaration:
      case K.MethodSignature: {
        const name = (node as ast.MethodDeclaration).name;
        return { kind: "method", name: propertyName(name, this.sourceFile), role: "method", symbolNode: name };
      }
      case K.Constructor:
        return { kind: "method", name: "constructor", role: "constructor" };
      case K.GetAccessor:
      case K.SetAccessor: {
        const name = (node as ast.GetAccessorDeclaration).name;
        return { kind: "method", name: propertyName(name, this.sourceFile), role: "accessor", symbolNode: name };
      }
      case K.PropertyDeclaration:
      case K.PropertySignature: {
        const declaration = node as ast.PropertyDeclaration;
        const callable = node.kind === K.PropertyDeclaration && declaration.initializer
          && isFunctionLikeValue(declaration.initializer);
        return {
          kind: callable ? "method" : "property",
          name: propertyName(declaration.name, this.sourceFile),
          role: callable ? "callable-property" : "property",
          symbolNode: declaration.name,
        };
      }
      case K.VariableDeclaration: {
        const declaration = node as ast.VariableDeclaration;
        if (declaration.name.kind !== K.Identifier) return null;
        const callable = declaration.initializer && isFunctionLikeValue(declaration.initializer);
        if (!callable && !isModuleVariable(declaration)) return null;
        return {
          kind: callable ? "function" : variableKind(declaration),
          name: (declaration.name as ast.Identifier).text,
          role: callable ? "function-variable" : "variable",
          symbolNode: declaration.name,
        };
      }
      case K.ArrowFunction:
      case K.FunctionExpression: {
        const parent = node.parent;
        if (parent.kind === K.BinaryExpression) {
          const binary = parent as ast.BinaryExpression;
          if (binary.operatorToken.kind === K.EqualsToken && binary.right === node
            && (binary.left.kind === K.PropertyAccessExpression || binary.left.kind === K.ElementAccessExpression)) {
            const name = assignedFunctionName(binary.left);
            if (name) {
              const symbolNode = binary.left.kind === K.PropertyAccessExpression
                ? (binary.left as ast.PropertyAccessExpression).name
                : (binary.left as ast.ElementAccessExpression).argumentExpression;
              return { kind: "function", name, role: "function-assignment", symbolNode, declarations: [parent] };
            }
          }
        }
        if (isNamedFunctionValue(node)) return null;
        const role = anonymousFunctionRole(node, this.sourceFile);
        return { kind: "function", name: `<callback:${role.label}>`, role: role.identity };
      }
      default:
        return null;
    }
  }

  private addDraft(node: Node, descriptor: DeclarationDescriptor): DraftNode | undefined {
    const rawSymbol = descriptor.symbolNode ? this.symbolAt(descriptor.symbolNode) : undefined;
    const symbol = rawSymbol ? this.session.canonical(rawSymbol) : undefined;
    if (symbol && descriptor.role !== "function-assignment") {
      const existing = this.symbolDrafts.get(symbol.id);
      if (existing) {
        this.declarationDrafts.set(node, existing);
        return undefined;
      }
    }
    const declarations = descriptor.declarations?.slice()
      ?? (symbol ? this.sameFileDeclarations(symbol, descriptor.kind) : undefined)
      ?? [node];
    const usable = declarations.length > 0 ? declarations : [node];
    if (usable.some((declaration) => intersectsRanges(declaration, this.errorRanges, this.sourceFile))) {
      this.health.excludedDeclarationCount++;
      for (const declaration of usable) {
        this.excludedDeclarationRanges.push({ start: declaration.getStart(this.sourceFile, false), end: declaration.end });
      }
      return undefined;
    }
    const container = this.closestDraft(node.parent) ?? this.fileDraft;
    const qualifiedName = [
      ...(container && container.kind !== "file" ? [container.qualifiedName] : []),
      descriptor.name,
    ].join("::");
    const representative = implementationDeclaration(usable);
    const draft: DraftNode = {
      kind: descriptor.kind,
      name: descriptor.name,
      qualifiedName,
      declarationRole: descriptor.role,
      declarations: usable,
      symbol,
      container,
      filePath: this.filePath,
      language: this.language,
      docstring: symbol ? undefined : jsDocForNode(representative),
      visibility: visibilityOf(representative),
      isExported: hasModifier(representative, K.ExportKeyword) || hasModifier(representative, K.DefaultKeyword),
      isAsync: hasModifier(representative, K.AsyncKeyword) || undefined,
      isStatic: hasModifier(representative, K.StaticKeyword) || undefined,
      isAbstract: hasModifier(representative, K.AbstractKeyword) || undefined,
      decorators: decoratorsOf(representative, this.sourceFile),
      typeParameters: typeParametersOf(representative),
    };
    this.drafts.push(draft);
    this.declarationDrafts.set(node, draft);
    for (const declaration of usable) this.declarationDrafts.set(declaration, draft);
    if (symbol) this.symbolDrafts.set(symbol.id, draft);
    return draft;
  }

  private sameFileDeclarations(symbol: ApiSymbol, kind: CompilerNodeKind): Node[] | undefined {
    const declarations = symbol.declarations;
    if (!declarations) return undefined;
    const result: Node[] = [];
    for (const handle of declarations) {
      if (handle.path !== this.sourceFile.path) continue;
      const node = this.session.resolveHandle(handle);
      if (node && node.getSourceFile() === this.sourceFile && compatibleDeclaration(kind, node)) result.push(node);
    }
    return result;
  }

  /** Docstrings, exports, signatures and return types: one batch for the whole file. */
  /**
   * Docstrings, exports and signatures, in one batch for the whole file and
   * about three requests a node. A node's signature is display text, so it is
   * the checker's ordinary, length-limited rendering of the declared type;
   * classes, interfaces, enums, aliases and namespaces show their source
   * header instead, and a return type is the one written in the source.
   */
  private loadDraftDetails(drafts: readonly DraftNode[]): void {
    const root = this.session.root;
    for (const draft of drafts) draft.returnType = annotatedReturnType(draft.declarations, this.sourceFile);
    const withSymbol = drafts.filter((draft) => draft.symbol);
    const exported = this.moduleExports(withSymbol.some((draft) => !draft.isExported));
    const checker = this.checker;
    const detail = function* (draft: DraftNode) {
      const symbol = draft.symbol!;
      const docstring = yield* checker.getDocumentationCommentOfSymbol.gen(symbol);
      if (!TYPED_SIGNATURE_KINDS.has(draft.kind)) return { docstring, typeText: undefined };
      const type = yield* checker.getTypeOfSymbolAtLocation.gen(symbol, draft.declarations[0]!);
      const typeText = yield* checker.typeToString.gen(type, draft.declarations[0]!, TYPE_FORMAT_FLAGS);
      return { docstring, typeText };
    };
    const results = withSymbol.length > 0 ? this.session.server.batch(...withSymbol.map(detail)) : [];
    withSymbol.forEach((draft, index) => {
      const result = results[index]!;
      draft.docstring = result.docstring || undefined;
      draft.signature = declarationSignature(
        draft.declarations,
        result.typeText === undefined || result.typeText === "any" ? undefined : result.typeText,
        root,
      );
      if (!draft.isExported && exported.has(this.session.canonical(draft.symbol!).id)) draft.isExported = true;
    });
    for (const draft of drafts) {
      if (!draft.symbol) draft.signature = declarationSignature(draft.declarations, undefined, root);
    }
  }

  private moduleExports(needed: boolean): Set<number> {
    if (!needed) return new Set();
    const moduleSymbol = this.checker.getSymbolOfSourceFile(this.sourceFile.fileName);
    if (!moduleSymbol) return new Set();
    const exports = this.checker.getExportsOfModule(moduleSymbol);
    this.session.canonicalize(exports);
    return new Set(exports.map((symbol) => this.session.canonical(symbol).id));
  }

  private closestDraft(node: Node | undefined): DraftNode | undefined {
    for (let current = node; current && current.kind !== K.SourceFile; current = current.parent) {
      const draft = this.declarationDrafts.get(current);
      if (draft) return draft;
    }
    return this.fileDraft;
  }

  private enclosingSourceId(node: Node): string | undefined {
    return this.closestDraft(node)?.id ?? this.fileDraft?.id;
  }

  assignIdentities(): void {
    const groups = new Map<string, DraftNode[]>();
    for (const draft of this.drafts) {
      const base = canonicalCompilerIdentity({
        filePath: draft.filePath,
        kind: draft.kind,
        qualifiedName: draft.qualifiedName,
        declarationRole: draft.declarationRole,
      });
      draft.identityBase = base;
      const entries = groups.get(base) ?? [];
      entries.push(draft);
      groups.set(base, entries);
    }
    for (const [base, entries] of groups) {
      entries.sort((left, right) => draftStart(left) - draftStart(right));
      entries.forEach((draft, index) => {
        draft.identityKey = entries.length === 1 ? base : `${base}\u0000ordinal:${index}`;
        draft.id = generateCanonicalCompilerNodeId(draft.kind, draft.identityKey);
      });
    }
    for (const draft of this.drafts) {
      if (!draft.id) continue;
      for (const declaration of draft.declarations) {
        this.locations.push([declarationLocation(declaration), draft.id]);
        if (draft.declarationRole === "function-assignment" && declaration.kind === K.BinaryExpression) {
          const binary = declaration as ast.BinaryExpression;
          this.locations.push([declarationLocation(binary.left), draft.id]);
          this.locations.push([declarationLocation(binary.right), draft.id]);
        }
      }
    }
    this.nodes = this.materializeNodes();
  }

  private materializeNodes(): CompilerExtractedNode[] {
    const sourceFile = this.sourceFile;
    const point = (position: number): { line: number; character: number } => sourceFile.getLineAndCharacterOfPosition(position);
    return this.drafts
      .filter((draft): draft is DraftNode & { id: string; identityKey: string } => Boolean(draft.id && draft.identityKey))
      .sort((left, right) => draftStart(left) - draftStart(right) || left.id.localeCompare(right.id))
      .map((draft) => {
        const declarations = draft.declarations.slice().sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
        const start = point(declarations[0]!.getStart(sourceFile));
        const end = point(declarations.at(-1)!.end);
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
          docstring: draft.docstring ? helpers.sourceEvidenceText(draft.docstring) : undefined,
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
            const spanStart = point(declaration.getStart(sourceFile));
            const spanEnd = point(declaration.end);
            return {
              startLine: spanStart.line + 1,
              endLine: spanEnd.line + 1,
              startColumn: spanStart.character,
              endColumn: spanEnd.character,
            };
          }),
        };
      });
  }

  // ── References ────────────────────────────────────────────────────────────

  finish(): CapturedFile {
    const resolvedSpecifiers: string[] = [];
    const bindings = this.captureImportBindings(resolvedSpecifiers);
    const captured = this.captureReferences(bindings);
    const result: CapturedFile = {
      filePath: this.filePath,
      language: this.language,
      projectId: this.session.projectId,
      health: this.health,
      nodes: this.nodes,
      fileDraftId: this.fileDraft?.id,
      bindings,
      captured,
      locations: this.locations,
      resolvedSpecifiers,
    };
    this.drafts = [];
    this.declarationDrafts.clear();
    this.symbolDrafts.clear();
    this.symbols.clear();
    this.fileDraft = undefined;
    return result;
  }

  private captureImportBindings(resolvedSpecifiers: string[]): DeferredImportBinding[] {
    const sourceFile = this.sourceFile;
    const statements = sourceFile.statements.filter((statement): statement is ast.ImportDeclaration =>
      statement.kind === K.ImportDeclaration
      && isStringLiteralLike((statement as ast.ImportDeclaration).moduleSpecifier)
      && this.referenceSyntaxIsTrusted(statement));
    if (statements.length === 0) return [];
    const program = this.session.apiProgram;
    const resolutions = this.session.server.batch(...statements.map((statement) =>
      program.getResolvedModuleFromModuleSpecifier.gen(statement.moduleSpecifier as ast.StringLiteral, sourceFile.fileName)));
    const bindings: DeferredImportBinding[] = [];
    statements.forEach((statement, index) => {
      const moduleSpecifier = (statement.moduleSpecifier as ast.StringLiteral).text;
      resolvedSpecifiers.push(moduleSpecifier);
      const resolution = resolutions[index];
      const resolvedFileName = resolution?.resolvedFileName ? helpers.normalizedAbsolute(resolution.resolvedFileName) : undefined;
      const resolvedFilePath = resolvedFileName && helpers.withinRoot(this.session.root, resolvedFileName)
        ? helpers.relativePath(this.session.root, resolvedFileName)
        : undefined;
      const clause = statement.importClause;
      const add = (
        local: ast.Identifier,
        importedName: string,
        flags: { isDefault?: boolean; isNamespace?: boolean; isTypeOnly?: boolean } = {},
      ): void => {
        const position = sourceFile.getLineAndCharacterOfPosition(local.getStart(sourceFile));
        const identity = [this.filePath, local.text, moduleSpecifier, importedName].join("\u0000");
        bindings.push({
          binding: {
            id: `import:${helpers.sha256(identity).slice(0, 32)}`,
            filePath: this.filePath,
            localName: local.text,
            importedName,
            moduleSpecifier,
            resolvedFilePath,
            isTypeOnly: Boolean(clause && isTypeOnlyClause(clause)) || Boolean(flags.isTypeOnly),
            isNamespace: Boolean(flags.isNamespace),
            isDefault: Boolean(flags.isDefault),
            line: position.line,
            column: position.character,
            confidence: 1,
            resolutionMethod: "typescript-import",
          } satisfies Omit<CompilerImportBinding, "targetId">,
          targetLocations: this.session.locations(this.symbolAt(local)),
        });
      };
      if (!clause) return;
      if (clause.name) add(clause.name, "default", { isDefault: true });
      const named = clause.namedBindings;
      if (named && named.kind === K.NamespaceImport) {
        add((named as ast.NamespaceImport).name, "*", { isNamespace: true });
      } else if (named && named.kind === K.NamedImports) {
        for (const element of (named as ast.NamedImports).elements) {
          const propertyNameNode = element.propertyName as Node | undefined;
          const importedName = propertyNameNode ? (propertyNameNode as ast.Identifier).text : element.name.text;
          add(element.name, importedName, { isTypeOnly: element.isTypeOnly });
        }
      }
    });
    return bindings.sort((left, right) => left.binding.line - right.binding.line
      || left.binding.column - right.binding.column
      || left.binding.id.localeCompare(right.binding.id));
  }

  private captureReferences(importBindings: readonly DeferredImportBinding[]): CapturedReference[] {
    if (!this.fileDraft?.id) return [];
    const sourceFile = this.sourceFile;
    const fileDraftId = this.fileDraft.id;
    const captured: CapturedReference[] = [];
    for (const draft of this.drafts) {
      if (!draft.id || !draft.container?.id) continue;
      const position = draftStart(draft);
      const point = lineColumn(sourceFile, position);
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
          filePath: this.filePath,
          line: point.line,
          column: point.column,
          evidence: { declarationRole: draft.declarationRole },
        } satisfies Omit<CompilerReference, "id">,
      });
    }
    for (const { binding } of importBindings) {
      captured.push({
        form: "import",
        position: sourceFile.getPositionOfLineAndCharacter(binding.line, binding.column),
        line: binding.line,
        column: binding.column,
        sourceId: fileDraftId,
        bindingId: binding.id,
        moduleSpecifier: binding.moduleSpecifier,
        resolvedFilePath: binding.resolvedFilePath,
      });
    }

    // One walk in source order; checker questions for calls are batched and
    // their records filled in afterwards, in the same order.
    type Slot = { kind: "call"; index: number } | { kind: "record"; record: CapturedReference };
    const slots: Slot[] = [];
    const calls: Array<ast.CallExpression | ast.NewExpression> = [];
    const visit = (node: Node): void => {
      const trusted = this.referenceSyntaxIsTrusted(node);
      if (trusted && (node.kind === K.CallExpression || node.kind === K.NewExpression)) {
        slots.push({ kind: "call", index: calls.length });
        calls.push(node as ast.CallExpression | ast.NewExpression);
      } else if (trusted && node.kind === K.HeritageClause) {
        for (const record of this.heritageReferences(node as ast.HeritageClause)) slots.push({ kind: "record", record });
      } else if (trusted && node.kind === K.Identifier && shouldEmitIdentifierReference(node as ast.Identifier)) {
        const record = this.identifierReference(node as ast.Identifier);
        if (record) slots.push({ kind: "record", record });
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    const facts = timeGraphPhase("compiler.api.calls", () => this.callFacts(calls));
    timeGraphPhase("compiler.api.declarationSymbols", () => this.session.symbolsForDeclarations(facts.flatMap((fact) => [
      ...fact.callSignatures.map((signature) => signature.declaration),
      ...(fact.memberSignatures === null && fact.resolvedSignature ? [fact.resolvedSignature.declaration] : []),
    ])));
    for (const slot of slots) {
      if (slot.kind === "record") {
        captured.push(slot.record);
        continue;
      }
      const fact = facts[slot.index]!;
      const call = this.callReference(fact);
      if (call) captured.push(call);
      if (fact.node.kind === K.CallExpression) captured.push(...this.callbackReferences(fact));
    }
    return captured;
  }

  /** Every call's checker questions, batched across the file. */
  private callFacts(calls: ReadonlyArray<ast.CallExpression | ast.NewExpression>): CallFacts[] {
    if (calls.length === 0) return [];
    const checker = this.checker;
    const alternatives = calls.map((call) => calleeAlternatives(call.expression, this));
    const fact = function* (call: ast.CallExpression | ast.NewExpression, alternativeNodes: Node[] | undefined) {
      const expression = call.expression;
      const kind = call.kind === K.NewExpression ? SignatureKind.Construct : SignatureKind.Call;
      // An optional call (`f?.()`) calls the callee only when it is present;
      // 5.9 reports that type without `undefined`, and so do we.
      let calleeType = yield* checker.getTypeAtLocation.gen(expression);
      if ((call as ast.CallExpression).questionDotToken) calleeType = yield* checker.getNonNullableType.gen(calleeType);
      const isUnion = calleeType.isUnionType();
      const members = isUnion ? yield* (calleeType as ApiUnionType).getTypes.gen() : [];
      const signaturesOf = function* (type: ApiType, signatureKind: SignatureKind) {
        if (!type.isUnionType()) return yield* checker.getSignaturesOfType.gen(type, signatureKind);
        const result: ApiSignature[] = [];
        for (const member of yield* type.getTypes.gen()) {
          result.push(...yield* checker.getSignaturesOfType.gen(member, signatureKind));
        }
        return result;
      };
      let memberSignatures: ApiSignature[] | null = null;
      if (alternativeNodes) {
        const seen = new Map<number, ApiSignature>();
        for (const alternative of alternativeNodes) {
          const type = yield* checker.getTypeAtLocation.gen(alternative);
          for (const signature of yield* signaturesOf(type, kind)) seen.set(signature.id, signature);
        }
        memberSignatures = [...seen.values()];
      } else if (isUnion) {
        memberSignatures = [];
        for (const member of members) memberSignatures.push(...yield* checker.getSignaturesOfType.gen(member, kind));
      }
      let unionCallSignatures: ApiSignature[] | null = null;
      if (isUnion && call.kind === K.CallExpression) {
        unionCallSignatures = [];
        for (const member of members) {
          unionCallSignatures.push(...yield* checker.getSignaturesOfType.gen(member, SignatureKind.Call));
        }
      }
      const unionCallee = isUnion || alternativeNodes !== undefined;
      let resolvedSignature: ApiSignature | undefined;
      if (!unionCallee || (call.kind === K.CallExpression && !isUnion)) {
        const signature = yield* checker.getResolvedSignature.gen(call);
        resolvedSignature = signature.declaration ? signature : undefined;
      }
      const callSignatures = unionCallee ? memberSignatures ?? [] : yield* calleeType.getCallSignatures.gen();
      let polymorphic = false;
      if (expression.kind === K.PropertyAccessExpression) {
        const receiver = (expression as ast.PropertyAccessExpression).expression;
        if (receiver.kind !== K.ThisKeyword && receiver.kind !== K.SuperKeyword) {
          let receiverType = yield* checker.getTypeAtLocation.gen(receiver);
          if ((expression as ast.PropertyAccessExpression).questionDotToken) {
            receiverType = yield* checker.getNonNullableType.gen(receiverType);
          }
          if (receiverType.flags & (TypeFlags.Union | TypeFlags.Intersection | TypeFlags.TypeParameter)) polymorphic = true;
          else {
            const symbol = yield* receiverType.getSymbol.gen();
            polymorphic = Boolean(symbol && (symbol.flags & SymbolFlags.Interface));
          }
        }
      }
      return { node: call, calleeType, memberSignatures, unionCallSignatures, resolvedSignature, callSignatures, polymorphic };
    };
    return this.session.server.batch(...calls.map((call, index) => fact(call, alternatives[index])));
  }

  private callReference(fact: CallFacts): CapturedReference | undefined {
    const node = fact.node;
    const sourceFile = this.sourceFile;
    const expression = node.expression;
    const sourceId = this.enclosingSourceId(node);
    if (!sourceId) return undefined;
    const unionCallee = fact.memberSignatures !== null;
    // 5.9 parity: the resolved signature counts only for a callee that is
    // neither a union nor a choice between values.
    const resolved = unionCallee ? undefined : fact.resolvedSignature;
    const declarationSymbols = this.session.symbolsForDeclarations([
      ...fact.callSignatures.map((signature) => signature.declaration),
      resolved?.declaration,
    ]);
    const expressionSymbol = this.symbolAt(expression.kind === K.PropertyAccessExpression
      ? (expression as ast.PropertyAccessExpression).name
      : expression);
    const locations = new Set<string>();
    for (const symbol of [...declarationSymbols, expressionSymbol]) {
      for (const location of this.session.locations(symbol)) locations.add(location);
    }
    const isAccess = expression.kind === K.PropertyAccessExpression;
    const access = expression as ast.PropertyAccessExpression;
    const receiver = isAccess ? helpers.sourceEvidenceText(nodeText(access.expression, sourceFile)) : undefined;
    const targetName = isAccess
      ? (access.name as ast.Identifier).text
      : helpers.sourceEvidenceText(nodeText(expression, sourceFile));
    const position = isAccess ? access.name.getStart(sourceFile) : expression.getStart(sourceFile);
    const point = lineColumn(sourceFile, position);
    return {
      form: "call",
      position,
      line: point.line,
      column: point.column,
      sourceId,
      isNew: node.kind === K.NewExpression,
      targetName,
      receiver,
      polymorphic: fact.polymorphic,
      candidateLocations: [...locations].sort(helpers.compareCodePoints),
      expressionText: helpers.sourceEvidenceText(nodeText(expression, sourceFile)),
    };
  }

  private callbackReferences(fact: CallFacts): CapturedReference[] {
    const call = fact.node as ast.CallExpression;
    if (call.arguments.length === 0) return [];
    let declaration: Node | undefined;
    if (fact.unionCallSignatures) {
      declaration = firstDeclarationInCodeOrder(
        fact.unionCallSignatures.map((signature) => this.session.resolveHandle(signature.declaration))
          .filter((candidate): candidate is Node => Boolean(candidate)),
        this.session.root,
      );
    } else {
      declaration = this.session.resolveHandle(fact.resolvedSignature?.declaration);
    }
    if (!declaration || !isFunctionLike(declaration)) return [];
    const calleeLocations = this.locationsOfDeclarationSymbol(declaration);
    if (calleeLocations.length === 0) return [];
    const parameters = (declaration as ast.FunctionDeclaration).parameters;
    const declarationFile = declaration.getSourceFile();
    const records: CapturedReference[] = [];
    call.arguments.forEach((argument, index) => {
      const mapping = callbackParameterForArgument(parameters, index);
      if (!mapping || !isFunctionLikeWithBody(declaration!)
        || !this.session.parameterIsInvoked(declaration!, mapping.parameter, mapping.restArgumentIndex)) return;
      let callbackDraftId: string | undefined;
      let callbackLocations: string[] = [];
      if (argument.kind === K.ArrowFunction || argument.kind === K.FunctionExpression) {
        callbackDraftId = this.declarationDrafts.get(argument)?.id;
        if (!callbackDraftId) return;
      } else {
        callbackLocations = this.session.locations(this.symbolAt(argument));
        if (callbackLocations.length === 0) return;
      }
      const position = argument.getStart(this.sourceFile);
      const point = lineColumn(this.sourceFile, position);
      records.push({
        form: "callback",
        position,
        line: point.line,
        column: point.column,
        calleeLocations,
        callbackDraftId,
        callbackLocations,
        parameterName: helpers.sourceEvidenceText(nodeText(mapping.parameter.name, declarationFile)),
        argumentIndex: index,
        wiringSite: helpers.sourceEvidenceText(nodeText(call, this.sourceFile)),
        argumentText: helpers.sourceEvidenceText(nodeText(argument, this.sourceFile)),
      });
    });
    return records;
  }

  /** The 5.9 session's `symbolForDeclaration` for a declaration we already hold. */
  private locationsOfDeclarationSymbol(declaration: Node): string[] {
    const name = (declaration as { name?: Node }).name;
    const target = name ?? (isClassLike(declaration.parent) ? declaration.parent.name : undefined);
    return target ? this.session.locations(this.symbolAt(target)) : [];
  }

  private heritageReferences(clause: ast.HeritageClause): CapturedReference[] {
    const sourceId = this.enclosingSourceId(clause.parent);
    if (!sourceId) return [];
    const records: CapturedReference[] = [];
    for (const type of clause.types) {
      // 7.1 parses some heritage elements as type references.
      const expression = ((type as ast.ExpressionWithTypeArguments).expression
        ?? (type as unknown as ast.TypeReferenceNode).typeName) as Node | undefined;
      if (!expression) continue;
      const position = type.getStart(this.sourceFile);
      const point = lineColumn(this.sourceFile, position);
      records.push({
        form: "heritage",
        position,
        line: point.line,
        column: point.column,
        sourceId,
        isImplements: clause.token === K.ImplementsKeyword,
        targetName: helpers.sourceEvidenceText(nodeText(expression, this.sourceFile)),
        targetLocations: this.session.locations(this.symbolAt(expression)),
      });
    }
    return records;
  }

  private identifierReference(identifier: ast.Identifier): CapturedReference | undefined {
    const targetLocations = this.session.locations(this.symbolAt(identifier));
    const sourceId = this.enclosingSourceId(identifier);
    if (!sourceId || targetLocations.length === 0) return undefined;
    const position = identifier.getStart(this.sourceFile);
    const point = lineColumn(this.sourceFile, position);
    const parent = identifier.parent;
    const receiver = parent.kind === K.PropertyAccessExpression && (parent as ast.PropertyAccessExpression).name === identifier
      ? helpers.sourceEvidenceText(nodeText((parent as ast.PropertyAccessExpression).expression, this.sourceFile))
      : undefined;
    return {
      form: "identifier",
      position,
      line: point.line,
      column: point.column,
      sourceId,
      text: identifier.text,
      receiver,
      targetLocations,
    };
  }

  private referenceSyntaxIsTrusted(node: Node): boolean {
    if (intersectsRanges(node, this.errorRanges, this.sourceFile)) return false;
    if (this.excludedDeclarationRanges.length === 0) return true;
    const start = node.getStart(this.sourceFile, false);
    const end = node.end;
    return !this.excludedDeclarationRanges.some((range) => range.start <= start && range.end >= end);
  }
}

function sourceHealth(
  program: Program,
  sourceFile: SourceFile,
  absoluteFile: string,
): { health: CompilerSourceHealth; ranges: ErrorRange[] } {
  const syntactic = program.getSyntacticDiagnostics(absoluteFile);
  const text = sourceFile.text;
  const ranges = helpers.diagnosticRanges(text, syntactic.map((diagnostic) => ({
    start: diagnostic.pos,
    length: Math.max(0, diagnostic.end - diagnostic.pos),
  })));
  const coveredBytes = ranges.reduce((total, range) => total + Buffer.byteLength(text.slice(range.start, range.end), "utf8"), 0);
  const totalBytes = Math.max(1, Buffer.byteLength(text, "utf8"));
  const coverage = Math.min(1, coveredBytes / totalBytes);
  return {
    health: {
      status: syntactic.length === 0 ? "ok" : coverage <= 0.25 ? "partial" : "failed",
      syntacticDiagnosticCount: syntactic.length,
      semanticDiagnosticCount: 0,
      diagnosticByteCoverage: coverage,
      excludedDeclarationCount: 0,
      diagnostics: syntactic.slice(0, 100).map((diagnostic): CompilerDiagnosticSummary => ({
        code: diagnostic.code,
        category: DIAGNOSTIC_CATEGORIES[diagnostic.category] ?? "message",
        message: diagnostic.text,
        start: diagnostic.pos,
        length: Math.max(0, diagnostic.end - diagnostic.pos),
      })),
    },
    ranges,
  };
}

const DIAGNOSTIC_CATEGORIES: Record<number, CompilerDiagnosticSummary["category"]> = {
  0: "warning", 1: "error", 2: "suggestion", 3: "message",
};

// `typeToString`'s default length limit applies: a node's signature is display
// text and no longer part of its identity, so it need not be complete.
const TYPE_FORMAT_FLAGS = 16384; // TypeFormatFlags.UseAliasDefinedOutsideCurrentScope

function intersectsRanges(node: Node, ranges: readonly ErrorRange[], sourceFile: SourceFile): boolean {
  if (ranges.length === 0) return false;
  const start = node.getStart(sourceFile, false);
  const end = node.end;
  return ranges.some((range) => range.start < end && range.end > start);
}

/**
 * Which identifiers name a parameter or a plain local variable of an
 * enclosing function. Such a name's symbol is that local, which is never a
 * graph node, so the capture does not ask the checker about it. Callees are
 * asked about anyway (their value may be traced), and so is any name a
 * function-valued local, a nested function or a nested class declares.
 */
class LocalScopes {
  private readonly scopes = new Map<Node, { locals: Set<string>; declared: Set<string> }>();

  shadows(identifier: ast.Identifier): boolean {
    const parent = identifier.parent;
    if ((parent.kind === K.CallExpression || parent.kind === K.NewExpression)
      && (parent as ast.CallExpression).expression === identifier) return false;
    // A member or property name is not a variable reference, whatever locals are in scope.
    if ((parent as { name?: Node }).name === identifier && parent.kind !== K.VariableDeclaration) return false;
    if (parent.kind === K.QualifiedName && (parent as ast.QualifiedName).right === identifier) return false;
    const name = identifier.text;
    for (let current: Node | undefined = parent; current; current = current.parent) {
      const kind = current.kind;
      if (kind === K.SourceFile || kind === K.ModuleBlock || kind === K.ClassDeclaration || kind === K.ClassExpression) return false;
      if (!LOCAL_SCOPE_KINDS.has(kind)) continue;
      const scope = this.scopeOf(current);
      if (scope.declared.has(name)) return false;
      if (scope.locals.has(name)) return true;
    }
    return false;
  }

  private scopeOf(node: Node): { locals: Set<string>; declared: Set<string> } {
    let scope = this.scopes.get(node);
    if (scope) return scope;
    scope = { locals: new Set(), declared: new Set() };
    const addBinding = (binding: Node | undefined, target: Set<string>): void => {
      if (!binding) return;
      if (binding.kind === K.Identifier) target.add((binding as ast.Identifier).text);
      else if (binding.kind === K.ObjectBindingPattern || binding.kind === K.ArrayBindingPattern) {
        for (const element of (binding as ast.ObjectBindingPattern).elements) {
          if (element.kind === K.BindingElement) addBinding((element as ast.BindingElement).name, target);
        }
      }
    };
    if (isFunctionLike(node)) {
      for (const parameter of (node as ast.FunctionDeclaration).parameters ?? []) addBinding(parameter.name, scope.locals);
    } else if (node.kind === K.CatchClause) {
      addBinding((node as ast.CatchClause).variableDeclaration?.name, scope.locals);
    } else if (node.kind === K.ForStatement || node.kind === K.ForInStatement || node.kind === K.ForOfStatement) {
      const initializer = (node as ast.ForOfStatement).initializer;
      if (initializer?.kind === K.VariableDeclarationList) {
        for (const declaration of (initializer as ast.VariableDeclarationList).declarations) addBinding(declaration.name, scope.locals);
      }
    } else if (node.kind === K.Block || node.kind === K.CaseBlock) {
      const statements = node.kind === K.Block
        ? (node as ast.Block).statements
        : (node as ast.CaseBlock).clauses.flatMap((clause) => [...(clause as ast.CaseClause).statements]);
      for (const statement of statements) {
        if (statement.kind === K.VariableStatement) {
          for (const declaration of (statement as ast.VariableStatement).declarationList.declarations) {
            const callable = declaration.initializer && isFunctionLikeValue(declaration.initializer);
            addBinding(declaration.name, callable ? scope.declared : scope.locals);
          }
        } else if (statement.kind === K.FunctionDeclaration || statement.kind === K.ClassDeclaration
          || statement.kind === K.EnumDeclaration || statement.kind === K.ModuleDeclaration) {
          const name = (statement as ast.FunctionDeclaration).name;
          if (name?.kind === K.Identifier) scope.declared.add(name.text);
        }
      }
    }
    // A `var` hoists from a nested block; it is not seen here, so that name is simply asked about.
    for (const name of scope.declared) scope.locals.delete(name);
    this.scopes.set(node, scope);
    return scope;
  }
}

const LOCAL_SCOPE_KINDS = new Set<number>([
  ...FUNCTION_LIKE_KINDS, K.Block, K.CaseBlock, K.CatchClause, K.ForStatement, K.ForInStatement, K.ForOfStatement,
]);

/** Kinds whose name is a graph declaration (see `declarationDescriptor`). */
const DRAFT_NAME_PARENTS = new Set<number>([
  K.FunctionDeclaration, K.ClassDeclaration, K.InterfaceDeclaration, K.EnumDeclaration, K.EnumMember,
  K.TypeAliasDeclaration, K.ModuleDeclaration, K.MethodDeclaration, K.MethodSignature, K.GetAccessor,
  K.SetAccessor, K.PropertyDeclaration, K.PropertySignature, K.VariableDeclaration,
  K.ImportClause, K.NamespaceImport, K.ImportSpecifier, K.PropertyAccessExpression,
]);

/**
 * Identifiers whose symbol the capture uses (see `loadSymbols`): declaration
 * names, import bindings, member names, callees, heritage targets and
 * identifiers that can become references. Parameters, type parameters and
 * names inside type annotations are never asked about.
 */
function wantsSymbol(node: Node): boolean {
  const parent = node.parent;
  const k = parent.kind;
  if ((parent as { name?: Node }).name === node) return DRAFT_NAME_PARENTS.has(k);
  if ((k === K.CallExpression || k === K.NewExpression) && (parent as ast.CallExpression).expression === node) return true;
  if (k === K.ExpressionWithTypeArguments) return true;
  return node.kind === K.Identifier && shouldEmitIdentifierReference(node as ast.Identifier);
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent as Node & { name?: Node };
  return Boolean(parent && parent.name === node);
}

function declarationSignature(declarations: readonly Node[], typeText: string | undefined, root: string): string | undefined {
  if (typeText) return portableCheckerText(typeText, root);
  const headers = [...new Set(declarations.map(declarationHeader).filter(Boolean))].sort();
  return headers.length > 0 ? headers.join(" | ") : undefined;
}

/** Kinds whose signature is their type; the others show their source header. */
const TYPED_SIGNATURE_KINDS = new Set<CompilerNodeKind>(["function", "method", "property", "variable", "constant", "enum_member"]);

/** The return type written in the source, if the declaration has one. */
function annotatedReturnType(declarations: readonly Node[], sourceFile: SourceFile): string | undefined {
  const representative = implementationDeclaration(declarations);
  const target = representative.kind === K.VariableDeclaration
    ? (representative as ast.VariableDeclaration).initializer
    : representative.kind === K.PropertyDeclaration ? (representative as ast.PropertyDeclaration).initializer : representative;
  if (!target || !isFunctionLike(target)) return undefined;
  const type = (target as { type?: Node }).type;
  return type ? helpers.normalizeSignature(nodeText(type, type.getSourceFile() ?? sourceFile)) : undefined;
}

function declarationHeader(node: Node): string {
  const source = node.getSourceFile();
  let end = node.end;
  if (isFunctionLikeWithBody(node)) end = node.body.getStart(source);
  else if (node.kind === K.ClassDeclaration || node.kind === K.InterfaceDeclaration || node.kind === K.EnumDeclaration) {
    end = (node as ast.ClassDeclaration).members.pos;
  } else if ((node.kind === K.VariableDeclaration || node.kind === K.PropertyDeclaration)
    && (node as ast.VariableDeclaration).initializer) {
    end = (node as ast.VariableDeclaration).initializer!.getStart(source);
  }
  return helpers.normalizeSignature(source.text.slice(node.getStart(source), end).replace(/[={:]\s*$/u, ""));
}

function compatibleDeclaration(kind: CompilerNodeKind, declaration: Node): boolean {
  const k = declaration.kind;
  if (kind === "function") return k === K.FunctionDeclaration || k === K.VariableDeclaration || k === K.FunctionExpression || k === K.ArrowFunction;
  if (kind === "method") return k === K.MethodDeclaration || k === K.MethodSignature || k === K.GetAccessor || k === K.SetAccessor || k === K.PropertyDeclaration;
  if (kind === "property") return k === K.PropertyDeclaration || k === K.PropertySignature;
  return true;
}

function implementationDeclaration(declarations: readonly Node[]): Node {
  const assigned = declarations.find((declaration) => declaration.kind === K.BinaryExpression
    && isFunctionLikeWithBody((declaration as ast.BinaryExpression).right));
  return assigned ? (assigned as ast.BinaryExpression).right
    : declarations.find(isFunctionLikeWithBody)
    ?? declarations.find((declaration) => isClassLike(declaration) && Boolean(declaration.members))
    ?? declarations.at(-1)!;
}

function anonymousFunctionRole(node: Node, sourceFile: SourceFile): { label: string; identity: string } {
  const parent = node.parent;
  if (parent.kind === K.CallExpression) {
    const call = parent as ast.CallExpression;
    const index = call.arguments.indexOf(node as ast.Expression);
    const callee = helpers.normalizeSignature(nodeText(call.expression, sourceFile)).slice(0, 80);
    return { label: `${callee}[${index}]`, identity: `callback-argument:${callee}:${index}` };
  }
  if (parent.kind === K.NewExpression) {
    const call = parent as ast.NewExpression;
    const index = call.arguments?.indexOf(node as ast.Expression) ?? -1;
    const callee = helpers.normalizeSignature(nodeText(call.expression, sourceFile)).slice(0, 80);
    return { label: `${callee}[${index}]`, identity: `constructor-callback:${callee}:${index}` };
  }
  const syntaxRole = legacySyntaxKindName(parent.kind);
  return { label: syntaxRole, identity: `anonymous-callback:${syntaxRole}` };
}

/** 5.9's name for a syntax kind, so anonymous roles read the same on both compilers. */
function legacySyntaxKindName(kind: ast.SyntaxKind): string {
  const legacy = Number(legacyKind(kind));
  return Number.isNaN(legacy) ? (ast.SyntaxKind[kind] ?? "expression") : (ts.SyntaxKind[legacy] ?? "expression");
}

function isNamedFunctionValue(node: Node): boolean {
  const parent = node.parent;
  return parent.kind === K.VariableDeclaration
    || parent.kind === K.PropertyDeclaration
    || parent.kind === K.PropertyAssignment
    || (node.kind === K.FunctionExpression && Boolean((node as ast.FunctionExpression).name));
}

function assignedFunctionName(node: Node): string | undefined {
  if (node.kind === K.Identifier) return (node as ast.Identifier).text;
  if (node.kind === K.PropertyAccessExpression) {
    const access = node as ast.PropertyAccessExpression;
    const receiver = assignedFunctionName(access.expression);
    return receiver ? `${receiver}.${(access.name as ast.Identifier).text}` : undefined;
  }
  if (node.kind === K.ElementAccessExpression) {
    const access = node as ast.ElementAccessExpression;
    if (!access.argumentExpression || !isStringLiteralLike(access.argumentExpression)) return undefined;
    const receiver = assignedFunctionName(access.expression);
    const member = access.argumentExpression.text;
    return receiver && /^[A-Za-z_$][\w$]*$/u.test(member) ? `${receiver}.${member}` : undefined;
  }
  return undefined;
}

function isFunctionLikeValue(node: Node): boolean {
  return node.kind === K.ArrowFunction || node.kind === K.FunctionExpression;
}

function isModuleVariable(node: ast.VariableDeclaration): boolean {
  const statement = node.parent?.parent;
  return Boolean(statement && statement.kind === K.VariableStatement
    && (statement.parent.kind === K.SourceFile || statement.parent.kind === K.ModuleBlock));
}

function variableKind(node: ast.VariableDeclaration): "constant" | "variable" {
  const list = node.parent;
  return list.kind === K.VariableDeclarationList && (list.flags & ast.NodeFlags.Const) !== 0 ? "constant" : "variable";
}

function propertyName(name: Node, sourceFile: SourceFile): string {
  if (name.kind === K.Identifier || name.kind === K.PrivateIdentifier || isStringLiteralLike(name) || name.kind === K.NumericLiteral) {
    return (name as ast.Identifier).text;
  }
  return nodeText(name, sourceFile);
}

function visibilityOf(node: Node): "public" | "private" | "protected" | "internal" | undefined {
  if (hasModifier(node, K.PrivateKeyword)) return "private";
  if (hasModifier(node, K.ProtectedKeyword)) return "protected";
  if (hasModifier(node, K.PublicKeyword)) return "public";
  return undefined;
}

function decoratorsOf(node: Node, sourceFile: SourceFile): string[] | undefined {
  const modifiers = (node as { modifiers?: readonly Node[] }).modifiers;
  const decorators = modifiers?.filter((modifier) => modifier.kind === K.Decorator)
    .map((decorator) => helpers.sourceEvidenceText(nodeText((decorator as ast.Decorator).expression, sourceFile)));
  return decorators && decorators.length > 0 ? decorators : undefined;
}

function typeParametersOf(node: Node): string[] | undefined {
  const parameters = (node as { typeParameters?: readonly ast.TypeParameterDeclaration[] }).typeParameters;
  const result = parameters?.map((parameter) => parameter.name.text);
  return result && result.length > 0 ? result : undefined;
}

function jsDocForNode(node: Node): string | undefined {
  const comments = ast.getJSDocCommentsAndTags(node)
    .filter((doc): doc is ast.JSDoc => doc.kind === K.JSDoc)
    .map((doc) => ast.getTextOfJSDocComment(doc.comment) ?? "")
    .filter(Boolean);
  return comments.length > 0 ? comments.join("\n") : undefined;
}

function isTypeOnlyClause(clause: ast.ImportClause): boolean {
  return clause.phaseModifier === K.TypeKeyword;
}

function shouldEmitIdentifierReference(node: ast.Identifier): boolean {
  const parent = node.parent;
  const k = parent.kind;
  if (
    (parent as { name?: Node }).name === node
    || k === K.ImportClause
    || k === K.ImportSpecifier
    || k === K.NamespaceImport
    || k === K.ExportSpecifier
    || (k === K.PropertyAssignment && (parent as ast.PropertyAssignment).name === node)
    || (k === K.PropertyAccessExpression && (parent as ast.PropertyAccessExpression).name === node
      && (parent.parent.kind === K.CallExpression || parent.parent.kind === K.NewExpression))
    || ((k === K.CallExpression || k === K.NewExpression) && (parent as ast.CallExpression).expression === node)
    || k === K.TypeReference
    || k === K.ExpressionWithTypeArguments
  ) return false;
  for (let current: Node | undefined = parent; current && !ast.isStatement(current); current = current.parent) {
    if (ast.isTypeNode(current)) return false;
  }
  return true;
}

function callbackParameterForArgument(
  parameters: readonly ast.ParameterDeclaration[],
  argumentIndex: number,
): { parameter: ast.ParameterDeclaration; restArgumentIndex?: number } | undefined {
  const restIndex = parameters.length - 1;
  const finalParameter = parameters[restIndex];
  if (finalParameter?.dotDotDotToken && argumentIndex >= restIndex) {
    return { parameter: finalParameter, restArgumentIndex: argumentIndex - restIndex };
  }
  const parameter = parameters[argumentIndex];
  return parameter ? { parameter } : undefined;
}

function firstDeclarationInCodeOrder(declarations: readonly Node[], root: string): Node | undefined {
  return declarations
    .map((declaration) => ({
      declaration,
      path: helpers.portableInputPath(root, helpers.normalizedAbsolute(declaration.getSourceFile().fileName)),
      start: declaration.getStart(declaration.getSourceFile()),
      kind: Number(legacyKind(declaration.kind)),
    }))
    .sort((left, right) => helpers.compareCodePoints(left.path, right.path)
      || left.start - right.start
      || left.kind - right.kind)[0]?.declaration;
}

// ── Value alternatives of a callee (5.9's `calleeAlternatives`) ─────────────

const ARRAY_CALLBACK_METHODS = new Set(["every", "filter", "find", "findLast", "flatMap", "forEach", "map", "some"]);

interface SymbolSource {
  symbolAt(node: Node | undefined): ApiSymbol | undefined;
}

function calleeAlternatives(expression: Node, capture: FileCapture): Node[] | undefined {
  const session = capture.session;
  const leaves: Node[] = [];
  const visited = new Set<Node>();
  let branched = false;
  let opaque = false;
  const visitElements = (node: Node): void => {
    if (node.kind === K.ParenthesizedExpression) return visitElements((node as ast.ParenthesizedExpression).expression);
    const initializer = node.kind === K.Identifier ? unannotatedConstInitializer(node as ast.Identifier, capture, session) : undefined;
    if (initializer) return visitElements(initializer);
    if (node.kind !== K.ArrayLiteralExpression) {
      opaque = true;
      return;
    }
    const elements = (node as ast.ArrayLiteralExpression).elements;
    if (elements.length > 1) branched = true;
    for (const element of elements) {
      if (element.kind === K.SpreadElement) visitElements((element as ast.SpreadElement).expression);
      else if (element.kind === K.OmittedExpression) opaque = true;
      else visit(element);
    }
  };
  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === K.ParenthesizedExpression) {
      visit((node as ast.ParenthesizedExpression).expression);
    } else if (node.kind === K.ConditionalExpression) {
      branched = true;
      visit((node as ast.ConditionalExpression).whenTrue);
      visit((node as ast.ConditionalExpression).whenFalse);
    } else if (node.kind === K.BinaryExpression
      && ((node as ast.BinaryExpression).operatorToken.kind === K.QuestionQuestionToken
        || (node as ast.BinaryExpression).operatorToken.kind === K.BarBarToken)) {
      branched = true;
      visit((node as ast.BinaryExpression).left);
      visit((node as ast.BinaryExpression).right);
    } else if (node.kind === K.ElementAccessExpression
      && isArrayLiteralSource((node as ast.ElementAccessExpression).expression, capture, session)) {
      visitElements((node as ast.ElementAccessExpression).expression);
    } else if (node.kind === K.Identifier) {
      const initializer = unannotatedConstInitializer(node as ast.Identifier, capture, session);
      const elements = initializer ? undefined : elementSourceOf(node as ast.Identifier, capture, session);
      if (initializer) visit(initializer);
      else if (elements) visitElements(elements);
      else leaves.push(node);
    } else {
      leaves.push(node);
    }
  };
  visit(expression);
  return branched && !opaque ? leaves : undefined;
}

function symbolAtAnyFile(node: Node, capture: SymbolSource): ApiSymbol | undefined {
  return capture.symbolAt(node);
}

function valueDeclarationOf(symbol: ApiSymbol | undefined, session: ApiProjectSession, kinds: readonly number[]): Node | undefined {
  const handle = symbol?.valueDeclaration;
  if (!handle || !kinds.includes(handle.kind)) return undefined;
  return session.resolveHandle(handle);
}

function elementSourceOf(identifier: ast.Identifier, capture: SymbolSource, session: ApiProjectSession): Node | undefined {
  const declaration = valueDeclarationOf(symbolAtAnyFile(identifier, capture), session, [K.VariableDeclaration, K.Parameter]);
  if (!declaration) return undefined;
  if (declaration.kind === K.VariableDeclaration) {
    const variable = declaration as ast.VariableDeclaration;
    const list = variable.parent;
    if (variable.name.kind === K.Identifier && !variable.type && list.kind === K.VariableDeclarationList
      && list.parent.kind === K.ForOfStatement && (list.parent as ast.ForOfStatement).initializer === list) {
      const iterated = (list.parent as ast.ForOfStatement).expression;
      return isArrayLiteralSource(iterated, capture, session) ? iterated : undefined;
    }
    return undefined;
  }
  const parameter = declaration as ast.ParameterDeclaration;
  const fn = parameter.parent;
  if (parameter.name.kind !== K.Identifier || parameter.type
    || (fn.kind !== K.ArrowFunction && fn.kind !== K.FunctionExpression)
    || (fn as ast.ArrowFunction).parameters[0] !== parameter) return undefined;
  const call = fn.parent;
  if (call.kind !== K.CallExpression || (call as ast.CallExpression).arguments[0] !== fn) return undefined;
  const callee = (call as ast.CallExpression).expression;
  if (callee.kind !== K.PropertyAccessExpression
    || !ARRAY_CALLBACK_METHODS.has(((callee as ast.PropertyAccessExpression).name as ast.Identifier).text)) return undefined;
  const receiver = (callee as ast.PropertyAccessExpression).expression;
  return isArrayLiteralSource(receiver, capture, session) ? receiver : undefined;
}

function isArrayLiteralSource(expression: Node, capture: SymbolSource, session: ApiProjectSession): boolean {
  if (expression.kind === K.ParenthesizedExpression) {
    return isArrayLiteralSource((expression as ast.ParenthesizedExpression).expression, capture, session);
  }
  if (expression.kind === K.ArrayLiteralExpression) return true;
  const initializer = expression.kind === K.Identifier
    ? unannotatedConstInitializer(expression as ast.Identifier, capture, session)
    : undefined;
  return initializer !== undefined && isArrayLiteralSource(initializer, capture, session);
}

function unannotatedConstInitializer(identifier: ast.Identifier, capture: SymbolSource, session: ApiProjectSession): Node | undefined {
  const symbol = session.canonical(symbolAtAnyFile(identifier, capture));
  const declaration = valueDeclarationOf(symbol, session, [K.VariableDeclaration]) as ast.VariableDeclaration | undefined;
  return declaration
    && declaration.name.kind === K.Identifier
    && !declaration.type
    && declaration.initializer
    && declaration.parent.kind === K.VariableDeclarationList
    && (declaration.parent.flags & ast.NodeFlags.Const) !== 0
    ? declaration.initializer
    : undefined;
}

function lineColumn(sourceFile: SourceFile, position: number): { line: number; column: number } {
  const point = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: point.line, column: point.character };
}

function draftStart(draft: DraftNode): number {
  return Math.min(...draft.declarations.map((declaration) => declaration.getStart(declaration.getSourceFile(), false)));
}

