import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatuses } from "../agents.js";
import { OPENCODE_PLUGIN_MARKER } from "../opencode-plugin.js";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function setup() {
  const user = mkdtempSync(join(tmpdir(), "mex-agents-")); temps.push(user);
  return { user, userHome: user, home: join(user, ".mex"), env: {} as NodeJS.ProcessEnv };
}

describe("agent status for mex doctor", () => {
  it("notices an agent installed after MEX and asks to add MEX", () => {
    const f = setup();
    const rows = agentStatuses({ userHome: f.userHome, home: f.home, env: f.env, platform: "linux", onPath: program => program === "copilot" || program === "opencode" });
    expect(rows.map(row => [row.agent, row.ok, row.detail])).toEqual([
      ["copilot", false, "found · add MEX: `mex install`"],
      ["opencode", false, "found · add MEX: `mex install`"],
    ]);
  });

  it("retests the registered Copilot hook and reports a failure loudly", () => {
    const f = setup();
    put(join(f.user, ".copilot", "hooks.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [{ bash: "'/x/.mex/bin/mex-hook' 'copilot' 'preToolUse'" }] } }));
    put(join(f.user, ".config", "opencode", "plugin", "mex.js"), `${OPENCODE_PLUGIN_MARKER}\n`);
    let calls = 0;
    const passing = agentStatuses({ userHome: f.userHome, home: f.home, env: f.env, platform: "linux", onPath: () => false, commandTest: () => { calls++; return { ok: true }; } });
    expect(calls).toBe(1);
    expect(passing.find(row => row.agent === "copilot")).toMatchObject({ ok: true, reached: true });
    expect(passing.find(row => row.agent === "copilot")!.detail).toContain("self-test passed");
    expect(passing.find(row => row.agent === "opencode")).toMatchObject({ ok: true, reached: true });
    const failing = agentStatuses({ userHome: f.userHome, home: f.home, env: f.env, platform: "linux", onPath: () => true, commandTest: () => ({ ok: false, error: "blocked by policy" }) });
    const copilot = failing.find(row => row.agent === "copilot")!;
    expect(copilot.ok).toBe(false);
    expect(copilot.detail).toContain("blocked by policy");
    expect(copilot.detail).toContain("mex install");
  });

  it("says plainly how Devin and Kiro are reached", () => {
    const f = setup();
    put(join(f.user, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "/x/.mex/bin/mex-hook" }] }] } }));
    const rows = agentStatuses({ userHome: f.userHome, home: f.home, env: f.env, platform: "linux", onPath: program => program === "devin" || program === "kiro-cli" });
    expect(rows.find(row => row.agent === "devin")).toMatchObject({ ok: true, reached: true });
    expect(rows.find(row => row.agent === "kiro")!.detail).toContain("rule files only");
    expect(rows.find(row => row.agent === "kiro")!.ok).toBe(true);
  });
});
