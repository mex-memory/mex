import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const FIXTURE_SRC = join(here, "fixtures", "smoke-project");
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

let projectRoot: string;

function runMex(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "mex-smoke-"));
  cpSync(FIXTURE_SRC, projectRoot, { recursive: true });
  execSync("git init -q", { cwd: projectRoot });
  execSync("git add -A", { cwd: projectRoot });
  execSync('git -c user.email=smoke@test -c user.name=smoke commit -q -m "init"', {
    cwd: projectRoot,
  });
});

describe("CLI smoke", () => {
  it("--version matches package.json", () => {
    const { status, stdout } = runMex(["--version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("commands lists top-level commands", () => {
    const { status, stdout } = runMex(["commands"]);
    expect(status).toBe(0);
    expect(stdout).toContain("CLI Commands");
    expect(stdout).toContain("mex check");
  });

  it("check --quiet exits successfully on fixture", () => {
    const { status, stdout } = runMex(["check", "--quiet"]);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("doctor prints health summary", () => {
    const { status, stdout } = runMex(["doctor"]);
    expect(status).toBe(0);
    expect(stdout).toContain("mex doctor");
    expect(stdout).toContain("Drift");
  });

  it("log and timeline round-trip", () => {
    const log = runMex(["log", "smoke test note", "--type", "note"]);
    expect(log.status).toBe(0);
    const timeline = runMex(["timeline", "--limit", "1"]);
    expect(timeline.status).toBe(0);
    expect(timeline.stdout).toContain("smoke test note");
  });

  it("heartbeat --json reports status", () => {
    const { status, stdout } = runMex(["heartbeat", "--json"]);
    expect(status).toBe(0);
    expect(stdout).toContain("{");
  });

  it("completion bash emits script", () => {
    const { status, stdout } = runMex(["completion", "bash"]);
    expect(status).toBe(0);
    expect(stdout).toContain("complete");
  });

  it("sync --dry-run runs without error", () => {
    const { status } = runMex(["sync", "--dry-run"]);
    expect(status).toBe(0);
  });

  it("setup --dry-run previews scaffold", () => {
    const { status, stdout } = runMex(["setup", "--dry-run"]);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("init --json emits scanner brief", () => {
    const { status, stdout } = runMex(["init", "--json"]);
    expect(status).toBe(0);
    expect(stdout.trim().startsWith("{")).toBe(true);
  });

  it("watch --uninstall is a no-op success", () => {
    const { status } = runMex(["watch", "--uninstall"]);
    expect(status).toBe(0);
  });
});
