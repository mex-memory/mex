import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertProcessSucceeded, runProcessSync } from "./process.mjs";

function expand(token, context) {
  return token.replaceAll(/\{(suiteDir|harnessRoot|subjectRoot|artifactRoot)\}/g, (_, key) => context[key] ?? "");
}

const GRAPH_SCANNER_IGNORED_DIRECTORIES = new Set([
  ".git", ".mex", ".next", "build", "coverage", "dist", "node_modules", "out",
]);

/**
 * Graph builds scan supported source extensions without consulting .gitignore.
 * Refuse output locations whose CLI artifacts could therefore become subject code.
 */
export function assertGraphOutputIsolation(subjectRoot, outputDir) {
  const subject = resolve(subjectRoot);
  const output = resolve(outputDir);
  const pathFromSubject = relative(subject, output);
  if (pathFromSubject.startsWith("..") || isAbsolute(pathFromSubject)) return;
  const segments = pathFromSubject.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => GRAPH_SCANNER_IGNORED_DIRECTORIES.has(segment))) return;
  throw new Error(
    `evaluation output ${output} is inside graph subject ${subject} and is not scanner-isolated; `
    + "place it outside the subject or below .mex/ (the default)",
  );
}

function resolvedGitRevision(root, revision) {
  const result = assertProcessSucceeded(runProcessSync("git", ["rev-parse", `${revision}^{commit}`], { cwd: root }), `resolve ${revision}`);
  return String(result.stdout).trim();
}

/** Build CLI bundles from local git objects without changing the active worktree. */
export function buildSystemArtifacts({ suite, context, outputDir, overrides = {} }) {
  const resolvedOverrides = { ...overrides };
  const metadata = {};
  const artifactsDir = join(outputDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  for (const [systemId, system] of Object.entries(suite.systems)) {
    if (resolvedOverrides[systemId] || system.command || !system.buildFromGit) continue;
    const build = system.buildFromGit;
    const sourceRoot = resolve(expand(build.root, context));
    const revision = resolvedGitRevision(sourceRoot, build.revision);
    const artifactRoot = join(artifactsDir, systemId);
    if (existsSync(artifactRoot)) throw new Error(`artifact target already exists: ${artifactRoot}`);
    const temporaryRoot = mkdtempSync(join(artifactsDir, `.${systemId}-`));
    try {
      const archive = assertProcessSucceeded(runProcessSync("git", ["archive", "--format=tar", revision], {
        cwd: sourceRoot,
        encoding: null,
        maxOutputBytes: 512 * 1024 * 1024,
      }), `archive ${systemId}`);
      const archivePath = join(temporaryRoot, "source.tar");
      writeFileSync(archivePath, archive.stdout);
      assertProcessSucceeded(runProcessSync("tar", ["-xf", archivePath, "-C", temporaryRoot], { cwd: sourceRoot }), `extract ${systemId}`);
      rmSync(archivePath, { force: true });
      if (build.shareNodeModules) {
        const sourceModules = join(sourceRoot, "node_modules");
        const targetModules = join(temporaryRoot, "node_modules");
        if (!existsSync(sourceModules)) throw new Error(`cannot share missing node_modules from ${sourceRoot}`);
        symlinkSync(sourceModules, targetModules, "dir");
      }
      const commandResults = [];
      for (const command of build.commands) {
        const expanded = command.map((token) => expand(token, { ...context, artifactRoot: temporaryRoot }));
        const [executable, ...args] = expanded;
        const result = runProcessSync(executable, args, { cwd: temporaryRoot, maxOutputBytes: 256 * 1024 * 1024 });
        commandResults.push({ command: expanded, code: result.code, stdout: String(result.stdout), stderr: String(result.stderr), elapsedMs: result.elapsedMs });
        assertProcessSucceeded(result, `build ${systemId}`);
      }
      const cli = join(temporaryRoot, build.cli);
      if (!existsSync(cli)) throw new Error(`built CLI does not exist for ${systemId}: ${cli}`);
      renameSync(temporaryRoot, artifactRoot);
      resolvedOverrides[systemId] = join(artifactRoot, build.cli);
      metadata[systemId] = { sourceRoot, declaredRevision: build.revision, revision, commands: commandResults };
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }
  return { overrides: resolvedOverrides, metadata };
}

export class GraphDbGuard {
  constructor(subjectRoot, scratchRoot) {
    this.paths = ["graph.db", "graph.db-wal", "graph.db-shm"].map((name) => join(subjectRoot, ".mex", name));
    mkdirSync(scratchRoot, { recursive: true });
    this.backups = this.paths.map((path) => join(scratchRoot, path.endsWith("graph.db") ? "graph.db" : path.endsWith("-wal") ? "graph.db-wal" : "graph.db-shm"));
    this.present = this.paths.map(existsSync);
    this.present.forEach((present, index) => { if (present) copyFileSync(this.paths[index], this.backups[index]); });
  }

  clear() {
    for (const path of this.paths) rmSync(path, { force: true });
  }

  activate(snapshot) {
    this.clear();
    mkdirSync(dirname(this.paths[0]), { recursive: true });
    copyFileSync(snapshot, this.paths[0]);
  }

  restore() {
    this.clear();
    this.present.forEach((present, index) => {
      if (present) {
        mkdirSync(dirname(this.paths[index]), { recursive: true });
        copyFileSync(this.backups[index], this.paths[index]);
      }
    });
  }
}

/** Remove recovery scratch only after the guarded graph has been restored. */
export function restoreGraphDbAndRemoveScratch(guard, scratchRoot) {
  guard.restore();
  rmSync(scratchRoot, { recursive: true, force: true });
}
