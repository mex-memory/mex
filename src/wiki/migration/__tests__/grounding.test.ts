/**
 * Tier 2 — a grounded scaffold, generated in-test against a real code graph.
 *
 * Tier 1 has no groundings, because a real pre-wiki scaffold has none: the
 * census of one measured zero root `grounds_to`, zero `mex://` anchors and zero
 * `mex` keys. `mex ground` is what writes them. So the whole of section 13.4's
 * grounding migration lives here, where the node ids and `mh:64:` fingerprints
 * are produced by the current extractor rather than hand-typed — a hand-typed
 * fingerprint tests the fixture, not the engine.
 *
 * ## The constraint this tier exists to prove
 *
 * Root `grounds_to` is not inert legacy. `extractGroundings` reads it and
 * `writeGroundings` writes it on every `mex ground` run. Section 13.4 says move
 * it under `mex.grounds_to`, and a naive move produces a file carrying the same
 * grounding in **two** places, maintained by two writers that drift the moment
 * either updates — which is D1's failure arriving through a door D1 did not
 * name, and which also breaks re-apply idempotency, since the second migration
 * run sees a root `grounds_to` again.
 *
 * So: after migration, a `mex ground` run must produce no second record, and a
 * second migration run must be a no-op. Both are asserted below against a real
 * grounding run, not a simulation of one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../../../graph/engine-impl.js";
import { openGraphDatabase } from "../../../graph/db/database.js";
import { FingerprintStore } from "../../../graph/fingerprint-store.js";
import { MinHashReconciler } from "../../../graph/reconcile-engine.js";
import { createGroundingGraph } from "../../grounding/adapter.js";
import { extractGroundings, groundingKeyPath, writeGroundings } from "../../../markdown.js";
import { migrateScaffold } from "../migrate.js";
import { inventoryScaffold } from "../inventory.js";
import type { GroundingGraph } from "../../grounding/adapter.js";

const SOURCE = `export function rotateRefreshToken(userId: string): number {
  const windowSeconds = 3600;
  const attempts = userId.length;
  return attempts * windowSeconds;
}
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows holds SQLite files open a moment past close.
    }
  }
});

interface Project {
  root: string;
  scaffoldRoot: string;
  patternPath: string;
}

/**
 * A single-entity scaffold file carrying a root `grounds_to`.
 *
 * A pattern file, because the classifier makes it exactly one entity — which is
 * the only shape section 13.4 lets a grounding move on. The multi-entity case
 * is tier 3's, and it abstains.
 */
function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "mex-migration-grounding-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "patterns"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), SOURCE, "utf-8");

  const patternPath = join(root, ".mex", "patterns", "rotate-tokens.md");
  writeFileSync(
    patternPath,
    [
      "---",
      "name: rotate-tokens",
      'description: "Rotate a refresh token safely."',
      "triggers:",
      '  - "rotation"',
      "edges:",
      "  - target: context/conventions.md",
      "    condition: when verifying the change",
      "last_updated: 2026-03-14",
      "---",
      "",
      "# Rotate tokens",
      "",
      "## Context",
      "",
      "Use this when a refresh token has to be replaced without ending the",
      "session. The window is fixed and the caller does not choose it, which is",
      "what keeps two rotations from overlapping.",
      "",
    ].join("\n"),
    "utf-8",
  );
  return { root, scaffoldRoot: join(root, ".mex"), patternPath };
}

async function buildGraph(project: Project): Promise<void> {
  const engine = createGraphEngine({ rootDir: project.root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
}

function withGraph<T>(project: Project, body: (graph: GroundingGraph) => T): T {
  const dbPath = join(project.root, ".mex", "graph.db");
  const engine = createGraphEngine({ rootDir: project.root, dbPath });
  const db = openGraphDatabase(dbPath);
  try {
    return body(createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db));
  } finally {
    engine.close();
    db.close();
  }
}

function nodeIdOf(project: Project, name: string): string {
  const engine = createGraphEngine({ rootDir: project.root, dbPath: join(project.root, ".mex", "graph.db") });
  try {
    const node = engine.searchNodes(name).find((entry) => entry.kind === "function");
    if (node === undefined) throw new Error(`no function node named ${name}`);
    return node.id;
  } finally {
    engine.close();
  }
}

/** One grounding as it is on disk, including keys the legacy type does not declare. */
function groundingAt(project: Project, index: number): { node?: string; fingerprint?: string; bodyHash?: string } | undefined {
  const groundings = extractGroundings(readFileSync(project.patternPath, "utf-8")) as unknown as Record<string, string>[];
  return groundings[index];
}

/**
 * The grounding path, shaped the way `src/graph/runtime.ts` shapes it.
 *
 * That matters more than it looks. `runtime.ts` reads the groundings out of the
 * file, **mutates the parsed entries in place**, and splices the same array
 * back. It does not rebuild each entry from `Grounding` in `src/types.ts`,
 * which declares only `node` and `fingerprint` — so a `bodyHash` that migration
 * backfilled survives a re-ground. A helper that constructed a fresh object
 * would silently drop it and this test would then be asserting a behaviour mex
 * does not have. Written the wrong way first, and the assertion caught it.
 */
function runGround(project: Project, nodeId: string): void {
  const fresh = withGraph(project, (graph) => {
    const node = graph.getNode(nodeId);
    const fingerprint = graph.getFingerprint(nodeId);
    if (node === null || fingerprint === null) throw new Error("graph produced no node");
    return { node: node.id, fingerprint };
  });
  const before = readFileSync(project.patternPath, "utf-8");
  const groundings = extractGroundings(before);
  const existing = groundings.find((entry) => entry.node === fresh.node);
  if (existing === undefined) groundings.push(fresh);
  else existing.fingerprint = fresh.fingerprint;
  writeFileSync(project.patternPath, writeGroundings(before, groundings), "utf-8");
}

describe("tier 2 — a grounded scaffold, migrated", () => {
  it("moves the grounding under `mex:`, and a later `mex ground` writes no second record", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "rotateRefreshToken");

    // A pre-wiki scaffold: `mex ground` has run, so the root key exists.
    runGround(project, nodeId);
    const grounded = readFileSync(project.patternPath, "utf-8");
    expect(groundingKeyPath(grounded)).toEqual(["grounds_to"]);
    expect(extractGroundings(grounded).length).toBe(1);
    expect(/^grounds_to:/m.test(grounded)).toBe(true);

    const report = withGraph(project, (graph) =>
      migrateScaffold({ scaffoldRoot: project.scaffoldRoot, graph }),
    );
    expect(report.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(report.groundingsMoved).toBe(1);
    expect(report.groundingsAmbiguous).toBe(0);

    const migrated = readFileSync(project.patternPath, "utf-8");
    // Moved, not copied: the root key is gone and the values are under `mex:`.
    expect(/^grounds_to:/m.test(migrated), "the root key survived the move").toBe(false);
    expect(groundingKeyPath(migrated)).toEqual(["mex", "grounds_to"]);
    expect(extractGroundings(migrated).length).toBe(1);
    expect(extractGroundings(migrated)[0]?.node).toBe(nodeId);

    // **The constraint.** A real grounding run against the migrated file finds
    // the values where they now live and writes them back to the same place.
    runGround(project, nodeId);
    const reGrounded = readFileSync(project.patternPath, "utf-8");
    expect(/^grounds_to:/m.test(reGrounded), "mex ground wrote a second, root-level record").toBe(false);
    expect(extractGroundings(reGrounded).length).toBe(1);
    // Counted over the whole file, so a copy anywhere is caught, not just at the root.
    expect((reGrounded.match(/grounds_to:/g) ?? []).length).toBe(1);

    // And a second migration is a no-op.
    const again = withGraph(project, (graph) =>
      migrateScaffold({ scaffoldRoot: project.scaffoldRoot, graph }),
    );
    expect(again.idsGenerated).toEqual([]);
    expect(readFileSync(project.patternPath, "utf-8")).toBe(reGrounded);
  }, 180_000);

  it("backfills a bodyHash the graph can re-derive, and invents none it cannot", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "rotateRefreshToken");
    runGround(project, nodeId);

    // A pre-P4 grounding carries `node` and `fingerprint` only (section 8.7),
    // so drift against it can only ever be structural — finding 39.
    expect(groundingAt(project, 0)?.bodyHash).toBeUndefined();

    withGraph(project, (graph) => migrateScaffold({ scaffoldRoot: project.scaffoldRoot, graph }));
    const moved = groundingAt(project, 0);
    expect(moved?.bodyHash, "the graph could re-derive this and migration did not take it").toMatch(/^[0-9a-f]{64}$/);

    // And a later `mex ground` does not strip it. `Grounding` in src/types.ts
    // declares only `node` and `fingerprint`, so a run that rebuilt each entry
    // from the type would silently drop the backfill and return every migrated
    // grounding to the coarser structural comparator. It mutates the parsed
    // objects in place instead — asserted here rather than assumed, because the
    // type says otherwise and nothing else would notice.
    runGround(project, nodeId);
    expect(groundingAt(project, 0)?.bodyHash).toBe(moved?.bodyHash);
  }, 180_000);

  it("backfills the body the grounding was made against, not the code as it is now (#232)", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "rotateRefreshToken");
    runGround(project, nodeId);
    const committed = groundingAt(project, 0)!;
    const original = withGraph(project, (graph) => graph.getNode(nodeId)!.bodyHash!);

    // A constant edit: the fingerprint cannot see it, the body hash can.
    writeFileSync(join(project.root, "src", "auth.ts"), SOURCE.replace("3600", "7200"), "utf-8");
    await buildGraph(project);
    const current = withGraph(project, (graph) => graph.getNode(nodeId)!.bodyHash!);
    expect(current).not.toBe(original);

    // The baseline `mex ground` cached when the grounding was made.
    const db = openGraphDatabase(join(project.root, ".mex", "graph.db"));
    try {
      new FingerprintStore(db).saveBaseline({
        subject: { kind: "scaffold", id: ".mex/patterns/rotate-tokens.md" },
        nodeId,
        source: SOURCE,
        bodyHash: original,
        fingerprint: committed.fingerprint!,
      });
    } finally {
      db.close();
    }

    withGraph(project, (graph) => migrateScaffold({ scaffoldRoot: project.scaffoldRoot, graph }));
    // The drift since grounding survives migration rather than being adopted.
    expect(groundingAt(project, 0)?.bodyHash).toBe(original);
  }, 180_000);

  it("writes no bodyHash when neither a cached baseline nor the structure vouches for one (#232)", async () => {
    const project = createProject();
    await buildGraph(project);
    const nodeId = nodeIdOf(project, "rotateRefreshToken");
    runGround(project, nodeId);

    // A structural rewrite, with no cached baseline to say what it was before.
    writeFileSync(
      join(project.root, "src", "auth.ts"),
      SOURCE.replace(
        "return attempts * windowSeconds;",
        "if (attempts > 3) throw new Error(\"too many\");\n  return attempts * windowSeconds * 2;",
      ),
      "utf-8",
    );
    await buildGraph(project);
    expect(nodeIdOf(project, "rotateRefreshToken")).toBe(nodeId);

    withGraph(project, (graph) => migrateScaffold({ scaffoldRoot: project.scaffoldRoot, graph }));
    const grounding = groundingAt(project, 0);
    expect(grounding?.node).toBe(nodeId);
    expect(grounding?.bodyHash).toBeUndefined();
  }, 180_000);

  it("moves nothing, and reports it, when no graph is available", async () => {
    const project = createProject();
    await buildGraph(project);
    runGround(project, nodeIdOf(project, "rotateRefreshToken"));

    const report = migrateScaffold({ scaffoldRoot: project.scaffoldRoot });
    expect(report.groundingsMoved).toBe(1);
    const grounding = groundingAt(project, 0);
    // Moved without a graph, so no body hash is invented. A wrong one is what
    // every future drift verdict would be measured against.
    expect(grounding?.bodyHash).toBeUndefined();
    expect(grounding?.node).toBeDefined();
  }, 180_000);

  it("leaves the prose untouched while the grounding moves", async () => {
    const project = createProject();
    await buildGraph(project);
    runGround(project, nodeIdOf(project, "rotateRefreshToken"));
    const before = readFileSync(project.patternPath, "utf-8");

    withGraph(project, (graph) => migrateScaffold({ scaffoldRoot: project.scaffoldRoot, graph }));
    const after = readFileSync(project.patternPath, "utf-8");

    const prose = (text: string): string => text.slice(text.indexOf("\n---", 3) + 4);
    expect(prose(after)).toBe(prose(before));
    // The edges key is untouched too: shipped drift checkers walk it.
    expect(after).toContain("  - target: context/conventions.md");
    expect(after).toContain("    condition: when verifying the change");
    // And the file is a wiki entity now.
    const inventory = inventoryScaffold({ scaffoldRoot: project.scaffoldRoot });
    expect(inventory.files.flatMap((file) => file.parsed.entities).length).toBe(1);
  }, 180_000);
});
