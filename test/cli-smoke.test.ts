import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const FIXTURE_SRC = join(here, "fixtures", "smoke-project");
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string };

let projectRoot: string | undefined;

function runMex(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    stdout,
    stderr,
    output: [stdout, stderr].filter(Boolean).join("\n"),
  };
}

function expectSuccess(result: ReturnType<typeof runMex>): void {
  expect(result.status, result.output).toBe(0);
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

afterAll(() => {
  if (projectRoot) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe("CLI smoke", () => {
  it("--version matches package.json", () => {
    const result = runMex(["--version"]);
    expectSuccess(result);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("commands lists top-level commands", () => {
    const result = runMex(["commands"]);
    expectSuccess(result);
    expect(result.stdout).toContain("CLI Commands");
    expect(result.stdout).toContain("mex check");
  });

  it("check prints drift summary on fixture", () => {
    const result = runMex(["check"]);
    expectSuccess(result);
    expect(result.stdout).toContain("Drift score");
  });

  it("check --quiet exits successfully on fixture", () => {
    const result = runMex(["check", "--quiet"]);
    expectSuccess(result);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("doctor prints health summary", () => {
    const result = runMex(["doctor"]);
    expectSuccess(result);
    expect(result.stdout).toContain("mex doctor");
    expect(result.stdout).toContain("Drift");
  });

  it("log and timeline round-trip", () => {
    const log = runMex(["log", "smoke test note", "--type", "note"]);
    expectSuccess(log);
    const timeline = runMex(["timeline", "--limit", "1"]);
    expectSuccess(timeline);
    expect(timeline.stdout).toContain("smoke test note");
  });

  it("heartbeat --json reports status", () => {
    const result = runMex(["heartbeat", "--json"]);
    expectSuccess(result);
    expect(result.stdout).toContain("{");
  });

  it("completion bash emits script", () => {
    const result = runMex(["completion", "bash"]);
    expectSuccess(result);
    expect(result.stdout).toContain("complete");
  });

  it("sync --dry-run runs without error", () => {
    expectSuccess(runMex(["sync", "--dry-run"]));
  });

  it("setup --dry-run previews scaffold", () => {
    const result = runMex(["setup", "--dry-run"]);
    expectSuccess(result);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("init --json emits scanner brief", () => {
    const result = runMex(["init", "--json"]);
    expectSuccess(result);
    expect(result.stdout.trim().startsWith("{")).toBe(true);
  });

  it("watch --uninstall is a no-op success", () => {
    expectSuccess(runMex(["watch", "--uninstall"]));
  });

  it("pattern add creates a scaffold file", () => {
    const result = runMex(["pattern", "add", "smoke-pattern"]);
    expectSuccess(result);
    expect(result.stdout).toContain("smoke-pattern.md");
  });
});
