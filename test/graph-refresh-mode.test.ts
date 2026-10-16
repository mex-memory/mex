/**
 * `mex graph refresh` says how it worked: nothing to do, incremental, or full.
 * The engine already measures this; the command prints it and `--json` carries it.
 * The full case, and the reason a refresh could not be incremental, are covered
 * where the mode is chosen (`src/graph/__tests__/incremental-refresh.test.ts`)
 * and where it is formatted (`src/graph/__tests__/refresh-work.test.ts`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let root = "";

function mex(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: { ...process.env, MEX_TELEMETRY: "0", MEX_NO_UPDATE_CHECK: "1" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!existsSync(cliPath))("mex graph refresh reports its mode", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mex-refresh-mode-")));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
    writeFileSync(join(root, "src", "a.ts"), "export function a(): number { return 1; }\n");
    writeFileSync(join(root, "src", "b.ts"), "export function b(): number { return 1; }\n");
    expect(mex(["graph", "rebuild"]).status).toBe(0);
  }, 90_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("says nothing changed when the sources match the graph", () => {
    const result = mex(["graph", "refresh"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Code graph refreshed:");
    expect(result.stdout).toContain("Refresh: nothing changed.");
    expect(JSON.parse(mex(["graph", "refresh", "--json"]).stdout).refresh).toBeUndefined();
  }, 90_000);

  it("says incremental, with counts, after one file changed", () => {
    writeFileSync(join(root, "src", "a.ts"), "export function a(): number { return 2; }\n");
    const result = mex(["graph", "refresh"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Refresh: incremental, 1 changed, 1 re-extracted.");
  }, 90_000);

  it("carries the mode in --json", () => {
    writeFileSync(join(root, "src", "b.ts"), "export function b(): number { return 3; }\n");
    const result = JSON.parse(mex(["graph", "refresh", "--json"]).stdout) as { refresh?: Record<string, unknown> };
    expect(result.refresh).toMatchObject({ mode: "incremental", filesChanged: 1, filesReextracted: 1 });
  }, 90_000);

  it("does not claim a refresh for a rebuild", () => {
    expect(mex(["graph", "rebuild"]).stdout).not.toContain("Refresh:");
  }, 90_000);
});
