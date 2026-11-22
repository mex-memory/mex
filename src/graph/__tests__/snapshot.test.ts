import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_SCHEMA_VERSION } from "../db/database.js";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine, GraphSourceStagingError } from "../engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  computeSourceCorpusDigest,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../snapshot.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function metadata(dbPath: string, key: string): string | null {
  const db = openSqlite(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

function initializeGit(root: string): string {
  const run = (args: string[]): string => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  run(["init", "-b", "snapshot-test"]);
  run(["config", "user.name", "Snapshot Test"]);
  run(["config", "user.email", "snapshot@example.test"]);
  run(["add", "src/stable.ts"]);
  run(["commit", "-m", "fixture"]);
  return run(["rev-parse", "HEAD"]);
}

describe("graph snapshot provenance", () => {
  it("writes one canonical snapshot with Git and deterministic corpus provenance", async () => {
    const root = temporaryRoot("mex-graph-snapshot-");
    const sourcePath = join(root, "src", "stable.ts");
    const source = "export function stableSnapshot(): number { return 7; }\n";
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, source);
    const head = initializeGit(root);
    const dbPath = join(root, "graph.db");

    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    engine.close();

    const raw = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    const snapshot = parseGraphSnapshot(raw);
    expect(snapshot).not.toBeNull();
    expect(raw).toBe(serializeGraphSnapshot(snapshot!));
    const contentHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    expect(snapshot).toMatchObject({
      version: 1,
      indexedBranch: "snapshot-test",
      indexedHead: head,
      schemaVersion: DB_SCHEMA_VERSION,
      extractorVersion: expect.stringContaining("tree-sitter-v4+engine-"),
      resolverVersion: "engine-first-v4",
      sourceCorpusDigest: computeSourceCorpusDigest([{ path: "src/stable.ts", contentHash }]),
      sourceCount: 1,
      parseHealth: { total: 1, ok: 1, partial: 0, failed: 0 },
    });
    expect(snapshot!.indexedAt).toBe(snapshot!.lastSuccessfulIndexAt);
    expect(new Date(snapshot!.indexedAt).toISOString()).toBe(snapshot!.indexedAt);
    expect(snapshot!.manifestHash).toBe(metadata(dbPath, "manifest_hash"));
    expect(snapshot!.configHash).toBe(metadata(dbPath, "config_hash"));
    expect(snapshot!.grammarHash).toBe(metadata(dbPath, "grammar_hash"));
  }, 15_000);

  it("publishes per-file read and parse gaps in snapshot provenance", async () => {
    const root = temporaryRoot("mex-graph-snapshot-failure-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");
    let failRead = false;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      sourceFileAccess: {
        read: (absolutePath) => {
          if (failRead && absolutePath === sourcePath) {
            throw Object.assign(new Error("injected staging failure"), { code: "EACCES" });
          }
          return readFileSync(absolutePath, "utf8");
        },
      },
    });
    await engine.build();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    expect(parseGraphSnapshot(successfulSnapshot)).toMatchObject({
      indexedBranch: null,
      indexedHead: null,
    });

    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 8; }\n");
    failRead = true;
    await engine.sync(["src/stable.ts"]);
    expect(engine.coverageFor("src/stable.ts")).toEqual({indexed:false,reason:"unreadable"});
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).not.toBe(successfulSnapshot);

    failRead = false;
    writeFileSync(sourcePath, "}\n");
    await engine.sync(["src/stable.ts"]);
    expect(engine.coverageFor("src/stable.ts")).toEqual({indexed:false,reason:"parse failed"});
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).not.toBe(successfulSnapshot);
    engine.close();
  });

  it("makes corpus identity independent of discovery order", () => {
    const first = { path: "src/a.ts", contentHash: "a".repeat(64) };
    const second = { path: "src/b.ts", contentHash: "b".repeat(64) };
    expect(computeSourceCorpusDigest([first, second])).toBe(computeSourceCorpusDigest([second, first]));
  });

  it("binds graph facts to staged source bytes across an A-to-B-to-A race", async () => {
    const root = temporaryRoot("mex-graph-source-aba-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function priorGraphFact(): number { return 1; }\n");

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    baseline.close();

    const stagedA = "export function securelyStagedFact(): number { return 2; }\n";
    const transientB = "export function transientGraphFact(): number { return 3; }\n";
    writeFileSync(sourcePath, stagedA);
    let swapped = false;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      __internalGraphEngineHooks: {
        afterSourcesStaged: () => {
          if (swapped) return;
          writeFileSync(sourcePath, transientB);
          swapped = true;
        },
        afterExtraction: () => writeFileSync(sourcePath, stagedA),
      },
    } as Parameters<typeof createGraphEngine>[0]);

    await engine.sync(["src/stable.ts"]);
    expect(swapped).toBe(true);
    expect(engine.searchNodes("securelyStagedFact").some((node) => node.name === "securelyStagedFact")).toBe(true);
    expect(engine.searchNodes("transientGraphFact").some((node) => node.name === "transientGraphFact")).toBe(false);
    engine.close();
  });

  it("binds import resolution to the staged path set across an A-to-B-to-A race", async () => {
    const root = temporaryRoot("mex-graph-import-aba-");
    // A native job that missed the target abstains. This case verifies that
    // the Node fallback resolves only against its captured source set.
    vi.stubEnv("MEX_GRAPH_ENGINE", join(root, "missing-mex-graph"));
    const sourceDir = join(root, "src");
    const targetPath = join(sourceDir, "target.ts");
    const savedTargetPath = join(sourceDir, "target.saved");
    const transientTargetPath = join(sourceDir, "target.js");
    const dbPath = join(root, "graph.db");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(targetPath, "export const targetValue = 1;\n");
    writeFileSync(join(sourceDir, "use.ts"), [
      "import { targetValue } from './target';",
      "export function readTarget(): number { return targetValue; }",
      "",
    ].join("\n"));
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      __internalGraphEngineHooks: {
        afterSourcesStaged: () => {
          renameSync(targetPath, savedTargetPath);
          writeFileSync(transientTargetPath, "export const targetValue = 2;\n");
        },
        afterExtraction: () => {
          rmSync(transientTargetPath);
          renameSync(savedTargetPath, targetPath);
        },
      },
    } as Parameters<typeof createGraphEngine>[0]);
    await engine.build();
    engine.close();

    const db = openSqlite(dbPath, { readOnly: true });
    const binding = db.prepare(
      `SELECT target.file_path AS resolvedFilePath
       FROM edges e JOIN nodes target ON target.id = e.target
       WHERE e.kind = 'imports' AND e.source = 'file:src/use.ts'`,
    ).get() as { resolvedFilePath: string | null } | undefined;
    db.close();
    expect(binding).toEqual({ resolvedFilePath: "src/target.ts" });
  });

  it("records a failed parse on a full rebuild without exposing its old facts", async () => {
    const root = temporaryRoot("mex-graph-full-build-parse-failure-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function fullBuildFact(): number { return 7; }\n");
    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    const priorNode = engine.searchNodes("fullBuildFact").find((node) => node.name === "fullBuildFact")!;

    writeFileSync(sourcePath, "}\n");
    await engine.build();
    expect(engine.coverageFor("src/stable.ts")).toEqual({indexed:false,reason:"parse failed"});
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).not.toBe(successfulSnapshot);
    expect(engine.getNode(priorNode.id)).toBeNull();
    engine.close();
  });

  it("publishes parse coverage when rebuilding a legacy graph without a snapshot", async () => {
    const root = temporaryRoot("mex-graph-legacy-full-build-parse-failure-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function legacyBuildFact(): number { return 7; }\n");
    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    const priorNode = baseline.searchNodes("legacyBuildFact").find((node) => node.name === "legacyBuildFact")!;
    baseline.close();
    const db = openSqlite(dbPath);
    db.prepare("DELETE FROM project_metadata WHERE key = ?").run(GRAPH_SNAPSHOT_METADATA_KEY);
    db.close();

    writeFileSync(sourcePath, "}\n");
    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    expect(engine.coverageFor("src/stable.ts")).toEqual({indexed:false,reason:"parse failed"});
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).not.toBeNull();
    expect(engine.getNode(priorNode.id)).toBeNull();
    engine.close();
  });

  // This asserted that an external `extends` aborted the build. Declining a
  // config input no longer costs a repository its entire graph — a tsconfig
  // extending a hoisted package is ordinary in any pnpm/yarn workspace. What
  // this test actually protects, and still asserts, is that the external file
  // is never read and never becomes graph provenance.
  it("rejects publication when Git branch provenance changes during staging", async () => {
    const root = temporaryRoot("mex-graph-snapshot-git-race-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");
    initializeGit(root);

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    baseline.close();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 8; }\n");

    let switchedBranch = false;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      sourceFileAccess: {
        read: (absolutePath) => {
          const source = readFileSync(absolutePath, "utf8");
          if (!switchedBranch && absolutePath === sourcePath) {
            execFileSync("git", ["checkout", "-b", "snapshot-race"], {
              cwd: root,
              stdio: ["ignore", "ignore", "pipe"],
            });
            switchedBranch = true;
          }
          return source;
        },
      },
    });

    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({ filePath: ".git/HEAD" }),
      ]),
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  }, 10_000);

  it("rejects publication when graph configuration changes during staging", async () => {
    const root = temporaryRoot("mex-graph-snapshot-config-race-");
    const sourcePath = join(root, "src", "stable.ts");
    const packagePath = join(root, "package.json");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");
    writeFileSync(packagePath, "{\"name\":\"before-staging\",\"type\":\"module\"}\n");

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    baseline.close();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 8; }\n");

    let changedConfig = false;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      sourceFileAccess: {
        read: (absolutePath) => {
          const source = readFileSync(absolutePath, "utf8");
          if (!changedConfig && absolutePath === sourcePath) {
            // `type` decides how a specifier resolves, so this changes the
            // build inputs rather than only the file's bytes.
            writeFileSync(packagePath, "{\"name\":\"before-staging\",\"type\":\"commonjs\"}\n");
            changedConfig = true;
          }
          return source;
        },
      },
    });

    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({ filePath: ".", message: expect.stringContaining("configHash") }),
      ]),
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });

  it("rejects publication when an exact source identity changes after staging", async () => {
    const root = temporaryRoot("mex-graph-snapshot-source-race-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    baseline.close();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 8; }\n");

    let sourceStats = 0;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      sourceFileAccess: {
        stat: (absolutePath) => {
          const stats = statSync(absolutePath);
          if (absolutePath === sourcePath) {
            sourceStats += 1;
            // inspectChangedSources and staging have already finished. Change
            // the file as the post-continuity publication probe begins.
            if (sourceStats === 3) {
              writeFileSync(sourcePath, "export function stableSnapshot(): number { return 9; }\n");
            }
          }
          return stats;
        },
      },
    });

    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/stable.ts", message: expect.stringContaining("changed") }),
      ]),
    });
    expect(sourceStats).toBe(3);
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });

  it("refuses an external source symlink and preserves the prior snapshot", async () => {
    const root = temporaryRoot("mex-graph-snapshot-source-escape-");
    const externalRoot = temporaryRoot("mex-graph-snapshot-source-external-");
    const sourcePath = join(root, "src", "stable.ts");
    const externalSourcePath = join(externalRoot, "outside.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");
    writeFileSync(externalSourcePath, "export const outsideSecret = 'must-not-index';\n");

    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    rmSync(sourcePath);
    symlinkSync(externalSourcePath, sourcePath);

    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/stable.ts",
          code: "GRAPH_SOURCE_PATH_ESCAPE",
        }),
      ]),
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });

  it("rejects an atomic source replacement during final verification", async () => {
    const root = temporaryRoot("mex-graph-snapshot-source-replace-");
    const sourcePath = join(root, "src", "stable.ts");
    const replacementPath = join(root, "src", "replacement.ts.tmp");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    baseline.close();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 8; }\n");

    let sourceReads = 0;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      sourceFileAccess: {
        read: (absolutePath) => {
          const source = readFileSync(absolutePath, "utf8");
          if (absolutePath === sourcePath) {
            sourceReads += 1;
            if (sourceReads === 2) {
              writeFileSync(replacementPath, "export function stableSnapshot(): number { return 9; }\n");
              renameSync(replacementPath, sourcePath);
            }
          }
          return source;
        },
      },
    });

    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/stable.ts",
          code: "GRAPH_SOURCE_PATH_ESCAPE",
        }),
      ]),
    });
    expect(sourceReads).toBe(2);
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });

  it("refuses an external config symlink and preserves the prior snapshot", async () => {
    const root = temporaryRoot("mex-graph-snapshot-config-escape-");
    const externalRoot = temporaryRoot("mex-graph-snapshot-config-external-");
    const sourcePath = join(root, "src", "stable.ts");
    const packagePath = join(root, "package.json");
    const externalPackagePath = join(externalRoot, "package.json");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");
    writeFileSync(packagePath, "{\"name\":\"inside\"}\n");
    writeFileSync(externalPackagePath, "{\"name\":\"outside-secret\"}\n");

    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    rmSync(packagePath);
    symlinkSync(externalPackagePath, packagePath);

    await expect(engine.sync([])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({
          filePath: "package.json",
          code: "GRAPH_SOURCE_PATH_ESCAPE",
        }),
      ]),
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });
});
