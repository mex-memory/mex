/**
 * The Wiki CLI and the code graph (#232).
 *
 * The CLI used to hand its services no graph, so `wiki validate` never
 * resolved a grounding and `wiki rebuild-index` stored no health in a checkout
 * with a fresh `graph.db`. These drive the commands through a bridge with the
 * repository graph port's contract: one snapshot per command, a refusal when
 * the graph cannot be trusted, and a final freshness proof that can fail after
 * the work has run.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GroundedNode, GroundingGraph } from "../../grounding/adapter.js";
import { MexPortError, type MexErrorCode } from "../../../team/contracts/shared.js";
import { wikiGroundingStatus } from "../../service/read.js";
import { runRebuildIndex, runValidate, type CommandIo } from "../commands.js";
import {
  publishWithGraph,
  readWithGraph,
  writeWithGraph,
  type WikiCliGroundingBridge,
  type WikiCliPreparedPublication,
} from "../grounding.js";

const ENTITY = "mx_01KR2E4K002H3ZYA9G0C4XV531";
const NODE = "function:1a2b3c4d5e6f7a8b";
const FINGERPRINT = "mh:64:0a0b0c0d";

const ENTITY_MD = `---
mex:
  id: ${ENTITY}
  type: component
  status: promoted
  revision: 1
  title: Auth
  grounds_to:
    - node: ${NODE}
      fingerprint: ${FINGERPRINT}
      bodyHash: body-1
---

# Auth

Rotates refresh tokens.
`;

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

function graphWithBody(bodyHash: string): GroundingGraph {
  const node: GroundedNode = { id: NODE, bodyHash, filePath: "src/auth.ts", startLine: 1, endLine: 5 };
  return {
    getNode: (id) => (id === NODE ? node : null),
    getFingerprint: (id) => (id === NODE ? FINGERPRINT : null),
    reconcile: () => ({ kind: "GONE" }),
    getBaselineSource: () => null,
  };
}

function refusal(code: MexErrorCode): MexPortError {
  return new MexPortError({ title: "Graph unavailable", status: 409, code, detail: "refused" });
}

interface FakeBridge extends WikiCliGroundingBridge {
  snapshots: number;
}

/** The repository graph port's contract, with the refusal and final proof under test control. */
function bridge(
  graph: GroundingGraph,
  options: { refuse?: MexErrorCode; failFinalProof?: boolean } = {},
): FakeBridge {
  const fake: FakeBridge = {
    snapshots: 0,
    async withFreshGroundingSnapshot(callback) {
      if (options.refuse !== undefined) throw refusal(options.refuse);
      fake.snapshots += 1;
      const value = await callback(graph);
      if (options.failFinalProof === true) throw refusal("OPERATION_INTERRUPTED");
      return value;
    },
    async withFreshGroundingPublication(prepare) {
      if (options.refuse !== undefined) throw refusal(options.refuse);
      fake.snapshots += 1;
      const prepared = await prepare(graph);
      await prepared.preflight();
      if (options.failFinalProof === true) {
        await prepared.discard();
        throw refusal("OPERATION_INTERRUPTED");
      }
      return prepared.commit();
    },
  };
  return fake;
}

function cli(groundingBridge?: WikiCliGroundingBridge): { io: CommandIo; root: string; lines: string[] } {
  const root = mkdtempSync(join(tmpdir(), "mex-wiki-cli-graph-"));
  roots.push(root);
  mkdirSync(join(root, "context"), { recursive: true });
  writeFileSync(join(root, "context", "auth.md"), ENTITY_MD, "utf-8");
  const lines: string[] = [];
  return {
    root,
    lines,
    io: {
      write: (line) => lines.push(line),
      setExitCode: () => undefined,
      scaffoldRoot: root,
      projectRoot: root,
      ...(groundingBridge === undefined ? {} : { groundingBridge }),
    },
  };
}

interface Envelope {
  data: { codeGraphAvailable?: boolean; groundingsUnverified?: boolean };
  diagnostics: Array<{ code: string; severity: string }>;
}

function envelope(lines: readonly string[]): Envelope {
  return JSON.parse(lines[0]!) as Envelope;
}

function codes(lines: readonly string[]): string[] {
  return envelope(lines).diagnostics.map((entry) => entry.code);
}

describe("wiki validate", () => {
  it("checks structure only and never opens the code graph", async () => {
    let opened = false;
    const watched = bridge(graphWithBody("body-2"));
    const spy = new Proxy(watched, {
      get(target, key, receiver) {
        if (key === "withFreshGroundingSnapshot") opened = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const run = cli(spy);
    await runValidate(run.io, { json: true });
    expect(codes(run.lines)).not.toContain("GROUNDING_STALE");
    expect(opened).toBe(false);

    const human = cli(bridge(graphWithBody("body-2")));
    await runValidate(human.io, {});
    expect(human.lines.join("\n")).toContain("`mex check` checks every code link");
  });
});

describe("wiki rebuild-index", () => {
  it("stores grounding health from a fresh graph", async () => {
    const local = cli(bridge(graphWithBody("body-2")));
    await runRebuildIndex(local.io, { json: true });
    expect(wikiGroundingStatus({ scaffoldRoot: local.root, id: ENTITY }).data.entities[0]?.health).toBe("changed");
  });

  it("publishes no health from a graph that changed while the index was built", async () => {
    const local = cli(bridge(graphWithBody("body-2"), { failFinalProof: true }));
    await runRebuildIndex(local.io, { json: true });
    expect(codes(local.lines)).toContain("CODE_GRAPH_UNAVAILABLE");
    // Still rebuilt — just without a verdict nobody can stand behind.
    expect(wikiGroundingStatus({ scaffoldRoot: local.root, id: ENTITY }).data.entities[0]?.health).toBeNull();
  });

  it("still rebuilds with no graph at all", async () => {
    const local = cli();
    await runRebuildIndex(local.io, { json: true });
    expect(codes(local.lines)).not.toContain("CODE_GRAPH_UNAVAILABLE");
    expect(wikiGroundingStatus({ scaffoldRoot: local.root, id: ENTITY }).data.entities[0]?.health).toBeNull();
  });
});

describe("the graph helpers", () => {
  it("never runs a completed write twice when the final proof fails after it", async () => {
    const graph = graphWithBody("body-1");
    let runs = 0;
    const result = await writeWithGraph(bridge(graph, { failFinalProof: true }), (received) => {
      runs += 1;
      return received;
    });
    expect(runs).toBe(1);
    expect(result).toEqual({ value: graph, unavailable: "changed" });
  });

  it("reruns a read without a graph when the final proof fails", async () => {
    const seen: Array<GroundingGraph | null> = [];
    const result = await readWithGraph(bridge(graphWithBody("body-1"), { failFinalProof: true }), (graph) => {
      seen.push(graph);
      return seen.length;
    });
    expect(seen.map((graph) => graph === null)).toEqual([false, true]);
    expect(result).toEqual({ value: 2, unavailable: "changed" });
  });

  it("rethrows a failure of the work itself rather than retrying it", async () => {
    let runs = 0;
    await expect(readWithGraph(bridge(graphWithBody("body-1")), () => {
      runs += 1;
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(runs).toBe(1);
  });

  it("rethrows an unexpected bridge error instead of hiding it as a missing graph", async () => {
    const broken: WikiCliGroundingBridge = {
      withFreshGroundingSnapshot: async () => {
        throw new Error("disk on fire");
      },
      withFreshGroundingPublication: async () => {
        throw new Error("disk on fire");
      },
    };
    await expect(readWithGraph(broken, () => 1)).rejects.toThrow("disk on fire");
    const prepared: WikiCliPreparedPublication<number> = { preflight: () => undefined, commit: () => 1, discard: () => undefined };
    await expect(publishWithGraph(broken, () => prepared)).rejects.toThrow("disk on fire");
  });

  it("reports a caller that supplied no bridge as such, never as a checkout without a graph", async () => {
    expect(await readWithGraph(undefined, () => 1)).toEqual({ value: 1, unavailable: "not_supplied" });
  });
});
