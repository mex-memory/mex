import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setCheckoutEnabled } from "../../controls/index.js";
import { buildIndex } from "../../file-index/build.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { AGENT_VARIABLES } from "../../repo-start/caller.js";
import { forget } from "../mutations.js";
import { parseEntry, serializeEntry } from "../entry.js";
import { note } from "../store.js";

// A person's own note, dropped with `mex forget`. The note file stays; the record says it is dropped. Nothing may hand it to an agent.
let suite: string, binary: string, base: string, root: string, home: string, writer: RecordWriter, options: { home: string; projectPath: string };
beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-forgotten-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(async () => {
  for (const key of AGENT_VARIABLES) vi.stubEnv(key, undefined);
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, ".mex");
  mkdirSync(join(root, "api"), { recursive: true });
  writeFileSync(join(root, "api", "endpoint.ts"), "export const endpoint = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-qb", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOOK_BINARY", binary); vi.stubEnv("MEX_HOME", base); vi.stubEnv("MEX_BACKGROUND", "0"); vi.stubEnv("MEX_OFFLINE", "1");
  writer = openRecord({ home, projectPath: root, isNetwork: () => false });
  const checkout = setCheckoutEnabled(writer, root, true);
  options = { home, projectPath: checkout.path };
  await buildIndex({ root, projectId: checkout.project_id, recordDirectory: writer.location.directory, workers: 0 });
}, 60_000);
afterEach(() => { writer.close(); vi.unstubAllEnvs(); });

const text = "Endpoint handlers must never block on the blue widget queue."; // the prompt below never says "must never block"
let session = 0;
function delivered() {
  const id = `s${++session}`;
  const hook = (name: string, extra: Record<string, unknown>) => execFileSync(binary, ["claude-code", name], { env: process.env, cwd: root, encoding: "utf8", timeout: 20_000,
    input: JSON.stringify({ session_id: id, cwd: root, hook_event_name: name, ...extra }) });
  const brief = hook("SessionStart", { source: "startup" });
  const prompt = hook("UserPromptSubmit", { prompt: "Change the endpoint handler so it can block on the blue widget queue." });
  const file = join(root, "api", "endpoint.ts");
  const read = hook("PostToolBatch", { tool_calls: [{ tool_name: "Read", tool_use_id: "r" + id, tool_input: { file_path: file }, tool_response: "export const endpoint = 1;\n" }] });
  const edit = hook("PostToolBatch", { tool_calls: [{ tool_name: "Edit", tool_use_id: "e" + id, tool_input: { file_path: file, old_string: "= 1", new_string: "= 2" }, tool_response: "The file has been updated" }] });
  return Object.entries({ brief, prompt, read, edit }).filter(([, out]) => out.includes("must never block")).map(([moment]) => moment);
}

it.each([["rule"], ["pitfall"]] as const)("hands a forgotten %s to no agent, at any moment", kind => {
  const saved = note({ text, kind, scope: ["api/**"] }, options);
  const before = delivered();
  expect(before.length, "the note must be delivered while it is live, or this test proves nothing").toBeGreaterThan(0);
  forget(saved.entry.mex.id, "No longer true", options);
  const after = delivered();
  expect(after).toEqual([]);
}, 60_000);

it("never stops an edit for a forgotten rule", () => {
  const saved = note({ text: "Never call blueWidgetQueue directly.", kind: "rule", scope: ["api/**"] }, options);
  const id = saved.entry.mex.id, project = writer.checkout(root)!.project_id, path = join(home, "projects", project, "notes", `${id}.md`);
  const entry = parseEntry(readFileSync(path, "utf8"));
  writeFileSync(path, serializeEntry({ ...entry, mex: { ...entry.mex, when: [{ type: "anti", match: "literal", pattern: "blueWidgetQueue(" }] } }));
  const stopped = () => {
    const id = `edit${++session}`;
    const hook = (name: string, extra: Record<string, unknown>) => execFileSync(binary, ["claude-code", name], { env: process.env, cwd: root, encoding: "utf8", timeout: 20_000,
      input: JSON.stringify({ session_id: id, cwd: root, hook_event_name: name, ...extra }) });
    hook("SessionStart", { source: "startup" });
    return hook("PreToolUse", { tool_name: "Write", tool_use_id: id, tool_input: { file_path: join(root, "api", `${id}.ts`), content: "blueWidgetQueue(1);" } }).includes("deny");
  };
  expect(stopped(), "the rule must stop the edit while it is live, or this test proves nothing").toBe(true);
  forget(id, "No longer true", options);
  expect(stopped()).toBe(false);
}, 60_000);

it.each(["api/UserPage.ts", "api/Button/**", "CONTRIBUTING.md"])("reaches a rule scoped to %s, whose name has capitals", async scope => {
  const file = scope === "api/Button/**" ? "api/Button/View.ts" : scope;
  mkdirSync(join(root, "api", "Button"), { recursive: true });
  writeFileSync(join(root, file), "export const a = 1;\n");
  const saved = note({ text: "Never call blueWidgetQueue directly.", kind: "rule", scope: [scope] }, options);
  const id = saved.entry.mex.id, project = writer.checkout(root)!.project_id, path = join(home, "projects", project, "notes", `${id}.md`);
  const entry = parseEntry(readFileSync(path, "utf8"));
  writeFileSync(path, serializeEntry({ ...entry, mex: { ...entry.mex, when: [{ type: "anti", match: "literal", pattern: "blueWidgetQueue(" }] } }));
  const name = `case${++session}`;
  const hook = (event: string, extra: Record<string, unknown>) => execFileSync(binary, ["claude-code", event], { env: process.env, cwd: root, encoding: "utf8", timeout: 20_000,
    input: JSON.stringify({ session_id: name, cwd: root, hook_event_name: event, ...extra }) });
  hook("SessionStart", { source: "startup" });
  expect(hook("PreToolUse", { tool_name: "Write", tool_use_id: name, tool_input: { file_path: join(root, file), content: "blueWidgetQueue(1);" } })).toContain("deny");
}, 60_000);
