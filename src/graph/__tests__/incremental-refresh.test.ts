// ============================================================================
// Incremental refresh convergence (issue #209)
// ============================================================================
//
// Every step applies one edit to a fixture repository and refreshes two stores
// from the same tree: DB-I through the default (incremental) sync and DB-F
// through the full-restage oracle. The complete derived-table dumps must be
// identical after every step. After each sequence the graph is also compared
// with a clean build of a fresh copy of the tree, where only continuity
// aliases (history by design) and path-dependent metadata are excluded.
//
// The edit kinds include the classic incremental-resolution failure: a
// same-named definition appearing or disappearing in a file other than its
// callers, where an indexer that re-resolves only changed files leaves
// unchanged callers bound to the old target.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine, GraphSourceStagingError, type GraphRefreshStrategy } from "../engine-impl.js";
import type { BuildResult } from "../engine.js";
import { diffGraphDumps, dumpGraphDatabase, type GraphDump } from "./graph-dump.js";

type Files = Record<string, string>;

interface Edit {
  name: string;
  apply(root: string): void;
  /** A refresh that must refuse and leave both stores untouched. */
  refuses?: boolean;
  /** The refresh strategy a correct implementation must report. */
  expectMode?: "incremental" | "full";
}

interface Fixture {
  name: string;
  files: Files;
  edits: Edit[];
}

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function writeTree(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function write(path: string, content: string): Edit["apply"] {
  return (root) => writeTree(root, { [path]: content });
}

function remove(path: string): Edit["apply"] {
  return (root) => rmSync(join(root, path));
}

function append(path: string, content: string): Edit["apply"] {
  return (root) => writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + content);
}

function replace(path: string, from: string, to: string): Edit["apply"] {
  return (root) => {
    const before = readFileSync(join(root, path), "utf8");
    if (!before.includes(from)) throw new Error(`Fixture edit did not match ${path}: ${from}`);
    writeFileSync(join(root, path), before.replace(from, to));
  };
}

function all(...steps: Edit["apply"][]): Edit["apply"] {
  return (root) => { for (const step of steps) step(root); };
}

async function refresh(
  root: string,
  dbPath: string,
  strategy: GraphRefreshStrategy,
): Promise<BuildResult | GraphSourceStagingError> {
  const engine = createGraphEngine({
    rootDir: root,
    dbPath,
    __internalRefreshStrategy: strategy,
  } as Parameters<typeof createGraphEngine>[0]);
  try {
    return await engine.sync([]);
  } catch (error) {
    if (error instanceof GraphSourceStagingError) return error;
    throw error;
  } finally {
    engine.close();
  }
}

async function build(root: string, dbPath: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root, dbPath });
  try {
    await engine.build(root);
  } finally {
    engine.close();
  }
}

const EXACT_TABLES = undefined;
/**
 * Another checkout of the same tree: a clean build has no continuity history,
 * and file mtimes and path-dependent metadata belong to its own directory.
 */
const CROSS_TREE_TABLES: (keyof GraphDump)[] = [
  "fileContents", "nodes", "edges", "importBindings", "unresolvedRefs", "fingerprints",
  "lshBuckets", "sourceChunks", "rowDigests", "extractionCache", "sourceChunksFts", "nodesFts",
];

function expectSameGraph(left: string, right: string, tables: (keyof GraphDump)[] | undefined, context: string): void {
  const differences = diffGraphDumps(dumpGraphDatabase(left), dumpGraphDatabase(right), tables);
  expect(differences, context).toEqual([]);
}

interface Harness {
  root: string;
  incrementalDb: string;
  fullDb: string;
  results: Array<{ edit: string; incremental: BuildResult | GraphSourceStagingError }>;
}

async function startHarness(fixture: Fixture): Promise<Harness> {
  const root = tempDir(`mex-incr-${fixture.name}-`);
  const stores = tempDir("mex-incr-stores-");
  writeTree(root, fixture.files);
  const harness: Harness = {
    root,
    incrementalDb: join(stores, "incremental.db"),
    fullDb: join(stores, "full.db"),
    results: [],
  };
  await build(root, harness.incrementalDb);
  await build(root, harness.fullDb);
  expectSameGraph(harness.incrementalDb, harness.fullDb, EXACT_TABLES, `${fixture.name}: initial build`);
  return harness;
}

async function step(harness: Harness, edit: Edit, context: string): Promise<void> {
  // Each refresh is long synchronous compiler work; let the test worker answer
  // its runner between steps.
  await new Promise((resolve) => setImmediate(resolve));
  edit.apply(harness.root);
  const incremental = await refresh(harness.root, harness.incrementalDb, "incremental");
  const full = await refresh(harness.root, harness.fullDb, "full");
  harness.results.push({ edit: edit.name, incremental });
  if (edit.refuses) {
    expect(incremental, `${context}: incremental refusal`).toBeInstanceOf(GraphSourceStagingError);
    expect(full, `${context}: full refusal`).toBeInstanceOf(GraphSourceStagingError);
    expect((incremental as GraphSourceStagingError).failures.map((failure) => failure.code))
      .toEqual((full as GraphSourceStagingError).failures.map((failure) => failure.code));
  } else {
    expect(incremental, `${context}: incremental refresh`).not.toBeInstanceOf(GraphSourceStagingError);
    expect(full, `${context}: full refresh`).not.toBeInstanceOf(GraphSourceStagingError);
    // An edit that changes nothing the graph depends on is a no-op for both.
    // Otherwise the stores carry row digests from their first build, so the
    // incremental refresh must publish as a delta, and the oracle never does.
    if ((full as BuildResult).refresh === undefined) {
      expect((incremental as BuildResult).refresh, `${context}: incremental no-op`).toBeUndefined();
    } else {
      expect((incremental as BuildResult).refresh?.publication, `${context}: incremental publication`).toBe("delta");
      expect((full as BuildResult).refresh?.publication, `${context}: oracle publication`).toBe("full");
    }
  }
  expectSameGraph(harness.incrementalDb, harness.fullDb, EXACT_TABLES, context);
}

async function expectCleanBuildConvergence(harness: Harness, context: string): Promise<void> {
  const fresh = tempDir("mex-incr-clean-");
  cpSync(harness.root, fresh, { recursive: true });
  const cleanDb = join(tempDir("mex-incr-clean-store-"), "clean.db");
  await build(fresh, cleanDb);
  expectSameGraph(harness.incrementalDb, cleanDb, CROSS_TREE_TABLES, `${context}: clean build`);
}

/** Deterministic xorshift PRNG so a failing random sequence replays exactly. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const TS_FIXTURE: Fixture = {
  name: "typescript",
  files: {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
      include: ["src"],
    }, null, 2),
    "package.json": JSON.stringify({ name: "fixture-ts", type: "module" }, null, 2),
    "src/globals.d.ts": "declare global {\n  interface AppInfo { version: string }\n  var appInfo: AppInfo;\n}\nexport {};\n",
    "src/ambient.d.ts": "declare module \"virtual:config\" {\n  export const flag: boolean;\n}\n",
    "src/util/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function scale(value: number, factor: number): number {\n  return value * factor;\n}\n",
    "src/util/format.ts": "export function format(value: number): string {\n  return value.toFixed(2);\n}\n",
    "src/util/index.ts": "export * from \"./math\";\nexport { format } from \"./format\";\n",
    "src/service.ts": "import { add, format } from \"./util\";\nimport { flag } from \"virtual:config\";\n\nexport class Service {\n  total(a: number, b: number): string {\n    return flag ? format(add(a, b)) : \"\";\n  }\n}\n",
    "src/main.ts": "import { Service } from \"./service\";\n\nexport function run(): string {\n  return new Service().total(1, 2) + appInfo.version;\n}\n",
    "src/helpers.ts": "export function helper(input: string): string {\n  return input.trim();\n}\n",
    "src/consumer.ts": "import { helper } from \"./helpers\";\n\nexport function useHelper(): string {\n  return helper(\" value \");\n}\n",
    "src/standalone.ts": "export function lonely(): number {\n  return 42;\n}\n",
    "src/bulk.ts": Array.from({ length: 8 }, (_, index) =>
      `export function bulk${index}(value: number): number {\n  const doubled = value * ${index + 2};\n  return doubled + ${index};\n}\n`).join("\n"),
    "src/bulk-user.ts": "import { bulk0, bulk1 } from \"./bulk\";\n\nexport function useBulk(): number {\n  return bulk0(1) + bulk1(2);\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("src/util/format.ts", "// trailing comment\n"), expectMode: "incremental" },
    { name: "rename function", apply: all(
      replace("src/util/math.ts", "export function scale(", "export function multiply("),
    ), expectMode: "incremental" },
    { name: "change an import", apply: replace("src/consumer.ts", "import { helper } from \"./helpers\";", "import { helper } from \"./helpers2\";"), expectMode: "incremental" },
    { name: "add file", apply: write("src/helpers2.ts", "export function helper(input: string): string {\n  return input.toUpperCase();\n}\n"), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: write("src/shadow.ts", "export function add(a: number, b: number): number {\n  return a - b;\n}\n"), expectMode: "incremental" },
    { name: "move function between files", apply: all(
      replace("src/util/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n", ""),
      append("src/util/format.ts", "\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n"),
    ), expectMode: "incremental" },
    { name: "delete file", apply: remove("src/standalone.ts"), expectMode: "incremental" },
    // Many nodes and fingerprints disappear at once, and an importer whose
    // content is unchanged loses the targets of its bindings and calls.
    { name: "delete a file with many declarations", apply: remove("src/bulk.ts"), expectMode: "incremental" },
    { name: "remove same-named definition in another file", apply: remove("src/shadow.ts"), expectMode: "incremental" },
    { name: "revert import", apply: replace("src/consumer.ts", "from \"./helpers2\"", "from \"./helpers\""), expectMode: "incremental" },
    { name: "change the ambient declaration", apply: replace("src/globals.d.ts", "version: string", "version: string;\n    build: number"), expectMode: "full" },
    // Neither field decides what the compiler resolves, so both are no-ops.
    { name: "change an insignificant tsconfig option", apply: replace("tsconfig.json", "\"strict\": true", "\"strict\": false") },
    { name: "rename the package", apply: replace("package.json", "\"fixture-ts\"", "\"fixture-ts-renamed\"") },
    { name: "change tsconfig", apply: replace("tsconfig.json", "\"target\": \"ES2022\"", "\"target\": \"ES2020\""), expectMode: "full" },
    { name: "change package.json", apply: replace("package.json", "\"type\": \"module\"", "\"type\": \"module\",\n  \"imports\": { \"#util\": \"./src/util/index.ts\" }"), expectMode: "full" },
    { name: "file stops parsing", apply: write("src/helpers.ts", "export function helper(input: string): string {\n  return input.trim(\n}}}} ((( [[[ export const = ;\n"), refuses: true },
    // Not the last published bytes, or the refresh after the refusal is a no-op.
    { name: "file parses again", apply: write("src/helpers.ts", "export function helper(input: string): string {\n  return input.trim().toLowerCase();\n}\n"), expectMode: "incremental" },
    { name: "branch-switch batch", apply: all(
      write("src/util/math.ts", "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n\nexport function scale(value: number, factor: number): number {\n  return value * factor;\n}\n"),
      write("src/feature/index.ts", "import { scale } from \"../util/math\";\n\nexport function feature(): number {\n  return scale(2, 3);\n}\n"),
      write("src/feature/extra.ts", "import { feature } from \"./index\";\n\nexport const extra = feature();\n"),
      remove("src/helpers2.ts"),
      replace("src/consumer.ts", "return helper(\" value \");", "return helper(\" branch \");"),
    ) },
  ],
};

const JS_FIXTURE: Fixture = {
  name: "javascript",
  files: {
    "lib/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "lib/index.js": "import { add } from \"./math.js\";\n\nexport function total(values) {\n  return values.reduce((sum, value) => add(sum, value), 0);\n}\n",
    "lib/legacy.cjs": "const { total } = require(\"./total.cjs\");\n\nfunction legacy() {\n  return total([1, 2]);\n}\n\nmodule.exports = { legacy };\n",
    "lib/total.cjs": "function total(values) {\n  return values.length;\n}\n\nmodule.exports = { total };\n",
    "lib/consumer.js": "import { helper } from \"./helper.js\";\n\nexport function consume() {\n  return helper();\n}\n",
    "lib/helper.js": "export function helper() {\n  return 1;\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("lib/math.js", "// note\n"), expectMode: "incremental" },
    { name: "rename function", apply: all(
      replace("lib/math.js", "export function add(", "export function sum("),
      replace("lib/index.js", "import { add } from", "import { sum as add } from"),
    ), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: write("lib/other.js", "export function helper() {\n  return 2;\n}\n"), expectMode: "incremental" },
    { name: "change a require", apply: replace("lib/legacy.cjs", "require(\"./total.cjs\")", "require(\"./total2.cjs\")") },
    { name: "add required file", apply: write("lib/total2.cjs", "function total(values) {\n  return values.length * 2;\n}\n\nmodule.exports = { total };\n") },
    { name: "delete file", apply: remove("lib/other.js"), expectMode: "incremental" },
  ],
};

const PYTHON_FIXTURE: Fixture = {
  name: "python",
  files: {
    "pkg/__init__.py": "",
    "pkg/a.py": "def helper():\n    return 1\n\n\ndef other():\n    return helper()\n",
    "pkg/b.py": "from pkg.a import helper\n\n\ndef use():\n    return helper()\n\n\ndef bare():\n    return shared()\n",
    "pkg/c.py": "class Widget:\n    def render(self):\n        return 'w'\n",
  },
  edits: [
    { name: "trailing comment", apply: append("pkg/a.py", "# trailing\n"), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: append("pkg/c.py", "\n\ndef helper():\n    return 3\n\n\ndef shared():\n    return 4\n"), expectMode: "incremental" },
    { name: "rename function", apply: replace("pkg/a.py", "def other():", "def another():"), expectMode: "incremental" },
    { name: "move function between files", apply: all(
      replace("pkg/c.py", "\n\ndef shared():\n    return 4\n", ""),
      append("pkg/b.py", "\n\ndef shared():\n    return 5\n"),
    ), expectMode: "incremental" },
    { name: "remove same-named definition in another file", apply: replace("pkg/c.py", "\n\ndef helper():\n    return 3\n", ""), expectMode: "incremental" },
    { name: "add file", apply: write("pkg/d.py", "from pkg.c import Widget\n\n\ndef make():\n    return Widget().render()\n"), expectMode: "incremental" },
    { name: "delete file", apply: remove("pkg/d.py"), expectMode: "incremental" },
  ],
};

const RUST_FIXTURE: Fixture = {
  name: "rust",
  files: {
    "src/lib.rs": "pub mod a;\npub mod b;\n\npub fn root() -> u32 {\n    b::use_it()\n}\n",
    "src/a.rs": "pub fn helper() -> u32 {\n    1\n}\n",
    "src/b.rs": "use crate::a::helper;\n\npub fn use_it() -> u32 {\n    helper()\n}\n",
  },
  edits: [
    { name: "trailing comment", apply: append("src/a.rs", "// trailing\n"), expectMode: "incremental" },
    { name: "add same-named definition in another file", apply: write("src/c.rs", "pub fn helper() -> u32 {\n    2\n}\n"), expectMode: "incremental" },
    { name: "change an import", apply: replace("src/b.rs", "use crate::a::helper;", "use crate::c::helper;"), expectMode: "incremental" },
    { name: "revert", apply: replace("src/b.rs", "use crate::c::helper;", "use crate::a::helper;"), expectMode: "incremental" },
    { name: "delete file", apply: remove("src/c.rs"), expectMode: "incremental" },
  ],
};

const EXPRESS_FIXTURE: Fixture = {
  name: "express",
  files: {
    "package.json": JSON.stringify({ name: "fixture-express", dependencies: { express: "^5.0.0" } }, null, 2),
    "handlers.ts": "export function listUsers(): string {\n  return \"users\";\n}\n\nexport function health(): string {\n  return \"ok\";\n}\n",
    "routes.ts": "import express from \"express\";\nimport { listUsers, health } from \"./handlers\";\n\nconst app = express();\napp.get(\"/users\", listUsers);\napp.get(\"/health\", health);\n\nexport default app;\n",
  },
  edits: [
    { name: "trailing comment", apply: append("handlers.ts", "// trailing\n"), expectMode: "incremental" },
    { name: "add route", apply: replace("routes.ts", "app.get(\"/health\", health);", "app.get(\"/health\", health);\napp.post(\"/users\", listUsers);"), expectMode: "incremental" },
    { name: "rename handler", apply: all(
      replace("handlers.ts", "export function health()", "export function status()"),
      replace("routes.ts", "import { listUsers, health }", "import { listUsers, status as health }"),
    ), expectMode: "incremental" },
    { name: "add same-named handler in another file", apply: write("more.ts", "export function listUsers(): string {\n  return \"more\";\n}\n"), expectMode: "incremental" },
    { name: "delete file", apply: remove("more.ts"), expectMode: "incremental" },
  ],
};

const FIXTURES = [TS_FIXTURE, JS_FIXTURE, PYTHON_FIXTURE, RUST_FIXTURE, EXPRESS_FIXTURE];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("incremental refresh converges with the full-restage oracle", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: every scripted edit kind leaves identical stores`, async () => {
      const harness = await startHarness(fixture);
      for (const [index, edit] of fixture.edits.entries()) {
        await step(harness, edit, `${fixture.name} step ${index + 1} (${edit.name})`);
      }
      await expectCleanBuildConvergence(harness, fixture.name);
    }, 240_000);
  }

  for (const fixture of [TS_FIXTURE, PYTHON_FIXTURE]) {
    it(`${fixture.name}: a seeded random edit order leaves identical stores`, async () => {
      const next = random(209);
      const pool = fixture.edits.filter((edit) => !edit.refuses);
      const harness = await startHarness(fixture);
      for (let index = 0; index < 6; index++) {
        const edit = pool[Math.floor(next() * pool.length)]!;
        // A scripted edit may not apply to every random tree; skip it rather
        // than conflate a fixture mismatch with a convergence failure.
        try {
          await step(harness, edit, `${fixture.name} random step ${index + 1} (${edit.name})`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Fixture edit did not match")) continue;
          throw error;
        }
      }
      await expectCleanBuildConvergence(harness, `${fixture.name} random`);
    }, 240_000);
  }

  it("two incremental histories ending at the same tree produce identical stores", async () => {
    const first = await startHarness(TS_FIXTURE);
    const second = await startHarness(TS_FIXTURE);
    const [comment, rename, , addFile] = TS_FIXTURE.edits;
    for (const edit of [comment!, rename!, addFile!]) await step(first, edit, `history A (${edit.name})`);
    for (const edit of [addFile!, rename!, comment!]) await step(second, edit, `history B (${edit.name})`);
    // Continuity aliases record each history's own id transitions by design.
    expectSameGraph(first.incrementalDb, second.incrementalDb, CROSS_TREE_TABLES, "two histories");
  }, 240_000);
});

// Written before the optimisation landed (issue #209): the incremental path is
// actually taken where it is safe, and the conservative fallbacks (a global
// declaration, any config change) report themselves.
describe("incremental refresh reports its mode", () => {
  it("takes the incremental path for safe edits and the full path for config or global changes", async () => {
    const harness = await startHarness(TS_FIXTURE);
    for (const [index, edit] of TS_FIXTURE.edits.entries()) {
      await step(harness, edit, `mode step ${index + 1} (${edit.name})`);
    }
    for (const [index, edit] of TS_FIXTURE.edits.entries()) {
      const result = harness.results[index]!.incremental;
      if (!edit.expectMode || result instanceof GraphSourceStagingError) continue;
      expect((result as BuildResult & { refresh?: { mode?: string } }).refresh?.mode, edit.name).toBe(edit.expectMode);
    }
  }, 240_000);
});
