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
import { wikiGroundingStatus, wikiList } from "../read.js";
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
});
