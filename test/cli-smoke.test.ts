import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end smoke test for the shipped CLI against a real scaffold fixture.
// Two version bugs shipped because CI only exercised library code and the
// packed-install smoke: the CLI itself was never run against a scaffold in the
// suite. This spawns the built `dist/cli.js` for every top-level command a
// user or agent reaches for first, asserting exit codes and the output that
// makes each command worth running.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "dist", "cli.js");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const childTimeoutMs = 10_000;
// The timeline case runs three children; leave room for fixture work as well.
const testTimeoutMs = 3 * childTimeoutMs + 5_000;

const roots: string[] = [];

beforeAll(() => {
  // The suite's other CLI tests build dist/ themselves; the smoke test depends
  // on it, so fail with the reason instead of a confusing MODULE_NOT_FOUND.
  if (!existsSync(cliPath)) {
    throw new Error("dist/cli.js is missing — run `npm run build` before the smoke test.");
  }
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-cli-smoke-"));
  roots.push(root);
  return root;
}

function scaffold(root: string, files: Record<string, string> = {}): void {
  const mexDir = join(root, ".mex");
  mkdirSync(mexDir, { recursive: true });
  writeFileSync(join(mexDir, "ROUTER.md"), "# Router\n\nEntry point for the scaffold.\n");
  // A populated scaffold without a tool anchor reports SCAFFOLD_ORPHANED —
  // the fixture mirrors what `mex setup` produces: an agent entry point.
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n\nUse the scaffold under .mex/ as the project memory.\n");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(path) === path ? mexDir : join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function mex(
  root: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: childTimeoutMs,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      HOME: root,
      MEX_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      NO_COLOR: "1",
    },
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error(
      `mex ${args.join(" ")} did not exit normally (timeout: ${childTimeoutMs}ms)\n` +
      `error: ${result.error?.message ?? "none"}\n` +
      `signal: ${result.signal ?? "none"}\n` +
      `stderr:\n${result.stderr ?? ""}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI smoke test against a fixture scaffold", { timeout: testTimeoutMs }, () => {
  it("--version prints the package.json version (would catch a drifted constant)", () => {
    const root = project();
    const result = mex(root, ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("timeline renders a logged event end to end", () => {
    const root = project();
    scaffold(root);

    const logged = mex(root, ["log", "smoke: chose the bounded resolver", "--type", "decision"]);
    expect(logged.status).toBe(0);
    const receipt = /Recorded (log_[0-9A-Z]{26}) locally \(/.exec(logged.stdout);
    expect(receipt).not.toBeNull();

    const timeline = mex(root, ["timeline"]);
    expect(timeline.status).toBe(0);
    expect(timeline.stdout).toContain("smoke: chose the bounded resolver");

    const jsonTimeline = mex(root, ["timeline", "--json"]);
    expect(jsonTimeline.status).toBe(0);
    const asJson = JSON.parse(jsonTimeline.stdout) as {
      events: Array<{ kind: string; message: string }>;
    };
    expect(asJson.events).toEqual([
      expect.objectContaining({ id: receipt![1], kind: "decision", message: "smoke: chose the bounded resolver" }),
    ]);
  });

  it("check reports a healthy scaffold with exit code 0", () => {
    const root = project();
    scaffold(root);

    const result = mex(root, ["check"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("100/100");
  });

  it("check --json emits a parseable report with the expected shape", () => {
    const root = project();
    scaffold(root);

    const result = mex(root, ["check", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { score?: number; issues?: unknown[] };
    expect(report.score).toBe(100);
    expect(Array.isArray(report.issues)).toBe(true);
  });

  it("heartbeat runs clean on the fixture", () => {
    const root = project();
    scaffold(root);

    const result = mex(root, ["heartbeat"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("HEARTBEAT_OK");
  });

  it("doctor summarizes scaffold health without crashing", () => {
    const root = project();
    scaffold(root);

    const result = mex(root, ["doctor"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("mex doctor");
    expect(result.stdout).toContain("Drift");
  });

  it("help lists the top-level commands the docs promise", () => {
    const root = project();
    const result = mex(root, ["--help"]);
    expect(result.status).toBe(0);
    for (const command of ["check", "doctor", "timeline", "log", "heartbeat", "graph"]) {
      expect(result.stdout).toContain(command);
    }
  });
});
