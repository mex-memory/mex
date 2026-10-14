import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import { loadFreshGraphReadSession } from "../src/graph/read-session.js";
import { FingerprintStore } from "../src/graph/fingerprint-store.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";
import { runApply } from "../src/wiki/cli/commands.js";
import { resolveGrounding } from "../src/wiki/grounding/resolve.js";
import { envelope, JWT, makeScaffold, type Scaffold } from "../src/wiki/operations/__tests__/helpers.js";

const scaffolds: Scaffold[] = [];
afterEach(() => { for (const scaffold of scaffolds.splice(0)) scaffold.dispose(); });

async function fixture() {
  const scaffold = makeScaffold();
  scaffolds.push(scaffold);
  mkdirSync(join(scaffold.root, "src"));
  writeFileSync(join(scaffold.root, "src/good.ts"), "export function goodTarget() { return 42; }\n");
  writeFileSync(join(scaffold.root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["src"]}');
  writeFileSync(join(scaffold.root, "src/broken.ts"), "export function partialTarget() { return 1; }\nexport const broken = ;\n");
  const port = createRepositoryGraphPort(scaffold.root);
  await port.rebuild();
  const loaded = await loadFreshGraphReadSession(scaffold.root, { allowDegradedReads: true });
  expect(loaded.graphStatus.status).toBe("degraded");
  expect(loaded.session!.degradations).toEqual(["parse-degraded"]);
  const session = loaded.session!;
  try {
    const store = new FingerprintStore(session.db);
    const grounding = (name: string) => {
      const node = session.graph.searchNodes(name).find(node => node.name === name)!;
      expect(node).toBeDefined();
      return { node: node.id, fingerprint: serializeFingerprint(store.get(node.id)!), bodyHash: node.bodyHash };
    };
    return { scaffold, port, good: grounding("goodTarget"), partial: grounding("partialTarget") };
  } finally { session.close(); }
}

describe("Wiki CLI grounding with an unrelated incomplete parse", () => {
  it("applies an exact healthy grounding, rejects partial-file facts, and names the real remedy", async () => {
    const { scaffold, port, good, partial } = await fixture();
    const lines: string[] = [];
    const operation = join(scaffold.root, "operation.json");
    const io = { projectRoot: scaffold.root, scaffoldRoot: scaffold.root, groundingBridge: port,
      write: (value: string) => lines.push(value), setExitCode: () => {} };
    writeFileSync(operation, JSON.stringify(envelope(scaffold, "set-grounding", { groundsTo: [good] }, { entityId: JWT })));
    await runApply(io, operation, { json: true, apply: true });
    expect(JSON.parse(lines.at(-1)!).data.applied).toBe(true);
    expect(scaffold.entity(JWT).groundsTo[0]?.node).toBe(good.node);
    const before = readFileSync(join(scaffold.root, "context/architecture.md"), "utf8");
    lines.length = 0;
    writeFileSync(operation, JSON.stringify(envelope(scaffold, "set-grounding", { groundsTo: [partial] }, { entityId: JWT })));
    await runApply(io, operation, { json: true, apply: true });
    const rejected = JSON.parse(lines.at(-1)!);
    expect(rejected.data.applied).toBe(false);
    expect(rejected.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "GROUNDING_UNVERIFIED", message: expect.stringContaining("src/broken.ts"),
    })]));
    expect(JSON.stringify(rejected)).not.toContain("changed during this pass");
    expect(readFileSync(join(scaffold.root, "context/architecture.md"), "utf8")).toBe(before);
    await port.refresh();
    await port.withFreshGroundingSnapshot(snapshot => {
      expect(snapshot.getNode(good.node)).not.toBeNull();
      expect(snapshot.getNode(partial.node)).toBeNull();
      expect(snapshot.getFingerprint(partial.node)).toBeNull();
      expect(snapshot.getSymbols([good.node, partial.node]).map(symbol => symbol.ref.symbolId)).toEqual([good.node]);
      expect(resolveGrounding(partial, snapshot)).toMatchObject({ health: "unverified", reason: expect.stringContaining("src/broken.ts") });
      expect(resolveGrounding({ ...good, node: `function:${"0".repeat(32)}` }, snapshot))
        .toMatchObject({ health: "unverified", reason: expect.stringContaining("src/broken.ts") });
    });
  });

  it("refuses source drift and discards a prepared publication if source changes during the pass", async () => {
    const { scaffold, port, good } = await fixture();
    let committed = false;
    let discarded = false;
    await expect(port.withFreshGroundingPublication(snapshot => {
      expect(snapshot.getNode(good.node)).not.toBeNull();
      writeFileSync(join(scaffold.root, "src/good.ts"), "export function goodTarget() { return 43; }\n");
      return { preflight() {}, commit() { committed = true; }, discard() { discarded = true; } };
    })).rejects.toMatchObject({ problem: { code: "OPERATION_INTERRUPTED" } });
    expect({ committed, discarded }).toEqual({ committed: false, discarded: true });
    await expect(port.withFreshGroundingSnapshot(() => {})).rejects.toMatchObject({ problem: { code: "INDEX_STALE" } });
  });

  it("does not admit configuration drift through the incomplete-parse exception", async () => {
    const { scaffold, port } = await fixture();
    writeFileSync(join(scaffold.root, "tsconfig.json"), '{"compilerOptions":{"strict":true,"baseUrl":"src"},"include":["src"]}');
    let used = false;
    await expect(port.withFreshGroundingSnapshot(() => { used = true; })).rejects.toMatchObject({ problem: { code: "INDEX_STALE" } });
    expect(used).toBe(false);
  });
});
