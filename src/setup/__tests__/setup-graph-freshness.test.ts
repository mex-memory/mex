import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createGraphEngine } from "../../graph/engine-impl.js";
import { createRepositoryGraphPort } from "../../graph/application-adapter.js";
import { inspectGraphStatusWithFreshObservation } from "../../graph/status.js";
import { loadFreshGraphReadSession } from "../../graph/read-session.js";
import { createSetupGraphFreshness } from "../setup-graph-freshness.js";
import { createSetupBatchApplier } from "../subsystem-apply.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-freshness-")); roots.push(root);
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".mex", "AGENTS.md"), "# Instructions\n");
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "linked.py"), "def linked():\n    return 1\n");
  writeFileSync(join(root, "other.py"), "def other():\n    return 2\n");
  const engine = createGraphEngine({ rootDir: root });
  try { await engine.build(); } finally { engine.close(); }
  return root;
}

it("rechecks linked bytes on every setup batch while allowing unrelated edits", async () => {
  const root = await fixture();
  const applier = createSetupBatchApplier(root);
  const scope = { opIdPrefix: "setup_test_", files: ["context/test.md"] };
  const apply = async (step: number) => {
    const path = join(root, "batch.json");
    writeFileSync(path, JSON.stringify([{ opId: `setup_test_${step}`, type: "create-entry",
      actor: { kind: "human", id: "fixture" }, timestamp: "2026-10-24T00:00:00.000Z",
      payload: { file: "context/test.md", insertAt: { at: "end-of-file" }, type: "fact", title: `Claim ${step}`,
        body: "A claim.", headingDepth: 2, groundsTo: [{ file: "linked.py", symbol: "linked" }] },
    }]));
    return applier.apply(path, scope);
  };
  expect((await apply(1)).kind).toBe("applied");
  writeFileSync(join(root, "other.py"), "def other():\n    return 9\n");
  const second = await apply(2);
  expect(second.kind, JSON.stringify(second)).toBe("applied");
  writeFileSync(join(root, "linked.py"), "def linked():\n    return 9\n");
  expect(await apply(3)).toMatchObject({ kind: "refused", problems: expect.arrayContaining([
    expect.objectContaining({ code: "GROUNDING_UNVERIFIED" }),
  ]) });
  expect(await applier.close()).toEqual({ changed: false });
});

it("catches HEAD moving during a scoped batch through the public session policy", async () => {
  const root = await fixture();
  const freshness = createSetupGraphFreshness(root);
  const port = createRepositoryGraphPort(root, { loadFreshSession: freshness.loadFresh });
  const attempt = port.withFreshGroundingSnapshot(graph => {
    graph.verifySource!("linked.py");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: root });
  }, { sourceScope: new Set() });
  await expect(attempt).rejects.toBeDefined();
  expect(freshness.changed).toBe(true);
});

it("keeps the setup graph replacement refusal and message at final revalidation", async () => {
  const root = await fixture();
  const freshness = createSetupGraphFreshness(root);
  const loaded = await freshness.loadFresh(root, { sourceScope: new Set(["linked.py"]) });
  expect(loaded.session).not.toBeNull();
  // Windows locks an open SQLite file against rename. Release its descriptor
  // before replacing it, then exercise the policy's final identity boundary.
  loaded.session!.close();
  const db = join(root, ".mex", "graph.db");
  const bytes = readFileSync(db); renameSync(db, db + ".old"); writeFileSync(db, bytes);
  expect(await loaded.session!.revalidateFreshness()).toMatchObject({ valid: false,
    code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
    message: "The graph database or HEAD changed while a setup batch was being applied.",
  });
  expect(freshness.changed).toBe(true);
});

it("records a graph replacement between batches without skipping the next scoped proof", async () => {
  const root = await fixture();
  const freshness = createSetupGraphFreshness(root);
  const port = createRepositoryGraphPort(root, { loadFreshSession: freshness.loadFresh });
  const read = () => port.withFreshGroundingSnapshot(graph => graph.verifySource!("linked.py"), { sourceScope: new Set() });
  await read();
  const db = join(root, ".mex", "graph.db");
  const bytes = readFileSync(db); renameSync(db, db + ".old"); writeFileSync(db, bytes);
  await read();
  expect(freshness.changed).toBe(true);
  writeFileSync(join(root, "linked.py"), "def linked():\n    return 9\n");
  await expect(read()).rejects.toBeDefined();
});

it("reuses only the database audit and still proves configuration on every batch", async () => {
  const root = await fixture();
  const freshness = createSetupGraphFreshness(root);
  const audited: boolean[] = [];
  const load = () => freshness.loadFresh(root, {
    sourceScope: new Set(["linked.py"]),
    inspectObservation: async options => {
      audited.push(options.auditedDatabase !== undefined);
      return inspectGraphStatusWithFreshObservation(options);
    },
  });
  for (let batch = 0; batch < 2; batch++) {
    const loaded = await load();
    expect(loaded.session).not.toBeNull();
    try { expect((await loaded.session!.revalidateFreshness()).valid).toBe(true); }
    finally { loaded.session!.close(); }
  }
  expect(audited).toEqual([false, true, true, true]);
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  expect((await load()).session).toBeNull();
});

it("checks HEAD again after asynchronous freshness revalidation", async () => {
  const root = await fixture();
  const freshness = createSetupGraphFreshness(root, {
    loadFull: async (projectRoot, options) => {
      const loaded = await loadFreshGraphReadSession(projectRoot, options);
      const session = loaded.session!;
      const revalidate = session.revalidateFreshness.bind(session);
      session.revalidateFreshness = async () => {
        const validation = await revalidate();
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: root });
        return validation;
      };
      return loaded;
    },
  });
  const loaded = await freshness.loadFresh(root, { sourceScope: new Set(["linked.py"]) });
  try {
    expect(await loaded.session!.revalidateFreshness()).toMatchObject({ valid: false,
      message: "The graph database or HEAD changed while a setup batch was being applied.",
    });
    expect(freshness.changed).toBe(true);
  } finally { loaded.session!.close(); }
});
