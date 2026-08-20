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
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";

export const TYPESCRIPT_COMPILER_EXTRACTOR_VERSION = "typescript-5.9-v1";
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

export interface CompilerExtractionResult {
  compilerVersion: string;
  extractorVersion: string;
  projects: DiscoveredTypeScriptProject[];
  files: CompilerFileExtraction[];
}

export interface CompilerExtractionOptions {
  /** Additional options used only by the inferred program. */
  inferredCompilerOptions?: ts.CompilerOptions;
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
): CompilerExtractionResult {
  const root = resolve(rootDir);
  const candidates = collectCandidates(root, candidateFiles);
  const parsedProjects = parseProjects(root, new Set(candidates));
  const runtimeProjects: RuntimeProject[] = parsedProjects.map((project) => {
    const program = ts.createProgram({
      rootNames: project.parsed.fileNames,
      options: project.parsed.options,
      projectReferences: project.parsed.projectReferences,
    });
    return { ...project, program, checker: program.getTypeChecker() };
  });

  const ownership = new Map<string, RuntimeProject>();
  for (const file of candidates) {
    const owners = runtimeProjects
      .filter((project) => project.program.getSourceFile(file) !== undefined)
      .sort((left, right) => {
        const specificity = dirname(right.configPath).length - dirname(left.configPath).length;
        return specificity || left.configPath.localeCompare(right.configPath);
      });
    if (owners[0]) ownership.set(file, owners[0]);
  }

  const uncovered = candidates.filter((file) => !ownership.has(file));
  let inferred: RuntimeProject | undefined;
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
    const program = ts.createProgram({ rootNames: uncovered, options: inferredOptions });
    inferred = {
      id: "inferred",
      configPath: "",
      parsed: {
        options: inferredOptions,
        fileNames: uncovered,
        errors: [],
      },
      diagnostics: [],
      program,
      checker: program.getTypeChecker(),
    };
    runtimeProjects.push(inferred);
    for (const file of uncovered) ownership.set(file, inferred);
  }

  const contexts: FileContext[] = [];
  for (const absoluteFile of candidates) {
    const project = ownership.get(absoluteFile);
    const sourceFile = project?.program.getSourceFile(absoluteFile);
    if (!project || !sourceFile) continue;
    const filePath = relativePath(root, absoluteFile);
    const { health, ranges } = sourceHealth(project.program, sourceFile);
    const context: FileContext = {
      filePath,
      sourceFile,
      project,
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

  const locationIds = new Map<string, string>();
  const nodeById = new Map<string, CompilerExtractedNode>();
  for (const context of contexts) {
    for (const draft of context.drafts) {
      if (!draft.id) continue;
      for (const declaration of draft.declarations) {
        locationIds.set(declarationLocation(declaration), draft.id);
      }
    }
    context.nodes = materializeNodes(context);
    for (const node of context.nodes) nodeById.set(node.id, node);
  }

  const files = contexts.map((context) => {
    const importBindings = extractImportBindings(root, context, locationIds);
    const references = extractReferences(context, contexts, locationIds, nodeById, importBindings);
    return {
      filePath: context.filePath,
      language: context.language,
      projectId: context.project.id,
      health: context.health,
      nodes: context.nodes,
      importBindings,
      references,
    } satisfies CompilerFileExtraction;
  });

  const projectSummaries: DiscoveredTypeScriptProject[] = runtimeProjects.map((project) => ({
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
  };
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

function parseProjects(root: string, candidates?: ReadonlySet<string>): ParsedProject[] {
  const queue = findConfigFiles(root);
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
      fileExists: ts.sys.fileExists,
      readDirectory: ts.sys.readDirectory,
      readFile: ts.sys.readFile,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    if (!parsed) continue;
    diagnostics.push(...parsed.errors);
    for (const reference of parsed.projectReferences ?? []) {
      const referencePath = normalizedAbsolute(ts.resolveProjectReferencePath(reference));
      if (withinRoot(root, referencePath) && !seen.has(referencePath)) queue.push(referencePath);
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

function collectCandidates(root: string, supplied?: readonly string[]): string[] {
  if (supplied) {
    return [...new Set(supplied
      .map((file) => absoluteCandidate(root, file))
      .filter(isCompilerSourceFile)
      .filter((file) => existsSync(file) && statSync(file).isFile()))]
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
  const signature = declarationSignature(symbol, usableDeclarations, checker);
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
    returnType: returnTypeOf(symbol, representative, checker),
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

function extractImportBindings(
  root: string,
  context: FileContext,
  locationIds: ReadonlyMap<string, string>,
): CompilerImportBinding[] {
  const bindings: CompilerImportBinding[] = [];
  const checker = context.project.checker;
  const options = context.project.program.getCompilerOptions();
  for (const statement of context.sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (!referenceSyntaxIsTrusted(statement, context)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const resolution = ts.resolveModuleName(moduleSpecifier, context.sourceFile.fileName, options, ts.sys).resolvedModule;
    const resolvedFilePath = resolution && withinRoot(root, resolution.resolvedFileName)
      ? relativePath(root, resolution.resolvedFileName)
      : undefined;
    const add = (
      local: ts.Identifier,
      importedName: string,
      flags: { isDefault?: boolean; isNamespace?: boolean; isTypeOnly?: boolean } = {},
    ): void => {
      const symbol = checker.getSymbolAtLocation(local);
      const targetId = symbol ? idForSymbol(symbol, checker, locationIds) : undefined;
      const position = context.sourceFile.getLineAndCharacterOfPosition(local.getStart(context.sourceFile));
      const identity = [context.filePath, local.text, moduleSpecifier, importedName].join("\u0000");
      bindings.push({
        id: `import:${sha256(identity).slice(0, 32)}`,
        filePath: context.filePath,
        localName: local.text,
        importedName,
        moduleSpecifier,
        resolvedFilePath,
        targetId,
        isTypeOnly: Boolean(statement.importClause?.isTypeOnly || flags.isTypeOnly),
        isNamespace: Boolean(flags.isNamespace),
        isDefault: Boolean(flags.isDefault),
        line: position.line,
        column: position.character,
        confidence: 1,
        resolutionMethod: "typescript-import",
      });
    };
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) add(clause.name, "default", { isDefault: true });
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      add(clause.namedBindings.name, "*", { isNamespace: true });
    } else if (clause.namedBindings) {
      for (const element of clause.namedBindings.elements) {
        add(element.name, element.propertyName?.text ?? element.name.text, { isTypeOnly: element.isTypeOnly });
      }
    }
  }
  return bindings.sort((left, right) => left.line - right.line || left.column - right.column || left.id.localeCompare(right.id));
}

function extractReferences(
  context: FileContext,
  contexts: readonly FileContext[],
  locationIds: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CompilerExtractedNode>,
  importBindings: readonly CompilerImportBinding[],
): CompilerReference[] {
  if (!context.fileDraft?.id) return [];
  const pending: PendingReference[] = [];
  const checker = context.project.checker;

  const push = (reference: Omit<PendingReference, "position" | "identityHint">, position: number, identityHint: string): void => {
    pending.push({ ...reference, position, identityHint });
  };

  // Structural containment is compiler-proven and never inferred by name.
  for (const draft of context.drafts) {
    if (!draft.id || !draft.container?.id) continue;
    const position = declarationStart(draft);
    push({
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
      line: lineColumn(context.sourceFile, position).line,
      column: lineColumn(context.sourceFile, position).column,
      evidence: { declarationRole: draft.declarationRole },
    }, position, `contains:${draft.identityKey}`);
  }

  for (const binding of importBindings) {
    const resolvedFilePath = binding.resolvedFilePath;
    const targetFileId = resolvedFilePath
      ? contexts.find((entry) => entry.filePath === normalizeRelative(resolvedFilePath))?.fileDraft?.id
      : undefined;
    const targetId = targetFileId ?? binding.targetId;
    push({
      sourceId: context.fileDraft.id,
      targetId,
      kind: "imports",
      targetName: binding.moduleSpecifier,
      targetQualifiedName: targetId ? nodeById.get(targetId)?.qualifiedName : undefined,
      candidates: targetId ? [targetId] : [],
      status: targetId ? "resolved" : "unresolved",
      confidence: targetId ? 1 : 0,
      resolutionMethod: "typescript-import",
      provenance: "typescript-compiler",
      filePath: context.filePath,
      line: binding.line,
      column: binding.column,
      evidence: { importBindingId: binding.id, resolvedFilePath: binding.resolvedFilePath },
    }, context.sourceFile.getPositionOfLineAndCharacter(binding.line, binding.column), `import:${binding.id}`);
  }

  const visit = (node: ts.Node): void => {
    const trusted = referenceSyntaxIsTrusted(node, context);
    if (trusted && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      emitCallReference(node, context, locationIds, nodeById, push);
      if (ts.isCallExpression(node)) {
        emitCallbackReferences(node, context, locationIds, nodeById, push);
      }
    } else if (trusted && ts.isHeritageClause(node)) {
      emitHeritageReferences(node, context, locationIds, nodeById, push);
    } else if (trusted && ts.isIdentifier(node) && shouldEmitIdentifierReference(node)) {
      emitIdentifierReference(node, context, locationIds, nodeById, push);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(context.sourceFile, visit);

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

function emitCallReference(
  node: ts.CallExpression | ts.NewExpression,
  context: FileContext,
  locationIds: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CompilerExtractedNode>,
  push: (reference: Omit<PendingReference, "position" | "identityHint">, position: number, identityHint: string) => void,
): void {
  const checker = context.project.checker;
  const expression = node.expression;
  const sourceId = enclosingSourceId(node, context);
  if (!sourceId) return;
  const resolvedSignature = checker.getResolvedSignature(node);
  const signatureSymbol = resolvedSignature?.declaration
    ? symbolForDeclaration(resolvedSignature.declaration, checker)
    : undefined;
  const expressionSymbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  const signatureTargets = idsForSymbol(signatureSymbol, checker, locationIds);
  const expressionTargets = idsForSymbol(expressionSymbol, checker, locationIds);
  const callSignatures = checker.getTypeAtLocation(expression).getCallSignatures();
  const candidates = [...new Set(callSignatures
    .map((signature) => signature.declaration ? symbolForDeclaration(signature.declaration, checker) : undefined)
    .flatMap((symbol) => idsForSymbol(symbol, checker, locationIds))
    .concat(signatureTargets, expressionTargets))].sort();
  const polymorphic = ts.isPropertyAccessExpression(expression)
    && expression.expression.kind !== ts.SyntaxKind.ThisKeyword
    && expression.expression.kind !== ts.SyntaxKind.SuperKeyword
    && isPolymorphicReceiver(checker.getTypeAtLocation(expression.expression));
  const uniqueCandidate = !polymorphic && candidates.length === 1 ? candidates[0] : undefined;
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
  const ambiguous = !uniqueCandidate && (candidates.length > 0 || polymorphic);
  push({
    sourceId,
    targetId: uniqueCandidate,
    kind: ts.isNewExpression(node) ? "instantiates" : "calls",
    targetName,
    targetQualifiedName: uniqueCandidate ? nodeById.get(uniqueCandidate)?.qualifiedName : undefined,
    receiver,
    qualifier: receiver,
    candidates,
    status: uniqueCandidate ? "resolved" : ambiguous ? "ambiguous" : "unresolved",
    confidence: uniqueCandidate ? 1 : ambiguous ? 0.75 : 0,
    resolutionMethod: "typescript-signature",
    provenance: "typescript-compiler",
    filePath: context.filePath,
    line: point.line,
    column: point.column,
    evidence: {
      expression: expression.getText(context.sourceFile),
      signature: resolvedSignature ? normalizeSignature(checker.signatureToString(resolvedSignature, node)) : undefined,
      polymorphic,
    },
  }, position, `${targetName}:${receiver ?? ""}`);
}

function emitHeritageReferences(
  clause: ts.HeritageClause,
  context: FileContext,
  locationIds: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CompilerExtractedNode>,
  push: (reference: Omit<PendingReference, "position" | "identityHint">, position: number, identityHint: string) => void,
): void {
  const sourceId = enclosingSourceId(clause.parent, context);
  if (!sourceId) return;
  const checker = context.project.checker;
  for (const type of clause.types) {
    const symbol = checker.getSymbolAtLocation(type.expression);
    const targetId = idForSymbol(symbol, checker, locationIds);
    const targetName = type.expression.getText(context.sourceFile);
    const position = type.getStart(context.sourceFile);
    const point = lineColumn(context.sourceFile, position);
    push({
      sourceId,
      targetId,
      kind: clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends",
      targetName,
      targetQualifiedName: targetId ? nodeById.get(targetId)?.qualifiedName : undefined,
      candidates: targetId ? [targetId] : [],
      status: targetId ? "resolved" : "unresolved",
      confidence: targetId ? 1 : 0,
      resolutionMethod: "typescript-heritage",
      provenance: "typescript-compiler",
      filePath: context.filePath,
      line: point.line,
      column: point.column,
      evidence: { heritage: clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends" },
    }, position, targetName);
  }
}

function emitIdentifierReference(
  identifier: ts.Identifier,
  context: FileContext,
  locationIds: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CompilerExtractedNode>,
  push: (reference: Omit<PendingReference, "position" | "identityHint">, position: number, identityHint: string) => void,
): void {
  const checker = context.project.checker;
  const symbol = checker.getSymbolAtLocation(identifier);
  const targetIds = idsForSymbol(symbol, checker, locationIds);
  const targetId = targetIds.length === 1 ? targetIds[0] : undefined;
  const sourceId = enclosingSourceId(identifier, context);
  if (!sourceId || targetId === sourceId || targetIds.length === 0) return;
  const position = identifier.getStart(context.sourceFile);
  const point = lineColumn(context.sourceFile, position);
  const parent = identifier.parent;
  const receiver = ts.isPropertyAccessExpression(parent) && parent.name === identifier
    ? parent.expression.getText(context.sourceFile)
    : undefined;
  push({
    sourceId,
    targetId,
    kind: "references",
    targetName: identifier.text,
    targetQualifiedName: targetId ? nodeById.get(targetId)?.qualifiedName : undefined,
    receiver,
    qualifier: receiver,
    candidates: targetIds,
    status: targetId ? "resolved" : "ambiguous",
    confidence: targetId ? 1 : 0.75,
    resolutionMethod: "typescript-symbol",
    provenance: "typescript-compiler",
    filePath: context.filePath,
    line: point.line,
    column: point.column,
    evidence: { expression: identifier.text },
  }, position, `${identifier.text}:${receiver ?? ""}`);
}

function emitCallbackReferences(
  call: ts.CallExpression,
  context: FileContext,
  locationIds: ReadonlyMap<string, string>,
  nodeById: ReadonlyMap<string, CompilerExtractedNode>,
  push: (reference: Omit<PendingReference, "position" | "identityHint">, position: number, identityHint: string) => void,
): void {
  const checker = context.project.checker;
  const signature = checker.getResolvedSignature(call);
  const declaration = signature?.getDeclaration();
  if (!declaration || !ts.isFunctionLike(declaration)) return;
  const calleeSymbol = symbolForDeclaration(declaration, checker);
  const calleeId = idForSymbol(calleeSymbol, checker, locationIds);
  if (!calleeId) return;
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
    let callbackId: string | undefined;
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      callbackId = context.declarationDrafts.get(argument)?.id;
    } else {
      const callbackIds = idsForSymbol(checker.getSymbolAtLocation(argument), checker, locationIds);
      callbackId = callbackIds.length === 1 ? callbackIds[0] : undefined;
    }
    if (!callbackId) return;
    const position = argument.getStart(context.sourceFile);
    const point = lineColumn(context.sourceFile, position);
    const parameterName = parameter.name.getText(declaration.getSourceFile());
    push({
      sourceId: calleeId,
      targetId: callbackId,
      kind: "calls",
      targetName: nodeById.get(callbackId)?.name ?? argument.getText(context.sourceFile),
      targetQualifiedName: nodeById.get(callbackId)?.qualifiedName,
      candidates: [callbackId],
      status: "resolved",
      confidence: 0.85,
      resolutionMethod: "typescript-callback-parameter",
      provenance: "callback-synthesis",
      filePath: context.filePath,
      line: point.line,
      column: point.column,
      evidence: {
        parameterName,
        argumentIndex: index,
        wiringSite: call.getText(context.sourceFile),
        callee: nodeById.get(calleeId)?.qualifiedName,
      },
    }, position, `callback:${calleeId}:${parameterName}:${index}:${callbackId}`);
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

function sourceHealth(program: ts.Program, sourceFile: ts.SourceFile): { health: CompilerSourceHealth; ranges: ErrorRange[] } {
  const syntactic = program.getSyntacticDiagnostics(sourceFile);
  const semantic = program.getSemanticDiagnostics(sourceFile);
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
): string | undefined {
  if (symbol) {
    const location = declarations[0];
    const type = checker.getTypeOfSymbolAtLocation(symbol, location);
    const signatures = [
      ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
      ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
    ];
    const rendered = [...new Set(signatures.map((signature) => normalizeSignature(checker.signatureToString(signature, location))))].sort();
    if (rendered.length > 0) return rendered.join(" | ");
    const typeText = normalizeSignature(checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation));
    if (typeText && typeText !== "any") return typeText;
  }
  const headers = [...new Set(declarations.map(declarationHeader).filter(Boolean))].sort();
  return headers.length > 0 ? headers.join(" | ") : undefined;
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

function idForSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  locations: ReadonlyMap<string, string>,
): string | undefined {
  return idsForSymbol(symbol, checker, locations)[0];
}

function idsForSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  locations: ReadonlyMap<string, string>,
): string[] {
  if (!symbol) return [];
  const resolved = canonicalSymbol(symbol, checker);
  const ids = new Set<string>();
  for (const declaration of resolved.declarations ?? []) {
    const id = locations.get(declarationLocation(declaration));
    if (id) ids.add(id);
  }
  return [...ids].sort();
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

function returnTypeOf(symbol: ts.Symbol | undefined, node: ts.Node, checker: ts.TypeChecker): string | undefined {
  if (!symbol || !ts.isFunctionLike(node)) return undefined;
  const type = checker.getTypeOfSymbolAtLocation(symbol, node);
  const signature = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
  return signature ? normalizeSignature(checker.typeToString(signature.getReturnType(), node, ts.TypeFormatFlags.NoTruncation)) : undefined;
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

function isCompilerSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
