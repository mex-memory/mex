import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runImpact, type AgentCommandDeps } from "../src/graph/cli-agent.js";
import { openGraphDatabase } from "../src/graph/db/database.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { MinHashReconciler } from "../src/graph/reconcile-engine.js";
import { WIKI_CORPUS_LIMITS } from "../src/wiki/index/corpus-policy.js";
import { createGroundingGraph, deriveGrounding } from "../src/wiki/grounding/adapter.js";
import { resolveGrounding } from "../src/wiki/grounding/resolve.js";
import { rebuildWikiIndex } from "../src/wiki/index/rebuild.js";
import { knowledgeRecordsFor } from "../src/wiki/cli/for-code.js";

// `impact` reads knowledge links from the committed scaffold (#224). Every
// graph here is built by `mex graph` alone: no setup, sync or ground, so the
// `_mex_grounded_source` cache starts empty, as it does on a fresh clone.

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

interface Built {
  root: string;
  dbPath: string;
  leaf: string;
  parent: string;
}

async function built(prefix: string): Promise<Built> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  mkdirSync(join(root, ".mex", "patterns"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "src", "leaf.ts"), "export function leaf(value: number): number {\n  return value + 1;\n}\n");
  writeFileSync(
    join(root, "src", "parent.ts"),
    "import { leaf } from \"./leaf\";\nexport function parent(): number {\n  return leaf(41);\n}\n",
  );
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  const leaf = engine.searchNodes("leaf").find((node) => node.name === "leaf" && node.kind === "function");
  const parent = engine.searchNodes("parent").find((node) => node.name === "parent" && node.kind === "function");
  engine.close();
  if (!leaf || !parent) throw new Error("fixture nodes missing");
  const dbPath = join(root, ".mex", "graph.db");
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path) && statSync(path).size === 0) rmSync(path, { force: true });
  }
  return { root, dbPath, leaf: leaf.id, parent: parent.id };
}

function entry(node: string): string {
  return `  - node: ${node}\n    fingerprint: mh:64:00\n`;
}

/** A pre-wiki file: `grounds_to` at the frontmatter root. */
function rootShape(name: string, nodes: readonly string[]): string {
  return `---\nname: ${name}\ngrounds_to:\n${nodes.map(entry).join("")}---\n\n# ${name}\n`;
}

/** A file-level wiki entity: groundings under `mex.grounds_to`, and optionally also at the root (#226). */
function mexShape(name: string, id: string, mexNodes: readonly string[], rootNodes: readonly string[] = []): string {
  const mex = mexNodes.map((node) => `    - node: ${node}\n      fingerprint: mh:64:00\n`).join("");
  return `---\nname: ${name}\n` +
    (rootNodes.length > 0 ? `grounds_to:\n${rootNodes.map(entry).join("")}` : "") +
    `mex:\n  id: ${id}\n  type: pattern\n  status: promoted\n  revision: 1\n  title: ${name}\n` +
    (mexNodes.length > 0 ? `  grounds_to:\n${mex}` : "") +
    `---\n\n# ${name}\n\nBody.\n`;
}

async function impact(
  target: string,
  root: string,
  internal?: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const output: string[] = [];
  const deps = { write: (line: string) => output.push(line), ...(internal ? { __internal: internal } : {}) };
  await runImpact(target, root, deps as AgentCommandDeps, options);
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function groundings(records: Record<string, unknown>[]): Array<{ node: unknown; file: unknown }> {
  return records.filter((record) => record.type === "grounding").map(({ node, file }) => ({ node, file }));
}

describe("impact reads committed groundings (#224)", () => {
  it("returns every committed grounding on a graph-only build with an empty cache", async () => {
    const fixture = await built("mex-impact-fresh-clone-");
    writeFileSync(join(fixture.root, ".mex", "context", "architecture.md"), rootShape("architecture", [fixture.leaf]));
    writeFileSync(join(fixture.root, ".mex", "patterns", "callers.md"), rootShape("callers", [fixture.parent]));

    const records = await impact("leaf", fixture.root);

    expect(records.some((record) => record.type === "error")).toBe(false);
    expect(groundings(records)).toEqual([
      { node: fixture.leaf, file: ".mex/context/architecture.md" },
      { node: fixture.parent, file: ".mex/patterns/callers.md" },
    ]);
    expect(records.some((record) => record.type === "grounding-omitted")).toBe(false);
  });

  it("does not return a cached grounding the Markdown no longer declares", async () => {
    const fixture = await built("mex-impact-stale-cache-");
    writeFileSync(join(fixture.root, ".mex", "context", "architecture.md"), rootShape("architecture", [fixture.leaf]));
    // What capture once recorded, before the author removed the grounding.
    const db = openGraphDatabase(fixture.dbPath);
    try {
      new FingerprintStore(db).saveGroundedSource({
        scaffoldFile: ".mex/patterns/removed.md",
        nodeId: fixture.leaf,
        source: "export function leaf() {}",
        bodyHash: "0".repeat(64),
        fingerprint: "mh:64:00",
      });
    } finally {
      db.close();
    }
    writeFileSync(join(fixture.root, ".mex", "patterns", "removed.md"), "---\nname: removed\n---\n\n# Removed\n");

    const records = await impact("leaf", fixture.root);

    expect(groundings(records)).toEqual([{ node: fixture.leaf, file: ".mex/context/architecture.md" }]);
  });

  it("attaches a grounding recorded under a renamed node's old id to the current node", async () => {
    const fixture = await built("mex-impact-alias-");
    const oldId = "function:00000000000000000000000000000001";
    const db = openGraphDatabase(fixture.dbPath);
    try {
      db.prepare(
        `INSERT INTO node_aliases (alias_id, canonical_node_id, match_method, confidence, created_at)
         VALUES (?, ?, 'test', 1, 0)`,
      ).run(oldId, fixture.leaf);
    } finally {
      db.close();
    }
    writeFileSync(join(fixture.root, ".mex", "context", "architecture.md"), rootShape("architecture", [oldId]));

    const records = await impact("leaf", fixture.root);

    expect(groundings(records)).toEqual([{ node: fixture.leaf, file: ".mex/context/architecture.md" }]);
  });

  it("returns root-shape, mex-shape and mixed-shape groundings alike", async () => {
    const fixture = await built("mex-impact-shapes-");
    const scaffold = join(fixture.root, ".mex");
    writeFileSync(join(scaffold, "context", "root.md"), rootShape("root", [fixture.leaf]));
    writeFileSync(join(scaffold, "patterns", "migrated.md"), mexShape("migrated", "mx_01KR2E4K002H3ZYA9G0C4XV531", [fixture.leaf]));
    // Setup's own leftover shape: a `mex` map, with the root key beside it.
    writeFileSync(
      join(scaffold, "patterns", "mixed.md"),
      mexShape("mixed", "mx_01KRMEXM00JAAVJPQVVRX8N56V", [fixture.parent], [fixture.leaf]),
    );

    const records = await impact("leaf", fixture.root);

    expect(groundings(records)).toEqual([
      { node: fixture.leaf, file: ".mex/context/root.md" },
      { node: fixture.leaf, file: ".mex/patterns/migrated.md" },
      { node: fixture.leaf, file: ".mex/patterns/mixed.md" },
      { node: fixture.parent, file: ".mex/patterns/mixed.md" },
    ]);
  });

  it("names a scaffold file over the read bound instead of dropping its links silently", async () => {
    const fixture = await built("mex-impact-oversized-");
    writeFileSync(join(fixture.root, ".mex", "context", "architecture.md"), rootShape("architecture", [fixture.leaf]));
    const oversized = rootShape("oversized", [fixture.leaf]) + "x".repeat(WIKI_CORPUS_LIMITS.maxFileBytes);
    writeFileSync(join(fixture.root, ".mex", "patterns", "oversized.md"), oversized);

    const records = await impact("leaf", fixture.root);

    expect(groundings(records)).toEqual([{ node: fixture.leaf, file: ".mex/context/architecture.md" }]);
    expect(records.filter((record) => record.type === "grounding-omitted")).toEqual([{
      type: "grounding-omitted",
      reason: "scaffold-unreadable",
      files: [".mex/patterns/oversized.md"],
    }]);
    // The omission is a record like any other, admitted before the summary.
    expect(records.at(-1)).toMatchObject({ type: "summary" });
  });

  it("withholds every link when the scaffold changes during the call, and says so", async () => {
    const fixture = await built("mex-impact-scaffold-race-");
    const architecture = join(fixture.root, ".mex", "context", "architecture.md");
    writeFileSync(architecture, rootShape("architecture", [fixture.leaf]));

    const records = await impact("leaf", fixture.root, {
      afterCommittedGroundingRead: () => {
        writeFileSync(architecture, `${readFileSync(architecture, "utf-8")}\nEdited mid-call.\n`);
      },
    });

    expect(groundings(records)).toEqual([]);
    expect(records.filter((record) => record.type === "grounding-omitted")).toEqual([{
      type: "grounding-omitted",
      reason: "scaffold-changed",
      files: [".mex/context/architecture.md"],
    }]);
    // The graph half of the answer is unaffected.
    expect(records.some((record) => record.type === "defines")).toBe(true);
  });

  it("returns the same scaffold files as wiki for-code for each grounded node", async () => {
    const fixture = await built("mex-impact-for-code-");
    const scaffold = join(fixture.root, ".mex");
    const db = openGraphDatabase(fixture.dbPath);
    const engine = createGraphEngine({ rootDir: fixture.root });
    try {
      const seam = createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db);
      const leaf = deriveGrounding(seam, fixture.leaf)!;
      const parent = deriveGrounding(seam, fixture.parent)!;
      const real = (node: string): string => node === fixture.leaf ? leaf.fingerprint : parent.fingerprint;
      const withFingerprints = (text: string): string =>
        text.replace(/node: (\S+)\n(\s+)fingerprint: mh:64:00/g, (_all, node: string, indent: string) =>
          `node: ${node}\n${indent}fingerprint: ${real(node)}`);
      writeFileSync(join(scaffold, "patterns", "migrated.md"),
        withFingerprints(mexShape("migrated", "mx_01KR2E4K002H3ZYA9G0C4XV531", [fixture.leaf])));
      writeFileSync(join(scaffold, "patterns", "mixed.md"),
        withFingerprints(mexShape("mixed", "mx_01KRMEXM00JAAVJPQVVRX8N56V", [fixture.parent], [fixture.leaf])));
      writeFileSync(join(scaffold, "patterns", "callers.md"),
        withFingerprints(mexShape("callers", "mx_01M1M0CJJD2AQZ6XKHV4VKYTGJ", [fixture.parent])));
      rebuildWikiIndex({
        scaffoldRoot: scaffold,
        indexPath: join(scaffold, "wiki.db"),
        resolveGrounding: (grounding) => resolveGrounding(grounding, seam),
      });
    } finally {
      engine.close();
      db.close();
    }

    const records = await impact("leaf", fixture.root);
    for (const node of [fixture.leaf, fixture.parent]) {
      const fromImpact = groundings(records).filter((record) => record.node === node).map((record) => record.file);
      const fromWiki = knowledgeRecordsFor([node], {}, fixture.root).map((record) => `.mex/${record.file}`).sort();
      expect(fromImpact.length).toBeGreaterThan(0);
      expect(fromImpact).toEqual(fromWiki);
    }
  });
});
