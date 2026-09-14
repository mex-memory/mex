import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphRemediationCommand } from "../../reporter.js";
import { DB_SCHEMA_VERSION } from "../db/database.js";
import { openSqlite } from "../db/sqlite.js";
import { BANDS } from "../config.js";
import { GRAPH_CORPUS_LIMITS } from "../corpus-policy.js";
import { createGraphEngine } from "../engine-impl.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { decodeMinhash } from "../fingerprint.js";
import type { Fingerprint } from "../reconcile.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "../snapshot.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
  inspectGraphStatusWithFreshObservation,
  resolveContainedGraphDatabasePath,
} from "../status.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "mex-graph-status-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function source(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function build(root: string): Promise<string> {
  const engine = createGraphEngine({ rootDir: root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
  return join(root, ".mex", "graph.db");
}

async function inspect(root: string, maxChangedPaths?: number) {
  return inspectGraphStatus({ projectRoot: root, now: NOW, maxChangedPaths });
}

function updateSnapshot(dbPath: string, update: (snapshot: GraphSnapshot) => GraphSnapshot): void {
  const db = openSqlite(dbPath);
  try {
    const row = db.prepare(
      "SELECT value FROM project_metadata WHERE key = ?",
    ).get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(row.value);
    if (!snapshot) throw new Error("test fixture has no valid graph snapshot");
    db.prepare(
      "UPDATE project_metadata SET value = ?, updated_at = ? WHERE key = ?",
    ).run(serializeGraphSnapshot(update(snapshot)), NOW.getTime(), GRAPH_SNAPSHOT_METADATA_KEY);
  } finally {
    db.close();
  }
}

function readSnapshot(dbPath: string): GraphSnapshot {
  const db = openSqlite(dbPath, { readOnly: true, immutable: true });
  try {
    const row = db.prepare(
      "SELECT value FROM project_metadata WHERE key = ?",
    ).get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(row.value);
    if (!snapshot) throw new Error("test fixture has no valid graph snapshot");
    return snapshot;
  } finally {
    db.close();
  }
}

function executableRemediations(status: Awaited<ReturnType<typeof inspectGraphStatus>>): string[] {
  return status.diagnostics.flatMap((diagnostic) =>
    (diagnostic.remediation ?? []).flatMap((action) => action.command ? [action.command] : []));
}

function treeState(root: string): Array<Record<string, string | number>> {
  const entries: Array<Record<string, string | number>> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      const stats = statSync(absolute);
      entries.push({
        path,
        kind: entry.isDirectory() ? "directory" : "file",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ...(entry.isFile()
          ? { sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") }
          : {}),
      });
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return entries;
}

function swapCase(value: string): string {
  return [...value].map((char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()).join("");
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

describe("inspectGraphStatus", () => {
  it("reports a missing graph without creating .mex or changing the filesystem", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = true;\n");
    const before = treeState(root);

    const status = await inspect(root);

    expect(status).toMatchObject({
      status: "missing",
      observedAt: NOW.toISOString(),
      currentRepo: { branch: null, head: null, dirty: false, observedAt: NOW.toISOString() },
      schemaVersion: null,
      changes: { total: 1, added: ["src/service.ts"], modified: [], deleted: [] },
    });
    expect(treeState(root)).toEqual(before);
  });

  // One oversized file is a skipped file, not a corpus breach. This test used
  // to assert the opposite — that a single oversized source raised the
  // path-free GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED — which is the same defect
  // that let one 34 MB generated file abort a 3,259-file build. The invariant
  // that test actually guarded (a path-free corpus diagnostic survives when
  // per-path diagnostics are suppressed) is covered by the config-corpus case
  // immediately below, which still trips a genuine corpus-wide ceiling.
  it("skips one oversized source file, as a bounded per-path diagnostic", async () => {
    const root = temporaryRoot("mex-graph-status-oversized-file-");
    source(root, "src/service.ts", "export const service = true;\n");
    source(
      root,
      "src/oversized.py",
      "x".repeat(GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1),
    );

    const suppressed = await inspect(root, 0);
    const reported = await inspect(root, 10);

    // The skip names a path, so it is bounded like every other path diagnostic.
    expect(suppressed.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "GRAPH_SOURCE_FILE_SKIPPED" }),
    );
    expect(suppressed.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED" }),
    );
    expect(reported.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SOURCE_FILE_SKIPPED",
      severity: "warning",
      path: "src/oversized.py",
    }));
    // The rest of the repository is still observed: the walk did not stop.
    expect(reported.changes.added).toEqual(["src/service.ts"]);
  });

  it("classifies a bounded manifest refusal separately from generic inspection failure", async () => {
    const root = temporaryRoot("mex-graph-status-manifest-limit-");
    source(root, "package.json", "x".repeat(GRAPH_CORPUS_LIMITS.maxConfigFileBytes + 1));

    const status = await inspect(root, 0);

    expect(status.diagnostics).toContainEqual({
      code: "GRAPH_MANIFEST_CORPUS_LIMIT_EXCEEDED",
      severity: "warning",
      message: "The graph configuration corpus exceeds MEX's bounded inspection policy.",
    });
  });

  it("refuses an oversized disposable index before SQLite materialization", async () => {
    const root = temporaryRoot("mex-graph-status-index-limit-");
    source(root, "src/service.ts", "export const service = true;\n");
    const dbPath = await build(root);
    truncateSync(dbPath, GRAPH_CORPUS_LIMITS.maxIndexBytes + 1);

    const status = await inspect(root, 0);

    expect(status.status).toBe("degraded");
    expect(status.diagnostics).toContainEqual({
      code: "GRAPH_INDEX_CORPUS_LIMIT_EXCEEDED",
      severity: "warning",
      message: "The disposable graph index exceeds MEX's bounded inspection policy.",
    });
  });

  it("disables repository-configured Git filesystem monitors during inspection", async () => {
    const root = temporaryRoot("mex-graph-status-fsmonitor-");
    const monitor = join(root, "fsmonitor.sh");
    const sentinel = join(root, "fsmonitor-invoked");
    source(root, "src/service.ts", "export const service = true;\n");
    writeFileSync(monitor, `#!/bin/sh\nprintf invoked > ${JSON.stringify(sentinel)}\n`);
    chmodSync(monitor, 0o700);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "core.fsmonitor", monitor);

    await inspect(root, 0);

    expect(existsSync(sentinel)).toBe(false);
  });

  it("suppresses executable graph remediation when Git provenance is unavailable", async () => {
    const root = temporaryRoot("mex-graph-git-unavailable-");
    source(root, "src/service.ts", "export const service = true;\n");
    await build(root);
    source(root, "src/service.ts", "export const service = false;\n");
    const unavailablePath = join(root, "no-executables");
    mkdirSync(unavailablePath);
    const previousPath = process.env.PATH;
    process.env.PATH = unavailablePath;
    try {
      const status = await inspect(root);
      expect(status.status).toBe("stale");
      expect(status.diagnostics).toContainEqual(expect.objectContaining({
        code: "GRAPH_REPO_STATE_UNAVAILABLE",
      }));
      expect(status.diagnostics).toContainEqual(expect.objectContaining({
        code: "GRAPH_SOURCE_CORPUS_MISMATCH",
      }));
      expect(executableRemediations(status)).toEqual([]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("reports a fresh snapshot and leaves the database and sidecar set byte-identical", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export function service(): number { return 1; }\n");
    const dbPath = await build(root);
    const before = treeState(root);

    const status = await inspect(root);

    expect(status.status).toBe("fresh");
    expect(status.schemaVersion).toBe(DB_SCHEMA_VERSION);
    expect(status.parseHealth).toMatchObject({ total: 1, ok: 1, partial: 0, failed: 0 });
    expect(status.changes).toMatchObject({
      total: 0,
      added: [],
      modified: [],
      deleted: [],
      truncated: false,
      branchChanged: false,
      manifestChanged: false,
      configChanged: false,
      grammarChanged: false,
    });
    expect(status.indexedAt).not.toBeNull();
    expect(statSync(dbPath).isFile()).toBe(true);
    expect(treeState(root)).toEqual(before);
  });

  it("uses the engine's UTF-8 decoded-string hash for invalid byte sequences", async () => {
    const root = temporaryRoot();
    const path = join(root, "src", "invalid.ts");
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.concat([
      Buffer.from("export const valid = 1; // invalid byte: ", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("\n", "utf8"),
    ]);
    writeFileSync(path, bytes);
    const dbPath = await build(root);
    const db = openSqlite(dbPath, { readOnly: true, immutable: true });
    let storedHash: string;
    try {
      const row = db.prepare("SELECT content_hash FROM files WHERE path = ?")
        .get("src/invalid.ts") as { content_hash: string };
      storedHash = row.content_hash;
    } finally {
      db.close();
    }

    const decodedHash = createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
    const byteHash = createHash("sha256").update(bytes).digest("hex");
    expect(storedHash).toBe(decodedHash);
    expect(storedHash).not.toBe(byteHash);
    expect((await inspect(root)).status).toBe("fresh");
  });

  it("uses exact decoded content hashes for deterministic added, modified, and deleted paths", async () => {
    const root = temporaryRoot();
    source(root, "src/b.ts", "export const b = 1;\n");
    source(root, "src/c.ts", "export const c = 1;\n");
    await build(root);
    const prior = statSync(join(root, "src", "b.ts"));
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    utimesSync(join(root, "src", "b.ts"), prior.atime, prior.mtime);
    unlinkSync(join(root, "src", "c.ts"));
    source(root, "src/a.ts", "export const a = 1;\n");

    const full = await inspect(root);
    expect(full.status).toBe("stale");
    expect(full.changes).toMatchObject({
      total: 3,
      added: ["src/a.ts"],
      modified: ["src/b.ts"],
      deleted: ["src/c.ts"],
      truncated: false,
    });

    const bounded = await inspect(root, 2);
    expect(bounded.changes).toMatchObject({
      total: 3,
      added: ["src/a.ts"],
      modified: ["src/b.ts"],
      deleted: [],
      truncated: true,
    });
  });

  it("reports parser degradation with bounded failed paths", async () => {
    const root = temporaryRoot();
    source(root, "src/a.ts", "export const a = 1;\n");
    source(root, "src/b.ts", "export const b = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.prepare("UPDATE files SET parse_status = 'failed' WHERE path IN (?, ?)")
        .run("src/a.ts", "src/b.ts");
    } finally {
      db.close();
    }
    updateSnapshot(dbPath, (snapshot) => ({
      ...snapshot,
      parseHealth: { total: 2, ok: 0, partial: 0, failed: 2 },
    }));

    const status = await inspect(root, 1);
    expect(status.status).toBe("degraded");
    expect(status.parseHealth).toEqual({
      total: 2,
      ok: 0,
      partial: 0,
      failed: 2,
      failedPaths: ["src/a.ts"],
      failedPathsTruncated: true,
    });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_PARSE_DEGRADED",
      message: expect.stringContaining("2 failed"),
    }));
  });

  it.each([1, DB_SCHEMA_VERSION + 1])("classifies schema %s as rebuild_required", async (schemaVersion) => {
    const root = temporaryRoot();
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DELETE FROM schema_versions");
      db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)")
        .run(schemaVersion, NOW.getTime(), "test schema");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("rebuild_required");
    expect(status.schemaVersion).toBe(schemaVersion);
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_REBUILD_REQUIRED");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.remediation).toEqual([{ label: "Rebuild graph", command: "mex graph rebuild" }]);
  });

  it.each([2, 3])("offers lossless repair for structurally recognized schema %s", async (schemaVersion) => {
    const root = temporaryRoot(`mex-graph-repair-v${schemaVersion}-`);
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DELETE FROM schema_versions");
      db.prepare("INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)")
        .run(schemaVersion, NOW.getTime(), "recognized repair fixture");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("rebuild_required");
    expect(status.schemaVersion).toBe(schemaVersion);
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_REPAIR_AVAILABLE",
      remediation: [{ label: "Upgrade graph schema", command: "mex graph repair" }],
    }));
  });

  it("rejects a current-version store whose compact fingerprint column type is malformed", async () => {
    const root = temporaryRoot("mex-graph-current-shape-invalid-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      // Rebuild only the compact tables with a deliberately wrong declared
      // type. Mutating sqlite_master through writable_schema is rejected by
      // newer Node 24 SQLite builds, and the fixture should exercise our
      // schema validator rather than depend on that unsafe escape hatch.
      db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        CREATE TEMP TABLE saved_lsh AS
          SELECT band, band_hash, ref FROM lsh_buckets;
        CREATE TABLE node_fingerprints_malformed (
          ref INTEGER PRIMARY KEY,
          node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
          minhash TEXT NOT NULL,
          neighbors TEXT NOT NULL,
          token_count INTEGER NOT NULL
        );
        INSERT INTO node_fingerprints_malformed
          SELECT ref, node_id, CAST(minhash AS TEXT), neighbors, token_count
          FROM node_fingerprints;
        DROP TABLE lsh_buckets;
        DROP TABLE node_fingerprints;
        ALTER TABLE node_fingerprints_malformed RENAME TO node_fingerprints;
        CREATE TABLE lsh_buckets (
          band INTEGER NOT NULL,
          band_hash INTEGER NOT NULL,
          ref INTEGER NOT NULL REFERENCES node_fingerprints(ref) ON DELETE CASCADE,
          PRIMARY KEY (band, band_hash, ref)
        ) WITHOUT ROWID;
        INSERT INTO lsh_buckets SELECT band, band_hash, ref FROM saved_lsh;
        DROP TABLE saved_lsh;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    expect(status.schemaVersion).toBe(DB_SCHEMA_VERSION);
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SCHEMA_INVALID",
      message: "The current graph schema has incompatible column, key, or generated-table structure.",
    }));
  });

  it("offers isolated rebuild recovery for an empty recorded schema version", async () => {
    const root = temporaryRoot("mex-graph-invalid-version-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DELETE FROM schema_versions");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_SCHEMA_INVALID");
    expect(diagnostic?.message).toContain("invalid version");
    expect(diagnostic?.remediation).toBeUndefined();
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it("distinguishes a corrupt database from an active-WAL transient state", async () => {
    const corruptRoot = temporaryRoot("mex-graph-corrupt-");
    mkdirSync(join(corruptRoot, ".mex"));
    writeFileSync(join(corruptRoot, ".mex", "graph.db"), "not sqlite");
    const corruptBefore = treeState(corruptRoot);
    const corrupt = await inspect(corruptRoot);
    expect(corrupt.status).toBe("corrupt");
    expect(corrupt.changes.total).toBe(0);
    expect(corrupt.diagnostics).toContainEqual(expect.objectContaining({ code: "GRAPH_INDEX_CORRUPT" }));
    expect(executableRemediations(corrupt)).toContain("mex graph rebuild");
    expect(treeState(corruptRoot)).toEqual(corruptBefore);

    const transientRoot = temporaryRoot("mex-graph-transient-");
    source(transientRoot, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(transientRoot);
    const writer = openSqlite(dbPath);
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer.prepare("UPDATE project_metadata SET updated_at = ? WHERE key = 'manifest_hash'")
        .run(NOW.getTime());
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const transient = await inspect(transientRoot);
      expect(transient.status).toBe("degraded");
      expect(transient.changes.total).toBe(0);
      expect(transient.diagnostics).toContainEqual(expect.objectContaining({ code: "GRAPH_INDEX_SIDECAR_ACTIVE" }));
      expect(transient.diagnostics).not.toContainEqual(expect.objectContaining({ code: "GRAPH_INDEX_CORRUPT" }));
      expect(executableRemediations(transient)).toContain("mex graph repair");
    } finally {
      writer.close();
    }
  });

  it("reports sidecars deterministically and refuses immutable interpretation while one is active or unavailable", async () => {
    const root = temporaryRoot("mex-graph-sidecar-probe-");
    const dbPath = join(root, ".mex", "graph.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "not sqlite");
    expect(inspectGraphSidecars(dbPath)).toEqual({ state: "clear", paths: [] });

    writeFileSync(`${dbPath}-journal`, "hot rollback journal");
    expect(inspectGraphSidecars(dbPath)).toEqual({
      state: "active",
      paths: ["graph.db-journal"],
    });
    const active = await inspect(root);
    expect(active).toMatchObject({ status: "degraded", schemaVersion: null });
    expect(active.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SIDECAR_ACTIVE",
    }));
    expect(active.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_CORRUPT",
    }));

    chmodSync(`${dbPath}-journal`, 0o000);
    expect(inspectGraphSidecars(dbPath)).toEqual({
      state: "unavailable",
      paths: ["graph.db-journal"],
    });
    chmodSync(`${dbPath}-journal`, 0o600);
    unlinkSync(`${dbPath}-journal`);
    mkdirSync(`${dbPath}-wal`);
    expect(inspectGraphSidecars(dbPath)).toEqual({
      state: "unavailable",
      paths: ["graph.db-wal"],
    });
    const unavailable = await inspect(root);
    expect(unavailable).toMatchObject({ status: "degraded", schemaVersion: null });
    expect(unavailable.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SIDECAR_UNAVAILABLE",
    }));
  });

  it("detects a live rollback journal before reading the database", async () => {
    const root = temporaryRoot("mex-graph-hot-journal-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const writer = openSqlite(dbPath);
    let transactionOpen = false;
    try {
      writer.exec("PRAGMA journal_mode = DELETE");
      writer.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      writer.prepare("UPDATE project_metadata SET updated_at = ? WHERE key = 'manifest_hash'")
        .run(NOW.getTime());
      expect(statSync(`${dbPath}-journal`).size).toBeGreaterThan(0);

      const status = await inspect(root);
      expect(status).toMatchObject({ status: "degraded", schemaVersion: null });
      expect(status.diagnostics).toContainEqual(expect.objectContaining({
        code: "GRAPH_INDEX_SIDECAR_ACTIVE",
      }));
    } finally {
      if (transactionOpen) writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("never emits fresh when the database identity cannot stabilize across bounded retries", async () => {
    const root = temporaryRoot("mex-graph-status-race-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const attempts: number[] = [];

    const status = await inspectGraphStatus({
      projectRoot: root,
      now: NOW,
      internal: {
        beforeFreshValidation(attempt) {
          attempts.push(attempt);
          const changedAt = new Date(NOW.getTime() + (attempt + 1) * 60_000);
          utimesSync(dbPath, changedAt, changedAt);
        },
      },
    });

    expect(attempts).toEqual([0, 1]);
    expect(status.status).toBe("degraded");
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_STATUS_OBSERVATION_RACE",
      message: expect.stringContaining("graph snapshot"),
    }));
  });

  it("does not report durable corruption when the database changes during structural inspection", async () => {
    const root = temporaryRoot("mex-graph-structural-race-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DROP TABLE edges");
    } finally {
      db.close();
    }
    const attempts: number[] = [];

    const status = await inspectGraphStatus({
      projectRoot: root,
      now: NOW,
      internal: {
        beforeDatabaseResult(kind, attempt) {
          if (kind !== "corrupt") return;
          attempts.push(attempt);
          const changedAt = new Date(NOW.getTime() + (attempt + 1) * 60_000);
          utimesSync(dbPath, changedAt, changedAt);
        },
      },
    });

    expect(attempts).toEqual([0, 1]);
    expect(status.status).toBe("degraded");
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_STATUS_OBSERVATION_RACE",
      message: expect.stringContaining("graph database"),
    }));
    expect(status.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SCHEMA_INVALID",
    }));
  });

  it("retries an early structural result when a contained graph symlink is retargeted", async () => {
    const root = temporaryRoot("mex-graph-db-retarget-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const graphPath = await build(root);
    const targetA = join(root, ".mex", "graph-a.db");
    const targetB = join(root, ".mex", "graph-b.db");
    renameSync(graphPath, targetA);
    copyFileSync(targetA, targetB);
    symlinkSync("graph-a.db", graphPath);
    const corrupt = openSqlite(targetA);
    try {
      corrupt.exec("DROP TABLE edges");
    } finally {
      corrupt.close();
    }
    let retargeted = false;

    const status = await inspectGraphStatus({
      projectRoot: root,
      now: NOW,
      internal: {
        beforeDatabaseResult(kind, attempt) {
          if (retargeted || kind !== "corrupt" || attempt !== 0) return;
          unlinkSync(graphPath);
          symlinkSync("graph-b.db", graphPath);
          retargeted = true;
        },
      },
    });

    expect(retargeted).toBe(true);
    expect(status.status).toBe("fresh");
    expect(status.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SCHEMA_INVALID",
    }));
  });

  it("never emits fresh when an atomic save replaces a source path after it is read", async () => {
    const root = temporaryRoot("mex-graph-source-race-");
    source(root, "src/a.ts", "export const a = 1;\n");
    await build(root);
    const replacement = join(root, "src", "a.ts.next");
    writeFileSync(replacement, "export const a = 2;\n");
    let replaced = false;

    const status = await inspectGraphStatus({
      projectRoot: root,
      now: NOW,
      internal: {
        afterSourceRead(path, pass) {
          if (!replaced && pass === "validation" && path === "src/a.ts") {
            replaced = true;
            renameSync(replacement, join(root, "src", "a.ts"));
          }
        },
      },
    });

    expect(replaced).toBe(true);
    expect(status.status).toBe("stale");
    expect(status.changes.modified).toEqual(["src/a.ts"]);
  });

  it("classifies a valid current-schema legacy graph as stale with an adoption command", async () => {
    const root = temporaryRoot();
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.prepare("DELETE FROM project_metadata WHERE key = ?").run(GRAPH_SNAPSHOT_METADATA_KEY);
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("stale");
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SNAPSHOT_LEGACY",
      remediation: [{ label: "Republish graph snapshot", command: "mex graph refresh" }],
    }));
    expect(status.changes.total).toBe(0);
  });

  it("treats malformed, digest-inconsistent, or row-inconsistent snapshot metadata as corrupt", async () => {
    const malformedRoot = temporaryRoot("mex-graph-snapshot-invalid-");
    source(malformedRoot, "src/a.ts", "export const a = 1;\n");
    const malformedPath = await build(malformedRoot);
    const malformedDb = openSqlite(malformedPath);
    try {
      malformedDb.prepare("UPDATE project_metadata SET value = ? WHERE key = ?")
        .run("{", GRAPH_SNAPSHOT_METADATA_KEY);
    } finally {
      malformedDb.close();
    }
    const malformed = await inspect(malformedRoot);
    expect(malformed.status).toBe("corrupt");
    expect(executableRemediations(malformed)).toContain("mex graph rebuild");

    const digestRoot = temporaryRoot("mex-graph-snapshot-digest-");
    source(digestRoot, "src/a.ts", "export const a = 1;\n");
    const digestPath = await build(digestRoot);
    updateSnapshot(digestPath, (snapshot) => ({
      ...snapshot,
      sourceCorpusDigest: "0".repeat(64),
    }));
    const digestMismatch = await inspect(digestRoot);
    expect(digestMismatch.status).toBe("corrupt");
    expect(digestMismatch.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SNAPSHOT_CONTENT_MISMATCH",
    }));
    expect(executableRemediations(digestMismatch)).toContain("mex graph rebuild");

    const inconsistentRoot = temporaryRoot("mex-graph-snapshot-mismatch-");
    source(inconsistentRoot, "src/a.ts", "export const a = 1;\n");
    const inconsistentPath = await build(inconsistentRoot);
    updateSnapshot(inconsistentPath, (snapshot) => ({
      ...snapshot,
      sourceCount: 2,
      parseHealth: { total: 2, ok: 2, partial: 0, failed: 0 },
    }));
    const inconsistent = await inspect(inconsistentRoot);
    expect(inconsistent.status).toBe("corrupt");
    expect(inconsistent.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SNAPSHOT_CONTENT_MISMATCH",
    }));
    expect(executableRemediations(inconsistent)).toContain("mex graph rebuild");
  }, 10_000);

  it("treats missing core tables and duplicate or dangling edges as corrupt", async () => {
    const missingTableRoot = temporaryRoot("mex-graph-missing-table-");
    source(missingTableRoot, "src/a.ts", "export const a = 1;\n");
    const missingTablePath = await build(missingTableRoot);
    const missingTableDb = openSqlite(missingTablePath);
    try {
      missingTableDb.exec("DROP TABLE edges");
    } finally {
      missingTableDb.close();
    }
    const missingTable = await inspect(missingTableRoot);
    expect(missingTable.status).toBe("corrupt");
    expect(missingTable.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SCHEMA_INVALID",
      message: expect.stringContaining("edges"),
    }));

    const invalidEdgesRoot = temporaryRoot("mex-graph-invalid-edges-");
    source(invalidEdgesRoot, "src/a.ts", "export function a(): number { return 1; }\n");
    const invalidEdgesPath = await build(invalidEdgesRoot);
    const invalidEdgesDb = openSqlite(invalidEdgesPath);
    try {
      const node = invalidEdgesDb.prepare("SELECT id FROM nodes ORDER BY id LIMIT 1").get() as { id: string };
      invalidEdgesDb.exec("PRAGMA foreign_keys = OFF");
      invalidEdgesDb.exec("DROP INDEX idx_edges_semantic_callsite");
      invalidEdgesDb.exec("CREATE INDEX idx_edges_semantic_callsite ON edges(source, target, kind)");
      const insertEdge = invalidEdgesDb.prepare(
        "INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)",
      );
      insertEdge.run(node.id, node.id, "test_duplicate", 1, 1);
      insertEdge.run(node.id, node.id, "test_duplicate", 1, 1);
      insertEdge.run("missing-source", node.id, "test_dangling", 2, 1);
    } finally {
      invalidEdgesDb.close();
    }
    const invalidEdges = await inspect(invalidEdgesRoot);
    expect(invalidEdges.status).toBe("corrupt");
    const invariant = invalidEdges.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_INVARIANT_FAILED");
    expect(invariant?.message).toContain("1 duplicate edge group(s)");
    expect(invariant?.message).toContain("1 dangling edge(s)");
  });

  it("requires retrieval triggers and current table columns", async () => {
    const root = temporaryRoot("mex-graph-schema-structure-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DROP TRIGGER nodes_ai");
      db.exec("ALTER TABLE files DROP COLUMN extractor_version");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_SCHEMA_INVALID");
    expect(diagnostic?.message).toContain("missing trigger nodes_ai");
    expect(diagnostic?.message).toContain("missing column files.extractor_version");
  });

  it("rejects an empty current-v4 fingerprint layout with incompatible declared types", async () => {
    const root = temporaryRoot("mex-graph-current-v4-shape-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE lsh_buckets;
        DROP TABLE node_fingerprints;
        CREATE TABLE node_fingerprints (
          ref TEXT PRIMARY KEY,
          node_id TEXT NOT NULL UNIQUE,
          minhash TEXT NOT NULL,
          neighbors TEXT NOT NULL,
          token_count INTEGER NOT NULL
        );
        CREATE TABLE lsh_buckets (
          band INTEGER NOT NULL,
          band_hash TEXT NOT NULL,
          ref TEXT NOT NULL,
          PRIMARY KEY (band, band_hash, ref)
        ) WITHOUT ROWID;
      `);
    } finally {
      db.close();
    }

    const status = await inspect(root);

    expect(status.status).toBe("corrupt");
    expect(status.schemaVersion).toBe(DB_SCHEMA_VERSION);
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SCHEMA_INVALID",
      message: "The current graph schema has incompatible column, key, or generated-table structure.",
    }));
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it("rejects a current-v4 grounding table with a forged scaffold projection", async () => {
    const root = temporaryRoot("mex-graph-current-v4-grounding-");
    source(root, "src/a.ts", "export const a = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec(`
        DROP INDEX idx_grounded_subject;
        DROP INDEX idx_grounded_node;
        DROP TABLE _mex_grounded_source;
        CREATE TABLE _mex_grounded_source (
          subject_kind TEXT NOT NULL DEFAULT 'scaffold',
          subject_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          source TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          scaffold_file TEXT GENERATED ALWAYS AS ('wrong') VIRTUAL,
          PRIMARY KEY (subject_kind, subject_id, node_id)
        );
        CREATE INDEX idx_grounded_node ON _mex_grounded_source(node_id);
        CREATE INDEX idx_grounded_subject ON _mex_grounded_source(subject_kind, subject_id);
      `);
    } finally {
      db.close();
    }

    const status = await inspect(root);

    expect(status.status).toBe("corrupt");
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_SCHEMA_INVALID",
    }));
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it("requires every FTS shadow table used by retrieval and rebuild", async () => {
    const root = temporaryRoot("mex-graph-fts-schema-");
    source(root, "src/a.ts", "export const searchable = 1;\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      // SQLite 3.50+ protects FTS5 shadow tables from direct mutation. Dropping
      // each owning virtual table is the supported, portable way to remove the
      // complete retrieval structure, including every required shadow table.
      db.exec("DROP TABLE nodes_fts");
      db.exec("DROP TABLE source_chunks_fts");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_SCHEMA_INVALID");
    expect(diagnostic?.message).toContain("missing table nodes_fts_config");
    expect(diagnostic?.message).toContain("missing table source_chunks_fts_config");
    expect(diagnostic?.remediation).toBeUndefined();
  });

  it("advertises only isolated rebuild for a conflicting versionless schema", async () => {
    const root = temporaryRoot("mex-graph-versionless-");
    source(root, "src/a.ts", "export const a = 1;\n");
    mkdirSync(join(root, ".mex"), { recursive: true });
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      db.exec("CREATE TABLE nodes(id TEXT)");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_SCHEMA_INVALID");
    expect(diagnostic?.message).toContain("incompatible schema objects");
    expect(diagnostic?.remediation).toBeUndefined();
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it("detects dangling ownership, alias, reference, import, and LSH records", async () => {
    const root = temporaryRoot("mex-graph-relational-invariants-");
    source(root, "src/a.ts", "export function a(): number { return 1; }\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DELETE FROM files");
      db.prepare(
        "INSERT INTO node_aliases (alias_id, canonical_node_id, match_method, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("old-node", "missing-node", "test", 1, NOW.getTime());
      db.prepare(
        `INSERT INTO unresolved_refs (
          ref_key, from_node_id, reference_name, reference_kind, line, col, file_path,
          language, status, target_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("test-ref", "missing-from", "target", "calls", 1, 1, "src/missing.ts", "typescript", "resolved", "missing-target");
      db.prepare(
        `INSERT INTO import_bindings (
          binding_key, file_path, local_name, imported_name, module_specifier, target_id
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("test-binding", "src/missing.ts", "local", "remote", "./missing", "missing-target");
      db.prepare("INSERT INTO lsh_buckets (band, band_hash, ref) VALUES (?, ?, ?)")
        .run(0, 0n, 9_999_999n);
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_INVARIANT_FAILED");
    expect(diagnostic?.message).toContain("node(s) without an owning file");
    expect(diagnostic?.message).toContain("alias(es) without a canonical node");
    expect(diagnostic?.message).toContain("unresolved reference(s) without an owning node");
    expect(diagnostic?.message).toContain("unresolved reference(s) with a dangling target");
    expect(diagnostic?.message).toContain("import binding(s) without an owning file");
    expect(diagnostic?.message).toContain("import binding(s) with a dangling target");
    expect(diagnostic?.message).toContain("malformed LSH bucket owner row(s)");
  });

  it("rejects malformed reachable fingerprints before the reconciler can decode them", async () => {
    const root = temporaryRoot("mex-graph-fingerprint-shape-");
    source(root, "src/a.ts", `
      export function alpha(value: number): number { return value + 1; }
      export function beta(value: number): number { return value * 2; }
      export function gamma(value: number): number { return value - 3; }
      export function delta(value: number): number { return value / 4; }
    `);
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      const rows = db.prepare(
        `SELECT node_id, minhash, neighbors, token_count
         FROM node_fingerprints ORDER BY node_id LIMIT 4`,
      ).all() as Array<{
        node_id: string;
        minhash: Uint8Array;
        neighbors: string;
        token_count: number;
      }>;
      expect(rows).toHaveLength(4);
      const reachable = rows[0]!;
      const baseline: Fingerprint = {
        minhash: decodeMinhash(reachable.minhash),
        neighbors: JSON.parse(reachable.neighbors) as string[],
        tokenCount: reachable.token_count,
      };
      db.prepare("UPDATE node_fingerprints SET minhash = ? WHERE node_id = ?")
        .run(Buffer.alloc(1), reachable.node_id);
      db.prepare("UPDATE node_fingerprints SET minhash = ? WHERE node_id = ?")
        .run("not-a-blob", rows[1]!.node_id);
      db.prepare("UPDATE node_fingerprints SET neighbors = ? WHERE node_id = ?")
        .run("[1]", rows[2]!.node_id);
      db.prepare("UPDATE node_fingerprints SET token_count = -1 WHERE node_id = ?")
        .run(rows[3]!.node_id);

      expect(() => new FingerprintStore(db).lookup(baseline)).toThrow();
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_INVARIANT_FAILED");
    expect(diagnostic?.message).toContain("malformed fingerprint row(s)");
    expect(diagnostic?.remediation).toBeUndefined();
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it("requires one correct LSH hash for every configured fingerprint band", async () => {
    const root = temporaryRoot("mex-graph-fingerprint-bands-");
    source(root, "src/a.ts", `
      export function alpha(value: number): number { return value + 1; }
      export function beta(value: number): number { return value * 2; }
      export function gamma(value: number): number { return value - 3; }
      export function delta(value: number): number { return value / 4; }
    `);
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      const rows = db.prepare(
        "SELECT CAST(ref AS TEXT) AS ref, node_id FROM node_fingerprints ORDER BY node_id LIMIT 4",
      ).all() as Array<{ ref: string; node_id: string }>;
      expect(rows).toHaveLength(4);
      const [missing, outOfRange, wrongHash] = rows;
      db.prepare("DELETE FROM lsh_buckets WHERE ref = ?").run(BigInt(missing!.ref));
      db.prepare(
        "UPDATE lsh_buckets SET band = ? WHERE ref = ? AND band = 0",
      ).run(BANDS, BigInt(outOfRange!.ref));
      db.prepare("UPDATE lsh_buckets SET band_hash = ? WHERE ref = ?")
        .run(0n, BigInt(wrongHash!.ref));
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_INVARIANT_FAILED");
    expect(diagnostic?.message).toContain("missing fingerprint LSH band(s)");
    expect(diagnostic?.message).toContain("out-of-range fingerprint LSH bucket row(s)");
    expect(diagnostic?.message).toContain("fingerprint LSH bucket hash mismatch(es)");
    expect(diagnostic?.remediation).toBeUndefined();
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it.each([
    {
      name: "a fingerprint deleted with its LSH buckets left behind",
      corrupt: "DELETE FROM node_fingerprints WHERE ref = ?",
      expected: "malformed LSH bucket owner row(s)",
    },
    {
      name: "a bucketed fingerprint whose node is missing",
      corrupt: "UPDATE node_fingerprints SET node_id = 'missing-node' WHERE ref = ?",
      expected: "fingerprint(s) without a node",
    },
  ])("classifies $name as corrupt", async ({ corrupt, expected }) => {
    const root = temporaryRoot("mex-graph-orphan-buckets-");
    source(root, "src/a.ts", `
      export function alpha(value: number): number { return value + 1; }
      export function beta(value: number): number { return value * 2; }
    `);
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      const row = db.prepare(
        "SELECT CAST(ref AS TEXT) AS ref FROM node_fingerprints ORDER BY node_id LIMIT 1",
      ).get() as { ref: string } | undefined;
      expect(row).toBeDefined();
      const ref = BigInt(row!.ref);
      const buckets = db.prepare("SELECT COUNT(*) AS count FROM lsh_buckets WHERE ref = ?")
        .get(ref) as { count: number };
      expect(buckets.count).toBe(BANDS);
      db.prepare(corrupt).run(ref);
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_INVARIANT_FAILED");
    expect(diagnostic?.message).toContain(expected);
    expect(executableRemediations(status)).toContain("mex graph rebuild");
  });

  it("skips the structural audit only for the exact audited database path and identity", async () => {
    const root = temporaryRoot("mex-graph-audited-database-");
    source(root, "src/a.ts", "export function a(): number { return 1; }\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("INSERT INTO lsh_buckets (band, band_hash, ref) VALUES (?, ?, ?)")
        .run(0, 0n, 9_999_999n);
    } finally {
      db.close();
    }
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size === 0) rmSync(sidecar, { force: true });
    }
    const canonicalDbPath = resolveContainedGraphDatabasePath(root, dbPath)!;
    const stats = statSync(dbPath);
    const databaseIdentity = JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]);
    const inspectWith = async (auditedDatabase?: { canonicalDbPath: string; databaseIdentity: string }) =>
      (await inspectGraphStatusWithFreshObservation({ projectRoot: root, now: NOW, auditedDatabase })).graphStatus;

    expect((await inspectWith()).status).toBe("corrupt");
    // Vouching for this exact file is what skips the audit; anything else re-audits.
    expect((await inspectWith({ canonicalDbPath, databaseIdentity })).status).toBe("fresh");
    expect((await inspectWith({
      canonicalDbPath,
      databaseIdentity: JSON.stringify([stats.dev, stats.ino, stats.size + 1, stats.mtimeMs, stats.ctimeMs]),
    })).status).toBe("corrupt");
    expect((await inspectWith({
      canonicalDbPath: join(dirname(canonicalDbPath), "other.db"),
      databaseIdentity,
    })).status).toBe("corrupt");
  });

  it("cross-checks node and source-chunk FTS row parity", async () => {
    const root = temporaryRoot("mex-graph-fts-invariants-");
    source(root, "src/a.ts", "export function searchable(): number { return 1; }\n");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      // Use the supported FTS5 control command instead of mutating protected
      // shadow tables directly (which SQLite 3.50+ rejects).
      db.prepare("INSERT INTO nodes_fts(nodes_fts) VALUES (?)").run("delete-all");
      db.prepare("INSERT INTO source_chunks_fts(source_chunks_fts) VALUES (?)").run("delete-all");
    } finally {
      db.close();
    }

    const status = await inspect(root);
    expect(status.status).toBe("corrupt");
    const diagnostic = status.diagnostics.find((entry) => entry.code === "GRAPH_INDEX_INVARIANT_FAILED");
    expect(diagnostic?.message).toContain("node(s) missing from full-text search");
    expect(diagnostic?.message).toContain("source chunk(s) missing from full-text search");
  });

  it("refuses lexical and symlink database escapes without inspecting the external database", async () => {
    const root = temporaryRoot("mex-graph-contained-root-");
    const externalRoot = temporaryRoot("mex-graph-external-db-");
    source(root, "src/local.ts", "export const local = true;\n");
    source(externalRoot, "src/external.ts", "export const external = true;\n");
    const externalDbPath = await build(externalRoot);
    const externalBefore = treeState(externalRoot);

    const lexical = await inspectGraphStatus({
      projectRoot: root,
      dbPath: externalDbPath,
      now: NOW,
    });
    expect(lexical.status).toBe("degraded");
    expect(lexical.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_PATH_OUTSIDE_PROJECT",
    }));
    expect(treeState(externalRoot)).toEqual(externalBefore);

    mkdirSync(join(root, ".mex"), { recursive: true });
    symlinkSync(externalDbPath, join(root, ".mex", "graph.db"));
    const symlinked = await inspect(root);
    expect(symlinked.status).toBe("degraded");
    expect(symlinked.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_PATH_OUTSIDE_PROJECT",
    }));
    expect(treeState(externalRoot)).toEqual(externalBefore);
  });

  it("refuses to hash a supported source symlink whose target escapes the project", async () => {
    const root = temporaryRoot("mex-graph-contained-source-");
    const externalRoot = temporaryRoot("mex-graph-external-source-");
    source(root, "src/local.ts", "export const local = true;\n");
    source(root, "src/escape.ts", "export const formerlyLocal = true;\n");
    source(externalRoot, "secret.ts", "export const secret = true;\n");
    await build(root);
    unlinkSync(join(root, "src", "escape.ts"));
    symlinkSync(join(externalRoot, "secret.ts"), join(root, "src", "escape.ts"));

    const status = await inspect(root);
    expect(status.status).toBe("stale");
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SOURCE_PATH_OUTSIDE_PROJECT",
      path: "src/escape.ts",
    }));
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SOURCE_INSPECTION_INCOMPLETE",
    }));
  });

  it("hashes a supported source symlink whose target stays inside the project", async () => {
    const root = temporaryRoot("mex-graph-internal-source-link-");
    source(root, "src/impl/real.ts", "export const real = true;\n");
    source(root, "src/alias.ts", "export const real = true;\n");
    await build(root);
    unlinkSync(join(root, "src", "alias.ts"));
    symlinkSync(join(root, "src", "impl", "real.ts"), join(root, "src", "alias.ts"));

    const status = await inspect(root);
    expect(status.status).toBe("fresh");
    expect(status.diagnostics.map((diagnostic) => diagnostic.code))
      .not.toContain("GRAPH_SOURCE_PATH_OUTSIDE_PROJECT");
  });

  it("refuses a graph index whose .mex directory junction leads out of the project", async () => {
    const root = temporaryRoot("mex-graph-junction-index-");
    const externalRoot = temporaryRoot("mex-graph-junction-index-external-");
    source(root, "src/a.ts", "export const a = 1;\n");
    await build(root);
    renameSync(join(root, ".mex"), join(externalRoot, ".mex"));
    // "junction" is a Windows directory junction; other platforms ignore the
    // type and create an ordinary directory symlink.
    symlinkSync(join(externalRoot, ".mex"), join(root, ".mex"), "junction");

    const status = await inspect(root);
    expect(status.status).toBe("degraded");
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_PATH_OUTSIDE_PROJECT",
    }));
  });

  it("inspects a graph index whose .mex directory junction stays inside the project", async () => {
    const root = temporaryRoot("mex-graph-contained-junction-index-");
    source(root, "src/a.ts", "export const a = 1;\n");
    await build(root);
    mkdirSync(join(root, "cache"), { recursive: true });
    renameSync(join(root, ".mex"), join(root, "cache", "mex-index"));
    symlinkSync(join(root, "cache", "mex-index"), join(root, ".mex"), "junction");

    const status = await inspect(root);
    expect(status.status).toBe("fresh");
  });

  it("inspects a case-variant project root as the same contained root on a case-insensitive volume", async (context) => {
    const root = temporaryRoot("mex-graph-case-root-");
    source(root, "src/a.ts", "export const a = 1;\n");
    await build(root);
    const variant = join(dirname(root), swapCase(basename(root)));
    if (!existsSync(variant) || statSync(variant).ino !== statSync(root).ino) {
      context.skip();
    }

    const status = await inspectGraphStatus({ projectRoot: variant, now: NOW });
    expect(status.status).toBe("fresh");
  });

  it("suppresses every graph command when branch and rebuild findings coexist with an unsafe source", async () => {
    const root = temporaryRoot("mex-graph-unsafe-remediation-");
    const externalRoot = temporaryRoot("mex-graph-unsafe-remediation-external-");
    source(root, "src/a.ts", "export const a = 1;\n");
    source(externalRoot, "outside.ts", "export const outside = 1;\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Status Test");
    git(root, "config", "user.email", "status@example.invalid");
    writeFileSync(join(root, ".gitignore"), ".mex/graph.db*\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    const dbPath = await build(root);
    const db = openSqlite(dbPath);
    try {
      db.prepare(
        `INSERT INTO project_metadata(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run("rebuild_required", "1", NOW.getTime());
    } finally {
      db.close();
    }
    git(root, "switch", "-qc", "feature/unsafe-input");
    unlinkSync(join(root, "src", "a.ts"));
    symlinkSync(join(externalRoot, "outside.ts"), join(root, "src", "a.ts"));

    const status = await inspect(root);

    expect(status.status).toBe("rebuild_required");
    expect(status.changes.branchChanged).toBe(true);
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_REBUILD_REQUIRED",
    }));
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_BRANCH_CHANGED",
    }));
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SOURCE_INSPECTION_INCOMPLETE",
    }));
    expect(executableRemediations(status)).toEqual([]);
    expect(graphRemediationCommand(status)).toBeUndefined();
  });

  it("tracks exact compiler semantic-input content, disappearance, and negative probes", async () => {
    const root = temporaryRoot("mex-graph-semantic-inputs-");
    const basePath = join(root, "config", "base.json");
    const missingPath = join(root, "config", "optional.json");
    const base = JSON.stringify({ compilerOptions: { strict: true } });
    source(root, "src/a.ts", "export const a: number = 1;\n");
    source(root, "config/base.json", base);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./config/base.json",
      references: [{ path: "./config/optional.json" }],
      include: ["src/**/*.ts"],
    }));
    const dbPath = await build(root);
    const snapshot = readSnapshot(dbPath);

    expect(snapshot.semanticInputs).toContainEqual({
      path: "config/base.json",
      contentHash: createHash("sha256").update(base).digest("hex"),
    });
    expect(snapshot.semanticInputs).toContainEqual({
      path: "config/optional.json",
      contentHash: null,
    });
    expect((await inspect(root)).status).toBe("fresh");

    const changedBase = JSON.stringify({ compilerOptions: { strict: false } });
    writeFileSync(basePath, changedBase);
    const changed = await inspect(root);
    expect(changed.status).toBe("stale");
    expect(changed.changes).toMatchObject({ total: 0, configChanged: true });
    expect(changed.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_CHANGED",
      path: "config/base.json",
      message: expect.stringContaining("changed"),
    }));
    expect(executableRemediations(changed)).toContain("mex graph refresh");

    writeFileSync(basePath, base);
    expect((await inspect(root)).status).toBe("fresh");
    unlinkSync(basePath);
    const disappeared = await inspect(root);
    expect(disappeared.status).toBe("stale");
    expect(disappeared.changes).toMatchObject({ total: 0, configChanged: true });
    expect(disappeared.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_CHANGED",
      path: "config/base.json",
      message: expect.stringContaining("disappeared"),
    }));
    expect(executableRemediations(disappeared)).toContain("mex graph refresh");

    writeFileSync(basePath, base);
    source(root, "config/optional.json", JSON.stringify({ compilerOptions: { noEmit: true } }));
    const appeared = await inspect(root);
    expect(appeared.status).toBe("stale");
    expect(appeared.changes).toMatchObject({ total: 0, configChanged: true });
    expect(appeared.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_CHANGED",
      path: "config/optional.json",
      message: expect.stringContaining("appeared"),
    }));
    expect(executableRemediations(appeared)).toContain("mex graph refresh");
    expect(statSync(missingPath).isFile()).toBe(true);
  });

  it("refuses escaped semantic-input targets without recommending a build that must fail", async () => {
    const root = temporaryRoot("mex-graph-contained-semantic-");
    const externalRoot = temporaryRoot("mex-graph-external-semantic-");
    source(root, "src/a.ts", "export const a: number = 1;\n");
    source(root, "config/base.json", JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./config/base.json",
      include: ["src/**/*.ts"],
    }));
    source(externalRoot, "base.json", JSON.stringify({ compilerOptions: { strict: false } }));
    await build(root);
    unlinkSync(join(root, "config", "base.json"));
    symlinkSync(join(externalRoot, "base.json"), join(root, "config", "base.json"));

    const readPaths: string[] = [];
    const status = await inspectGraphStatus({
      projectRoot: root,
      now: NOW,
      internal: {
        afterSemanticInputRead(path) {
          readPaths.push(path);
        },
      },
    });

    expect(status.status).toBe("stale");
    expect(status.changes).toMatchObject({ total: 0, configChanged: true });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_PATH_OUTSIDE_PROJECT",
      path: "config/base.json",
    }));
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_INSPECTION_INCOMPLETE",
    }));
    expect(readPaths).not.toContain("config/base.json");
    expect(executableRemediations(status)).toEqual([]);
  });

  it("does not treat a negative semantic probe below an escaped ancestor as safely absent", async () => {
    const root = temporaryRoot("mex-graph-negative-probe-escape-");
    const externalRoot = temporaryRoot("mex-graph-negative-probe-external-");
    source(root, "src/a.ts", "export const a: number = 1;\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      references: [{ path: "./probes/optional.json" }],
      include: ["src/**/*.ts"],
    }));
    const dbPath = await build(root);
    expect(readSnapshot(dbPath).semanticInputs).toContainEqual({
      path: "probes/optional.json",
      contentHash: null,
    });
    mkdirSync(join(externalRoot, "probes"), { recursive: true });
    symlinkSync(join(externalRoot, "probes"), join(root, "probes"));

    const status = await inspect(root);

    expect(status.status).toBe("stale");
    expect(status.changes).toMatchObject({ total: 0, configChanged: true });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_PATH_OUTSIDE_PROJECT",
      path: "probes/optional.json",
    }));
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_INSPECTION_INCOMPLETE",
    }));
    expect(executableRemediations(status)).toEqual([]);
  });

  it("never emits fresh when a semantic-input path is atomically replaced after it is read", async () => {
    const root = temporaryRoot("mex-graph-semantic-race-");
    const basePath = join(root, "config", "base.json");
    source(root, "src/a.ts", "export const a: number = 1;\n");
    source(root, "config/base.json", JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      extends: "./config/base.json",
      include: ["src/**/*.ts"],
    }));
    await build(root);
    const replacement = join(root, "config", "base.json.next");
    writeFileSync(replacement, JSON.stringify({ compilerOptions: { strict: false } }));
    let replaced = false;

    const status = await inspectGraphStatus({
      projectRoot: root,
      now: NOW,
      internal: {
        afterSemanticInputRead(path, pass) {
          if (!replaced && pass === "validation" && path === "config/base.json") {
            replaced = true;
            renameSync(replacement, basePath);
          }
        },
      },
    });

    expect(replaced).toBe(true);
    expect(status.status).toBe("stale");
    expect(status.changes).toMatchObject({ total: 0, configChanged: true });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_SEMANTIC_INPUT_CHANGED",
      path: "config/base.json",
    }));
  });

  it("reports config/manifest drift without treating non-source HEAD movement as stale", async () => {
    const root = temporaryRoot();
    source(root, "src/a.ts", "export const a = 1;\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext" } }));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Status Test");
    git(root, "config", "user.email", "status@example.invalid");
    writeFileSync(join(root, ".gitignore"), ".mex/graph.db*\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    await build(root);

    git(root, "commit", "--allow-empty", "-qm", "non-source head movement");
    const headOnly = await inspect(root);
    expect(headOnly.status).toBe("fresh");
    expect(headOnly.changes.branchChanged).toBe(false);
    expect(headOnly.diagnostics).toContainEqual(expect.objectContaining({ code: "GRAPH_INDEX_HEAD_CHANGED" }));

    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }));
    const configChanged = await inspect(root);
    expect(configChanged.status).toBe("stale");
    expect(configChanged.changes).toMatchObject({
      total: 0,
      configChanged: true,
      manifestChanged: true,
      grammarChanged: false,
    });
    expect(configChanged.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_BUILD_MANIFEST_CHANGED",
      remediation: [{ label: "Republish graph with current inputs", command: "mex graph refresh" }],
    }));
  });

  it("detects a branch switch even when HEAD and source bytes are unchanged", async () => {
    const root = temporaryRoot();
    source(root, "src/a.ts", "export const a = 1;\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Status Test");
    git(root, "config", "user.email", "status@example.invalid");
    writeFileSync(join(root, ".gitignore"), ".mex/graph.db*\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    await build(root);
    git(root, "switch", "-qc", "feature/status");

    const status = await inspect(root);
    expect(status.currentRepo.branch).toBe("feature/status");
    expect(status.currentRepo.head).toBe(status.indexedHead);
    expect(status.status).toBe("stale");
    expect(status.changes).toMatchObject({ total: 0, branchChanged: true });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_BRANCH_CHANGED",
      remediation: [{ label: "Republish graph for this branch", command: "mex graph refresh" }],
    }));
  });
});
