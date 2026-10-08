import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiTool, MexConfig, DriftReport } from "../src/types.js";
import { buildKnowledgeUpgradeBrief, planKnowledgeUpgrade, runKnowledgeUpgrade } from "../src/sync/knowledge-upgrade.js";

const ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(): { config: MexConfig; file: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "mex-upgrade-"));
  roots.push(projectRoot);
  const scaffoldRoot = join(projectRoot, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  const file = join(scaffoldRoot, "context", "architecture.md");
  writeFileSync(file, `---\nmex:\n  id: ${ID}\n  type: component\n  status: promoted\n  revision: 1\n  grounds_to:\n    - node: function:1111111111111111\n      fingerprint: mh:4:11111111\n      bodyHash: ${"a".repeat(64)}\n---\n# Queue\n\nThe queue retries and preserves order.\n`);
  return { config: { projectRoot, scaffoldRoot, aiTools: ["opencode"] }, file };
}
function dependencies() {
  const report: DriftReport = { score: 100, issues: [], filesChecked: 1, timestamp: new Date().toISOString() };
  return {
    write: vi.fn(), available: vi.fn(() => true), pickTool: vi.fn(async () => "opencode" as const),
    ensureFreshGraph: vi.fn(async () => {}), check: vi.fn(async () => report),
    runAgent: vi.fn<(tool: AiTool, brief: string, cwd: string) => boolean>(() => true), rebuild: vi.fn(async () => ({ entityCount: 1 })),
  };
}
describe("existing knowledge upgrade", () => {
  it("previews with no launch, write, graph maintenance or baseline acceptance", async () => {
    const f = fixture(); const d = dependencies(); const before = readFileSync(f.file, "utf8");
    await runKnowledgeUpgrade(f.config, {}, d);
    await runKnowledgeUpgrade(f.config, { apply: true, dryRun: true }, d);
    expect(d.runAgent).not.toHaveBeenCalled(); expect(d.pickTool).not.toHaveBeenCalled();
    expect(d.ensureFreshGraph).not.toHaveBeenCalled(); expect(d.rebuild).not.toHaveBeenCalled();
    expect(readFileSync(f.file, "utf8")).toBe(before);
    expect(buildKnowledgeUpgradeBrief(planKnowledgeUpgrade(f.config))).toContain("not proven multi-fact entities");
  });
  it("uses the sync agent chooser and rebuilds and checks after successful review", async () => {
    const f = fixture(); const d = dependencies();
    await runKnowledgeUpgrade(f.config, { apply: true }, d);
    expect(d.pickTool).toHaveBeenCalledWith(["opencode"]);
    expect(d.runAgent).toHaveBeenCalledWith("opencode", expect.stringContaining(ID), f.config.projectRoot);
    expect(d.rebuild).toHaveBeenCalledOnce(); expect(d.check).toHaveBeenCalledTimes(2);
  });
  it("honors an explicit supported agent override", async () => {
    const f = fixture(); const d = dependencies();
    await runKnowledgeUpgrade(f.config, { apply: true, tool: "codex" }, d);
    expect(d.pickTool).not.toHaveBeenCalled(); expect(d.runAgent.mock.calls[0]?.[0]).toBe("codex");
  });
  it("offers a copyable prompt when no CLI is installed", async () => {
    const f = fixture(); const d = { ...dependencies(), pickTool: vi.fn(async () => null) };
    await runKnowledgeUpgrade(f.config, { apply: true }, d);
    expect(d.runAgent).not.toHaveBeenCalled(); expect(d.ensureFreshGraph).not.toHaveBeenCalled();
    expect(d.write).toHaveBeenCalledWith(expect.stringContaining("Copy this review prompt"));
  });
  it("blocks review when the code graph cannot prove freshness", async () => {
    const f = fixture(); const d = dependencies(); d.ensureFreshGraph.mockRejectedValue(new Error("Graph stale"));
    await expect(runKnowledgeUpgrade(f.config, { apply: true }, d)).rejects.toThrow("Graph stale");
    expect(d.runAgent).not.toHaveBeenCalled(); expect(d.rebuild).not.toHaveBeenCalled();
  });
  it("blocks flagged candidate links, including legacy project-relative paths", async () => {
    const f = fixture(); const d = dependencies();
    d.check.mockResolvedValue({ score: 80, filesChecked: 1, timestamp: "2026-10-08", issues: [
      { code: "GROUNDING_NO_BASELINE", severity: "warning", file: ".mex/context/architecture.md", message: "No baseline" },
    ] });
    await expect(runKnowledgeUpgrade(f.config, { apply: true }, d)).rejects.toThrow("No agent was started");
    expect(d.runAgent).not.toHaveBeenCalled();
  });
  it("reports an agent failure without claiming completion or rebuilding", async () => {
    const f = fixture(); const d = dependencies(); d.runAgent.mockReturnValue(false);
    await expect(runKnowledgeUpgrade(f.config, { apply: true }, d)).rejects.toThrow("partial working-tree changes");
    expect(d.rebuild).not.toHaveBeenCalled();
  });
  it("honors read-only files and leaves already typed fact entities outside the coarse review", () => {
    const f = fixture();
    expect(planKnowledgeUpgrade({ ...f.config, wiki: { exclude: [], readOnly: ["context/**"] } }).candidates).toEqual([]);
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace("type: component", "type: fact"));
    expect(planKnowledgeUpgrade(f.config).candidates).toEqual([]);
  });
  it("bounds large reviews and resumes after a preserved parent even if it loses its grounding", () => {
    const f = fixture();
    const id = (index: number) => `mx_${String(index).padStart(26, "0")}`;
    const entities = Array.from({ length: 51 }, (_, index) => `<!-- mex:entity\nid: ${id(index)}\ntype: component\nstatus: promoted\nrevision: 1\ngrounds_to:\n  - node: function:1111111111111111\n    fingerprint: mh:4:11111111\n-->\n## Unit ${index}\n\nBehavior ${index}.\n\n`);
    writeFileSync(f.file, entities.join(""));
    const plan = planKnowledgeUpgrade(f.config);
    expect(plan.candidates).toHaveLength(50); expect(plan.truncated).toBe(true);
    writeFileSync(f.file, entities.map((entry, i) => i === 49 ? entry.replace(/grounds_to:[\s\S]*?-->/, "-->") : entry).join(""));
    expect(planKnowledgeUpgrade(f.config, id(49)).candidates.map(entry => entry.id)).toEqual([id(50)]);
    expect(buildKnowledgeUpgradeBrief(plan).length).toBeLessThan(16_000);
  });
});
