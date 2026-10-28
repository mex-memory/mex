import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHooksInstall, runHooksRemove, runHooksStatus, type HooksIo } from "../cli.js";
import { hookHost, inspectSettings, planInstall, planRemove } from "../claude-settings.js";
import { applyInstalledSwitches, hookSwitches, installedSwitchArgs } from "../switches.js";
import { HOOK_INSTRUCTIONS_END, HOOK_INSTRUCTIONS_START } from "../instructions.js";

let root: string;
let io: HooksIo;
let out: string[];
let err: string[];
let exit: number;
const settings = () => join(root, ".codex/hooks.json");
const agents = () => join(root, "AGENTS.md");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-codex-install-"));
  mkdirSync(join(root, ".mex")); writeFileSync(join(root, ".mex/ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "hook.js"), "");
  out = []; err = []; exit = 0;
  io = { cwd: root, write: s => out.push(s), writeError: s => err.push(s), setExitCode: n => { exit = n; }, resolve: { env: { PATH: "" }, entryCandidates: [join(root, "hook.js")] } };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("Codex hooks installation", () => {
  it.each(["codex", "claude"] as const)("status of a %s install judges it by its recorded switches, not the caller's environment", tool => {
    vi.stubEnv("MEX_HOOK_EDIT", "1");
    runHooksInstall(io, { tool });
    vi.unstubAllEnvs();
    out = [];
    runHooksStatus(io, { tool, json: true });
    const status = JSON.parse(out.join(""));
    expect(status.data.state).toBe("installed");
    expect(status.data.settings.strays).toBe(0);
    // An explicit environment value still wins, and then the install reads as out of date.
    vi.stubEnv("MEX_HOOK_EDIT", "0");
    out = [];
    runHooksStatus(io, { tool, json: true });
    expect(JSON.parse(out.join("")).data.state).toBe("outdated");
  });

  it("installs anchored matchers, timeout, AGENTS block and trust advice; remains byte-idempotent", () => {
    vi.stubEnv("MEX_HOOK_EDIT", "1");
    writeFileSync(join(root, "CLAUDE.md"), "keep Claude\n");
    const skills = "# Instructions\r\n<!-- mex-agent:skills:start -->\r\nRead MEX.\r\n<!-- mex-agent:skills:end -->\r\n";
    writeFileSync(agents(), skills);
    runHooksInstall(io, { tool: "codex" });
    expect(exit).toBe(0);
    const first = readFileSync(settings(), "utf8");
    const json = JSON.parse(first);
    expect(json.hooks.PostToolUse.map((g: any) => g.matcher)).toEqual(["^Bash$", "^apply_patch$"]);
    for (const group of Object.values(json.hooks).flat() as any[]) {
      expect(group.hooks[0].timeout).toBe(30);
      expect(group.hooks[0].command).toContain('--mex-managed --switch edit=1 --host codex');
    }
    const instructions = readFileSync(agents(), "utf8");
    expect(instructions.startsWith(skills)).toBe(true);
    expect(instructions).toContain(HOOK_INSTRUCTIONS_START);
    expect(instructions.replace(/\r\n/g, "")).not.toContain("\n");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("keep Claude\n");
    expect(out.join("\n")).toContain("/hooks");
    expect(out.join("\n")).toContain("--dangerously-bypass-hook-trust");
    runHooksInstall(io, { tool: "codex" });
    expect(readFileSync(settings(), "utf8")).toBe(first);
    expect(readFileSync(agents(), "utf8")).toBe(instructions);
    runHooksStatus(io, { tool: "codex" });
    expect(out.at(-1)).toContain("AGENTS.md block: present");
    expect(out.at(-1)).toContain("installed PostToolUse apply_patch");
    runHooksRemove(io, { tool: "codex" });
    expect(existsSync(settings())).toBe(false);
    expect(readFileSync(agents(), "utf8")).toBe(skills);
  });

  it("preserves user groups, extra keys, order and indentation, and never deletes a pre-existing empty file", () => {
    mkdirSync(join(root, ".codex"));
    const user = { custom: true, hooks: { PostToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "echo mine", timeout: 4 }] }] }, other: 9 };
    const original = JSON.stringify(user, null, "\t") + "\r\n";
    writeFileSync(settings(), original);
    runHooksInstall(io, { tool: "codex" });
    const merged = readFileSync(settings(), "utf8");
    expect(merged).toContain('\n\t"custom"');
    expect(JSON.parse(merged).hooks.PostToolUse[0]).toEqual(user.hooks.PostToolUse[0]);
    runHooksRemove(io, { tool: "codex" });
    expect(readFileSync(settings(), "utf8")).toBe(original.replace(/(?<!\r)\n/g, "\r\n"));
    writeFileSync(settings(), "{}\n");
    runHooksInstall(io, { tool: "codex" }); runHooksRemove(io, { tool: "codex" });
    expect(readFileSync(settings(), "utf8")).toBe("{}\n");
  });

  it("keeps a MEX-created file after a user adds content; dry run writes nothing", () => {
    runHooksInstall(io, { tool: "codex", dryRun: true });
    expect(existsSync(settings())).toBe(false);
    expect(existsSync(agents())).toBe(false);
    expect(out[0]).toContain("+++ b/.codex/hooks.json");
    runHooksInstall(io, { tool: "codex" });
    const json = JSON.parse(readFileSync(settings(), "utf8")); json.custom = "mine";
    writeFileSync(settings(), JSON.stringify(json));
    runHooksRemove(io, { tool: "codex" });
    expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual({ custom: "mine" });
  });

  it("resolves Codex like Claude, and persists lexical/read/graph choices for both hosts", () => {
    writeFileSync(join(root, process.platform === "win32" ? "mex-hook.cmd" : "mex-hook"), "");
    io.resolve!.env = { PATH: root };
    vi.stubEnv("MEX_HOOK_LEXICAL", "1"); vi.stubEnv("MEX_HOOK_READ", "1"); vi.stubEnv("MEX_HOOK_GRAPH", "0");
    runHooksInstall(io, { tool: "codex" });
    const command = JSON.parse(readFileSync(settings(), "utf8")).hooks.UserPromptSubmit[0].hooks[0].command;
    expect(command).toMatch(/^node ".*hook.js" --mex-managed --lexical --switch read=1 --switch graph=0 --host codex/);
    runHooksInstall(io);
    expect(readFileSync(join(root, ".claude/settings.json"), "utf8")).toContain("--lexical --switch read=1 --switch graph=0");
    const env = { MEX_HOOK_READ: "0", MEX_HOOK_LEXICAL: "0" };
    applyInstalledSwitches(["--lexical", "--switch", "read=1", "--switch", "graph=0"], env);
    expect(env).toEqual({ MEX_HOOK_READ: "0", MEX_HOOK_LEXICAL: "0", MEX_HOOK_GRAPH: "0" });
    expect(hookSwitches(env).read).toBe(false);
    expect(installedSwitchArgs({})).toEqual([]);
  });

  it.each(["install", "status", "remove"])("refuses malformed and oversized files on %s without a partial write", operation => {
    mkdirSync(join(root, ".codex")); writeFileSync(settings(), "{ invalid");
    const run = operation === "install" ? runHooksInstall : operation === "status" ? runHooksStatus : runHooksRemove;
    run(io, { tool: "codex", json: true });
    // Status reports malformed JSON rather than mutating it.
    expect(readFileSync(settings(), "utf8")).toBe("{ invalid");
    expect(existsSync(agents())).toBe(false);
    writeFileSync(settings(), " ".repeat(1024 * 1024 + 1));
    run(io, { tool: "codex", json: true });
    expect(exit).toBe(1);
    expect(out.at(-1)).toContain("HOOKS_SETTINGS_UNSAFE");
  });

  it("refuses malformed instruction markers and a symlinked host directory", () => {
    writeFileSync(agents(), HOOK_INSTRUCTIONS_START + "\nbroken\n");
    runHooksInstall(io, { tool: "codex" });
    expect(exit).toBe(1); expect(existsSync(settings())).toBe(false);
    writeFileSync(agents(), HOOK_INSTRUCTIONS_START + "\nold\n" + HOOK_INSTRUCTIONS_END);
    mkdirSync(join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), join(root, ".codex"), "junction");
    runHooksInstall(io, { tool: "codex", json: true });
    expect(out.at(-1)).toContain("HOOKS_SETTINGS_UNSAFE");
    expect(existsSync(join(root, "elsewhere/hooks.json"))).toBe(false);
  });

  it("does not strand a MEX-created empty file when all events are switched off", () => {
    runHooksInstall(io, { tool: "codex" });
    vi.stubEnv("MEX_HOOK_PROMPT", "0"); vi.stubEnv("MEX_HOOK_STOP", "0"); vi.stubEnv("MEX_HOOK_BASH", "0");
    runHooksInstall(io, { tool: "codex" });
    expect(existsSync(settings())).toBe(false);
    runHooksRemove(io, { tool: "codex" });
    expect(existsSync(settings())).toBe(false); expect(existsSync(agents())).toBe(false);
  });

  it("shares the merge implementation with the host's timeout key", () => {
    const host = { ...hookHost("codex", { MEX_HOOK_EDIT: "1" }), timeoutKey: "timeout" };
    const installed = planInstall(null, "mex-hook --mex-managed --host codex", host);
    expect(inspectSettings(installed.text, "mex-hook --mex-managed --host codex", host).entries.every(e => e.state === "installed")).toBe(true);
    expect(planInstall(installed.text, "mex-hook --mex-managed --host codex", host).action).toBe("noop");
    expect(JSON.parse(planRemove(installed.text).text!)).toEqual({});
  });
});
