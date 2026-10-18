import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { loadInjectedChars, loadShown } from "../../session.js";
import { indexPathOf } from "../../index-file.js";
import { HOOK_LOG_NAME } from "../run.js";
import { createHookProject, promptPayload, toolPayload } from "./fixture.js";

afterEach(() => { cleanupProjects(); vi.unstubAllEnvs(); });

describe("graph delivery", () => {
  it("delivers and logs Grep/Bash graph context even with zero facts, and never repeats a named node", async () => {
    const p = await createHookProject();
    const path = indexPathOf(p.fx.context.localDir);
    const index = JSON.parse(readFileSync(path, "utf8")); index.entities = [];
    writeFileSync(path, JSON.stringify(index));
    const search = (session: string, tool = "Grep") => toolPayload(session, tool,
      tool === "Grep" ? { pattern: "calculateOrderTotal", path: join(p.fx.root, "src/report.ts") } : { command: "rg -n calculateOrderTotal src" },
      tool === "Grep" ? { content: "4: return calculateOrderTotal(items);" } : { stdout: "src/report.ts:4: return calculateOrderTotal(items);" });
    const first = p.text(await p.run(search("graph")));
    expect(first).toContain("MEX graph");
    expect(first).toContain("src/billing.ts:1-3");
    expect(await p.run(search("graph", "Bash"))).toBe("");
    expect(p.text(await p.run(search("bash", "Bash")))).toContain("MEX graph");
    expect(await p.run(toolPayload("read", "Read", { file_path: join(p.fx.root, "src/report.ts"), offset: 3, limit: 3 }))).toBe("");
    const logs = readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").map(s => JSON.parse(s));
    expect(logs[0]).toMatchObject({ kind: "graph", graphChars: first.length, ids: [] });
    expect(logs[0].graphNodes.length).toBeGreaterThan(0);
    expect(loadInjectedChars(p.fx.context.localDir, "graph")).toBe(first.length);
    vi.stubEnv("MEX_HOOK_GRAPH", "0");
    expect(await p.run(search("off"))).toBe("");
  });

  it("delivers a prompt identifier after knowledge abstains; budgets graph after knowledge without spending dedup keys", async () => {
    const p = await createHookProject();
    const payload = promptPayload("identifier", "Locate buildReport");
    expect(p.text(await p.run(payload))).toContain("MEX graph (definition");
    expect(await p.run(payload)).toBe("");
    p.fx.writeScaffoldFile("config.json", JSON.stringify({ context: { sessionBudgetChars: 1 } }));
    expect(await p.run(promptPayload("tiny", "Locate buildReport"))).toBe("");
    expect([...loadShown(p.fx.context.localDir, "tiny")].some(k => k.startsWith("graph:"))).toBe(false);
    vi.stubEnv("MEX_HOOK_GRAPH", "0");
    expect(await p.run(promptPayload("off", "Locate buildReport"))).toBe("");
  });

  it("adds impact after knowledge on Edit, and supplies impact with no linked fact", async () => {
    const p = await createHookProject();
    p.fx.writeSource("src/billing.ts", readFileSync(join(p.fx.root, "src/billing.ts"), "utf8").replace("return items.length;", "return items.length + 1;"));
    const edit = toolPayload("impact", "Edit", { file_path: join(p.fx.root, "src/billing.ts") });
    const note = p.text(await p.run(edit));
    expect(note).toContain("MEX graph (impact");
    expect(note).toContain("check callers: #buildReport");
    expect(note.indexOf("MEX graph")).toBeGreaterThan(note.indexOf("MEX knowledge"));
    expect(await p.run(edit)).toBe("");
    const path = indexPathOf(p.fx.context.localDir);
    const index = JSON.parse(readFileSync(path, "utf8")); index.entities = [];
    writeFileSync(path, JSON.stringify(index));
    expect(p.text(await p.run({ ...edit, session_id: "no-facts" }))).toContain("check callers: #buildReport");
  });
});
