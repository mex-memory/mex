/**
 * §20.5 — the grounding integration test, against a real temporary code graph.
 *
 * No stubs. A real repository on disk, a real tree-sitter/compiler extraction,
 * real fingerprints, real Markdown, and a real wiki index. The unit tests
 * around `resolveGrounding` decide what a reconciliation *outcome* means; this
 * decides whether the outcomes ever happen, which is a different question and
 * the one a user actually meets.
 *
 * The ten steps the spec lists are each named below. Two of them carry most of
 * the weight:
 *
 * **Step 9** — delete `wiki.db`, rebuild, and drift is still detected. That is
 * the disposability claim with teeth: the canonical reference is in Markdown,
 * so nothing durable was in the index to lose.
 *
 * **Its sibling, which the spec does not number** — mutate the code, *rebuild
 * the graph*, and only then resolve. A graph rebuild re-captures the cached
 * baseline from current code, so anything comparing current-against-cache is
 * comparing current against current and reports `fresh`. This is the failure
 * the whole phase is shaped around, and it is the one test that would go green
 * for the wrong reason if resolution were built the obvious way.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGraphEngine } from "../../../graph/engine-impl.js";
import { openGraphDatabase } from "../../../graph/db/database.js";
import { FingerprintStore } from "../../../graph/fingerprint-store.js";
import { MinHashReconciler } from "../../../graph/reconcile-engine.js";
import { createGroundingGraph, deriveGrounding } from "../adapter.js";
import { resolveEntityGroundings, resolveGrounding } from "../resolve.js";
import { WikiBaselineStore } from "../baseline.js";
import { checkGroundingProvenance } from "../provenance.js";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { openWikiIndex } from "../../index/open.js";
import { openWikiQuery } from "../../query/session.js";
import type { GroundingGraph } from "../adapter.js";
import type { WikiGrounding } from "../../model/grounding.js";

const ENTITY_ID = "mx_01KR2E4K002H3ZYA9G0C4XV531";

const ORIGINAL = `export function rotateRefreshToken(userId: string): number {
  const windowSeconds = 3600;
  const attempts = userId.length;
  const budget = attempts * windowSeconds;
  return budget > 100 ? budget : windowSeconds;
}

export function issueAccessToken(subject: string): string {
  const prefix = "at";
  const suffix = subject.slice(0, 8);
  return prefix + "_" + suffix;
}
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows holds SQLite files open a moment past close often enough that
      // cleanup failure would otherwise be the only red in the file.
    }
  }
});

interface Project {
  root: string;
  scaffoldRoot: string;
  sourcePath: string;
  entityPath: string;
  indexPath: string;
}

function createProject(): Project {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-grounding-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, "src", "auth.ts"), ORIGINAL, "utf-8");
  return {
    root,
    scaffoldRoot: join(root, ".mex"),
    sourcePath: join(root, "src", "auth.ts"),
    entityPath: join(root, ".mex", "context", "auth.md"),
    indexPath: join(root, ".mex", "wiki.db"),
  };
}

/** Build (or rebuild) the code graph, exactly as `mex graph` does. */
async function buildGraph(project: Project): Promise<void> {
  const engine = createGraphEngine({ rootDir: project.root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
}

/** Open the graph and hand the callback a live grounding seam. */
function withGraph<T>(project: Project, body: (graph: GroundingGraph, db: ReturnType<typeof openGraphDatabase>) => T): T {
  const dbPath = join(project.root, ".mex", "graph.db");
  const engine = createGraphEngine({ rootDir: project.root, dbPath });
  const db = openGraphDatabase(dbPath);
  try {
    const reconciler = new MinHashReconciler(new FingerprintStore(db));
    return body(createGroundingGraph(engine, reconciler, db, { projectRoot: project.root }), db);
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

/** Write the entity's Markdown with the given grounding. */
function writeEntity(project: Project, grounding: WikiGrounding, status = "promoted"): void {
  const lines = [
    `  - node: ${grounding.node}`,
    `    fingerprint: ${grounding.fingerprint}`,
    ...(grounding.bodyHash === undefined ? [] : [`    bodyHash: ${grounding.bodyHash}`]),
  ];
  writeFileSync(
    project.entityPath,
    `---\nname: auth\n---\n\n# Authentication\n\n` +
      `<!-- mex:entity\nid: ${ENTITY_ID}\ntype: decision\nstatus: ${status}\nrevision: 1\n` +
      `grounds_to:\n${lines.join("\n")}\n-->\n` +
      `## Refresh tokens rotate hourly\n\nThe rotation window is one hour.\n`,
    "utf-8",
  );
  if (grounding.bodyHash) withGraph(project, (graph) => graph.rememberBody?.(grounding.node, grounding.bodyHash!));
}

/** The groundings the entity declares, read back out of Markdown via the index. */
function committedGroundings(project: Project): WikiGrounding[] {
  rebuildWikiIndex({ scaffoldRoot: project.scaffoldRoot, indexPath: project.indexPath });
  const opened = openWikiIndex(project.indexPath);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try {
    return (
      opened.index.db
        .prepare(`SELECT node_id, fingerprint, body_hash FROM wiki_groundings ORDER BY ordinal`)
        .all() as Array<{ node_id: string; fingerprint: string; body_hash: string | null }>
    ).map((row) => ({
      node: row.node_id,
      fingerprint: row.fingerprint,
      ...(row.body_hash === null ? {} : { bodyHash: row.body_hash }),
    }));
  } finally {
    opened.index.close();
  }
}

describe("§20.5 grounding integration, against a real graph", () => {
  it("walks all ten steps", async () => {
    const project = createProject();

    // ---- 1. Create a grounded entity ---------------------------------------
    await buildGraph(project);
    const rotateId = nodeIdOf(project, "rotateRefreshToken");

    const minted = withGraph(project, (graph) => deriveGrounding(graph, rotateId));
    expect(minted).not.toBeNull();
    // Everything mex writes carries a body hash, so it is checkable by the
    // finer comparator from the moment it exists.
    expect(minted!.bodyHash).toBeTruthy();
    writeEntity(project, minted!);

    // ---- 2. Resolve it fresh -----------------------------------------------
    let resolution = withGraph(project, (graph) => resolveGrounding(committedGroundings(project)[0]!, graph));
    expect(resolution).toMatchObject({ state: "fresh", health: "fresh", resolvedNode: rotateId });

    // Capture the baseline, the way `mex ground` does. This is the cache that
    // renders the old side of a diff — and the thing that must never be the
    // oracle.
    withGraph(project, (graph, db) => {
      const store = new WikiBaselineStore(db);
      const node = graph.getNode(rotateId)!;
      store.capture(ENTITY_ID, minted!, ORIGINAL, node.bodyHash ?? "");
      expect(store.get(ENTITY_ID, rotateId)?.bodyHash).toBe(node.bodyHash);
    });

    // ---- 3. Change the declaration body ------------------------------------
    // A constant, and nothing else. This is the edit the fingerprint cannot
    // see: the extractor represents literals by grammar kind, so the MinHash
    // comes out byte-identical. If the committed body hash were not the
    // comparator, everything below this line would report fresh.
    writeFileSync(project.sourcePath, ORIGINAL.replace("3600", "7200"), "utf-8");

    // ---- 4. Rebuild the code graph -----------------------------------------
    // Deliberately a full rebuild, not a sync. A rebuild re-captures every
    // cached baseline from current code, which is precisely how a
    // current-against-cache comparison silently becomes
    // current-against-current.
    await buildGraph(project);

    // ---- 5. Observe stale health, with the old source still available ------
    const committed = committedGroundings(project)[0]!;
    resolution = withGraph(project, (graph) => resolveGrounding(committed, graph));
    expect(resolution).toMatchObject({ state: "stale", health: "changed" });

    withGraph(project, (graph, db) => {
      // The fingerprint is *unchanged* by this edit — asserted, because it is
      // the whole reason the body hash exists. A fingerprint-only resolver
      // would have called the line above fresh.
      expect(graph.getFingerprint(rotateId)).toBe(committed.fingerprint);
      // And the cached baseline is still there to render the old side.
      expect(new WikiBaselineStore(db).get(ENTITY_ID, rotateId)?.source).toContain("3600");
    });

    // ---- 6. Re-ground, and return to fresh ---------------------------------
    const reground = withGraph(project, (graph) => deriveGrounding(graph, rotateId));
    writeEntity(project, reground!);
    resolution = withGraph(project, (graph) => resolveGrounding(committedGroundings(project)[0]!, graph));
    expect(resolution).toMatchObject({ state: "fresh", health: "fresh" });

    // ---- 7. Rename the symbol, and reconcile -------------------------------
    writeFileSync(
      project.sourcePath,
      ORIGINAL.replace("3600", "7200").replace("rotateRefreshToken", "rotateSessionToken"),
      "utf-8",
    );
    await buildGraph(project);
    const renamedId = nodeIdOf(project, "rotateSessionToken");
    expect(renamedId).not.toBe(rotateId);

    resolution = withGraph(project, (graph) => resolveGrounding(committedGroundings(project)[0]!, graph));
    // Rebound, and the entity id is untouched — §5.6 and §8.7. The Markdown
    // still says the old node; `resolvedNode` says where it went. Rewriting
    // Markdown is an operation, and operations are P5.
    expect(resolution).toMatchObject({ state: "fresh", health: "fresh", node: rotateId, resolvedNode: renamedId });
    expect(readFileSync(project.entityPath, "utf-8")).toContain(`id: ${ENTITY_ID}`);
    expect(readFileSync(project.entityPath, "utf-8")).toContain(`node: ${rotateId}`);

    // ---- 8. Delete the symbol, and observe missing -------------------------
    writeFileSync(project.sourcePath, `export function issueAccessToken(subject: string): string {\n  return subject;\n}\n`, "utf-8");
    await buildGraph(project);

    resolution = withGraph(project, (graph) => resolveGrounding(committedGroundings(project)[0]!, graph));
    expect(resolution.state === "missing" || resolution.health === "ambiguous").toBe(true);
    expect(resolution.health).not.toBe("fresh");
  }, 300000);

  it("step 9: still detects drift after wiki.db is deleted and the graph rebuilt", async () => {
    // Disposability, stated as the property that matters. Nothing durable lives
    // in the index: the reference is in Markdown, the baseline is recapturable,
    // and the verdict is recomputed.
    const project = createProject();
    await buildGraph(project);
    const rotateId = nodeIdOf(project, "rotateRefreshToken");
    writeEntity(project, withGraph(project, (graph) => deriveGrounding(graph, rotateId))!);

    // Edit the constant and rebuild the graph, so every cached baseline is
    // re-captured from the *current* code.
    writeFileSync(project.sourcePath, ORIGINAL.replace("3600", "7200"), "utf-8");
    await buildGraph(project);

    // Now throw the index away entirely and rebuild it from Markdown alone.
    rmSync(project.indexPath, { force: true });
    const committed = committedGroundings(project)[0]!;
    expect(committed.bodyHash).toBeTruthy();

    const resolution = withGraph(project, (graph) => resolveGrounding(committed, graph));
    expect(resolution).toMatchObject({ state: "stale", health: "changed" });

    // The graph's own cache agrees with current code, which is exactly why it
    // could not have produced this answer. Asserted rather than described: it
    // is the difference between the right verdict and the right verdict for
    // the wrong reason.
    withGraph(project, (graph, db) => {
      const cached = new WikiBaselineStore(db).get(ENTITY_ID, rotateId);
      // Nothing captured a baseline in this test at all, so there is no cache
      // to have consulted — and the verdict was still reached.
      expect(cached).toBeNull();
      expect(graph.getNode(rotateId)?.bodyHash).not.toBe(committed.bodyHash);
    });
  }, 300000);

  it("step 10: local health never rewrites canonical lifecycle", async () => {
    const project = createProject();
    await buildGraph(project);
    const rotateId = nodeIdOf(project, "rotateRefreshToken");
    writeEntity(project, withGraph(project, (graph) => deriveGrounding(graph, rotateId))!);

    const before = readFileSync(project.entityPath, "utf-8");

    writeFileSync(project.sourcePath, ORIGINAL.replace("3600", "7200"), "utf-8");
    await buildGraph(project);

    withGraph(project, (graph) => {
      const resolved = resolveEntityGroundings(committedGroundings(project), graph);
      expect(resolved.health).toBe("changed");
    });

    // Byte-identical. A stale grounding is a branch-local fact (§5.3): the same
    // entity is fresh on the branch nobody edited, so letting drift rewrite
    // status would make a rebase change what a team had decided.
    expect(readFileSync(project.entityPath, "utf-8")).toBe(before);

    // And the indexed lifecycle is untouched too, with the drift reported
    // beside it rather than instead of it.
    rebuildWikiIndex({
      scaffoldRoot: project.scaffoldRoot,
      indexPath: project.indexPath,
      resolveGrounding: (grounding) => withGraph(project, (graph) => resolveGrounding(grounding, graph)),
    });
    const query = openWikiQuery(project.indexPath);
    if (!query.ok) throw new Error(query.diagnostic.message);
    try {
      const summary = query.value.get(ENTITY_ID);
      expect(summary.ok).toBe(true);
      if (summary.ok) {
        expect(summary.value.status).toBe("promoted");
        expect(summary.value.health).toBe("changed");
      }
    } finally {
      query.value.close();
    }
  }, 300000);

  it("degrades to unverified with no graph, and refuses to write an unverified grounding", async () => {
    const project = createProject();
    await buildGraph(project);
    const rotateId = nodeIdOf(project, "rotateRefreshToken");
    const minted = withGraph(project, (graph) => deriveGrounding(graph, rotateId))!;
    writeEntity(project, minted);

    // A checkout with no graph at all. Reads still work and say so.
    const resolution = resolveGrounding(committedGroundings(project)[0]!, null);
    expect(resolution).toMatchObject({ state: "unresolved", health: "unverified" });

    // §12.4, against the real graph: the real pair is accepted, and a pair with
    // a fabricated fingerprint is not — even though its node id is genuine.
    withGraph(project, (graph) => {
      expect(checkGroundingProvenance([minted], graph)).toEqual([]);
      const forged: WikiGrounding = { node: rotateId, fingerprint: "mh:64:00ff" };
      expect(checkGroundingProvenance([forged], graph).map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
      const invented: WikiGrounding = { node: "function:cafebabecafebabe", fingerprint: minted.fingerprint };
      expect(checkGroundingProvenance([invented], graph).map((entry) => entry.code)).toEqual(["GROUNDING_UNVERIFIED"]);
    });
  }, 300000);
});
