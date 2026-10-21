import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { loadInjectedChars, loadShown } from "../../session.js";
import { indexPathOf } from "../../index-file.js";
import { commandFiles, HOOK_LOG_NAME, mayWriteFiles } from "../run.js";
import { createHookProject, promptPayload, toolPayload } from "./fixture.js";

beforeEach(() => { vi.stubEnv("MEX_HOOK_GRAPH_IMPACT", "1"); });
afterEach(() => { cleanupProjects(); vi.unstubAllEnvs(); });

describe("graph delivery", () => {
  it("delivers and logs Grep/Bash graph context even with zero facts, and never repeats a named node", async () => {
    const p = await createHookProject();
    const path = indexPathOf(p.fx.context.localDir);
    const index = JSON.parse(readFileSync(path, "utf8")); index.entities = [];
    writeFileSync(path, JSON.stringify(index));
    const search = (session: string, tool = "Grep") => toolPayload(session, tool,
      tool === "Grep" ? { pattern: "calculateOrderTotal", path: join(p.fx.root, "src/report.ts") } : { command: "rg -n calculateOrderTotal src" },
      tool === "Grep" ? { content: "src/billing.ts:2: return items.length;\nsrc/report.ts:4: return calculateOrderTotal(items);" } : { stdout: "src/billing.ts:2: return items.length;\nsrc/report.ts:4: return calculateOrderTotal(items);" });
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

  it("still gives an edited symbol its impact note when a search note already named it, once", async () => {
    const p = await createHookProject();
    // The pilot's case: a search note lists the symbol (here as a definition); the agent then edits it.
    const search = toolPayload("seen", "Grep", { pattern: "calculateOrderTotal", path: join(p.fx.root, "src/report.ts") }, { content: "src/billing.ts:2: return items.length;\nsrc/report.ts:4: return calculateOrderTotal(items);" });
    expect(p.text(await p.run(search))).toContain("src/billing.ts:1-3 #calculateOrderTotal");
    const index = JSON.parse(readFileSync(indexPathOf(p.fx.context.localDir), "utf8")); index.entities = [];
    writeFileSync(indexPathOf(p.fx.context.localDir), JSON.stringify(index));
    p.fx.writeSource("src/billing.ts", readFileSync(join(p.fx.root, "src/billing.ts"), "utf8").replace("return items.length;", "return items.length + 1;"));
    const edit = toolPayload("seen", "Edit", { file_path: join(p.fx.root, "src/billing.ts") });
    expect(p.text(await p.run(edit))).toContain("#calculateOrderTotal src/billing.ts:1-3 | check callers: #buildReport");
    p.fx.writeSource("src/billing.ts", readFileSync(join(p.fx.root, "src/billing.ts"), "utf8").replace("return items.length + 1;", "return items.length + 2;"));
    expect(await p.run(edit)).toBe("");
    const logs = readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").map(s => JSON.parse(s));
    // A silent edit says why in the log.
    expect(logs.at(-1)).toMatchObject({ event: "edit", chars: 0, note: "nothing-touched" });
  });

  it("judges an edit that rewrote the whole file with CRLF line ends by its real change", async () => {
    const p = await createHookProject();
    // The checkout keeps LF (core.autocrlf=false); a Python script on Windows writes CRLF back.
    p.git("config", "core.autocrlf", "false");
    const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");
    const path = join(p.fx.root, "src/billing.ts");
    p.fx.writeSource("src/billing.ts", crlf(readFileSync(path, "utf8").replace("return items.length;", "return items.length + 1;")));
    const note = p.text(await p.run(toolPayload("crlf", "Edit", { file_path: path })));
    expect(note).toContain("#calculateOrderTotal");
    expect(note).not.toContain(p.ids.discount);
    expect(note).not.toContain(p.ids.invoice);
    expect(note).toContain("check callers: #buildReport");
    // Line ends alone are no change at all.
    p.git("checkout", "--", "src/billing.ts");
    p.fx.writeSource("src/billing.ts", crlf(readFileSync(path, "utf8")));
    expect(await p.run(toolPayload("crlf-only", "Edit", { file_path: path }))).toBe("");
    const logs = readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").map(s => JSON.parse(s));
    expect(logs.at(-1)).toMatchObject({ event: "edit", chars: 0, note: "no-change" });
  });
});

describe("shell edits", () => {
  it("tells writing commands from read-only ones", () => {
    for (const command of ["python - <<'E'\nopen('a.py','w').write('x')\nE", "sed -i 's/a/b/' src/a.ts", "cat > a.txt <<EOF", "node fix.mjs", "npx prettier --write src", "git checkout -- src/a.ts", "find . -name '*.pyc' -delete", "echo x > a.txt"]) {
      expect(mayWriteFiles(command), command).toBe(true);
    }
    for (const command of ["rg -n foo src", "cd src && grep -rn foo . | head -20", "sed -n 1,40p a.py", "git diff --stat", "git log --oneline -5 2>/dev/null", "cat a.py 2>&1 | head", "ls -la; wc -l a.py", ""]) {
      expect(mayWriteFiles(command), command).toBe(false);
    }
  });

  it("finds the files a command names, from arguments, inline scripts and cd targets", async () => {
    const p = await createHookProject();
    expect(commandFiles(p.fx.root, "sed -i 's/a/b/' src/billing.ts missing.py")).toEqual(["src/billing.ts"]);
    expect(commandFiles(p.fx.root, "cd src; python - <<'E'\np='report.ts'\nopen(p).read()\nE")).toEqual(["src/report.ts"]);
    expect(commandFiles(p.fx.root, `node -e "x" ${join(p.fx.root, "src/billing.ts")} .mex/config.json`)).toEqual(["src/billing.ts"]);
  });

  it("gives a shell edit the impact note, once per symbol, and never for changes made before the session", async () => {
    const p = await createHookProject();
    const path = indexPathOf(p.fx.context.localDir);
    const index = JSON.parse(readFileSync(path, "utf8")); index.entities = [];
    writeFileSync(path, JSON.stringify(index));
    const billing = join(p.fx.root, "src/billing.ts");
    // A change already in the working tree when the session starts is not the agent's.
    p.fx.writeSource("src/billing.ts", readFileSync(billing, "utf8").replace("return items.length;", "return items.length * 1;"));
    await p.run(promptPayload("shell", "Fix the order total"));
    const bash = (command: string) => toolPayload("shell", "Bash", { command }, { stdout: "" });
    // The agent's script edits applyDiscount (no production caller): the earlier hunk in the same file is not reported.
    p.fx.writeSource("src/billing.ts", readFileSync(billing, "utf8").replace("return total - 1;", "return total - 3;"));
    expect(await p.run(bash("cd src && python - <<'E'\np = 'billing.ts'\nE"))).toBe("");
    // A read-only command starts no git process and reports nothing, even with a new change waiting.
    p.fx.writeSource("src/billing.ts", readFileSync(billing, "utf8").replace("return items.length * 1;", "return items.length + 1;"));
    expect(await p.run(bash("cat src/billing.ts"))).toBe("");
    const note = p.text(await p.run(bash("cd src && python - <<'E'\np = 'billing.ts'\nE")));
    expect(note).toContain("MEX graph (impact");
    expect(note).toContain("#calculateOrderTotal src/billing.ts:1-3 | check callers: #buildReport");
    // The same symbol edited again: no second note.
    p.fx.writeSource("src/billing.ts", readFileSync(billing, "utf8").replace("return items.length + 1;", "return items.length + 2;"));
    expect(await p.run(bash("sed -i s/2/3/ src/billing.ts"))).toBe("");
    // A writing command that names no file is not diffed (a whole-tree diff costs too much per call).
    p.fx.writeSource("src/report.ts", readFileSync(join(p.fx.root, "src/report.ts"), "utf8").replace("return calculateOrderTotal(items);", "return calculateOrderTotal(items) + 0;"));
    expect(await p.run(bash("python fix.py"))).toBe("");
  });
});
