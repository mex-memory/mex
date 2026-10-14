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
import { afterEach, describe, expect, it } from "vitest";
import { DB_SCHEMA_VERSION } from "../db/database.js";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine, GraphSourceStagingError } from "../engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS,
  computeSourceCorpusDigest,
  createGraphSnapshot,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../snapshot.js";

const roots: string[] = [];

afterEach(() => {
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
      compilerVersion: "5.9.3",
      extractorVersion: expect.stringContaining("typescript-5.9"),
      resolverVersion: "compiler-first-v3",
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

  it("leaves the successful snapshot unchanged after staging and changed-parse failures", async () => {
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
    await expect(engine.sync(["src/stable.ts"])).rejects.toBeInstanceOf(GraphSourceStagingError);
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);

    failRead = false;
    writeFileSync(sourcePath, "}\n");
    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: [expect.objectContaining({
        filePath: "src/stable.ts",
        operation: "parse",
        code: "GRAPH_SOURCE_PARSE_FAILED",
      })],
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });

  it("makes corpus identity independent of discovery order", () => {
    const first = { path: "src/a.ts", contentHash: "a".repeat(64) };
    const second = { path: "src/b.ts", contentHash: "b".repeat(64) };
    expect(computeSourceCorpusDigest([first, second])).toBe(computeSourceCorpusDigest([second, first]));
  });

  it("validates canonical, bounded, unique semantic-input provenance", () => {
    const digest = "a".repeat(64);
    const snapshot = createGraphSnapshot({
      indexedAt: "2026-08-22T00:00:00.000Z",
      git: { branch: null, head: null },
      schemaVersion: DB_SCHEMA_VERSION,
      compilerVersion: "test",
      extractorVersion: "test",
      resolverVersion: "test",
      grammarHash: digest,
      configHash: digest,
      manifestHash: digest,
      sources: [{ path: "src/a.ts", contentHash: digest, parseStatus: "ok" }],
      semanticInputs: [
        { path: "config/z.json", contentHash: null },
        { path: "config/a.json", contentHash: digest },
      ],
    });
    expect(snapshot.semanticInputs.map((entry) => entry.path)).toEqual([
      "config/a.json",
      "config/z.json",
    ]);
    expect(parseGraphSnapshot(serializeGraphSnapshot(snapshot))).toEqual(snapshot);

    const duplicate = JSON.parse(serializeGraphSnapshot(snapshot)) as Record<string, unknown>;
    duplicate.semanticInputs = [
      { path: "config/a.json", contentHash: digest },
      { path: "config/a.json", contentHash: null },
    ];
    expect(parseGraphSnapshot(JSON.stringify(duplicate))).toBeNull();

    const oversized = JSON.parse(serializeGraphSnapshot(snapshot)) as Record<string, unknown>;
    oversized.semanticInputs = Array.from(
      { length: GRAPH_SNAPSHOT_MAX_SEMANTIC_INPUTS + 1 },
      (_, index) => ({ path: `config/${String(index).padStart(5, "0")}.json`, contentHash: null }),
    );
    expect(parseGraphSnapshot(JSON.stringify(oversized))).toBeNull();
    const overlong = JSON.parse(serializeGraphSnapshot(snapshot)) as Record<string, unknown>;
    overlong.semanticInputs = [{ path: `${"x".repeat(4_097)}.json`, contentHash: null }];
    expect(parseGraphSnapshot(JSON.stringify(overlong))).toBeNull();
    expect(() => createGraphSnapshot({
      ...snapshot,
      git: { branch: null, head: null },
      sources: [{ path: "src/a.ts", contentHash: digest, parseStatus: "ok" }],
      semanticInputs: [{ path: "src/a.ts", contentHash: digest }],
    })).toThrow("must not duplicate supported source paths");
  });

  it("binds compiler facts to staged source bytes across an A-to-B-to-A race", async () => {
    const root = temporaryRoot("mex-graph-compiler-source-aba-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function priorCompilerFact(): number { return 1; }\n");

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    baseline.close();

    const stagedA = "export function securelyStagedFact(): number { return 2; }\n";
    const transientB = "export function transientCompilerFact(): number { return 3; }\n";
    writeFileSync(sourcePath, stagedA);
    let swapped = false;
    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      __internalGraphEngineHooks: {
        afterSemanticInputsStaged: () => {
          if (swapped) return;
          writeFileSync(sourcePath, transientB);
          swapped = true;
        },
        afterCompilerExtraction: () => writeFileSync(sourcePath, stagedA),
      },
    } as Parameters<typeof createGraphEngine>[0]);

    await engine.sync(["src/stable.ts"]);
    expect(swapped).toBe(true);
    expect(engine.searchNodes("securelyStagedFact").some((node) => node.name === "securelyStagedFact")).toBe(true);
    expect(engine.searchNodes("transientCompilerFact").some((node) => node.name === "transientCompilerFact")).toBe(false);
    engine.close();
  });

  it("binds import resolution to the staged path set across an A-to-B-to-A race", async () => {
    const root = temporaryRoot("mex-graph-compiler-import-aba-");
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
        afterSemanticInputsStaged: () => {
          renameSync(targetPath, savedTargetPath);
          writeFileSync(transientTargetPath, "export const targetValue = 2;\n");
        },
        afterCompilerExtraction: () => {
          rmSync(transientTargetPath);
          renameSync(savedTargetPath, targetPath);
        },
      },
    } as Parameters<typeof createGraphEngine>[0]);
    await engine.build();
    engine.close();

    const db = openSqlite(dbPath, { readOnly: true });
    const binding = db.prepare(
      "SELECT resolved_file_path AS resolvedFilePath FROM import_bindings WHERE module_specifier = './target'",
    ).get() as { resolvedFilePath: string | null } | undefined;
    db.close();
    expect(binding).toEqual({ resolvedFilePath: "src/target.ts" });
  });

  it("rejects an extended-config A-to-B-to-A compiler race and preserves the prior snapshot", async () => {
    const root = temporaryRoot("mex-graph-compiler-config-aba-");
    const sourcePath = join(root, "src", "stable.ts");
    const baseConfigPath = join(root, "compiler-base.json");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function priorConfigFact(): number { return 1; }\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./compiler-base.json",
      include: ["src/**/*.ts"],
    }));
    const configA = JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } });
    const configB = JSON.stringify({ compilerOptions: { strict: false, target: "ES5" } });
    writeFileSync(baseConfigPath, configA);

    const baseline = createGraphEngine({ rootDir: root, dbPath });
    await baseline.build();
    const priorNode = baseline.searchNodes("priorConfigFact")
      .find((node) => node.name === "priorConfigFact")!;
    baseline.close();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);
    writeFileSync(sourcePath, "export function priorConfigFact(): number { return 2; }\n");

    const engine = createGraphEngine({
      rootDir: root,
      dbPath,
      __internalGraphEngineHooks: {
        afterSemanticInputsStaged: () => writeFileSync(baseConfigPath, configB),
        afterCompilerExtraction: () => writeFileSync(baseConfigPath, configA),
      },
    } as Parameters<typeof createGraphEngine>[0]);
    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({
          filePath: "compiler-base.json",
          message: expect.stringContaining("semantic input changed"),
        }),
      ]),
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    expect(engine.getNode(priorNode.id)).toMatchObject({ id: priorNode.id, bodyHash: priorNode.bodyHash });
    engine.close();
  });

  it("rejects a failed full rebuild and preserves the last trustworthy facts", async () => {
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
    await expect(engine.build()).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: [expect.objectContaining({
        filePath: "src/stable.ts",
        operation: "parse",
        code: "GRAPH_SOURCE_PARSE_FAILED",
      })],
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    expect(engine.getNode(priorNode.id)).toMatchObject({ id: priorNode.id, bodyHash: priorNode.bodyHash });
    engine.close();
  });

  it("preserves trustworthy legacy facts on a failed rebuild without snapshot metadata", async () => {
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
    await expect(engine.build()).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: [expect.objectContaining({ operation: "parse" })],
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBeNull();
    expect(engine.getNode(priorNode.id)).toMatchObject({ id: priorNode.id, bodyHash: priorNode.bodyHash });
    engine.close();
  });

  // This asserted that an external `extends` aborted the build. Declining a
  // config input no longer costs a repository its entire graph — a tsconfig
  // extending a hoisted package is ordinary in any pnpm/yarn workspace. What
  // this test actually protects, and still asserts, is that the external file
  // is never read and never becomes graph provenance.
  it("declines a direct external tsconfig extension without reading it", async () => {
    const root = temporaryRoot("mex-graph-config-direct-escape-");
    const externalRoot = temporaryRoot("mex-graph-config-direct-external-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function containedConfigFact(): number { return 7; }\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);

    const externalConfig = join(externalRoot, "node_modules", "attacker", "outside.json");
    mkdirSync(join(externalRoot, "node_modules", "attacker"), { recursive: true });
    writeFileSync(externalConfig, JSON.stringify({ compilerOptions: { strict: false } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: externalConfig,
      include: ["src/**/*.ts"],
    }));
    const result = await engine.sync(["tsconfig.json"]);

    expect(result.declinedInputs).toContainEqual(expect.objectContaining({
      reason: "outside-project-corpus",
    }));
    // The external file is not read, so it is in no snapshot and no compiler
    // option it declares can reach the graph.
    const snapshot = parseGraphSnapshot(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY));
    expect(snapshot).not.toBeNull();
    expect(successfulSnapshot).not.toBeNull();
    for (const input of snapshot!.semanticInputs) {
      expect(input.path.startsWith("..")).toBe(false);
      expect(input.path).not.toContain("attacker");
    }
    engine.close();
  });

  it("rejects a missing compiler input below an escaped symlink ancestor", async () => {
    const root = temporaryRoot("mex-graph-config-missing-ancestor-escape-");
    const externalRoot = temporaryRoot("mex-graph-config-missing-ancestor-external-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function containedMissingFact(): number { return 7; }\n");
    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    const successfulSnapshot = metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY);

    symlinkSync(externalRoot, join(root, "probes"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./probes/optional.json",
      include: ["src/**/*.ts"],
    }));
    await expect(engine.sync(["tsconfig.json"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({
          filePath: "probes/optional.json",
          code: "GRAPH_SOURCE_PATH_ESCAPE",
        }),
      ]),
    });
    expect(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY)).toBe(successfulSnapshot);
    engine.close();
  });

  it("persists indirect compiler inputs without duplicating source provenance", async () => {
    const root = temporaryRoot("mex-graph-semantic-input-provenance-");
    const sourcePath = join(root, "src", "stable.ts");
    const baseConfigPath = join(root, "compiler-base.json");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function semanticInputFact(): number { return 7; }\n");
    writeFileSync(baseConfigPath, JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./compiler-base.json",
      include: ["src/**/*.ts"],
    }));
    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    engine.close();

    const snapshot = parseGraphSnapshot(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY))!;
    expect(snapshot.semanticInputs).toEqual(expect.arrayContaining([{
      path: "compiler-base.json",
      contentHash: createHash("sha256").update(readFileSync(baseConfigPath)).digest("hex"),
    }]));
    expect(snapshot.semanticInputs.some((input) => input.path === "src/stable.ts")).toBe(false);
  });

  it("persists a missing extended-config probe so later appearance can stale the graph", async () => {
    const root = temporaryRoot("mex-graph-missing-semantic-input-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function missingConfigFact(): number { return 7; }\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./compiler-base.json",
      include: ["src/**/*.ts"],
    }));
    const engine = createGraphEngine({ rootDir: root, dbPath });
    await engine.build();
    engine.close();

    const snapshot = parseGraphSnapshot(metadata(dbPath, GRAPH_SNAPSHOT_METADATA_KEY))!;
    expect(snapshot.semanticInputs).toContainEqual({ path: "compiler-base.json", contentHash: null });
  });

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

  it("rejects a checkout during final indirect semantic-input verification", async () => {
    const root = temporaryRoot("mex-graph-snapshot-semantic-git-race-");
    const sourcePath = join(root, "src", "stable.ts");
    const dbPath = join(root, "graph.db");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "export function stableSnapshot(): number { return 7; }\n");
    writeFileSync(join(root, "compiler-base.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./compiler-base.json",
      include: ["src/**/*.ts"],
    }));
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
      __internalGraphEngineHooks: {
        afterFinalSemanticInputRead: (path: string) => {
          if (switchedBranch || path !== "compiler-base.json") return;
          execFileSync("git", ["checkout", "-b", "semantic-input-race"], {
            cwd: root,
            stdio: ["ignore", "ignore", "pipe"],
          });
          switchedBranch = true;
        },
      },
    } as Parameters<typeof createGraphEngine>[0]);
    await expect(engine.sync(["src/stable.ts"])).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      failures: expect.arrayContaining([
        expect.objectContaining({ filePath: ".git/HEAD" }),
      ]),
    });
    expect(switchedBranch).toBe(true);
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
