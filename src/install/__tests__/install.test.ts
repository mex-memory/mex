import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as settingsModule from "../settings.js";
import { withContainedArtifactLock } from "../../team/artifacts/filesystem.js";
import { installAgents, installationChanges, recoveryFile, uninstallAgents, type InstallOptions } from "../index.js";
import { applyOrphanRecovery } from "../recovery.js";
import { readSnapshot } from "../files.js";
import { EVENTS, installSettings, parseSettings } from "../settings.js";
import { openRecord } from "../../record/index.js";
import { enqueueModelBatch, claimModelBatch, settleModelBatch } from "../../model-runner/budget-queue.js";

const temps: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function write(path: string, value: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "mex-install-"))); temps.push(base);
  const user = join(base, "user");
  const home = join(user, ".mex");
  const repo = join(base, "repo");
  mkdirSync(repo);
  const entry = join(base, "package-v1", "cli.js"); write(entry, "// fixture cli\n");
  const fallback = join(base, "hook-fallback.cjs"); write(fallback, "// fixture fallback\n");
  const binary = join(base, "native"); write(binary, "fixture native v1");
  const claude = join(user, ".claude", "settings.json");
  const codex = join(user, ".codex", "hooks.json");
  const options: InstallOptions = { home, userHome: user, cwd: repo, entry, fallbackFile: fallback,
    nativeBinary: binary, selfTest: () => ({ ok: true }), available: agent => agent === "claude-code" || agent === "codex", env: {} };
  const copilot = join(user, ".copilot", "hooks.json");
  return { base, user, home, repo, entry, fallback, binary, claude, codex, copilot, options };
}
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }

describe("machine-wide hook installation", () => {
  it("previews without creating a home, record, runtime or settings", async () => {
    const f = fixture();
    const result = await installAgents({ ...f.options, dryRun: true });
    expect(result.changes.filter(change => change.kind === "settings")).toHaveLength(2);
    expect(existsSync(f.home)).toBe(false);
    expect(existsSync(f.claude)).toBe(false);
    expect(existsSync(f.codex)).toBe(false);
  });

  it("installs all supported events only in user settings and preserves other hooks", async () => {
    const f = fixture();
    const other = { type: "command", command: "someone-elses-check", timeout: 20 };
    write(f.claude, JSON.stringify({ env: { FIXTURE: "kept" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [other] }] } }));
    const result = await installAgents(f.options);
    const settings = JSON.parse(readFileSync(f.claude, "utf8"));
    expect(settings.env).toEqual({ FIXTURE: "kept" });
    expect(settings.hooks.PreToolUse[0]).toEqual({ matcher: "Bash", hooks: [other] });
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining([...EVENTS["claude-code"]]));
    const handler = settings.hooks.SessionStart[0].hooks[0];
    expect(handler).toMatchObject({ command: join(f.home, "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook"), args: ["claude-code", "SessionStart"], onFailure: "continue" });
    expect(result.notices.filter(line => line.includes("/hooks"))).toHaveLength(1);
    expect(existsSync(join(f.repo, ".claude"))).toBe(false);
    expect(existsSync(join(f.repo, ".codex"))).toBe(false);
    expect(installationChanges({ home: f.home })).toHaveLength(5);
  });

  it("restores exact original settings and runtime bytes after an upgrade", async () => {
    const f = fixture();
    const originalClaude = Buffer.from('\uFEFF{\r\n  "env": {"FIXTURE": "keep"}, "hooks": {}\r\n}');
    const originalCodex = Buffer.from('{ "hooks": {}, "description": "keep" }   \n');
    write(f.claude, originalClaude); write(f.codex, originalCodex); chmodSync(f.claude, 0o640);
    const originalMode = lstatSync(f.claude).mode & 0o777;
    const runtime = join(f.home, "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    write(runtime, "older existing runtime");
    write(join(f.home, "bin", "launcher.json"), "original launcher bytes\n");
    await installAgents(f.options);
    const firstCommands = readFileSync(f.codex, "utf8");
    const secondEntry = join(f.base, "package-v2", "cli.js"); write(secondEntry, "// fixture v2\n");
    write(f.binary, "fixture native v2"); write(f.fallback, "// fallback v2\n");
    await installAgents({ ...f.options, entry: secondEntry });
    expect(readFileSync(f.codex, "utf8")).toBe(firstCommands);
    const result = await uninstallAgents({ home: f.home });
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(f.claude)).toEqual(originalClaude);
    expect(readFileSync(f.codex)).toEqual(originalCodex);
    expect(lstatSync(f.claude).mode & 0o777).toBe(originalMode);
    expect(readFileSync(runtime, "utf8")).toBe("older existing runtime");
    expect(readFileSync(join(f.home, "bin", "launcher.json"), "utf8")).toBe("original launcher bytes\n");
    expect(installationChanges({ home: f.home })).toEqual([]);
    expect(existsSync(join(f.home, "record.db"))).toBe(true);
  });

  it("is idempotent and retains original bytes rather than a serialized equivalent", async () => {
    const f = fixture();
    await installAgents(f.options);
    const rows = installationChanges({ home: f.home });
    const snapshot = readSnapshot(f.claude);
    expect((await installAgents(f.options)).changes).toEqual([]);
    expect(installationChanges({ home: f.home })).toEqual(rows);
    expect(readSnapshot(f.claude)).toEqual(snapshot);
    await uninstallAgents({ home: f.home });
    expect(existsSync(f.claude)).toBe(false);
    expect(existsSync(f.codex)).toBe(false);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
  });

  it("keeps later user changes while undoing only the installed hook delta", async () => {
    const f = fixture();
    write(f.claude, '{"env":{"OLD":"kept"}}');
    await installAgents(f.options);
    const settings = JSON.parse(readFileSync(f.claude, "utf8"));
    settings.env.NEW = "user-added";
    settings.hooks.SessionStart.push({ hooks: [{ type: "command", command: "user-added-hook" }] });
    write(f.claude, JSON.stringify(settings));
    const result = await uninstallAgents({ home: f.home });
    expect(result.conflicts).toEqual([]);
    expect(JSON.parse(readFileSync(f.claude, "utf8"))).toEqual({ env: { OLD: "kept", NEW: "user-added" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "user-added-hook" }] }] } });
  });

  it("retains runtime and data when a hook was changed and needs manual recovery", async () => {
    const f = fixture();
    await installAgents(f.options);
    const settings = JSON.parse(readFileSync(f.claude, "utf8"));
    settings.hooks.SessionStart[0].hooks[0].args.push("--user-change");
    write(f.claude, JSON.stringify(settings));
    const result = await uninstallAgents({ home: f.home, purge: true });
    expect(result.conflicts).toContain(f.claude);
    expect(result.purged).toBe(false);
    expect(existsSync(join(f.home, "bin", "mex-hook.cjs"))).toBe(true);
    expect(existsSync(join(f.home, "record.db"))).toBe(true);
  });

  it("records the intent before writing and can undo an interrupted install", async () => {
    const f = fixture();
    const original = '{ "env": {"SAFE": "old"} }\r\n'; write(f.claude, original);
    await expect(installAgents({ ...f.options, beforeWrite: change => { if (change.kind === "settings") throw new Error("simulated crash"); } })).rejects.toThrow("simulated crash");
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(installationChanges({ home: f.home }).some(row => row.path === f.claude)).toBe(true);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(existsSync(join(f.home, "bin", "mex-hook.cjs"))).toBe(false);
  });

  it("refuses to overwrite a user edit made after the settings JSON was prepared", async () => {
    const f = fixture();
    write(f.claude, '{"env":{"ORIGINAL":"kept"}}');
    const original = settingsModule.installSettings;
    const concurrent = '{"env":{"ORIGINAL":"kept","CONCURRENT":"user edit"}}\r\n';
    vi.spyOn(settingsModule, "installSettings").mockImplementation((...args) => {
      const result = original(...args);
      write(f.claude, concurrent);
      return result;
    });
    await expect(installAgents(f.options)).rejects.toThrow("File changed before installation");
    expect(readFileSync(f.claude, "utf8")).toBe(concurrent);
    expect(installationChanges({ home: f.home }).some(row => row.path === f.claude)).toBe(false);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    expect(readFileSync(f.claude, "utf8")).toBe(concurrent);
  });

  it("uses the Node fallback when a binary is missing or fails self-test", async () => {
    for (const missing of [true, false]) {
      const f = fixture();
      await installAgents({ ...f.options, nativeBinary: missing ? null : f.binary, selfTest: () => ({ ok: false }) });
      const handler = JSON.parse(readFileSync(f.claude, "utf8")).hooks.SessionStart[0].hooks[0];
      expect(handler.command).toBe("node");
      expect(handler.args).toEqual([join(f.home, "bin", "mex-hook.cjs"), "claude-code", "SessionStart"]);
      const first = readFileSync(f.claude);
      await installAgents(f.options);
      expect(readFileSync(f.claude)).toEqual(first);
      expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    }
  });

  it("preserves other Node-based hooks when using the Node fallback", async () => {
    const f = fixture();
    const otherClaude = { type: "command", command: "node", args: ["/user/own-hook.cjs"] };
    const otherCodex = { type: "command", command: "'node' '/user/own-hook.cjs'" };
    write(f.claude, JSON.stringify({ hooks: { SessionStart: [{ hooks: [otherClaude] }] } }));
    write(f.codex, JSON.stringify({ hooks: { SessionStart: [{ hooks: [otherCodex] }] } }));
    await installAgents({ ...f.options, nativeBinary: null });
    expect(JSON.parse(readFileSync(f.claude, "utf8")).hooks.SessionStart[0].hooks).toEqual([otherClaude]);
    expect(JSON.parse(readFileSync(f.codex, "utf8")).hooks.SessionStart[0].hooks).toEqual([otherCodex]);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
  });

  it("keeps a pre-existing native command stable on upgrades", async () => {
    const f = fixture();
    const target = join(f.home, "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    write(target, readFileSync(f.binary)); chmodSync(target, 0o700);
    await installAgents(f.options);
    const first = readFileSync(f.claude);
    await installAgents(f.options);
    expect(readFileSync(f.claude)).toEqual(first);
    expect(JSON.parse(first.toString()).hooks.SessionStart[0].hooks[0].command).toBe(target);
  });

  it("replaces the old native handlers if every native binary fails self-test", async () => {
    const f = fixture();
    await installAgents(f.options);
    await installAgents({ ...f.options, selfTest: () => ({ ok: false }) });
    const settings = JSON.parse(readFileSync(f.claude, "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("node");
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    expect(existsSync(f.claude)).toBe(false);
  });

  it("honors config overrides and only shows Codex trust when Codex is detected", async () => {
    const f = fixture();
    const override = join(f.base, "claude-profile");
    const result = await installAgents({ ...f.options, env: { CLAUDE_CONFIG_DIR: override }, available: agent => agent === "claude-code" });
    expect(existsSync(join(override, "settings.json"))).toBe(true);
    expect(existsSync(f.claude)).toBe(false);
    expect(result.notices.some(line => line.includes("Codex"))).toBe(false);
  });

  it("does not create storage when neither agent is installed", async () => {
    const f = fixture();
    expect((await installAgents({ ...f.options, available: () => false })).changes).toEqual([]);
    expect(existsSync(f.home)).toBe(false);
  });

  it("refuses invalid, redirected, oversized and tracked user settings before installation", async () => {
    for (const kind of ["invalid", "link", "oversized", "tracked"] as const) {
      const f = fixture();
      write(f.claude, kind === "invalid" ? "{" : kind === "oversized" ? " ".repeat((1 << 20) + 1) : "{}");
      if (kind === "link") { rmSync(f.claude); symlinkSync(f.entry, f.claude); }
      if (kind === "tracked") { git(f.user, "init", "-q"); git(f.user, "add", ".claude/settings.json"); }
      await expect(installAgents(f.options)).rejects.toThrow();
      expect(existsSync(join(f.home, "record.db"))).toBe(false);
      expect(existsSync(f.codex)).toBe(false);
    }
  });

  it("does not overwrite tracked runtime files in a dotfiles repository", async () => {
    const f = fixture();
    const target = join(f.home, "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    write(target, "tracked runtime original");
    git(f.user, "init", "-q"); git(f.user, "add", ".mex/bin");
    await expect(installAgents(f.options)).rejects.toThrow("MEX will not edit a tracked file");
    expect(readFileSync(target, "utf8")).toBe("tracked runtime original");
    expect(existsSync(f.claude)).toBe(false);
    expect(existsSync(f.codex)).toBe(false);
  });

  it("cleans only owned untracked project hooks and previews tracked ones for Git removal", async () => {
    for (const tracked of [true, false]) {
      const f = fixture(); git(f.repo, "init", "-q");
      const path = join(f.repo, ".claude", "settings.json");
      const user = { type: "command", command: "user-hook" };
      const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "/old/dist/hook.js" --mex-managed', }, user] }] } });
      write(path, original);
      if (tracked) git(f.repo, "add", ".claude/settings.json");
      const result = await installAgents(f.options);
      if (tracked) { expect(readFileSync(path, "utf8")).toBe(original); expect(result.legacyTracked).toEqual([path]); }
      else { expect(JSON.parse(readFileSync(path, "utf8")).hooks.Stop[0].hooks).toEqual([user]); }
      expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  it("keeps notes by default and deletes them only with purge", async () => {
    const f = fixture();
    await installAgents(f.options);
    write(join(f.home, "projects", "fixture", "notes.json"), "private fixture notes");
    await uninstallAgents({ home: f.home });
    expect(existsSync(join(f.home, "projects", "fixture", "notes.json"))).toBe(true);
    expect((await uninstallAgents({ home: f.home, purge: true })).purged).toBe(true);
    expect(existsSync(f.home)).toBe(false);
  });

  it("refuses to purge a tree containing a link or junction", async () => {
    const f = fixture();
    await installAgents(f.options);
    symlinkSync(f.repo, join(f.home, "linked-repo"), process.platform === "win32" ? "junction" : "dir");
    await expect(uninstallAgents({ home: f.home, purge: true })).rejects.toThrow("link or junction");
    expect(existsSync(f.home)).toBe(true);
    expect(existsSync(f.repo)).toBe(true);
  });
  it("keeps the record while model work owns it, then permits purge after it finishes", async () => {
    const f = fixture(); await installAgents(f.options);
    const writer = openRecord({ home: f.home });
    try {
      const batch = enqueueModelBatch(writer, { agent: "claude", model: "opus", projectPath: f.repo });
      expect(claimModelBatch(writer, batch)).toBeUndefined();
      const held = await uninstallAgents({ home: f.home, purge: true });
      expect(held.purged).toBe(false); expect(held.conflicts).toContain("Model work is active; retry --purge after it finishes.");
      expect(existsSync(writer.location.record)).toBe(true);
      settleModelBatch(writer, batch, { input: 1, cache_read: 0, cache_write: 0, output: 1, model: "unknown", estimated: false });
    } finally { writer.close(); }
    expect((await uninstallAgents({ home: f.home, purge: true })).purged).toBe(true);
  });

  it("provides standalone settings recovery after the CLI has been removed", async () => {
    const f = fixture();
    const original = '{ "env": {"SAFE": "old"} }\r\n'; write(f.claude, original);
    await installAgents(f.options);
    rmSync(f.entry);
    expect(existsSync(recoveryFile(f.home))).toBe(true);
    const record = readFileSync(join(f.home, "record.db"));
    expect(await applyOrphanRecovery(f.home)).toBe(true);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(existsSync(f.codex)).toBe(false);
    expect(readFileSync(join(f.home, "record.db"))).toEqual(record);
    // The CLI can finish/reconcile cleanup later without a Go database write.
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
  });

  it("does not recover settings while an installer holds the shared lock", async () => {
    const f = fixture();
    await installAgents(f.options);
    const installed = readFileSync(f.claude);
    rmSync(f.entry);
    await withContainedArtifactLock(f.home, "install", ".install.lock", async () => {
      expect(await applyOrphanRecovery(f.home)).toBe(false);
      expect(readFileSync(f.claude)).toEqual(installed);
    });
    expect(await applyOrphanRecovery(f.home)).toBe(true);
    expect(existsSync(f.claude)).toBe(false);
  });

  it("rechecks that the CLI is absent before applying orphan recovery", async () => {
    const f = fixture();
    await installAgents(f.options);
    const installed = readFileSync(f.claude);
    expect(await applyOrphanRecovery(f.home)).toBe(false);
    expect(readFileSync(f.claude)).toEqual(installed);
  });
});

describe("agent settings format", () => {
  it("quotes Windows commands without expanding dollars, backticks or apostrophes", () => {
    const path = "C:\\Users\\O'Brien $fixture`\\.mex\\bin\\mex-hook.exe";
    const result = parseSettings(installSettings(null, "codex", { path, args: [] }, "win32"));
    const handler = (result.hooks as any).SessionStart[0].hooks[0];
    expect(handler.commandWindows).toBe("& 'C:\\Users\\O''Brien $fixture`\\.mex\\bin\\mex-hook.exe' 'codex' 'SessionStart'");
    expect(Object.keys(result.hooks as object)).toHaveLength(9);
    expect((result.hooks as any).SessionEnd[0].hooks[0].timeout).toBe(3);
  });
});

describe("Copilot CLI: registered only after the hook command proves it runs", () => {
  const withCopilot = (f: ReturnType<typeof fixture>, extra: Partial<InstallOptions> = {}): InstallOptions =>
    ({ ...f.options, available: () => true, commandTest: () => ({ ok: true }), ...extra });

  it("registers every Copilot event with bash and powershell commands and a short timeout", async () => {
    const f = fixture();
    const result = await installAgents(withCopilot(f));
    expect(result.agents).toContain("copilot");
    const settings = JSON.parse(readFileSync(f.copilot, "utf8"));
    expect(settings.version).toBe(1);
    expect(Object.keys(settings.hooks)).toEqual([...EVENTS.copilot]);
    const handler = settings.hooks.preToolUse[0];
    expect(handler.type).toBe("command");
    expect(handler.bash).toMatch(/'copilot' 'preToolUse'$/);
    expect(handler.powershell).toMatch(/^& .*'copilot' 'preToolUse'$/);
    expect(handler.timeoutSec).toBeLessThanOrEqual(10);
    // A repeated install leaves the file's bytes alone.
    const bytes = readFileSync(f.copilot);
    expect((await installAgents(withCopilot(f))).changes).toEqual([]);
    expect(readFileSync(f.copilot)).toEqual(bytes);
  });

  it("leaves Copilot without MEX hooks when the hook command can't run, so the agent keeps working", async () => {
    const f = fixture();
    const other = { type: "command", bash: "./someone-elses-check.sh", timeoutSec: 30 };
    write(f.copilot, JSON.stringify({ version: 1, hooks: { preToolUse: [other] } }));
    const result = await installAgents(withCopilot(f, { nativeBinary: null, commandTest: () => ({ ok: false, error: "node: not found" }) }));
    expect(result.agents).not.toContain("copilot");
    expect(result.agents).toEqual(["claude-code", "codex", "opencode"]);
    expect(result.notices.some(line => line.includes("Copilot CLI") && line.includes("node: not found") && line.includes("mex doctor"))).toBe(true);
    expect(JSON.parse(readFileSync(f.copilot, "utf8"))).toEqual({ version: 1, hooks: { preToolUse: [other] } });
  });

  it("removes earlier MEX Copilot hooks when a later self-test fails, and keeps other hooks", async () => {
    const f = fixture();
    const other = { type: "command", bash: "./someone-elses-check.sh", timeoutSec: 30 };
    write(f.copilot, JSON.stringify({ version: 1, hooks: { preToolUse: [other] } }));
    await installAgents(withCopilot(f));
    expect(JSON.parse(readFileSync(f.copilot, "utf8")).hooks.preToolUse).toHaveLength(2);
    await installAgents(withCopilot(f, { commandTest: () => ({ ok: false, error: "blocked by policy" }) }));
    const settings = JSON.parse(readFileSync(f.copilot, "utf8"));
    expect(settings.hooks).toEqual({ preToolUse: [other] });
  });

  it("restores the original Copilot file on uninstall", async () => {
    const f = fixture();
    await installAgents(withCopilot(f));
    expect(existsSync(f.copilot)).toBe(true);
    const result = await uninstallAgents({ home: f.home });
    expect(result.conflicts).toEqual([]);
    expect(existsSync(f.copilot)).toBe(false);
  });

  it("proves the Node fallback starts from PATH before trusting it", async () => {
    const { testCommand } = await import("../index.js");
    const f = fixture();
    const script = Buffer.from("process.stdout.write('{}\\n')\n");
    expect(testCommand({ path: process.execPath, args: [join(f.base, "not-yet-written.cjs")] }, process.env, script)).toEqual({ ok: true });
    const broken = testCommand({ path: process.execPath, args: [join(f.base, "x.cjs")] }, process.env, Buffer.from("process.exit(3)\n"));
    expect(broken.ok).toBe(false);
    const missing = testCommand({ path: join(f.base, "no-such-node"), args: [join(f.base, "x.cjs")] }, process.env, script);
    expect(missing.ok).toBe(false);
  });
});

describe("OpenCode: one plugin file, removed on uninstall", () => {
  it("writes the plugin with the hook command and removes it again", async () => {
    const f = fixture();
    const xdg = join(f.user, "xdg");
    const plugin = join(xdg, "opencode", "plugin", "mex.js");
    const options: InstallOptions = { ...f.options, env: { XDG_CONFIG_HOME: xdg }, available: agent => agent === "opencode" };
    const result = await installAgents(options);
    expect(result.agents).toEqual(["opencode"]);
    const text = readFileSync(plugin, "utf8");
    expect(text).toContain("MEX hook plugin for OpenCode");
    expect(text).toContain(JSON.stringify(join(f.home, "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook")));
    expect((await installAgents(options)).changes).toEqual([]);
    expect((await uninstallAgents({ home: f.home })).conflicts).toEqual([]);
    expect(existsSync(plugin)).toBe(false);
  });
});
