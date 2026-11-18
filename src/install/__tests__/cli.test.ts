import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "dist", "cli.js");
const built = existsSync(cli) && existsSync(join(root, "dist", "hook-fallback.cjs"));
const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "mex-install-cli-"))); temps.push(base);
  const user = join(base, "user"); const repo = join(base, "repo"); const bin = join(base, "path");
  mkdirSync(repo); mkdirSync(bin);
  // Discovery only: these executables are never launched. No model/account is used.
  for (const agent of ["claude", "codex"]) {
    const path = join(bin, process.platform === "win32" ? `${agent}.cmd` : agent);
    writeFileSync(path, process.platform === "win32" ? "@exit /b 99\r\n" : "#!/bin/sh\nexit 99\n"); chmodSync(path, 0o700);
  }
  const env = { ...process.env, HOME: user, USERPROFILE: user, MEX_HOME: user, CODEX_HOME: join(user, ".codex"), CLAUDE_CONFIG_DIR: join(user, ".claude"),
    PATH: `${bin}${delimiter}${process.env.PATH}`, MEX_TELEMETRY: "0", MEX_BACKGROUND: "0", MEX_INSTALL_AUTO: "0" };
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, cwd: repo, encoding: "utf8", timeout: 15_000 });
  return { base, user, repo, env, run, home: join(user, ".mex"), claude: join(user, ".claude", "settings.json") };
}

describe.skipIf(!built)("built install and uninstall commands", () => {
  it("previews, installs, restores byte for byte and purges without recreating runtime", () => {
    const f = fixture();
    const preview = JSON.parse(f.run("install", "--dry-run", "--json"));
    expect(preview.dryRun).toBe(true);
    expect(existsSync(f.home)).toBe(false);
    mkdirSync(dirname(f.claude), { recursive: true });
    const original = '{\r\n  "env": {"FIXTURE": "preserved"}\r\n}'; writeFileSync(f.claude, original);
    const installed = JSON.parse(f.run("install", "--json"));
    expect(installed.agents).toEqual(["claude-code", "codex"]);
    expect(installed.notices.filter((line: string) => line.includes("/hooks"))).toHaveLength(1);
    const after = readFileSync(f.claude);
    expect(JSON.parse(f.run("uninstall", "--dry-run", "--json")).paths).toContain(f.claude);
    expect(readFileSync(f.claude)).toEqual(after);
    const result = JSON.parse(f.run("uninstall", "--json"));
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(existsSync(join(f.home, "record.db"))).toBe(true);
    expect(existsSync(join(f.home, "bin", "launcher.json"))).toBe(false);
    expect(JSON.parse(f.run("uninstall", "--purge", "--json")).purged).toBe(true);
    expect(existsSync(f.home)).toBe(false);
  });

  it("keeps a standalone fail-open recovery bundle after the CLI is gone", () => {
    const f = fixture();
    mkdirSync(dirname(f.claude), { recursive: true });
    const original = '{"env":{"FIXTURE":"preserved"}}\r\n'; writeFileSync(f.claude, original);
    f.run("install", "--json");
    writeFileSync(join(f.home, "bin", "launcher.json"), JSON.stringify({ version: 1, node: process.execPath, entry: join(f.base, "removed-package", "cli.js") }));
    const fallback = join(f.home, "bin", "mex-hook.cjs");
    const invoke = (background: string) => execFileSync(process.execPath, [fallback, "claude-code", "SessionStart"], {
      env: { ...f.env, MEX_BACKGROUND: background }, input: '{"session_id":"fixture","hook_event_name":"SessionStart"}', encoding: "utf8", timeout: 5000,
    });
    expect(invoke("1")).toBe("{}\n");
    expect(readFileSync(f.claude, "utf8")).not.toBe(original);
    expect(execFileSync(process.execPath, [fallback, "claude-code", "SessionStart", "--mex-managed"], { env: f.env, encoding: "utf8" })).toBe("");
    expect(readFileSync(f.claude, "utf8")).not.toBe(original);
    expect(invoke("0")).toBe("{}\n");
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(existsSync(join(f.user, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(f.home, "record.db"))).toBe(true);
  });
});
