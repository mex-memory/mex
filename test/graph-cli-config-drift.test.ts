import { currentGraphPath } from "../src/graph/storage.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCommandDeps } from "../src/graph/cli-agent.js";
import {
  runGraphGet,
  runGraphQuery,
  runGraphScope,
  runImpact,
} from "../src/graph/cli-agent.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../src/graph/snapshot.js";

const roots: string[] = [];
type Rec = Record<string, unknown>;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  targetId: string;
}

/** A two-package workspace, so a dependency bump touches only a config file. */
async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-config-drift-cli-"));
  roots.push(root);
  mkdirSync(join(root, "packages", "api", "src"), { recursive: true });
  mkdirSync(join(root, "packages", "web", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-root", private: true, workspaces: ["packages/*"],
    dependencies: { "some-dependency": "1.0.0" },
  }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
  }));
  for (const name of ["api", "web"]) {
    writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({
      name: `@fixture/${name}`, version: "1.0.0", type: "module",
    }));
  }
  writeFileSync(join(root, "packages", "api", "src", "index.ts"),
    "export function handleRequest(path: string): string {\n  return normalizePath(path);\n}\n"
    + "export function normalizePath(path: string): string {\n  return path.trim();\n}\n");
  writeFileSync(join(root, "packages", "web", "src", "index.ts"),
    "import { handleRequest } from \"../../api/src/index.js\";\n"
    + "export function renderPage(path: string): string {\n  return handleRequest(path);\n}\n");
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  const node = engine.searchNodes("normalizePath").find((entry) => entry.name === "normalizePath");
  if (!node) throw new Error("fixture node missing");
  engine.close();
  return { root, targetId: node.id };
}

/**
 * Change a config field that genuinely affects extraction.
 *
 * A dependency *version* deliberately no longer registers: config inputs are
 * identified by the fields that decide what the compiler resolves. `type` is
 * one of those, so this is drift the graph must notice.
 */
function driftConfig(root: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-root", private: true, type: "commonjs", workspaces: ["packages/*"],
    dependencies: { "some-dependency": "1.0.0" },
  }));
}

function breakEngineIdentity(root: string): void {
  const db = openSqlite(currentGraphPath(root));
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = ?")
      .get(GRAPH_SNAPSHOT_METADATA_KEY) as { value: string };
    const snapshot = parseGraphSnapshot(row.value);
    if (!snapshot) throw new Error("fixture has no snapshot");
    db.prepare("UPDATE project_metadata SET value = ? WHERE key = ?").run(
      serializeGraphSnapshot({ ...snapshot, manifestHash: "0".repeat(64) }),
      GRAPH_SNAPSHOT_METADATA_KEY,
    );
  } finally {
    db.close();
  }
}

async function capture(command: (deps: AgentCommandDeps) => void | Promise<void>): Promise<Rec[]> {
  const output: string[] = [];
  await command({ write: (line) => output.push(line) });
  return output.map((line) => JSON.parse(line) as Rec);
}

const statusRecord = (records: Rec[]): Rec | undefined =>
  records.find((record) => record.type === "status");
const errorRecord = (records: Rec[]): Rec | undefined =>
  records.find((record) => record.type === "error");
const ofType = (records: Rec[], type: string): Rec[] =>
  records.filter((record) => record.type === type);

describe("graph reads after a config-only change", () => {
  it("answers query, get and impact, labelled, instead of refusing", async () => {
    const { root, targetId } = await fixture();
    driftConfig(root);

    const query = await capture((deps) => runGraphQuery("who-calls", "normalizePath", root, deps, {}));
    expect(errorRecord(query)).toBeUndefined();
    expect(statusRecord(query)).toMatchObject({
      graphStatus: "stale",
      reasons: ["config-drift"],
      trusted: ["definitions", "containment", "source"],
      stale: ["resolution", "edges"],
      recoveryCommand: "mex graph refresh",
    });
    const results = ofType(query, "result");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((record) => record.stale === true)).toBe(true);

    const impact = await capture((deps) => runImpact("normalizePath", root, deps, {}));
    expect(errorRecord(impact)).toBeUndefined();
    expect(statusRecord(impact)).toBeDefined();
    expect(ofType(impact, "caller").every((record) => record.stale === true)).toBe(true);
    // A definition is not a resolution outcome and is not labelled.
    expect(ofType(impact, "defines").every((record) => record.stale === undefined)).toBe(true);

    const got = await capture((deps) => runGraphGet([targetId], root, deps, { detail: "source" }));
    expect(errorRecord(got)).toBeUndefined();
    expect(statusRecord(got)).toBeDefined();
    const sources = ofType(got, "source");
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((record) => record.stale === undefined)).toBe(true);
  });

  it("does not label where-defined, which no resolution produced", async () => {
    const { root } = await fixture();
    driftConfig(root);
    const records = await capture((deps) => runGraphQuery("where-defined", "normalizePath", root, deps, {}));
    expect(statusRecord(records)).toBeDefined();
    expect(ofType(records, "result").every((record) => record.stale === undefined)).toBe(true);
  });

  it("answers scope, labelled, on the same gate", async () => {
    const { root } = await fixture();
    driftConfig(root);
    const records = await capture((deps) => runGraphScope("normalize request path", root, deps, {}));
    expect(errorRecord(records)).toBeUndefined();
    expect(statusRecord(records)).toMatchObject({
      graphStatus: "stale",
      reasons: ["config-drift"],
      recoveryCommand: "mex graph refresh",
    });
    const summary = records.find((record) => record.type === "summary");
    expect(summary?.warnings).toContainEqual(expect.stringContaining("build configuration changed"));
  });

  it("keeps answering scope when indexed source drifted, as it always did", async () => {
    const { root } = await fixture();
    writeFileSync(join(root, "packages", "api", "src", "index.ts"),
      "export function normalizePath(path: string): string {\n  return path;\n}\n");
    const records = await capture((deps) => runGraphScope("normalize request path", root, deps, {}));
    expect(errorRecord(records)).toBeUndefined();
    expect(statusRecord(records)).toBeUndefined();
    const health = records.find((record) => record.type === "health");
    expect(health?.staleFiles).toContain("packages/api/src/index.ts");
  });

  it("still refuses every command when engine identity does not match", async () => {
    const { root, targetId } = await fixture();
    driftConfig(root);
    breakEngineIdentity(root);
    const cases: Array<[string, Rec[]]> = [
      ["query", await capture((deps) => runGraphQuery("who-calls", "normalizePath", root, deps, {}))],
      ["impact", await capture((deps) => runImpact("normalizePath", root, deps, {}))],
      ["get", await capture((deps) => runGraphGet([targetId], root, deps, {}))],
      ["scope", await capture((deps) => runGraphScope("normalize request path", root, deps, {}))],
    ];
    for (const [name, records] of cases) {
      expect(statusRecord(records), `${name} must not answer`).toBeUndefined();
      expect(errorRecord(records), `${name} must refuse`).toMatchObject({ type: "error" });
    }
  });

  it("labels scope flow records, not their planning envelope", async () => {
    const { root } = await fixture();
    driftConfig(root);
    const records = await capture((deps) =>
      runGraphScope("render page handle request normalize path", root, deps, { detail: "standard" }));
    const flows = ofType(records, "flow");
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((record) => record.stale === true)).toBe(true);
    expect(flows.every((record) => record.stepCount === undefined)).toBe(true);
  });

  it("answers around a source file that drifted alongside the config", async () => {
    const { root } = await fixture();
    driftConfig(root);
    writeFileSync(join(root, "packages", "api", "src", "index.ts"),
      "export function normalizePath(path: string): string { return path; }");
    const records = await capture((deps) => runGraphQuery("where-defined", "renderPage", root, deps, {}));
    expect(errorRecord(records)).toBeUndefined();
    expect(statusRecord(records)).toMatchObject({
      reasons: ["config-drift", "source-drift"],
      excludedFiles: ["packages/api/src/index.ts"],
    });
    // The answer comes from the file that did not move.
    const results = ofType(records, "result");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((record) => record.filePath === "packages/web/src/index.ts")).toBe(true);
  });

  it("emits nothing extra while the graph is fresh", async () => {
    const { root } = await fixture();
    const records = await capture((deps) => runGraphQuery("who-calls", "normalizePath", root, deps, {}));
    expect(statusRecord(records)).toBeUndefined();
    expect(records.every((record) => record.stale === undefined)).toBe(true);
  });

  it("does not touch the store while reading it drifted", async () => {
    const { root } = await fixture();
    driftConfig(root);
    // The store is the published graph's index folder.
    const mexDir = dirname(currentGraphPath(root));
    const before = readdirSync(mexDir).sort().map((name) => {
      const path = join(mexDir, name);
      return statSync(path).isFile()
        ? { name, bytes: readFileSync(path).toString("base64") }
        : { name, bytes: null };
    });
    await capture((deps) => runGraphQuery("who-calls", "normalizePath", root, deps, {}));
    await capture((deps) => runGraphScope("normalize request path", root, deps, {}));
    const after = readdirSync(mexDir).sort().map((name) => {
      const path = join(mexDir, name);
      return statSync(path).isFile()
        ? { name, bytes: readFileSync(path).toString("base64") }
        : { name, bytes: null };
    });
    expect(after).toEqual(before);
  });

  it("is byte-identical across repeated drifted reads", async () => {
    const { root } = await fixture();
    driftConfig(root);
    const once: string[] = [];
    const twice: string[] = [];
    await runGraphQuery("who-calls", "normalizePath", root, { write: (line) => once.push(line) }, {});
    await runGraphQuery("who-calls", "normalizePath", root, { write: (line) => twice.push(line) }, {});
    expect(twice).toEqual(once);
  });
});
