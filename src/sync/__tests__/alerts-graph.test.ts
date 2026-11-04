import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGraphEngine } from "../../graph/engine-impl.js";
import { serializeFingerprint } from "../../graph/fingerprint.js";
import { loadGroundingRuntime, refreshGroundingBaselines } from "../../graph/runtime.js";
import { writeGroundings } from "../../markdown.js";
import { runDriftAlertPass } from "../alert-pass.js";
import { detectDrift } from "../detect.js";

it("alerts for a drifted grounding revealed by rebuilding a missing graph, with no further source edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-alert-graph-"));
  const source = join(root, "src/service.ts");
  const doc = join(root, ".mex/context/architecture.md");
  const config = { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] };
  const original = "export function orderTotal(items: number[]): number { const subtotal = items.reduce((sum, item) => sum + item, 0); const tax = subtotal * 0.18; const shipping = subtotal > 1000 ? 0 : 75; const discount = items.length > 5 ? subtotal * 0.05 : 0; return subtotal + tax + shipping - discount; }\n";
  const build = async () => {
    const engine = createGraphEngine({ rootDir: root });
    try { await engine.build(); } finally { engine.close(); }
  };
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, ".mex/context"), { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(join(root, ".mex/ROUTER.md"), `---\nname: router\ndescription: Test navigation\nlast_updated: "${date}"\n---\n# Test\n`);
    writeFileSync(join(root, "AGENTS.md"), "Read .mex/ROUTER.md before project work.\n");
    writeFileSync(doc, `---\nname: architecture\ndescription: Order totals\nlast_updated: "${date}"\n---\n# Architecture\n`);
    writeFileSync(source, original);
    await build();
    const runtime = await loadGroundingRuntime(config);
    try {
      const node = runtime!.graph.searchNodes("orderTotal").find((n) => n.kind === "function")!;
      writeFileSync(doc, writeGroundings(readFileSync(doc, "utf8"), [{
        node: node.id, fingerprint: serializeFingerprint(runtime!.reconciler.getFingerprint(node.id)!),
      }]));
      refreshGroundingBaselines(config, [doc], runtime!);
    } finally { runtime!.close(); }
    writeFileSync(source, original.replace("subtotal * 0.18", "subtotal * 0.21"));
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, `.mex/graph.db${suffix}`), { force: true });
    const notify = vi.fn(async () => true);
    expect(await detectDrift(config)).toMatchObject({ state: "in_sync", codeLinks: "partial" });
    await expect(runDriftAlertPass(root, { afterCommit: true, notify })).resolves.toBe("checked");
    await build();
    expect(await detectDrift(config)).toMatchObject({ state: "needs_sync", codeLinks: "checked" });
    await expect(runDriftAlertPass(root, { afterCommit: true, notify })).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledTimes(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
