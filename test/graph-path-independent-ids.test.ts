import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { generateCanonicalCompilerNodeId } from "../src/graph/extraction/compiler.js";
import { deserializeFingerprint, serializeFingerprint } from "../src/graph/fingerprint.js";
import { rebuildGraph } from "../src/graph/maintenance.js";
import { loadGroundingRuntime, persistMovedGroundings } from "../src/graph/runtime.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import type { CompilerNodeKind } from "../src/graph/extraction/compiler.js";

// TypeScript node ids must be a function of repository content only (#240).
// Compiler-rendered signatures used to print `import("<absolute path>").T`, and
// signatures feed canonical identity, so the same commit produced different ids
// in different checkout directories.

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

/** A home-directory style checkout path that a v2 build would have embedded. */
const OLD_CHECKOUT = "C:/Users/someone/work/app";

// `renderPage` returns a type from another module, so its signature needs an
// import type; it calls only `element`, whose id is unaffected. `renderApp`
// is affected too, and its only neighbour is the affected `renderPage`.
const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src/**/*.ts"],
  }),
  "src/jsx/base.ts": [
    "export namespace JSX { export interface Element { tag: string; children: string[] } }",
    "export function element(tag: string): JSX.Element { return { tag, children: [] }; }",
    "",
  ].join("\n"),
  "src/page.ts": [
    "import { element } from \"./jsx/base\";",
    "export function renderPage(title: string, items: string[]) {",
    "  const heading = element(\"h1\");",
    "  heading.children.push(title.trim());",
    "  const list = element(\"ul\");",
    "  for (const item of items) list.children.push(item.toUpperCase());",
    "  const footer = element(\"footer\");",
    "  footer.children.push(String(items.length));",
    "  return heading.children.length > 0 ? list : footer;",
    "}",
    "",
  ].join("\n"),
  "src/app.ts": [
    "import { renderPage } from \"./page\";",
    "export function renderApp(pages: string[][], title: string) {",
    "  const rendered = pages.map((items, index) => renderPage(`${title} ${index}`, items));",
    "  const visible = rendered.filter((page) => page.children.length > 0);",
    "  const fallback = renderPage(title.toLowerCase(), [String(pages.length)]);",
    "  return visible.length > 0 ? visible[0] : fallback;",
    "}",
    "",
  ].join("\n"),
};

function checkout(parent: string): { root: string; config: MexConfig; scaffold: string } {
  mkdirSync(parent, { recursive: true });
  for (const [path, source] of Object.entries(FILES)) {
    mkdirSync(join(parent, path, ".."), { recursive: true });
    writeFileSync(join(parent, path), source);
  }
  mkdirSync(join(parent, ".mex", "context"), { recursive: true });
  writeFileSync(join(parent, ".mex", "ROUTER.md"), "# Router\n");
  const scaffold = join(parent, ".mex", "context", "architecture.md");
  writeFileSync(scaffold, "---\nname: architecture\n---\n\n# Architecture\n");
  return { root: parent, scaffold, config: { projectRoot: parent, scaffoldRoot: join(parent, ".mex"), aiTools: [] } };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function build(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
  dropEmptySidecars(root);
}

function dropEmptySidecars(root: string): void {
  const dbPath = join(root, ".mex", "graph.db");
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path) && statSync(path).size === 0) rmSync(path, { force: true });
  }
}

function query<T>(root: string, sql: string): T[] {
  const db = openSqlite(join(root, ".mex", "graph.db"), { readOnly: true, immutable: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

interface NodeRow {
  id: string;
  kind: CompilerNodeKind;
  name: string;
  identity_key: string;
  signature: string | null;
  body_hash: string | null;
}

function nodeNamed(root: string, name: string): NodeRow {
  const [row] = query<NodeRow>(
    root,
    `SELECT id, kind, name, identity_key, signature, body_hash FROM nodes WHERE name = '${name}'`,
  );
  if (!row) throw new Error(`fixture node ${name} missing`);
  return row;
}

/** The identity a v2 extractor produced for this node in a checkout at OLD_CHECKOUT. */
function v2Identity(node: NodeRow): { id: string; identityKey: string; signature: string | null } {
  const withPath = (value: string) => value.replaceAll('import("./', `import("${OLD_CHECKOUT}/`);
  const identityKey = withPath(node.identity_key);
  return {
    id: generateCanonicalCompilerNodeId(node.kind, identityKey),
    identityKey,
    signature: node.signature === null ? null : withPath(node.signature),
  };
}

/** Every text value in the graph, table by table, for absolute-path scans. */
function allText(root: string): Array<{ table: string; column: string; value: string }> {
  const tables = query<{ name: string }>(
    root,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%'",
  );
  const values: Array<{ table: string; column: string; value: string }> = [];
  for (const { name: table } of tables) {
    const columns = query<{ name: string }>(root, `PRAGMA table_info("${table}")`);
    for (const { name: column } of columns) {
      const rows = query<{ value: string }>(
        root,
        `SELECT "${column}" AS value FROM "${table}" WHERE typeof("${column}") = 'text'`,
      );
      for (const { value } of rows) values.push({ table, column, value });
    }
  }
  return values;
}

describe("path-independent TypeScript node ids (#240)", () => {
  it("builds identical ids, edges and signatures in two checkout directories", async () => {
    const first = checkout(join(temporaryRoot("mex-ids-a-"), "app"));
    const second = checkout(join(temporaryRoot("mex-ids-b-"), "deeper", "clone", "of", "app"));
    await build(first.root);
    await build(second.root);

    const nodes = (root: string) => query(
      root,
      "SELECT id, kind, qualified_name, file_path, identity_key, signature, return_type FROM nodes ORDER BY id",
    );
    const edges = (root: string) => query(
      root,
      "SELECT source, target, kind, evidence FROM edges ORDER BY source, target, kind, line, col",
    );
    expect(nodes(second.root)).toEqual(nodes(first.root));
    expect(edges(second.root)).toEqual(edges(first.root));
    expect(nodeNamed(first.root, "renderPage").signature)
      .toBe('(title: string, items: string[]): import("./src/jsx/base").JSX.Element');

    for (const { root } of [first, second]) {
      const posixRoot = root.replaceAll("\\", "/");
      const leaks = allText(root).filter(({ value }) => (
        value.includes(root)
        || value.includes(posixRoot)
        || /\b[A-Za-z]:[\\/]/u.test(value)
        || value.includes('import("/')
      ));
      expect(leaks).toEqual([]);
    }
  }, 30_000);

  it("maps old path-bearing ids to the new ids through refresh continuity aliases", async () => {
    const { root, config, scaffold } = checkout(join(temporaryRoot("mex-ids-refresh-"), "app"));
    await build(root);
    const page = nodeNamed(root, "renderPage");
    const app = nodeNamed(root, "renderApp");
    const oldPage = v2Identity(page);
    const oldApp = v2Identity(app);
    expect(oldPage.signature).toContain(`import("${OLD_CHECKOUT}/src/jsx/base")`);

    // Reproduce a graph a v2 extractor published: the same rows under the
    // path-bearing ids, signatures and identity keys.
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const [node, old] of [[page, oldPage], [app, oldApp]] as const) {
        db.prepare("UPDATE nodes SET id = ?, identity_key = ?, signature = ? WHERE id = ?")
          .run(old.id, old.identityKey, old.signature, node.id);
        db.prepare("UPDATE edges SET source = ? WHERE source = ?").run(old.id, node.id);
        db.prepare("UPDATE edges SET target = ? WHERE target = ?").run(old.id, node.id);
        db.prepare("UPDATE node_fingerprints SET node_id = ? WHERE node_id = ?").run(old.id, node.id);
        db.prepare("UPDATE nodes SET container_id = ? WHERE container_id = ?").run(old.id, node.id);
        db.prepare("UPDATE import_bindings SET target_id = ? WHERE target_id = ?").run(old.id, node.id);
        db.prepare("UPDATE unresolved_refs SET from_node_id = ? WHERE from_node_id = ?").run(old.id, node.id);
        db.prepare("UPDATE unresolved_refs SET target_id = ? WHERE target_id = ?").run(old.id, node.id);
        db.prepare("UPDATE node_fingerprints SET neighbors = replace(neighbors, ?, ?)").run(node.id, old.id);
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    dropEmptySidecars(root);

    await rebuildGraph(root);
    const aliases = query<{ alias_id: string; canonical_node_id: string; match_method: string }>(
      root,
      "SELECT alias_id, canonical_node_id, match_method FROM node_aliases ORDER BY alias_id",
    );
    expect(aliases).toEqual(expect.arrayContaining([
      { alias_id: oldPage.id, canonical_node_id: page.id, match_method: "qualified-name" },
      { alias_id: oldApp.id, canonical_node_id: app.id, match_method: "qualified-name" },
    ]));

    // Committed knowledge still holds the old ids; sync's MOVED persistence
    // rewrites both entries and the inline anchor through the aliases.
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [
      { node: oldPage.id, fingerprint: "mh:64:00", bodyHash: page.body_hash! },
      { node: oldApp.id, fingerprint: "mh:64:00", bodyHash: app.body_hash! },
    ]) + `\n[\`renderPage()\`](mex://${oldPage.id})\n`);
    const runtime = await loadGroundingRuntime(config);
    expect(runtime!.graph.getNode(oldPage.id)?.id).toBe(page.id);
    persistMovedGroundings(config, [scaffold], runtime!);
    runtime!.close();

    const content = readFileSync(scaffold, "utf-8");
    expect(extractGroundings(content).map((entry) => entry.node)).toEqual([page.id, app.id]);
    expect(content).toContain(`mex://${page.id}`);
    expect(content).not.toContain(oldPage.id);
    expect(content).not.toContain(oldApp.id);
    const report = await runDriftCheckWithGraphStatus(config);
    expect(report.issues.filter((issue) => issue.code.startsWith("GROUNDING_"))).toEqual([]);
  }, 30_000);

  it("reconciles old ids on a fresh clone by fingerprint, then sync rewrites the MOVED ones", async () => {
    const { root, config, scaffold } = checkout(join(temporaryRoot("mex-ids-clone-"), "app"));
    await build(root);
    const page = nodeNamed(root, "renderPage");
    const app = nodeNamed(root, "renderApp");
    const oldPage = v2Identity(page);
    const oldApp = v2Identity(app);

    // The committed baselines a v2 build wrote: the same token minhash, with
    // any path-bearing neighbour recorded under its old id.
    let runtime = await loadGroundingRuntime(config);
    const oldIds = new Map([[page.id, oldPage.id], [app.id, oldApp.id]]);
    const v2Fingerprint = (id: string) => {
      const current = runtime!.reconciler.getFingerprint(id)!;
      return serializeFingerprint({
        ...current,
        neighbors: current.neighbors.map((neighbor) => oldIds.get(neighbor) ?? neighbor).sort(),
      });
    };
    const pageBaseline = v2Fingerprint(page.id);
    const appBaseline = v2Fingerprint(app.id);
    runtime!.close();
    expect(deserializeFingerprint(appBaseline)!.neighbors).toContain(oldPage.id);

    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [
      { node: oldPage.id, fingerprint: pageBaseline, bodyHash: page.body_hash! },
      { node: oldApp.id, fingerprint: appBaseline, bodyHash: app.body_hash! },
    ]) + `\n[\`renderPage()\`](mex://${oldPage.id})\n`);

    // No graph here has ever held the old ids, so there are no aliases.
    expect(query(root, "SELECT alias_id FROM node_aliases")).toEqual([]);
    let report = await runDriftCheckWithGraphStatus(config);
    // Only the grounds_to entries; an inline anchor's own reconciliation
    // before sync is #229's concern.
    const grounded = report.issues.filter((issue) => issue.message.startsWith("Grounded node"));
    // renderPage's neighbours kept their ids: MOVED rebinds silently. Every
    // neighbour of renderApp was itself path-affected, so the neighbour half of
    // its score is lost and it surfaces as AMBIGUOUS with the right candidate.
    expect(grounded).toEqual([expect.objectContaining({
      code: "GROUNDING_AMBIGUOUS",
      message: expect.stringContaining(`${oldApp.id}; candidate: ${app.id}`),
    })]);

    runtime = await loadGroundingRuntime(config);
    const moved = persistMovedGroundings(config, [scaffold], runtime!);
    runtime!.close();
    expect(moved).toBe(2);
    const content = readFileSync(scaffold, "utf-8");
    expect(extractGroundings(content).map((entry) => entry.node)).toEqual([page.id, oldApp.id]);
    expect(content).toContain(`mex://${page.id}`);
    expect(content).not.toContain(`mex://${oldPage.id}`);
    report = await runDriftCheckWithGraphStatus(config);
    expect(report.issues.filter((issue) => issue.code.startsWith("GROUNDING_")).map((issue) => issue.code))
      .toEqual(["GROUNDING_AMBIGUOUS"]);
  }, 30_000);
});
