#!/usr/bin/env node
// Usage from the repository root, with Cargo on PATH:
// node scripts/graph-engine-bench/module-parity.mjs <directory>
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ENGINE = fileURLToPath(new URL("../../native/engine/", import.meta.url));
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const PROJECT = /^(?:tsconfig.*|jsconfig)\.json$/;
const MAX_SAMPLES = 5;
const DIFFERENCE_REASONS = {
  nearest_project: "The file also occurs in another program. TypeScript matches Rust when queried with the selected project's options.",
  transitive_importer_without_project: "The program loaded the file transitively. No config includes it by files or include; the compiler with inferred options agrees with Rust.",
  workspace_manifest_without_compiler_link: "The repository manifest declares this package target. The compiler could not see it through package self-resolution or an installed workspace link.",
  workspace_build_to_source_before_emit: "The repository declares a workspace package entry and an output layout. Rust can resolve to the input before its output or workspace link exists.",
  build_to_source_before_emit: "The compiler found no output file, and Rust resolved to an input under a configured output layout.",
  builtin_precedence: "The specifier names a Node builtin. The graph gives builtins precedence over compiler path lookup.",
  ambiguous_workspace_package: "Several manifests have this package name. The selected project supplies no path mapping, self-reference or project reference that identifies a unique workspace package.",
  classic_implicit_ancestor_lookup: "Classic TypeScript resolution searches parent directories for bare names. The graph requires an explicit alias, baseUrl or workspace manifest.",
  build_output_without_source: "The compiler found a build artifact. The graph requires a source under the owning project's output layout.",
  extends_outside_repository: "Rust stops config inheritance at the boundary of the supplied repository.",
  unexplained: "The observed results differ under the tested inputs.",
};

function inventory(root) {
  const files = [];
  const directories = new Set([root]);
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.add(path);
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  visit(root);
  files.sort();
  return { files, directories, paths: new Set(files) };
}

function dependencyPath(path) {
  return path.split(/[\\/]/).includes("node_modules");
}

function relativePath(root, path) {
  const result = relative(root, path);
  return result === ".." || result.startsWith(".." + sep) || isAbsolute(result)
    ? undefined
    : result.split(sep).join("/");
}

function compilerHosts(root, view) {
  function inView(path) {
    return relativePath(root, path) !== undefined && !dependencyPath(path);
  }
  const fileExists = (path) => inView(path) ? view.paths.has(resolve(path)) : ts.sys.fileExists(path);
  const directoryExists = (path) => inView(path) ? view.directories.has(resolve(path)) : ts.sys.directoryExists(path);
  const readFile = (path) => fileExists(path) ? ts.sys.readFile(path) : undefined;
  const moduleHost = {
    fileExists, directoryExists, readFile, realpath: ts.sys.realpath,
    getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: true,
  };
  const parseHost = { ...moduleHost, readDirectory: ts.sys.readDirectory };
  return { moduleHost, parseHost };
}

function buildExample() {
  const messages = execFileSync("cargo", [
    "build", "--locked", "--release", "-p", "mex-graph-ecmascript", "--example", "resolve",
    "--message-format=json-render-diagnostics",
  ], { cwd: ENGINE, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  for (const line of messages.trim().split("\n")) {
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.target.name === "resolve" && message.executable) {
      return message.executable;
    }
  }
  throw new Error("Cargo did not report the resolve example executable");
}

function collectSites(source) {
  const sites = [];
  function add(node, syntax, attributes) {
    if (node && ts.isStringLiteralLike(node)) {
      const override = ts.getResolutionModeOverride(attributes);
      if (override === ts.ModuleKind.ESNext) syntax = "force_import";
      if (override === ts.ModuleKind.CommonJS) syntax = "force_require";
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      sites.push({ specifier: node.text, syntax, line: line + 1, column: character, usage: node });
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const attributes = ts.isExclusivelyTypeOnlyImportOrExport(node) ? node.attributes : undefined;
      add(node.moduleSpecifier, "import", attributes);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, "require");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, "import", node.attributes);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node.arguments[0], "dynamic_import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add(node.arguments[0], "require");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return sites;
}

function readProjects(root, view, { moduleHost, parseHost }) {
  const found = new Map();
  const pending = view.files.filter((path) => PROJECT.test(basename(path)));
  for (let i = 0; i < pending.length; i++) {
    const file = pending[i];
    const key = relativePath(root, file);
    if (key === undefined || found.has(key) || !view.paths.has(file)) continue;
    const config = ts.readJsonConfigFile(file, parseHost.readFile);
    const parsed = ts.parseJsonSourceFileConfigFileContent(config, parseHost, dirname(file), undefined, file);
    for (const reference of parsed.projectReferences ?? []) {
      pending.push(ts.resolveProjectReferencePath(reference));
    }
    parsed.options.traceResolution = false;
    found.set(key, {
      key, parsed,
      roots: new Set(parsed.fileNames),
      cache: ts.createModuleResolutionCache(root, (path) => path, parsed.options),
    });
  }
  const options = { allowJs: true };
  const inferred = {
    key: null,
    parsed: { options, fileNames: view.files.filter((path) => SOURCE.test(path)) },
    cache: ts.createModuleResolutionCache(root, (path) => path, options),
  };
  return { found, inferred, host: moduleHost, root };
}

function emitPaths(projects, view) {
  const mappings = new Map();
  for (const { parsed } of projects.found.values()) {
    const { options } = parsed;
    if ((!options.outDir && !options.declarationDir) || options.noEmit || options.outFile) continue;
    // Query TypeScript's emit layout independently of the Rust resolver.
    // Ask for declarations as well so existing declarations in outDir can
    // be compared even when this particular config does not emit them.
    const rootDir = ts.getCommonSourceDirectoryOfConfig(parsed, false);
    const declaration = { ...parsed, options: { ...options, rootDir, declaration: true } };
    for (const path of parsed.fileNames) {
      const from = relativePath(projects.root, path);
      if (from === undefined || !view.paths.has(path) || !SOURCE.test(path) || /\.d\.[cm]?ts$/.test(path)) continue;
      for (const emitted of ts.getOutputFileNames(declaration, path, false)) {
        const output = relativePath(projects.root, emitted);
        if (output === undefined || output === from || !SOURCE.test(output)) continue;
        if (!mappings.has(output)) mappings.set(output, new Set());
        mappings.get(output).add(from);
      }
    }
  }
  return mappings;
}

function packageName(specifier) {
  if (/^(?:\.{1,2}(?:\/|$)|[/:#])/.test(specifier) || specifier.includes(":") || !specifier) return undefined;
  const parts = specifier.split("/");
  if (specifier[0] === "@") return parts.length > 1 ? parts.slice(0, 2).join("/") : undefined;
  return parts[0];
}

function matchesPathAlias(options, specifier) {
  return Object.keys(options.paths ?? {}).some((key) => {
    const [prefix, suffix, extra] = key.split("*");
    return suffix === undefined ? key === specifier : extra === undefined
      && specifier.length >= prefix.length + suffix.length
      && specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
}

function compilerAnswer(projects, workspace, project, from, site) {
  const { options } = project.parsed;
  const resolution = ts.getEmitModuleResolutionKind(options);
  let mode = site.syntax === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
  if (resolution === ts.ModuleResolutionKind.Node16 || resolution === ts.ModuleResolutionKind.NodeNext) {
    const impliedNodeFormat = ts.getImpliedNodeFormatForFile(
      from, project.cache.getPackageJsonInfoCache(), projects.host, options,
    );
    mode = ts.getModeForUsageLocation({ fileName: from, impliedNodeFormat }, site.usage, options);
  }
  const { resolvedModule } = ts.resolveModuleName(
    site.specifier, from, options, projects.host, project.cache, undefined, mode,
  );
  if (resolvedModule) {
    const path = relativePath(projects.root, resolvedModule.resolvedFileName);
    if (path !== undefined && !dependencyPath(path) && !dependencyPath(resolvedModule.originalPath ?? "")) {
      return { kind: "file", path };
    }
    return { kind: "external", path: path ?? resolvedModule.resolvedFileName };
  }
  if (site.specifier.startsWith("node:") || isBuiltin(site.specifier)) return { kind: "builtin" };
  const pkg = packageName(site.specifier);
  if (pkg && !workspace.has(pkg) && !matchesPathAlias(options, site.specifier)) {
    return { kind: "external", lookup: "missing" };
  }
  return { kind: "unresolved" };
}

function* queries(view, projects, workspace) {
  const programs = projects.found.size ? projects.found.values() : [projects.inferred];
  const siteCache = new Map();
  for (const project of programs) {
    const { parsed } = project;
    const options = { ...parsed.options, noLib: true };
    const host = Object.assign(ts.createCompilerHost(options), projects.host, {
      getCanonicalFileName: (path) => path,
      useCaseSensitiveFileNames: () => true,
    });
    const program = ts.createProgram({
      rootNames: parsed.fileNames, options, host, projectReferences: parsed.projectReferences,
    });
    for (const source of program.getSourceFiles()) {
      if (!SOURCE.test(source.fileName) || !view.paths.has(source.fileName)) continue;
      let sites = siteCache.get(source.fileName);
      if (sites === undefined) {
        sites = collectSites(source);
        siteCache.set(source.fileName, sites);
      }
      for (const site of sites) {
        yield {
          ...site,
          from: relativePath(projects.root, source.fileName),
          project: project.key,
          typescript: compilerAnswer(projects, workspace, project, source.fileName, site),
        };
      }
    }
  }
}

function agreement(typescript, rust, emitted) {
  if (typescript.kind !== rust.kind) return undefined;
  if (typescript.kind !== "file") return typescript.kind;
  if (typescript.path === rust.path) return "file";
  if (emitted.get(typescript.path)?.has(rust.path)) return "build_to_source";
  return undefined;
}

function differenceClass(query, rust) {
  const { typescript } = query;
  if (typescript.kind === "file" && rust.kind === "file") return "typescript_file_rust_other_file";
  return "typescript_" + typescript.kind + "_rust_" + rust.kind;
}

function differenceReason(query, answer, projects, workspace, emitted) {
  const { typescript } = query;
  const rust = answer.target;
  const from = join(projects.root, query.from);
  const pkg = packageName(query.specifier);
  const directories = workspace.get(pkg) ?? [];
  if (rust.kind === "builtin" && (query.specifier.startsWith("node:") || isBuiltin(query.specifier))) {
    return "builtin_precedence";
  }
  if (answer.project !== query.project) {
    const selected = answer.project === null ? projects.inferred : projects.found.get(answer.project);
    if (selected && agreement(compilerAnswer(projects, workspace, selected, from, query), rust, emitted)) {
      if (answer.project === null && !projects.found.get(query.project)?.roots.has(from)) {
        return "transitive_importer_without_project";
      }
      if (answer.project !== null) return "nearest_project";
    }
  }
  if (rust.kind === "file" && typescript.kind !== "file") {
    if ((rust.basis === "workspace_package" || rust.basis === "build_to_source")
        && directories.some((dir) => dir === "." || rust.path.startsWith(dir + "/"))) {
      return rust.basis === "build_to_source"
        ? "workspace_build_to_source_before_emit"
        : "workspace_manifest_without_compiler_link";
    }
    if (rust.basis === "build_to_source" && typescript.kind === "unresolved") {
      return "build_to_source_before_emit";
    }
  }
  if (typescript.kind === "file" && rust.kind === "external" && pkg) {
    const project = projects.found.get(query.project);
    if (project && ts.getEmitModuleResolutionKind(project.parsed.options) === ts.ModuleResolutionKind.Classic
        && !project.parsed.options.baseUrl && !matchesPathAlias(project.parsed.options, query.specifier)) {
      return "classic_implicit_ancestor_lookup";
    }
  }
  if (rust.reason === "ambiguous_workspace_package" && directories.length > 1) {
    return "ambiguous_workspace_package";
  }
  if (rust.reason === "build_output_without_source" && typescript.kind === "file") {
    return "build_output_without_source";
  }
  if (rust.reason === "extends_outside_repository") return "extends_outside_repository";
  return "unexplained";
}

function measureRecord(summary, query, answer, projects, workspace, emitted) {
  const comparison = agreement(query.typescript, answer.target, emitted);
  const { usage, ...site } = query;
  const sample = { ...site, rustProject: answer.project, rust: answer.target };
  if (comparison) {
    summary.agreements++;
    summary.agreementKinds[comparison] = (summary.agreementKinds[comparison] ?? 0) + 1;
    if (comparison === "build_to_source" && summary.buildToSourceSamples.length < MAX_SAMPLES) {
      summary.buildToSourceSamples.push(sample);
    }
    return;
  }
  const name = differenceClass(query, answer.target);
  const reason = differenceReason(query, answer, projects, workspace, emitted);
  const bucket = summary.disagreements[name] ??= { count: 0, reasons: {} };
  bucket.count++;
  const detail = bucket.reasons[reason] ??= { count: 0, explanation: DIFFERENCE_REASONS[reason], samples: [] };
  detail.count++;
  if (detail.samples.length < MAX_SAMPLES) detail.samples.push(sample);
  if (reason === "unexplained") summary.unexplained++;
}

async function compare(binary, root, view, configs, projects, workspace, emitted, summary) {
  const child = spawn(binary, { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const outstanding = [];
  let observed = 0;
  let finalResult;
  async function send(value) {
    if (!child.stdin.write(JSON.stringify(value) + "\n")) await once(child.stdin, "drain");
  }
  async function feed() {
    await send({ root, files: view.files.map((path) => relativePath(root, path)), configs });
    for (const query of queries(view, projects, workspace)) {
      outstanding.push(query);
      const { from, specifier, syntax } = query;
      await send({ from, specifier, syntax });
    }
    child.stdin.end();
  }
  async function receive() {
    for await (const line of lines) {
      const reply = JSON.parse(line);
      if (reply.timing) {
        finalResult = reply;
      } else {
        const query = outstanding[observed];
        if (!query || finalResult) throw new Error("Unexpected resolver response");
        outstanding[observed++] = undefined;
        measureRecord(summary, query, reply, projects, workspace, emitted);
      }
    }
  }
  try {
    const [[code, signal]] = await Promise.all([once(child, "close"), feed(), receive()]);
    if (code !== 0 || observed !== outstanding.length || finalResult?.timing.requests !== observed) {
      throw new Error("Resolver exited with " + (signal ?? code) + " after " + observed + "/" + outstanding.length + " requests");
    }
    summary.totalSpecifiers = observed;
    summary.rustTiming = finalResult.timing;
    summary.configIssues = finalResult.configIssues;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

if (process.argv.length !== 3) {
  console.error("Usage: node scripts/graph-engine-bench/module-parity.mjs <directory>");
  process.exit(2);
}
if (ts.version !== "5.9.3") throw new Error("Expected TypeScript 5.9.3, got " + ts.version);
const root = realpathSync(resolve(process.argv[2]));
const view = inventory(root);
// Additional JSON can be referenced by a project under any basename.
const configs = Object.fromEntries(view.files.filter((path) => path.endsWith(".json"))
  .map((path) => [relativePath(root, path), readFileSync(path, "utf8")]));
const workspace = new Map();
for (const [path, text] of Object.entries(configs)) {
  if (basename(path) !== "package.json") continue;
  const { config } = ts.parseConfigFileTextToJson(path, text);
  if (typeof config?.name === "string") {
    if (!workspace.has(config.name)) workspace.set(config.name, []);
    workspace.get(config.name).push(dirname(path));
  }
}
const projects = readProjects(root, view, compilerHosts(root, view));
const summary = {
  repository: root,
  typescriptVersion: ts.version,
  projects: projects.found.size,
  inferredProject: !projects.found.size,
  totalSpecifiers: 0,
  agreements: 0,
  agreementKinds: {},
  buildToSourceSamples: [],
  disagreements: {},
  unexplained: 0,
};
await compare(buildExample(), root, view, configs, projects, workspace, emitPaths(projects, view), summary);
console.log(JSON.stringify(summary, null, 2));
if (summary.unexplained > 0) process.exitCode = 1;
