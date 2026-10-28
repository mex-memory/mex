import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupProjects } from "../../__tests__/fixture.js";
import { BILLING_V1, createHookProject, toolPayload } from "./fixture.js";
import { loadInjectedChars } from "../../session.js";
import { SETTLE_LOCK_NAME } from "../settle.js";

const built = resolve(__dirname, "../../../../dist/hook.js");
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MEX_HOOK_") && key !== "CLAUDE_PROJECT_DIR"));
afterEach(() => { cleanupProjects(); vi.unstubAllEnvs(); });

describe.skipIf(!existsSync(built))("Codex built hook entry", () => {
  it("honours installed switches without host environment, and lets explicit env override them", async () => {
    const p = await createHookProject();
    const args = [built, "--mex-managed", "--host", "codex", "--lexical", "--switch", "read=1", "--switch", "edit=1", "--switch", "graph=0"];
    const payload = JSON.stringify({ ...toolPayload("codex-entry", "Bash", { command: "gc billing.ts -Head 3" }, "source"), cwd: join(p.fx.root, "src") });
    const run = (override: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, args, { input: payload, cwd: join(p.fx.root, "src"), encoding: "utf8", windowsHide: true, env: { ...cleanEnv(), ...override } });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Order totals count the items");
    const logs = readFileSync(join(p.fx.context.localDir, "context-log.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(logs.at(-1)).toMatchObject({ host: "codex", recipe: "lexical", switches: { read: true, edit: true, graph: false } });
    expect(loadInjectedChars(p.fx.context.localDir, "codex-entry")).toBeGreaterThan(0);
    expect(run({ MEX_HOOK_READ: "0", MEX_HOOK_EDIT: "0" }).stdout).toBe("");
  });

  it("keeps a detached settle worker alive after the Codex hook process exits", async () => {
    const p = await createHookProject();
    p.fx.writeSource("src/billing.ts", BILLING_V1.replace("return total - 1;", "return total - 2;"));
    const done = join(p.fx.root, "settle-finished");
    const fake = join(p.fx.root, "fake-cli.mjs");
    writeFileSync(fake, `import {writeFileSync} from 'node:fs'; setTimeout(() => {writeFileSync(${JSON.stringify(done)}, 'finished'); console.log('{}');}, 1800);`);
    const result = spawnSync(process.execPath, [built, "--host", "codex", "--lexical", "--switch", "read=1"], {
      input: JSON.stringify({ hook_event_name: "Stop", cwd: p.fx.root, session_id: "01a1823f-9a65-7501-8207-3535ae7f6654", stop_hook_active: false }),
      cwd: p.fx.root, encoding: "utf8", windowsHide: true, env: { ...cleanEnv(), MEX_CLI: fake },
    });
    expect(result.status).toBe(0); expect(result.stdout).toBe("");
    // Parent exited already; the detached worker still holds its own PID lock.
    const lock = join(p.fx.context.localDir, SETTLE_LOCK_NAME);
    const pid = Number(readFileSync(lock, "utf8"));
    expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).not.toThrow();
    expect(existsSync(done)).toBe(false);
    for (let i = 0; i < 80 && existsSync(lock); i++) await new Promise(r => setTimeout(r, 100));
    expect(existsSync(done)).toBe(true); expect(existsSync(lock)).toBe(false);
    const logs = readFileSync(join(p.fx.context.localDir, "context-log.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(logs.find(l => l.event === "stop")).toMatchObject({ host: "codex", settle: "started" });
    expect(logs.find(l => l.event === "settle")).toMatchObject({ host: "codex", recipe: "lexical", switches: { read: true } });
  });
});
