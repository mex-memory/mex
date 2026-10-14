/**
 * Index writes record grounding health from the graph they were given (#232).
 *
 * The write services took a graph to mint and verify groundings, but the index
 * writes beside them never saw it, so a rebuild with a fresh graph stored NULL
 * health — "nothing looked" — and `--health changed` matched nothing.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundedNode, GroundingGraph } from "../../grounding/adapter.js";
import { entitiesGroundedIn } from "../../query/get.js";
import { openWikiQuery } from "../../query/session.js";
import { estimateTokens, FRAMING_RESERVE } from "../../query/budget.js";
import { wikiGroundingStatus, wikiList, wikiSearch } from "../read.js";
import { wikiPrepareRebuildIndex, wikiRebuildIndex, wikiRefreshIndex } from "../write.js";

const ENTITY = "mx_01KR2E4K002H3ZYA9G0C4XV531";
const NODE = "function:1a2b3c4d5e6f7a8b";
const FINGERPRINT = "mh:64:0a0b0c0d";

function entityText(bodyHash: string): string {
  return `---
mex:
  id: ${ENTITY}
  type: component
  status: promoted
  revision: 1
  title: Auth
  grounds_to:
    - node: ${NODE}
      fingerprint: ${FINGERPRINT}
      bodyHash: ${bodyHash}
---

# Auth

Rotates refresh tokens.
`;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed SQLite files.
    }
  }
});

function scaffold(bodyHash = "body-1"): string {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-health-"));
  roots.push(root);
  mkdirSync(join(root, "context"), { recursive: true });
  writeFileSync(join(root, "context", "auth.md"), entityText(bodyHash), "utf-8");
  return root;
}

function graphWithBody(bodyHash: string): GroundingGraph {
  const node: GroundedNode = { id: NODE, bodyHash, filePath: "src/auth.ts", startLine: 1, endLine: 5 };
  return {
    getNode: (id) => (id === NODE ? node : null),
    getFingerprint: (id) => (id === NODE ? FINGERPRINT : null),
    reconcile: () => ({ kind: "GONE" }),
    getBaselineSource: () => null,
  };
}

function healthOf(root: string): string | null | undefined {
  return wikiGroundingStatus({ scaffoldRoot: root, id: ENTITY }).data.entities[0]?.health;
}

describe("index health from the graph a write was given (#232)", () => {
  it("keeps ranked hits when grounding explanations exceed a tight budget", () => {
    const root = scaffold();
    const links = Array.from({ length: 30 }, (_, index) => `    - node: function:${String(index).padStart(16, "0")}\n      fingerprint: ${FINGERPRINT}\n      bodyHash: body-1`).join("\n");
    writeFileSync(join(root, "context/auth.md"), entityText("body-1").replace(
      `    - node: ${NODE}\n      fingerprint: ${FINGERPRINT}\n      bodyHash: body-1`, links));
    writeFileSync(join(root, "context/secondary.md"), `<!-- mex:entity\nid: mx_01KS6FPN00RT04JXY9QEG0JN19\ntype: fact\nstatus: promoted\nrevision: 1\n-->\n## Auth secondary\n\nUses the same token issuer.\n`);
    wikiRebuildIndex({ scaffoldRoot: root });
    const opened = openWikiQuery(join(root, "wiki.db"));
    if (!opened.ok) throw new Error(opened.diagnostic.message);
    const ranked = opened.value.search("Auth", { limit: 5 }).items;
    opened.value.close();
    expect(ranked).toHaveLength(2);
    const maxTokens = FRAMING_RESERVE + ranked.reduce((sum, hit) => sum + estimateTokens(hit), 0);
    const tight = wikiSearch({ scaffoldRoot: root, text: "Auth", limit: 5, maxTokens }).data;
    expect(tight.hits.map(hit => hit.entity.id)).toEqual(ranked.map(hit => hit.entity.id));
    expect(tight.hits.find(hit => hit.entity.id === ENTITY)?.groundingsTruncated).toBeUndefined();
    expect(tight.hits.find(hit => hit.entity.id === ENTITY)?.groundings).toBeUndefined();
    expect(tight.truncated).toBe(true);
    expect(estimateTokens(tight)).toBeLessThanOrEqual(maxTokens);
    const normal = wikiSearch({ scaffoldRoot: root, text: "Auth", limit: 5 }).data;
    expect(normal.hits.map(hit => hit.entity.id)).toEqual(ranked.map(hit => hit.entity.id));
    expect(normal.hits.find(hit => hit.entity.id === ENTITY)?.groundings).toHaveLength(25);
    expect(normal.hits.find(hit => hit.entity.id === ENTITY)?.groundingsTruncated).toBe(true);
  });

  it("explains a search warning per grounding while keeping its sibling link fresh", () => {
    const root = scaffold();
    const other = "function:2a2b3c4d5e6f7a8b";
    writeFileSync(join(root, "context/auth.md"), entityText("body-1").replace("      bodyHash: body-1",
      `      bodyHash: body-1\n    - node: ${other}\n      fingerprint: ${FINGERPRINT}\n      bodyHash: body-1`));
    const original = graphWithBody("body-2");
    const graph: GroundingGraph = { ...original,
      getNode: id => id === other ? { id, bodyHash: "body-1", filePath: "src/rotate.ts", startLine: 1, endLine: 1 } : original.getNode(id),
      getFingerprint: id => id === other ? FINGERPRINT : original.getFingerprint(id),
    };
    wikiRebuildIndex({ scaffoldRoot: root, graph });
    const hit = wikiSearch({ scaffoldRoot: root, text: "Auth" }).data.hits[0]!;
    expect(hit.entity.health).toBe("changed");
    expect(hit.groundings).toEqual([
      { nodeId: NODE, resolvedNodeId: NODE, health: "changed", state: "stale", reason: "The grounded code changed; re-check this claim." },
      { nodeId: other, resolvedNodeId: other, health: "fresh", state: "fresh", reason: null },
    ]);
    expect(hit.entity.status).toBe("promoted");
  });

  it("a rebuild with no graph stores no verdict", () => {
    const root = scaffold();
    wikiRebuildIndex({ scaffoldRoot: root });
    expect(healthOf(root)).toBeNull();
  });

  it("a rebuild with a graph stores the resolved health, and --health filters on it", () => {
    const root = scaffold();
    wikiRebuildIndex({ scaffoldRoot: root, graph: graphWithBody("body-1") });
    expect(healthOf(root)).toBe("fresh");

    wikiRebuildIndex({ scaffoldRoot: root, graph: graphWithBody("body-2") });
    expect(healthOf(root)).toBe("changed");
    expect(wikiList({ scaffoldRoot: root, health: "changed" }).data.entities.map((entry) => entry.id)).toEqual([ENTITY]);
  });

  it("a prepared rebuild publishes the same health on commit and nothing on discard", () => {
    const discarded = scaffold();
    const dropped = wikiPrepareRebuildIndex({ scaffoldRoot: discarded, graph: graphWithBody("body-2") });
    dropped.preflight();
    dropped.discard();
    expect(existsSync(join(discarded, "wiki.db"))).toBe(false);

    const root = scaffold();
    const prepared = wikiPrepareRebuildIndex({ scaffoldRoot: root, graph: graphWithBody("body-2") });
    prepared.preflight();
    const committed = prepared.commit();
    expect(committed.data.entityCount).toBe(1);
    expect(healthOf(root)).toBe("changed");
  });

  it("a refresh resolves the files it re-reads", () => {
    const root = scaffold();
    wikiRebuildIndex({ scaffoldRoot: root, graph: graphWithBody("body-1") });
    writeFileSync(join(root, "context", "auth.md"), entityText("body-0"), "utf-8");
    wikiRefreshIndex({ scaffoldRoot: root, changed: ["context/auth.md"], graph: graphWithBody("body-1") });
    expect(healthOf(root)).toBe("changed");
  });
  it("preserves code lookup for an unverified legacy identity after a rebind", () => {
    const root = scaffold();
    writeFileSync(join(root, "context", "auth.md"), entityText("body-1").replace(/\n\s+bodyHash: [^\n]+/, ""));
    const newNode = "function:9c8d7e6f5a4b3c2d";
    const graph = graphWithBody("current-body");
    graph.getNode = () => ({ id: newNode, bodyHash: "current-body", filePath: "src/auth.ts", startLine: 1, endLine: 5 });
    graph.getFingerprint = () => FINGERPRINT;
    wikiRebuildIndex({ scaffoldRoot: root, graph });
    expect(healthOf(root)).toBe("unverified");
    const result = entitiesGroundedIn(join(root, "wiki.db"), [newNode]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toMatchObject([{ entity: { id: ENTITY, health: "unverified" }, matchedNodes: [newNode] }]);
    }
  });
});
