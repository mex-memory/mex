import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("status and doctor share a read-only JSON view without a legacy scaffold", () => {
  const base = mkdtempSync(join(tmpdir(), "mex-status-cli-")), repo = join(base, "repo");
  mkdirSync(repo); mkdirSync(join(repo, ".git"));
  const env = { ...process.env, MEX_HOME: join(base, "home"), CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), LOCALAPPDATA: join(base, "local"), MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0", MEX_BACKGROUND: "0" };
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], { cwd: repo, env, encoding: "utf8", timeout: 15_000 });
  const status = run("status", "--json"), doctor = run("doctor", "--json");
  expect(status.status, status.stderr).toBe(0);
  expect(doctor.status, doctor.stderr).toBe(1);
  const { problems, ...view } = JSON.parse(doctor.stdout);
  expect(view).toEqual(JSON.parse(status.stdout));
  expect(problems).toContain("Hook binary missing: run mex install");
  expect(existsSync(join(env.MEX_HOME, ".mex"))).toBe(false);
  const outside = spawnSync(process.execPath, [resolve("dist/cli.js"), "status"], { cwd: base, env, encoding: "utf8", timeout: 15_000 });
  expect(outside.status, outside.stderr).toBe(0);
  expect(outside.stdout).not.toContain("Knowledge here");
  expect(outside.stdout.trimEnd()).toMatch(/Next: run mex in a repo to turn MEX on there$/u);
});
