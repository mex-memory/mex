import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { createHookProject, toolPayload } from "./fixture.js";

const built = resolve(__dirname, "..", "..", "..", "..", "dist", "hook.js");

afterEach(() => {
  cleanupProjects();
  vi.unstubAllEnvs();
});

// The bundle is a build output: these run when `npm run build` has produced it.
describe.skipIf(!existsSync(built))("dist/hook.js", () => {
  const run = (input: string, cwd: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [built], { input, cwd, encoding: "utf8", env: { ...process.env, MEX_HOOK_LEXICAL: "1", MEX_HOOK_READ: "1", ...env }, windowsHide: true });

  it("rejects a no-op before loading sqlite", () => {
    const script = `await import(${JSON.stringify(pathToFileURL(built).href)}); await new Promise(r=>setImmediate(r)); console.error(process.moduleLoadList.filter(s=>/sqlite/i.test(s)).join(''));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify({hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:"pwd"}}),
      encoding:"utf8",windowsHide:true,env:{...process.env,MEX_HOOK_READ:"0",MEX_HOOK_EDIT:"0"},
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("");
  });

  it("exits 0 with no output for empty, garbage and unhandled input", async () => {
    const project = await createHookProject();
    for (const input of ["", "garbage", "{}", JSON.stringify({ hook_event_name: "Stop" })]) {
      const result = run(input, project.fx.root);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("exits 0 with no output outside a MEX project", async () => {
    const project = await createHookProject();
    const outside = resolve(project.fx.root, "..");
    const result = run(JSON.stringify(toolPayload("s", "Read", { file_path: join(outside, "x.ts") })), outside, { CLAUDE_PROJECT_DIR: "" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("prints a valid hook document for a read of a file with a fact", async () => {
    const project = await createHookProject();
    const payload = { cwd: project.fx.root, ...toolPayload("s-bin", "Read", { file_path: join(project.fx.root, "src/billing.ts"), limit: 3 }) };
    const result = run(JSON.stringify(payload), project.fx.root);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Order totals count the items");
    expect(result.stderr).toBe("");
  });

  it("honours CLAUDE_PROJECT_DIR when the working directory is elsewhere", async () => {
    const project = await createHookProject();
    const payload = toolPayload("s-env", "Read", { file_path: join(project.fx.root, "src/billing.ts"), limit: 3 });
    const result = run(JSON.stringify(payload), resolve(project.fx.root, ".."), { CLAUDE_PROJECT_DIR: project.fx.root });
    expect(result.stdout).toContain("Order totals count the items");
  });
});
