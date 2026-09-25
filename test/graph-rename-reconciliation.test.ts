import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DriftIssue, Grounding, MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { openGraphDatabase } from "../src/graph/db/database.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { rebuildGraph } from "../src/graph/maintenance.js";
import { MinHashReconciler } from "../src/graph/reconcile-engine.js";
import { loadGroundingRuntime, persistMovedGroundings } from "../src/graph/runtime.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { createGroundingGraph } from "../src/wiki/grounding/adapter.js";
import { resolveGrounding } from "../src/wiki/grounding/resolve.js";

// Renames reported as GROUNDING_GONE (#229): small functions, whose body is
// too small to recognise across a rename, and inline anchors, which ignored
// the committed fingerprint of the same node.

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can hold a SQLite handle briefly after close.
    }
  }
});

type Names = readonly [string, string, string];

/** 1-, 2- and 3-line wrappers of one core function, each with two callers of its own. */
function typescript([one, two, three]: Names, threeBody = "(await observe(options)).graphStatus"): Record<string, string> {
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
      include: ["src/**/*.ts"],
    }),
    "src/core.ts": [
      "export interface Options { root: string; verbose: boolean }",
      "export interface Observation { graphStatus: string; fresh: boolean; count: number }",
      "export async function observe(options: Options): Promise<Observation> {",
      "  const count = options.root.length;",
      "  return { graphStatus: options.verbose ? \"ok\" : \"quiet\", fresh: count > 0, count };",
      "}",
      "",
    ].join("\n"),
    "src/wrap.ts": [
      "import { observe, type Options } from \"./core\";",
      `export const ${one} = (options: Options) => observe(options);`,
      `export async function ${two}(options: Options) {`,
      "  return (await observe(options)).fresh; }",
      `export async function ${three}(options: Options) {`,
      `  return ${threeBody};`,
      "}",
      "",
    ].join("\n"),
    "src/use.ts": [
      `import { ${one}, ${two}, ${three} } from "./wrap";`,
      `export async function oneA() { return ${one}({ root: "a", verbose: true }); }`,
      `export async function oneB() { return ${one}({ root: "b", verbose: false }); }`,
      `export async function twoA() { return ${two}({ root: "a", verbose: true }); }`,
      `export async function twoB() { return ${two}({ root: "b", verbose: false }); }`,
      `export async function threeA() { return ${three}({ root: "a", verbose: true }); }`,
      `export async function threeB() { return ${three}({ root: "b", verbose: false }); }`,
      "",
    ].join("\n"),
  };
}

function python([one, two, three]: Names): Record<string, string> {
  return {
    "core.py": [
      "def observe(options):",
      "    count = len(options['root'])",
      "    return {'graph_status': 'ok' if options['verbose'] else 'quiet', 'fresh': count > 0}",
      "",
    ].join("\n"),
    "wrap.py": [
      "from core import observe",
      `def ${one}(options): return observe(options)`,
      `def ${two}(options):`,
      "    return observe(options)['fresh']",
      `def ${three}(options):`,
      "    result = observe(options)",
      "    return result['graph_status']",
      "",
    ].join("\n"),
    "use.py": [
      `from wrap import ${one}, ${two}, ${three}`,
      `def one_a(): return ${one}({'root': 'a', 'verbose': True})`,
      `def one_b(): return ${one}({'root': 'b', 'verbose': False})`,
      `def two_a(): return ${two}({'root': 'a', 'verbose': True})`,
      `def two_b(): return ${two}({'root': 'b', 'verbose': False})`,
      `def three_a(): return ${three}({'root': 'a', 'verbose': True})`,
      `def three_b(): return ${three}({'root': 'b', 'verbose': False})`,
      "",
    ].join("\n"),
  };
}

/** A normal-sized function with a grounds_to entry and an inline anchor (the issue's scenario 2). */
function summarizer(name: string): Record<string, string> {
  return {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
    "src/summary.ts": [
      `export function ${name}(values: number[], label: string): string {`,
      "  const total = values.reduce((sum, value) => sum + value, 0);",
      "  const average = values.length === 0 ? 0 : total / values.length;",
      "  const highest = values.length === 0 ? 0 : Math.max(...values);",
      "  return `${label}: total ${total}, average ${average.toFixed(2)}, highest ${highest}`;",
      "}",
      "",
    ].join("\n"),
  };
}

function project(files: Record<string, string>): MexConfig {
  const root = mkdtempSync(join(tmpdir(), "mex-229-"));
  roots.push(root);
  write(root, files);
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  return { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] };
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), source);
  }
}

async function build(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/** A teammate's fresh clone: no graph at all, then a full build. */
async function freshBuild(root: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, ".mex", `graph.db${suffix}`), { force: true });
  await build(root);
}

function withGraph<T>(root: string, body: (db: ReturnType<typeof openGraphDatabase>) => T): T {
  const db = openGraphDatabase(join(root, ".mex", "graph.db"));
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** The committed `grounds_to` entry `mex graph ground` would write for the node named `name`. */
function grounding(root: string, name: string): Grounding {
  return withGraph(root, (db) => {
    const row = db.prepare("SELECT id, body_hash FROM nodes WHERE name = ?").get(name) as
      { id: string; body_hash: string } | undefined;
    if (!row) throw new Error(`fixture node ${name} missing`);
    const fingerprint = new FingerprintStore(db).get(row.id);
    if (!fingerprint) throw new Error(`fixture node ${name} has no fingerprint`);
    return { node: row.id, fingerprint: serializeFingerprint(fingerprint), bodyHash: row.body_hash };
  });
}

function nodeId(root: string, name: string): string {
  return withGraph(root, (db) => (db.prepare("SELECT id FROM nodes WHERE name = ?").get(name) as { id: string }).id);
}

function scaffold(config: MexConfig, file: string, entries: Grounding[], anchors: string[] = []): string {
  const path = join(config.scaffoldRoot, "context", file);
  const body = `---\nname: ${file.replace(".md", "")}\n---\n\n# Notes\n`
    + anchors.map((id) => `\nSee [the code](mex://${id}).\n`).join("");
  writeFileSync(path, entries.length > 0 ? writeGroundings(body, entries) : body);
  return path;
}

async function groundingIssues(config: MexConfig): Promise<DriftIssue[]> {
  const report = await runDriftCheckWithGraphStatus(config);
  return report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"));
}

/** What `check` concluded about one old id: the verdict and, for a match, the candidate. */
function verdict(issues: readonly DriftIssue[], oldId: string, anchor = false): string {
  const own = issues.filter((issue) => issue.message.includes(oldId)
    && issue.message.startsWith("Inline anchor") === anchor);
  if (own.some((issue) => issue.code === "GROUNDING_GONE")) return "GONE";
  const ambiguous = own.find((issue) => issue.code === "GROUNDING_AMBIGUOUS");
  if (ambiguous) return `AMBIGUOUS ${/candidate: (\S+)/u.exec(ambiguous.message)?.[1] ?? ""}`.trim();
  const moved = own.find((issue) => issue.code === "GROUNDING_DRIFT" && issue.message.includes("candidate: "));
  if (moved) return `MOVED ${/candidate: (\S+)/u.exec(moved.message)![1]}`;
  return own.length === 0 && !anchor ? "MOVED silently" : own.map((issue) => issue.code).join(",");
}

describe("small functions renamed with their bodies unchanged (#229)", () => {
  for (const [language, files, before, after] of [
    ["TypeScript", typescript, ["wrapOne", "wrapTwo", "inspectGraphStatus"], ["callOne", "callTwo", "readGraphStatus"]],
    ["Python", python, ["wrap_one", "wrap_two", "wrap_three"], ["call_one", "call_two", "call_three"]],
  ] as const) {
    for (const rebuild of ["fresh build", "refresh"] as const) {
      it(`reconciles 1-, 2- and 3-line ${language} wrappers as MOVED after a ${rebuild}`, async () => {
        const config = project(files(before));
        await build(config.projectRoot);
        const entries = before.map((name) => grounding(config.projectRoot, name));
        scaffold(config, "wrappers.md", entries);

        write(config.projectRoot, files(after));
        if (rebuild === "refresh") await rebuildGraph(config.projectRoot);
        else await freshBuild(config.projectRoot);

        const issues = await groundingIssues(config);
        expect(entries.map((entry) => verdict(issues, entry.node)))
          .toEqual(after.map((name) => `MOVED ${nodeId(config.projectRoot, name)}`));
      }, 60_000);
    }
  }

  it("reconciles a small function renamed and edited as MOVED, and reports the edit", async () => {
    const config = project(typescript(["wrapOne", "wrapTwo", "inspectGraphStatus"]));
    await build(config.projectRoot);
    const entry = grounding(config.projectRoot, "inspectGraphStatus");
    scaffold(config, "wrappers.md", [entry]);

    write(config.projectRoot, typescript(
      ["wrapOne", "wrapTwo", "readGraphStatus"],
      "(await observe(options)).graphStatus.trim()",
    ));
    await freshBuild(config.projectRoot);

    // Its callers and callee are unchanged and its shape is close, so this is
    // the same function; the GROUNDING_DRIFT carrying the candidate is what
    // tells the reader the body moved on.
    const issues = await groundingIssues(config);
    expect(verdict(issues, entry.node)).toBe(`MOVED ${nodeId(config.projectRoot, "readGraphStatus")}`);
    expect(issues.find((issue) => issue.message.includes(entry.node))?.message)
      .toMatch(/^Grounded node body changed:/u);
  }, 60_000);
});

describe("inline anchors reconcile from the committed fingerprint (#229)", () => {
  it("gives an anchor and a grounds_to entry for the same node the same verdict on a fresh build", async () => {
    const config = project(summarizer("summarize"));
    await build(config.projectRoot);
    const entry = grounding(config.projectRoot, "summarize");
    scaffold(config, "summary.md", [entry], [entry.node]);

    write(config.projectRoot, summarizer("describeValues"));
    await freshBuild(config.projectRoot);

    const issues = await groundingIssues(config);
    const moved = `MOVED ${nodeId(config.projectRoot, "describeValues")}`;
    expect(verdict(issues, entry.node)).toBe(moved);
    expect(verdict(issues, entry.node, true)).toBe(moved);
  }, 60_000);

  it("uses a committed entry for the node in another scaffold file", async () => {
    const config = project(summarizer("summarize"));
    await build(config.projectRoot);
    const entry = grounding(config.projectRoot, "summarize");
    scaffold(config, "grounded.md", [entry]);
    scaffold(config, "linked.md", [], [entry.node]);

    write(config.projectRoot, summarizer("describeValues"));
    await freshBuild(config.projectRoot);

    const issues = await groundingIssues(config);
    const linked = issues.filter((issue) => issue.file.endsWith("linked.md"));
    expect(verdict(linked, entry.node, true)).toBe(`MOVED ${nodeId(config.projectRoot, "describeValues")}`);
  }, 60_000);

  it("reports AMBIGUOUS when other scaffold files commit different fingerprints for the node", async () => {
    const config = project({
      ...summarizer("summarize"),
      "src/other.ts": "export function unrelated(a: number, b: number): number {\n  return a > b ? a - b : b - a;\n}\n",
    });
    await build(config.projectRoot);
    const entry = grounding(config.projectRoot, "summarize");
    const other = grounding(config.projectRoot, "unrelated");
    scaffold(config, "grounded.md", [entry]);
    scaffold(config, "stale.md", [{ ...entry, fingerprint: other.fingerprint }]);
    scaffold(config, "linked.md", [], [entry.node]);

    write(config.projectRoot, summarizer("describeValues"));
    await freshBuild(config.projectRoot);

    const issues = await groundingIssues(config);
    const linked = issues.filter((issue) => issue.file.endsWith("linked.md"));
    expect(linked).toEqual([expect.objectContaining({
      code: "GROUNDING_AMBIGUOUS",
      message: `Inline anchor has conflicting committed fingerprints in other scaffold files: ${entry.node}`,
    })]);
  }, 60_000);
});

describe("one verdict for one renamed node in every reader (#229)", () => {
  it("agrees across check, the Wiki resolution and sync, which rewrites both references", async () => {
    const config = project(typescript(["wrapOne", "wrapTwo", "inspectGraphStatus"]));
    await build(config.projectRoot);
    const entry = grounding(config.projectRoot, "inspectGraphStatus");
    const path = scaffold(config, "wrappers.md", [entry], [entry.node]);

    write(config.projectRoot, typescript(["wrapOne", "wrapTwo", "readGraphStatus"]));
    await freshBuild(config.projectRoot);
    const renamed = nodeId(config.projectRoot, "readGraphStatus");

    const issues = await groundingIssues(config);
    expect(verdict(issues, entry.node)).toBe(`MOVED ${renamed}`);
    expect(verdict(issues, entry.node, true)).toBe(`MOVED ${renamed}`);

    const wiki = withGraph(config.projectRoot, (db) => {
      const engine = createGraphEngine({ rootDir: config.projectRoot, dbPath: join(config.projectRoot, ".mex", "graph.db") });
      try {
        const graph = createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db);
        return resolveGrounding({ ...entry, bodyHash: entry.bodyHash! }, graph);
      } finally {
        engine.close();
      }
    });
    expect(wiki).toMatchObject({ resolvedNode: renamed, rebound: true });

    const runtime = await loadGroundingRuntime(config);
    expect(persistMovedGroundings(config, [path], runtime!)).toBe(2);
    runtime!.close();
    const content = readFileSync(path, "utf-8");
    expect(extractGroundings(content).map((grounded) => grounded.node)).toEqual([renamed]);
    expect(content).toContain(`mex://${renamed}`);
    expect(content).not.toContain(entry.node);
    expect(existsSync(path)).toBe(true);
  }, 60_000);
});
