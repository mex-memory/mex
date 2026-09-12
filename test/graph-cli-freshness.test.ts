import { createHash } from "node:crypto";
import {
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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCommandDeps } from "../src/graph/cli-agent.js";
import { GRAPH_CORPUS_LIMITS } from "../src/graph/corpus-policy.js";
import {
  runGraphGet,
  runGraphQuery,
  runGraphScope,
  runImpact,
} from "../src/graph/cli-agent.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import {
  openImmutableGraphReadSession,
  openImmutableGraphReadSessionSync,
} from "../src/graph/read-session.js";
import { inspectGraphStatusWithFreshObservation } from "../src/graph/status.js";

const roots: string[] = [];

interface Fixture {
  root: string;
  sourcePath: string;
  dbPath: string;
  nodeId: string;
  original: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(prefix: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const sourcePath = join(root, "src", "service.ts");
  const original = "export function stableFact(): string { return \"old\"; }\n";
  writeFileSync(sourcePath, original);
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  const node = engine.searchNodes("stableFact").find((entry) => entry.name === "stableFact");
  if (!node) throw new Error("fixture node missing");
  engine.close();
  const dbPath = join(root, ".mex", "graph.db");
  removeEmptySidecars(dbPath);
  return { root, sourcePath, dbPath, nodeId: node.id, original };
}

async function capture(command: (deps: AgentCommandDeps) => void | Promise<void>): Promise<Record<string, unknown>[]> {
  const output: string[] = [];
  await command({ write: (line) => output.push(line) });
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function internalDeps(
  output: string[],
  internal: Record<string, unknown>,
): AgentCommandDeps {
  return {
    write: (line) => output.push(line),
    __internal: internal,
  } as unknown as AgentCommandDeps;
}

function expectUnavailableOnly(records: Record<string, unknown>[], reason?: string): void {
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    type: "error",
    code: "GRAPH_UNAVAILABLE",
    ...(reason ? { reasonCode: reason } : {}),
  });
  expect(records.some((record) => ["meta", "source", "result", "fact", "summary"].includes(String(record.type))))
    .toBe(false);
}

describe("agent graph freshness-bound readers", () => {
  it("never pairs an old node with changed live source, and excludes that file instead", async () => {
    const built = await fixture("mex-cli-stale-read-");
    const fixed = new Date("2024-01-01T00:00:00.000Z");
    const changed = built.original.replace("\"old\"", "\"new\"");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(built.original));
    writeFileSync(built.sourcePath, changed);
    utimesSync(built.sourcePath, fixed, fixed);

    const get = await capture((deps) => runGraphGet([built.nodeId], built.root, deps));
    const query = await capture((deps) => runGraphQuery(
      "where-defined", "stableFact", built.root, deps, { detail: "source" },
    ));
    const impact = await capture((deps) => runImpact(
      "stableFact", built.root, deps, { detail: "source" },
    ));

    // The invariant is that a node from a changed file is never described,
    // and its live text never returned. The whole repository is one file here,
    // so excluding it leaves nothing to answer from — but the response says
    // which file it excluded rather than only that something was wrong.
    for (const records of [get, query, impact]) {
      const status = records.find((record) => record.type === "status");
      expect(status).toMatchObject({
        graphStatus: "stale",
        reasons: ["source-drift"],
        excludedFiles: ["src/service.ts"],
        recoveryCommand: "mex graph refresh",
      });
      expect(records.some((record) => record.type === "source")).toBe(false);
      expect(records.some((record) => record.type === "result" || record.type === "defines")).toBe(false);
      expect(JSON.stringify(records)).not.toContain("return \\\"new\\\"");
      expect(JSON.stringify(records)).not.toContain("return \\\"old\\\"");
    }
  });

  it("discards a fully prepared Get stream when source changes before final freshness validation", async () => {
    const built = await fixture("mex-cli-mid-source-");
    const output: string[] = [];
    const fixed = new Date("2024-01-01T00:00:00.000Z");
    const changed = built.original.replace("\"old\"", "\"new\"");
    const deps = internalDeps(output, {
      beforeFinalFreshnessValidation() {
        writeFileSync(built.sourcePath, changed);
        utimesSync(built.sourcePath, fixed, fixed);
      },
    });

    await runGraphGet([built.nodeId], built.root, deps);

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expectUnavailableOnly(records, "GRAPH_SOURCE_CORPUS_MISMATCH");
    expect(JSON.stringify(records)).not.toContain("return \\\"old\\\"");
    expect(JSON.stringify(records)).not.toContain("return \\\"new\\\"");
  });

  it("rejects an A-to-B-to-A source ABA even when both freshness observations see A", async () => {
    const built = await fixture("mex-cli-source-aba-");
    const transient = built.original.replace("\"old\"", "\"new\"");
    expect(Buffer.byteLength(transient)).toBe(Buffer.byteLength(built.original));
    const output: string[] = [];
    const observedStatuses: string[] = [];
    let reachedFinalValidation = false;
    const deps = internalDeps(output, {
      freshRead: {
        async inspectObservation(input: Parameters<typeof inspectGraphStatusWithFreshObservation>[0]) {
          const inspection = await inspectGraphStatusWithFreshObservation(input);
          observedStatuses.push(inspection.graphStatus.status);
          return inspection;
        },
        hooks: {
          beforeIndexedSourceRead() {
            writeFileSync(built.sourcePath, transient);
          },
          afterIndexedSourceRead() {
            writeFileSync(built.sourcePath, built.original);
          },
        },
      },
      beforeFinalFreshnessValidation() {
        reachedFinalValidation = true;
      },
    });

    await runGraphGet([built.nodeId], built.root, deps);

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(reachedFinalValidation).toBe(true);
    expect(observedStatuses).toEqual(["fresh", "fresh"]);
    expect(readFileSync(built.sourcePath, "utf8")).toBe(built.original);
    expectUnavailableOnly(records, "GRAPH_SOURCE_CORPUS_MISMATCH");
    expect(JSON.stringify(records)).not.toContain("return \\\"old\\\"");
    expect(JSON.stringify(records)).not.toContain("return \\\"new\\\"");
  });

  it("hands only the bound database identity to the final freshness inspection", async () => {
    const built = await fixture("mex-cli-audited-identity-");
    const output: string[] = [];
    const inputs: Array<Parameters<typeof inspectGraphStatusWithFreshObservation>[0]> = [];
    const inspections: Array<Awaited<ReturnType<typeof inspectGraphStatusWithFreshObservation>>> = [];
    const deps = internalDeps(output, {
      freshRead: {
        async inspectObservation(input: Parameters<typeof inspectGraphStatusWithFreshObservation>[0]) {
          inputs.push(input);
          const inspection = await inspectGraphStatusWithFreshObservation(input);
          inspections.push(inspection);
          return inspection;
        },
      },
    });

    await runGraphGet([built.nodeId], built.root, deps);

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((record) => record.type === "error")).toBe(false);
    expect(inspections.map((inspection) => inspection.graphStatus.status)).toEqual(["fresh", "fresh"]);
    expect(inputs[0]?.auditedDatabase).toBeUndefined();
    const bound = inspections[0]!.freshObservation!;
    expect(inputs[1]?.auditedDatabase).toEqual({
      canonicalDbPath: bound.canonicalDbPath,
      databaseIdentity: bound.databaseIdentity,
    });
  });

  it("re-audits a database rewritten after the fresh observation instead of trusting its identity", async () => {
    const built = await fixture("mex-cli-audited-rewrite-");
    const output: string[] = [];
    const observedStatuses: string[] = [];
    const deps = internalDeps(output, {
      freshRead: {
        async inspectObservation(input: Parameters<typeof inspectGraphStatusWithFreshObservation>[0]) {
          const inspection = await inspectGraphStatusWithFreshObservation(input);
          observedStatuses.push(inspection.graphStatus.status);
          return inspection;
        },
      },
      beforeFinalFreshnessValidation() {
        // An LSH bucket with no fingerprint: a structural fault only the audit
        // can see, written in place so the path stays the same.
        const writer = openSqlite(built.dbPath);
        try {
          writer.exec("PRAGMA foreign_keys = OFF");
          writer.prepare("INSERT INTO lsh_buckets (band, band_hash, ref) VALUES (?, ?, ?)")
            .run(0, 0n, 9_999_999n);
        } finally {
          writer.close();
        }
        removeEmptySidecars(built.dbPath);
        const past = new Date("2024-01-01T00:00:00.000Z");
        utimesSync(built.dbPath, past, past);
      },
    });

    await runGraphGet([built.nodeId], built.root, deps);

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(observedStatuses).toEqual(["fresh", "corrupt"]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "error", code: "GRAPH_UNAVAILABLE" });
    expect(JSON.stringify(records)).not.toContain("return \\\"old\\\"");
  });

  it("rejects a source that crosses the per-file ceiling before the read-session buffer is allocated", async () => {
    const built = await fixture("mex-cli-source-growth-bound-");
    const output: string[] = [];
    const deps = internalDeps(output, {
      freshRead: {
        hooks: {
          beforeIndexedSourceRead() {
            writeFileSync(
              built.sourcePath,
              "x".repeat(GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1),
            );
          },
        },
      },
    });

    await runGraphGet([built.nodeId], built.root, deps);

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expectUnavailableOnly(records, "GRAPH_INDEX_READER_SOURCE_READ_FAILED");
    expect(statSync(built.sourcePath).size).toBe(GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1);
    expect(JSON.stringify(records)).not.toContain("return \\\"old\\\"");
  });

  it("refuses an immutable reader when WAL activity begins after the fresh observation", async () => {
    const built = await fixture("mex-cli-wal-race-");
    const output: string[] = [];
    let writer: ReturnType<typeof openSqlite> | null = null;
    let walSize = 0;
    const deps = internalDeps(output, {
      freshRead: {
        afterStatusInspection() {
          writer = openSqlite(built.dbPath);
          writer.exec("PRAGMA wal_autocheckpoint = 0");
          writer.prepare(
            "UPDATE project_metadata SET updated_at = ? WHERE key = 'manifest_hash'",
          ).run(Date.now());
          walSize = statSync(`${built.dbPath}-wal`).size;
        },
      },
    });

    try {
      await runGraphQuery("where-defined", "stableFact", built.root, deps);
      const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
      expectUnavailableOnly(records, "GRAPH_INDEX_READER_SIDECAR_ACTIVITY");
      expect(walSize).toBeGreaterThan(0);
      expect(statSync(`${built.dbPath}-wal`).size).toBe(walSize);
    } finally {
      writer?.close();
    }
  });

  it("rejects atomic database replacement between identity capture and immutable open", async () => {
    const built = await fixture("mex-cli-db-replace-");
    const replacementPath = join(built.root, ".mex", "replacement.db");
    copyFileSync(built.dbPath, replacementPath);
    const replacementBytes = readFileSync(replacementPath);
    const output: string[] = [];
    const deps = internalDeps(output, {
      freshRead: {
        hooks: {
          afterDatabaseIdentityRead() {
            renameSync(replacementPath, built.dbPath);
          },
        },
      },
    });

    await runGraphGet([built.nodeId], built.root, deps);

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expectUnavailableOnly(records, "GRAPH_INDEX_READER_DATABASE_CHANGED");
    expect(readFileSync(built.dbPath)).toEqual(replacementBytes);
  });

  it("binds SQLite to the inspected database across a path A-to-B-to-A swap", async () => {
    const built = await fixture("mex-cli-db-aba-");
    const originalPath = join(built.root, ".mex", "original.db");
    const forgedPath = join(built.root, ".mex", "forged.db");
    copyFileSync(built.dbPath, forgedPath);
    const forged = openSqlite(forgedPath);
    try {
      const changed = forged.prepare("UPDATE nodes SET name = ? WHERE id = ?")
        .run("forgedFact", built.nodeId);
      expect(changed.changes).toBe(1);
      forged.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      forged.close();
    }
    removeEmptySidecars(forgedPath);

    const session = await openImmutableGraphReadSession(built.root, built.dbPath, {
      deferPostOpenValidation: true,
      afterDatabaseIdentityRead() {
        renameSync(built.dbPath, originalPath);
        renameSync(forgedPath, built.dbPath);
      },
      afterDatabaseOpen() {
        renameSync(built.dbPath, forgedPath);
        renameSync(originalPath, built.dbPath);
      },
    });
    try {
      expect(session.graph.getNode(built.nodeId)?.name).toBe("stableFact");
    } finally {
      session.close();
    }
  });

  it("closes the bound database descriptor on every pre-open failure", async () => {
    const built = await fixture("mex-cli-db-fd-cleanup-");
    const inspection = await inspectGraphStatusWithFreshObservation({
      projectRoot: built.root,
      dbPath: built.dbPath,
    });
    expect(inspection.freshObservation).not.toBeNull();
    let closed = 0;
    const observedClose = () => { closed += 1; };

    await expect(openImmutableGraphReadSession(built.root, built.dbPath, {
      expectedObservation: {
        ...inspection.freshObservation!,
        databaseIdentity: "different-database-identity",
      },
      afterDatabaseDescriptorClose: observedClose,
    })).rejects.toMatchObject({ code: "GRAPH_INDEX_READER_DATABASE_CHANGED" });
    expect(closed).toBe(1);

    await expect(openImmutableGraphReadSession(built.root, built.dbPath, {
      afterDatabaseIdentityRead() {
        throw new Error("injected identity-hook failure");
      },
      afterDatabaseDescriptorClose: observedClose,
    })).rejects.toMatchObject({ code: "GRAPH_INDEX_READER_OPEN_FAILED" });
    expect(closed).toBe(2);

    await expect(openImmutableGraphReadSession(built.root, built.dbPath, {
      inspectSidecars: () => ({ state: "active", paths: ["graph.db-wal"] }),
      afterDatabaseDescriptorClose: observedClose,
    })).rejects.toMatchObject({ code: "GRAPH_INDEX_READER_SIDECAR_ACTIVITY" });
    expect(closed).toBe(3);

    expect(() => openImmutableGraphReadSessionSync(built.root, built.dbPath, {
      inspectSidecars: () => ({ state: "active", paths: ["graph.db-wal"] }),
      afterDatabaseDescriptorClose: observedClose,
    })).toThrow(expect.objectContaining({ code: "GRAPH_INDEX_READER_SIDECAR_ACTIVITY" }));
    expect(closed).toBe(4);
  });

  it("keeps successful production reads and Scope filesystem-read-only", async () => {
    const built = await fixture("mex-cli-readonly-");
    const before = directorySnapshot(join(built.root, ".mex"));
    const sourceBefore = fileIdentity(built.sourcePath);

    const get = await capture((deps) => runGraphGet([built.nodeId], built.root, deps));
    const query = await capture((deps) => runGraphQuery("where-defined", "stableFact", built.root, deps));
    const scope = await capture((deps) => runGraphScope("stableFact", built.root, deps));

    expect(get.some((record) => record.type === "source")).toBe(true);
    expect(query.some((record) => record.type === "result")).toBe(true);
    expect(scope.some((record) => record.type === "source")).toBe(true);
    expect(directorySnapshot(join(built.root, ".mex"))).toEqual(before);
    expect(fileIdentity(built.sourcePath)).toEqual(sourceBefore);
    expect(existsSync(`${built.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${built.dbPath}-shm`)).toBe(false);
  });

  it("uses the indexer's UTF-8 decoding semantics for an invalid source byte", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-cli-invalid-utf8-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    const sourcePath = join(root, "src", "invalid.ts");
    writeFileSync(sourcePath, Buffer.concat([
      Buffer.from("export function invalidUtf8Fact(): string { return \"ok\"; }\n// invalid: "),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]));
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    const node = engine.searchNodes("invalidUtf8Fact")
      .find((entry) => entry.name === "invalidUtf8Fact");
    engine.close();
    expect(node).toBeDefined();
    removeEmptySidecars(join(root, ".mex", "graph.db"));

    const records = await capture((deps) => runGraphGet([node!.id], root, deps));

    expect(records.some((record) => record.type === "source")).toBe(true);
    expect(records.some((record) => record.type === "error")).toBe(false);
  });

  it("does not suggest graph mutation when a missing index has unsafe build prerequisites", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-cli-unsafe-missing-"));
    const external = mkdtempSync(join(tmpdir(), "mex-cli-unsafe-config-"));
    roots.push(root, external);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "entry.ts"), "export const entry = 1;\n");
    writeFileSync(join(external, "package.json"), "{\"name\":\"outside\"}\n");
    const manifestPath = join(root, "package.json");
    symlinkSync(join(external, "package.json"), manifestPath);

    const records = await capture((deps) => runGraphGet(["function:missing"], root, deps));

    expectUnavailableOnly(records);
    expect(records[0]).toMatchObject({ graphStatus: "missing" });
    expect(records[0]).not.toHaveProperty("recoveryCommand");
    unlinkSync(manifestPath);
  });
});

function removeEmptySidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path) && statSync(path).size === 0) rmSync(path, { force: true });
  }
}

function fileIdentity(path: string): Record<string, unknown> {
  const stat = statSync(path);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function directorySnapshot(path: string): Record<string, ReturnType<typeof fileIdentity>> {
  return Object.fromEntries(readdirSync(path).sort().map((name) => [name, fileIdentity(join(path, name))]));
}
