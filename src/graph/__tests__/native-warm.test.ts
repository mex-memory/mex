import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openGraphDatabase } from "../db/database.js";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { graphEngineBinary } from "../native-engine.js";
import { NativeGraphServer } from "../native-serve.js";
import { writeGraphState } from "../jobs.js";
import { NativeWarmCheckout } from "../native-warm.js";
import { currentGraphPath, graphLocation, readGraphPointer } from "../storage.js";
import { openWarmCheckout, type WarmGraphCheckout } from "../warm.js";
import { WarmRegistry } from "../warm-registry.js";
import { verifyGraph } from "../verify.js";

const engine = graphEngineBinary();
let scratch: string | undefined;
let checkout: WarmGraphCheckout | undefined;
let registry: WarmRegistry | undefined;

afterEach(() => {
  registry?.closeAll();
  registry = undefined;
  checkout?.close();
  checkout = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(): Promise<string> {
  scratch = mkdtempSync(join(tmpdir(), "mex-native-warm-"));
  const root = mkdtempSync(join(scratch, "repo-"));
  vi.stubEnv("MEX_HOME", join(scratch, "home"));
  vi.stubEnv("MEX_GRAPH_ENGINE", engine);
  vi.stubEnv("MEX_GRAPH_ENGINE_LANGUAGES", "typescript");
  vi.stubEnv("MEX_GRAPH_STORAGE", "v5");
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "leaf.ts"), "export function leaf() { return 1; }\n");
  writeFileSync(join(root, "caller.ts"), 'import { leaf } from "./leaf"; export function caller() { return leaf(); }\n');
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=MEX Test", "-c", "user.email=test@example.org", "commit", "-qm", "fixture"], { cwd: root });
  expect((await rebuildGraph(root)).status.schemaVersion).toBe(5);
  return root;
}

function callTargets(root: string): unknown[] {
  const db = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
  try {
    return db.prepare(`SELECT target.name FROM edges e JOIN nodes target ON target.id = e.target
      JOIN nodes source ON source.id = e.source WHERE e.kind = 'calls' AND source.name = 'caller'`).all();
  } finally { db.close(); }
}

describe.skipIf(!engine)("native warm checkout", () => {
  it("publishes a rename and its dependent call, then continues on the same resident process", async () => {
    const root = await fixture();
    const location = graphLocation(root);
    const base = readGraphPointer(location)!.base;
    checkout = await openWarmCheckout(root);
    expect(checkout).toBeInstanceOf(NativeWarmCheckout);
    const pid = (checkout as NativeWarmCheckout).pid;
    renameSync(join(root, "leaf.ts"), join(root, "moved.ts"));
    writeFileSync(join(root, "moved.ts"), "export function moved() { return 2; }\n");
    writeFileSync(join(root, "caller.ts"), 'import { moved } from "./moved"; export function caller() { return moved(); }\n');
    // Discovery treats these as hints and also picks up the unreported importer.
    expect(await checkout.edit(["leaf.ts", "moved.ts"])).toMatchObject({ status: "published" });
    expect(callTargets(root)).toEqual([{ name: "moved" }]);
    const firstOverlay = readGraphPointer(location);
    expect(firstOverlay).toMatchObject({ base, overlay: expect.any(String) });
    appendFileSync(join(root, "moved.ts"), "// subsequent edit\n");
    expect(await checkout.edit(["moved.ts"])).toMatchObject({ status: "published" });
    expect((checkout as NativeWarmCheckout).pid).toBe(pid);
    expect(readGraphPointer(location)?.overlay).not.toBe(firstOverlay?.overlay);
    expect(callTargets(root)).toEqual([{ name: "moved" }]);

    checkout.close();
    checkout = await openWarmCheckout(root);
    appendFileSync(join(root, "moved.ts"), "// state reopened from the overlay\n");
    expect(await checkout.edit(["moved.ts"])).toMatchObject({ status: "published" });
    expect(callTargets(root)).toEqual([{ name: "moved" }]);
  });

  it("does not publish stale facts when another existing source was changed in place", async () => {
    const root = await fixture();
    checkout = await openWarmCheckout(root);
    appendFileSync(join(root, "leaf.ts"), "// reported\n");
    writeFileSync(join(root, "caller.ts"), 'export function caller() { return missing(); }\n');
    expect(await checkout.edit(["leaf.ts"])).toMatchObject({ status: "published", files: expect.arrayContaining(["caller.ts", "leaf.ts"]) });
    expect(callTargets(root)).toEqual([]);
  });

  it("keeps signature aliases when a function moves from an already shadowed file", async () => {
    const root = await fixture();
    checkout = await openWarmCheckout(root);
    const leaf = join(root, "leaf.ts");
    appendFileSync(leaf, "// first overlay\n");
    expect(await checkout.edit(["leaf.ts"])).toMatchObject({ status: "published" });
    const before = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
    let oldId: string;
    try {
      oldId = (before.prepare("SELECT id FROM nodes WHERE file_path = 'leaf.ts' AND name = 'leaf'").get() as { id: string }).id;
    } finally { before.close(); }

    writeFileSync(leaf, "export function unrelated() { return 2; }\n");
    writeFileSync(join(root, "moved.ts"), "export function leaf() { return 1; }\n");
    expect(await checkout.edit(["leaf.ts", "moved.ts"])).toMatchObject({ status: "published" });
    const after = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
    try {
      expect(after.prepare(`SELECT n.file_path, a.match_method FROM node_aliases a JOIN nodes n
        ON n.id = a.canonical_node_id WHERE a.alias_id = ?`).get(oldId))
        .toEqual({ file_path: "moved.ts", match_method: "signature" });
    } finally { after.close(); }
  });

  it("warms a v5 checkout after a v4 verification failure and records a matching v5 check", async () => {
    const root = await fixture();
    vi.stubEnv("MEX_GRAPH_MACHINE", "cores=4,totalMb=8192");
    const open = vi.spyOn(NativeGraphServer, "open");
    const location = graphLocation(root);
    writeGraphState(location.directory, { version: 1, warm: "off", checkedAt: new Date().toISOString() });
    registry = new WarmRegistry({ queueRefresh: vi.fn() });
    appendFileSync(join(root, "leaf.ts"), "// native edit\n");
    registry.note(location.projectId, root, ["leaf.ts"]);
    await registry.run();
    expect(open).toHaveBeenCalledWith(engine, location.directory, expect.objectContaining({
      limits: expect.objectContaining({ memoryMb: 512 }),
    }));
    expect(registry.warmCheckouts).toBe(1);
    expect(readGraphPointer(location)?.overlay).toBeTruthy();
    expect(await verifyGraph(root)).toEqual({ status: "match", files: 2 });
  });

  it.each(["crash", "stale base"] as const)("queues a normal refresh after a %s and opens warm again", async (failure) => {
    const root = await fixture();
    const location = graphLocation(root);
    const queued: string[] = [];
    const reasons: string[] = [];
    registry = new WarmRegistry({
      open: async path => { checkout = await openWarmCheckout(path); return checkout; },
      log: message => reasons.push(message),
      queueRefresh: (_id, path) => queued.push(path),
    }, { capMb: 4096, coolMs: 60_000, quietMs: 0, probeMs: 60_000 });
    const file = join(root, "leaf.ts");
    appendFileSync(file, "// warm up\n");
    registry.note(location.projectId, root, ["leaf.ts"]);
    await registry.run();
    expect(registry.warmCheckouts).toBe(1);
    if (failure === "crash") process.kill((checkout as NativeWarmCheckout).pid!, "SIGKILL");
    else await rebuildGraph(root);
    const before = currentGraphPath(root);

    appendFileSync(file, "// use normal refresh\n");
    registry.note(location.projectId, root, ["leaf.ts"]);
    await registry.run();
    expect(reasons.some(message => message.includes("went cold"))).toBe(true);
    expect(queued).toEqual([root]);
    expect(registry.warmCheckouts).toBe(0);
    expect(currentGraphPath(root)).toBe(before);
    expect(readdirSync(location.directory).filter(name => name.startsWith("graph-tmp-"))).toEqual([]);

    expect((await refreshGraph(root)).status.status).toBe("fresh");
    appendFileSync(file, "// warm again\n");
    registry.note(location.projectId, root, ["leaf.ts"]);
    await registry.run();
    expect(registry.warmCheckouts).toBe(1);
    expect(queued).toEqual([root]);
  });
});
