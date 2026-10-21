import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph, cleanupProjects } from "../../__tests__/fixture.js";
import { indexPathOf } from "../../index-file.js";
import { PACKET_CHAR_LIMIT } from "../../packet.js";
import { sessionDirOf } from "../../session.js";
import { GREP_NOTE_CHAR_LIMIT } from "../events.js";
import { HOOK_LOG_NAME } from "../run.js";
import { BILLING_V1, createHookProject, promptPayload, toolPayload, type HookProject } from "./fixture.js";

let project: HookProject;

afterEach(() => {
  cleanupProjects();
  vi.unstubAllEnvs();
});

const PROMPT = "The order total looks wrong: does the order total count the items in the basket, and does a discount change it?";

const read = (session: string, file: string, range: { offset?: number; limit?: number } = {}) =>
  toolPayload(session, "Read", { file_path: join(project.fx.root, file), ...range });

describe("shell exploration", () => {
  it("routes shell source reads through range selection and session dedup", async () => {
    const p = await createHookProject();
    for (const command of ["sed -n '1,3p' src/billing.ts", "head -n 3 src/billing.ts", "cat src/billing.ts", "nl -ba src/billing.ts"]) {
      const payload = toolPayload(command, "Bash", { command });
      const first = await p.run(payload);
      expect(p.text(first)).toContain("Order totals count the items");
      expect(await p.run(payload)).not.toBe(first);
    }
    const tail = p.text(await p.run(toolPayload("tail", "Bash", {command:"tail -n 3 src/billing.ts"})));
    expect(tail).toContain("Invoices print the plain total");
    expect(tail).not.toContain("Order totals count the items");
  });

  it("logs compound searches and their actual silence reason", async () => {
    const p = await createHookProject();
    await p.run(toolPayload("search", "Bash", {command:"rg calculateOrderTotal src | head"}, {stdout:""}));
    const log = readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(log.at(-1)).toMatchObject({event:"search-compound",note:"no-search-hits"});
    const payload = toolPayload("search", "Bash", {command:"pwd && rg -n calculateOrderTotal src | head"}, {stdout:"src/report.ts:4: return calculateOrderTotal(items);"});
    expect(p.text(await p.run(payload))).toContain("calculateOrderTotal");
    expect(await p.run(payload)).toBe("");
    const last = JSON.parse(readFileSync(join(p.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({event:"search-compound",note:"no-new-search-context"});
    const single = await p.run(toolPayload("single", "Bash", {command:"cd src && grep -n calculateOrderTotal report.ts | head"}, {stdout:"4: return calculateOrderTotal(items);"}));
    expect(p.text(single)).toContain("calculateOrderTotal");
    const mixed = p.text(await p.run(toolPayload("mixed", "Bash", {command:"rg -n calculateOrderTotal src/report.ts; rg -n formatInvoice src/billing.ts"}, {stdout:"src/report.ts:4: return calculateOrderTotal(items);\nsrc/billing.ts:9: function formatInvoice()"})));
    expect(mixed).toContain("calculateOrderTotal");
    expect(mixed).not.toContain("formatInvoice");
  });
});

describe("hook output", () => {
  it("prints hookSpecificOutput.additionalContext for a matching prompt", async () => {
    project = await createHookProject();
    const stdout = await project.run(promptPayload("s-prompt", PROMPT));
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("MEX knowledge (fresh · lexical) — Order totals count the items");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("code: src/billing.ts:1-3 #calculateOrderTotal");
  });

  it("skips a prompt that is a background task notification", async () => {
    project = await createHookProject();
    expect(await project.run(promptPayload("s-note", `<task-notification>${PROMPT}</task-notification>`))).toBe("");
  });

  it("does not repeat a fact the session already saw, across events", async () => {
    project = await createHookProject();
    expect(await project.run(promptPayload("s-dedup", PROMPT))).not.toBe("");
    expect(await project.run(promptPayload("s-dedup", PROMPT))).toBe("");
    // The same fact is not repeated by a read either; a new session sees it again.
    expect(project.text(await project.run(read("s-dedup", "src/billing.ts")))).not.toContain("Order totals count the items");
    expect(project.text(await project.run(read("s-other", "src/billing.ts")))).toContain("Order totals count the items");
  });

  it("is silent outside a MEX project and for events it does not handle", async () => {
    project = await createHookProject();
    expect(await project.run({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "WebFetch", tool_input: {} })).toBe("");
    expect(await project.run({ hook_event_name: "SessionStart", session_id: "s" })).toBe("");
    expect(await project.run({ hook_event_name: "Stop", session_id: "s" })).toBe("");
  });
});

describe("read", () => {
  it("shows the facts linked to the file and a live health label", async () => {
    project = await createHookProject();
    const text = project.text(await project.run(read("s-read", "src/billing.ts")));
    expect(text).toContain("MEX knowledge (fresh · read) — Order totals count the items");
    expect(text).toContain("more: mex wiki show");
    expect(text.length).toBeLessThanOrEqual(PACKET_CHAR_LIMIT);
  });

  it("filters by the lines actually read", async () => {
    project = await createHookProject();
    const text = project.text(await project.run(read("s-range", "src/billing.ts", { offset: 5, limit: 3 })));
    expect(text).toContain("Discounts subtract one flat unit");
    expect(text).not.toContain("Order totals count the items");
    expect(text).not.toContain("Invoices print the plain total");
    // Reading only the top three lines shows only the first function's fact.
    const top = project.text(await project.run(read("s-range-2", "src/billing.ts", { limit: 3 })));
    expect(top).toContain("Order totals count the items");
    expect(top).not.toContain("Discounts subtract");
  });

  it("shows at most two facts and points at the rest", async () => {
    project = await createHookProject();
    const text = project.text(await project.run(read("s-many", "src/billing.ts")));
    expect(text.match(/MEX knowledge \(/g)).toHaveLength(2);
    expect(text).toMatch(/\+1 more fact about src\/billing\.ts: mex wiki show mx_/);
  });

  it("labels a fact whose linked code changed as changed, verify before relying", async () => {
    project = await createHookProject();
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return Math.max(0, total - 1);"));
    await buildGraph(project.fx);
    const text = project.text(await project.run(read("s-changed", "src/billing.ts", { offset: 5, limit: 3 })));
    expect(text).toContain("changed ⚠");
    expect(text).toContain("verify before relying");
    // A fact about code that did not change stays fresh.
    const fresh = project.text(await project.run(read("s-changed-2", "src/billing.ts", { limit: 3 })));
    expect(fresh).toContain("(fresh · read)");
  });

  it("is silent for files with no linked fact and for files outside the project or inside .mex", async () => {
    project = await createHookProject();
    expect(await project.run(read("s-none", "src/report.ts"))).toBe("");
    expect(await project.run(read("s-out", "../elsewhere.ts"))).toBe("");
    expect(await project.run(read("s-mex", ".mex/context/billing.md"))).toBe("");
  });

  it("keeps a packet under 4000 characters however long the facts are", async () => {
    project = await createHookProject({ extraFacts: 6 });
    const stdout = await project.run(read("s-big", "src/billing.ts", { limit: 3 }));
    expect(project.text(stdout).length).toBeLessThanOrEqual(PACKET_CHAR_LIMIT);
    expect(stdout).not.toBe("");
  });
});

describe("edit and Bash diff", () => {
  const editCall = (session: string, file = "src/billing.ts") => toolPayload(session, "Edit", { file_path: join(project.fx.root, file), old_string: "a", new_string: "b" });

  it("names the facts whose linked code the edit touched, with the .mex line to update", async () => {
    project = await createHookProject();
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    const text = project.text(await project.run(editCall("s-edit")));
    expect(text).toContain("you changed src/billing.ts");
    expect(text).toContain("Discounts subtract one flat unit");
    expect(text).not.toContain("Order totals count the items");
    expect(text).toMatch(/rewrite its prose at \.mex\/context\/billing\.md:\d+/);
    expect(text).toContain("Never edit <!-- mex:entity --> blocks, ids or fingerprints");
    expect(text).not.toMatch(/re-?record (the )?fingerprint/i);
  });

  it("does not ask again about a fact it already raised", async () => {
    project = await createHookProject();
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    expect(await project.run(editCall("s-twice"))).not.toBe("");
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 3;"));
    expect(await project.run(editCall("s-twice"))).toBe("");
  });

  it("matches hunks against where the code stood at HEAD, not where the rebuilt graph puts it", async () => {
    project = await createHookProject();
    // Session start: the first event records where each fact's code stood.
    await project.run(promptPayload("s-base", PROMPT));
    // Four lines are added above everything and one line of formatInvoice changes; the graph is rebuilt,
    // so formatInvoice now lives at lines 13-15 and applyDiscount at 9-11.
    const edited = `// one\n// two\n// three\n// four\n${BILLING_V1.replace("Total: ${total}", "Sum: ${total}")}`;
    project.fx.writeSource("src/billing.ts", edited);
    await buildGraph(project.fx);
    const text = project.text(await project.run(editCall("s-base-edit")));
    expect(text).toContain("Invoices print the plain total");
    expect(text).not.toContain("Discounts subtract one flat unit");
  });

  it("is silent when the edit touches no linked code, and for files no fact links", async () => {
    project = await createHookProject();
    project.fx.writeSource("src/billing.ts", `${BILLING_V1}\nexport const NOTE = 1;\n`);
    expect(await project.run(editCall("s-quiet"))).toBe("");
    project.fx.writeSource("src/report.ts", "// changed\n");
    expect(await project.run(editCall("s-quiet-2", "src/report.ts"))).toBe("");
  });

  it("finds edits made through Bash and does not look again when nothing changed", async () => {
    project = await createHookProject();
    const bash = (session: string, command = "sed -i s/1/2/ src/billing.ts") => toolPayload(session, "Bash", { command }, { stdout: "", stderr: "" });
    await project.run(promptPayload("s-bash", PROMPT));
    expect(await project.run(bash("s-bash"))).toBe("");
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    const text = project.text(await project.run(bash("s-bash")));
    expect(text).toContain("Discounts subtract one flat unit");
    expect(await project.run(bash("s-bash", "npm test"))).toBe("");
  });

  it("does not blame the agent for changes that were already in the working tree when the session began", async () => {
    project = await createHookProject();
    project.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    await project.run(promptPayload("s-dirty", PROMPT));
    const bash = toolPayload("s-dirty", "Bash", { command: "ls" }, { stdout: "x" });
    expect(await project.run(bash)).toBe("");
  });
});

describe("grep", () => {
  const grepCall = (session: string, content: string) =>
    toolPayload(session, "Grep", { pattern: "calculateOrderTotal" }, { mode: "content", numFiles: 3, filenames: [], content, numLines: 3 });

  it("maps hits to the enclosing symbol, its fact and callers by id, marking tests", async () => {
    project = await createHookProject();
    const stdout = await project.run(
      grepCall("s-grep", "src/billing.ts:2:  return items.length;\nsrc/report.ts:4:  return calculateOrderTotal(items);\ntests/billing.test.ts:4:  return calculateOrderTotal([1, 2]);"),
    );
    const text = project.text(stdout);
    expect(text).toContain("in #calculateOrderTotal (src/billing.ts:1-3)");
    expect(text).toContain("fact [fresh]");
    expect(text).toContain("Order totals count the items");
    expect(text).toContain("callers:");
    expect(text).toContain("#buildReport src/report.ts:3");
    expect(text).toContain("#checksTotal tests/billing.test.ts:3 [test]");
    expect(text).toContain("tests/billing.test.ts:4 [test]");
    expect(text.length).toBeLessThanOrEqual(GREP_NOTE_CHAR_LIMIT);
  });

  it("reads search output from a Bash rg or grep call", async () => {
    project = await createHookProject();
    const stdout = await project.run(
      toolPayload("s-rg", "Bash", { command: "rg -n applyDiscount src" }, { stdout: "src/billing.ts:6:  return total - 1;\n", stderr: "" }),
    );
    expect(project.text(stdout)).toContain("Discounts subtract one flat unit");
    // A Bash call that is not a search is not read for hits.
    const other = await project.run(
      toolPayload("s-echo", "Bash", { command: "echo hi" }, { stdout: "src/billing.ts:6:  return total - 1;\n", stderr: "" }),
    );
    expect(other).toBe("");
  });

  it("offers graph navigation without a fact and deduplicates both tiers", async () => {
    project = await createHookProject();
    expect(project.text(await project.run(grepCall("s-grep-none", "src/report.ts:4:  return calculateOrderTotal(items);")))).toContain("MEX graph");
    expect(await project.run(grepCall("s-grep-seen", "src/billing.ts:2:  return items.length;"))).not.toBe("");
    expect(await project.run(grepCall("s-grep-seen", "src/billing.ts:2:  return items.length;"))).toBe("");
  });

  it("looks at the top five files only and keeps the note under 1200 characters", async () => {
    project = await createHookProject({ extraFacts: 5 });
    const files = Array.from({ length: 9 }, (_, i) => `src/other${i}.ts:1:  nothing`).join("\n");
    const text = project.text(await project.run(grepCall("s-cap", `${files}\nsrc/billing.ts:2:  return items.length;`)));
    // The ninth file is past the five-file horizon, so the billing hit is never mapped.
    expect(text).toBe("");
    const top = project.text(await project.run(grepCall("s-cap-2", "src/billing.ts:2:  return items.length;\nsrc/billing.ts:6:  return total - 1;\nsrc/billing.ts:10:  return 1;")));
    expect(top.length).toBeLessThanOrEqual(GREP_NOTE_CHAR_LIMIT);
    expect(top).not.toBe("");
  });

  it("maps file-name-only output to one fact per file", async () => {
    project = await createHookProject();
    const stdout = await project.run(toolPayload("s-files", "Grep", { pattern: "x" }, { mode: "files_with_matches", numFiles: 1, filenames: ["src/billing.ts"] }));
    expect(project.text(stdout)).toContain("MEX (search hits");
  });
});

describe("failure and logging", () => {
  it("exits quietly on input that is not a hook payload", async () => {
    project = await createHookProject();
    const { runHook } = await import("../run.js");
    const env = { cwd: project.fx.root, lexical: true };
    expect((await runHook("", env)).stdout).toBe("");
    expect((await runHook("not json", env)).stdout).toBe("");
    expect((await runHook("[1,2]", env)).stdout).toBe("");
    expect((await runHook("null", env)).stdout).toBe("");
  });

  it("turns an unexpected error into silence and a log line", async () => {
    project = await createHookProject();
    // A hand-damaged index (the shape is right, a field is not) makes the read event throw.
    const path = indexPathOf(project.fx.context.localDir);
    const index = JSON.parse(readFileSync(path, "utf8")) as { entities: Array<{ code: unknown }> };
    for (const entity of index.entities) entity.code = 5;
    writeFileSync(path, JSON.stringify(index));
    expect(await project.run(read("s-err", "src/billing.ts"))).toBe("");
    const log = readFileSync(join(project.fx.context.localDir, HOOK_LOG_NAME), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const failure = log.find((entry) => entry["event"] === "error");
    expect(failure).toBeDefined();
    expect(String(failure!["error"])).toContain("TypeError");
    expect(failure!["during"]).toBe("read");
  });

  it("is silent without an index and logs why", async () => {
    project = await createHookProject();
    const path = indexPathOf(project.fx.context.localDir);
    writeFileSync(path, "{ not json");
    expect(await project.run(read("s-noindex", "src/billing.ts"))).toBe("");
    const log = readFileSync(join(project.fx.context.localDir, HOOK_LOG_NAME), "utf8");
    expect(log).toContain("no-index:unreadable");
  });

  it("keeps the log bounded", async () => {
    project = await createHookProject();
    const { appendBoundedLine } = await import("../../local-state.js");
    const path = join(project.fx.context.localDir, "bounded.log");
    for (let i = 0; i < 400; i += 1) appendBoundedLine(project.fx.context.localDir, path, `line ${i} ${"x".repeat(80)}`, { maxBytes: 8 * 1024 });
    expect(readFileSync(path, "utf8").length).toBeLessThan(8 * 1024 + 200);
    expect(readFileSync(path, "utf8")).toContain("line 399");
  });

  it("writes only under .mex/local", async () => {
    project = await createHookProject();
    await project.run(promptPayload("s-writes", PROMPT));
    await project.run(read("s-writes", "src/billing.ts"));
    expect(existsSync(sessionDirOf(project.fx.context.localDir))).toBe(true);
    expect(project.git("status", "--porcelain")).toBe("");
  });
});
