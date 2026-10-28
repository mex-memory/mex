import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph, cleanupProjects, createProject, graphSymbol, writeEntities } from "../../__tests__/fixture.js";
import { indexPathOf } from "../../index-file.js";
import { ensureContextIndex } from "../../index-store.js";
import { isValidSessionId, loadInjectedChars, loadShown, loadStats } from "../../session.js";
import { preflightHook } from "../../../hooks/preflight.js";
import { classifyHook, runHook, bashGrepHits, HOOK_LOG_NAME, type HookPayload } from "../run.js";
import * as diff from "../diff.js";
import * as settle from "../settle.js";
import { BILLING_V1, createHookProject, git, promptPayload, toolPayload } from "./fixture.js";

const probe: Array<{ event: string; stdin: string }> = readFileSync(join(__dirname, "fixtures/codex-probe.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const sid = JSON.parse(probe[1]!.stdin).session_id;
const wrap = (body: string) => `Exit code: 0\nWall time: 0.1 seconds\nOutput:\n${body}`;
function citeClaims(p: Awaited<ReturnType<typeof createHookProject>>) {
  const path = indexPathOf(p.fx.context.localDir);
  const index = JSON.parse(readFileSync(path, "utf8"));
  for (const entity of index.entities) for (const symbol of entity.symbols) entity.body += ` Evidence: ${symbol.file}:${symbol.start + 1}-${symbol.end}.`;
  writeFileSync(path, JSON.stringify(index));
}
const patch = (file: string, body: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n${body}\n*** End Patch`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupProjects(); });

describe("Codex probe replay", () => {
  it("classifies and preflights every measured payload; delivers prompt/read notes and the precise edit outcome", async () => {
    vi.stubEnv("MEX_HOOK_READ", "1"); vi.stubEnv("MEX_HOOK_EDIT", "1"); vi.stubEnv("MEX_HOOK_GRAPH", "0");
    const fx = createProject("mex-codex-probe-");
    fx.writeSource("math.js", "export function add(a, b) {\n  return a + b;\n}\n");
    fx.writeSource(".gitignore", ".mex/graph.db*\n.mex/local/\n");
    await buildGraph(fx);
    const symbol = graphSymbol(fx, "add");
    const ids = writeEntities(fx, "context/math.md", [
      { title: "Project codename is PELICAN", body: "The project codename is PELICAN. Quote the codename when asked about this project." },
      { title: "Arithmetic follows JavaScript coercion", body: "Arithmetic uses the native operator, including its coercion rules for nonnumeric operands.", groundings: [{ node: symbol.id, file: symbol.file, bodyHash: symbol.bodyHash }] },
      { title: "Add sums two numbers", body: "The add function in math.js adds two numbers with the JavaScript addition operator.", groundings: [{ node: symbol.id, file: symbol.file, bodyHash: symbol.bodyHash }] },
    ]);
    await ensureContextIndex(fx.context, "force");
    git(fx.root, "init", "-q"); git(fx.root, "add", "-A"); git(fx.root, "commit", "-qm", "base");
    const outputs: string[] = [];
    const events = [null, "prompt", "bash", "edit", "bash", "stop"];
    for (let i = 0; i < probe.length; i++) {
      const payload: HookPayload = JSON.parse(probe[i]!.stdin.replaceAll("/probe/repo", fx.root.replace(/\\/g, "/")));
      // The recorded Windows path separator is normalized when replayed elsewhere.
      if (payload.tool_name === "apply_patch") {
        (payload.tool_input as any).command = (payload.tool_input as any).command.replace(/\\math\.js/g, "/math.js");
        fx.writeSource("math.js", "// adds two numbers\nexport function add(a, b) {\n  return a + b;\n}\n");
      }
      expect(classifyHook(payload)).toBe(events[i]);
      expect(await preflightHook(JSON.stringify(payload), fx.root)).toBe(i > 0);
      outputs.push((await runHook(JSON.stringify(payload), { cwd: fx.root, lexical: true, tools: { read: true, edit: true, search: true } })).stdout);
    }
    expect(outputs[0]).toBe("");
    expect(outputs[1]).toContain("Add sums two numbers");
    expect(outputs[2]).toContain("Arithmetic follows JavaScript coercion");
    // The probe adds a comment before the function: no grounded body line changed.
    expect(outputs[3]).toBe("");
    expect(outputs[4]).toBe(""); // The measured rg was unavailable, not a search hit.
    expect(outputs[5]).toBe("");
    const logs = readFileSync(join(fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(logs.every(l => l.host === "codex" && l.recipe === "lexical")).toBe(true);
    expect(logs.find(l => l.event === "edit").note).toBe("nothing-touched");
    expect(isValidSessionId(sid)).toBe(true);
    expect(loadShown(fx.context.localDir, sid).has(ids[1]!)).toBe(true);
    expect(loadShown(fx.context.localDir, sid).has(ids[2]!)).toBe(true);
    expect(loadInjectedChars(fx.context.localDir, sid)).toBe(outputs.slice(1, 3).reduce((n, out) => n + JSON.parse(out).hookSpecificOutput.additionalContext.length, 0));
    expect(loadStats(fx.context.localDir, sid)[diff.hunksKey("math.js")]).toBeTruthy();
  });
});

describe("Codex runtime", () => {
  it("attributes a real body edit without including dirty lines from before the patch, and deduplicates it", async () => {
    vi.stubEnv("MEX_HOOK_GRAPH", "0");
    const p = await createHookProject();
    citeClaims(p);
    // Older dirty lines and the new edit deliberately coalesce into one Git hunk.
    const prior = BILLING_V1.replace("return items.length;", "return items.length + 10;")
      .replace("}\n\nexport function applyDiscount(total: number): number {", "} // prior\n// prior\nexport function applyDiscount(total: number): number { // prior");
    p.fx.writeSource("src/billing.ts", prior);
    await p.run(promptPayload(sid, "unmatched words"));
    p.fx.writeSource("src/billing.ts", prior.replace("return total - 1;", "return total - 2;"));
    const payload = { ...toolPayload(sid, "apply_patch", { command: patch("src/billing.ts", "-  return total - 1;\n+  return total - 2;") }, wrap("Success")), turn_id: "turn" };
    const result = p.text(await p.run(payload));
    expect(result).toContain("Discounts subtract one flat unit");
    expect(result).not.toContain("Order totals count the items");
    expect(await p.run(payload)).toBe("");
    expect(await p.run(toolPayload(sid, "Bash", { command: "pwd" }))).toBe("");
  });
  it("edits every patched linked file and judges a move's old and new names", async () => {
    const p = await createHookProject();
    citeClaims(p);
    await p.run(promptPayload(sid, "unmatched words"));
    p.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    p.fx.writeSource("src/report.ts", 'export function buildReport(items: number[]): number {\n  return 0;\n}\n');
    const command = `*** Begin Patch\n*** Update File: src/billing.ts\n@@\n-  return total - 1;\n+  return total - 2;\n*** Update File: src/report.ts\n@@\n-export function buildReport(items: number[]): number {\n-  return calculateOrderTotal(items);\n-}\n+export function buildReport(items: number[]): number {\n+  return 0;\n+}\n*** End Patch`;
    expect(p.text(await p.run(toolPayload(sid, "apply_patch", { command }, wrap("Success"))))).toContain("Discounts subtract one flat unit");
    const stats = loadStats(p.fx.context.localDir, sid);
    expect(stats["src/billing.ts"]).toBeTruthy(); expect(stats["src/report.ts"]).toBeTruthy();
    p.git("mv", "src/billing.ts", "src/moved.ts");
    const moved = await p.run(toolPayload("move", "apply_patch", { command: "*** Begin Patch\n*** Update File: src/billing.ts\n*** Move to: src/moved.ts\n*** End Patch" }, wrap("Success")));
    expect(p.text(moved)).toContain("Order totals count the items");
    expect(loadStats(p.fx.context.localDir, "move")["src/moved.ts"]).toBeTruthy();
  });
  it("skips unlinked patch files with graph notes off without starting git diff or scanning linked signatures", async () => {
    vi.stubEnv("MEX_HOOK_GRAPH", "0");
    const p = await createHookProject();
    citeClaims(p);
    p.fx.writeSource("src/unlinked.ts", "new\n");
    const scoped = vi.spyOn(diff, "diffAgainstHeadAsync"); const sync = vi.spyOn(diff, "diffAgainstHead"); const stat = vi.spyOn(diff, "fileSignature");
    expect(await p.run(toolPayload(sid, "apply_patch", { command: patch("src/unlinked.ts", "-old\n+new") }, wrap("Success")))).toBe("");
    expect(scoped).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
    expect(await p.run(toolPayload(sid, "apply_patch", { command: patch(".mex/AGENTS.md", "-old\n+new") }, wrap("Success")))).toBe("");
    expect(scoped).not.toHaveBeenCalled();
    expect(await p.run(toolPayload(sid, "apply_patch", { command: patch("src/billing.ts", "-old\n+new") }, "Exit code: 1\nWall time: 0.1 seconds\nOutput:\nFailed"))).toBe("");
    expect(scoped).not.toHaveBeenCalled();
  });
  it("maps PowerShell search output and reads to the existing composers, from a subdirectory cwd", async () => {
    const p = await createHookProject();
    citeClaims(p);
    const payload = { ...toolPayload(sid, "Bash", { command: "Get-Content -Path billing.ts -TotalCount 3" }, wrap("source")), cwd: join(p.fx.root, "src"), turn_id: "turn" };
    expect(p.text(await p.run(payload))).toContain("Order totals count the items");
    expect(await p.run(payload)).toBe("");
    const search = { ...payload, session_id: "search", tool_input: { command: "Get-ChildItem . | Select-String -Pattern applyDiscount" }, tool_response: wrap("billing.ts:6:  return total - 1;") };
    expect(bashGrepHits(search, p.fx.root, join(p.fx.root, "src"))).toEqual([{ file: "src/billing.ts", line: 6 }]);
    expect(p.text(await p.run(search))).toContain("Discounts subtract one flat unit");
    expect(await p.run(search)).toBe("");
  });
  it("narrows Codex numbered-shell slices without changing the Claude replay", async () => {
    const p = await createHookProject();
    const input = toolPayload("slice-claude", "Bash", { command: "nl -ba src/billing.ts | sed -n '9,11p'" });
    const before = p.text(await p.run(input));
    const after = p.text(await p.run({ ...input, session_id: "slice-codex", turn_id: "turn" }));
    expect(before).toContain("Order totals count the items");
    expect(before).toContain("Discounts subtract one flat unit");
    expect(after).toContain("Invoices print the plain total");
    expect(after).not.toContain("Order totals count the items");
    expect(after).not.toContain("Discounts subtract one flat unit");
    expect(after.length).toBeLessThan(before.length);
  });
  it("uses the same non-blocking Stop path, carries the host to settle, and honours stop_hook_active", async () => {
    const p = await createHookProject();
    citeClaims(p);
    await p.run(promptPayload(sid, "unmatched words"));
    p.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    const start = vi.spyOn(settle, "startSettle").mockResolvedValue("started");
    const payload = { hook_event_name: "Stop", session_id: sid, turn_id: "turn", stop_hook_active: false };
    expect(await p.run(payload)).toBe("");
    expect(start.mock.calls[0]![2]!.env!.MEX_HOOK_HOST).toBe("codex");
    vi.stubEnv("MEX_HOOK_STOP_REVIEW", "1");
    expect(await p.run({ ...payload, session_id: "active", stop_hook_active: true })).toBe("");
    const logs = readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8");
    expect(logs).toContain('"host":"codex"'); expect(logs).toContain('"settle":"started"');
  });
});
