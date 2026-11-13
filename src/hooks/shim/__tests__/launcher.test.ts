import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launcherFile, writeLauncher } from "../launcher.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "mex-launcher-")); temps.push(dir); return dir; }

describe("hook launcher file", () => {
  it("names the Node binary and the CLI entry, and is rewritten only when they change", () => {
    const home = temp();
    expect(writeLauncher(home, "dist/cli.js", "/usr/bin/node")).toBe(true);
    expect(JSON.parse(readFileSync(launcherFile(home), "utf8"))).toEqual({ version: 1, node: "/usr/bin/node", entry: resolve("dist/cli.js") });
    expect(writeLauncher(home, "dist/cli.js", "/usr/bin/node")).toBe(false);
    expect(writeLauncher(home, "dist/cli.js", "/opt/node")).toBe(true);
  });

  it("never creates MEX's home, and ignores source runs", () => {
    const home = join(temp(), ".mex");
    expect(writeLauncher(home, "dist/cli.js", "/usr/bin/node")).toBe(false);
    expect(existsSync(home)).toBe(false);
    mkdirSync(home);
    expect(writeLauncher(home, "src/cli.ts", "/usr/bin/node")).toBe(false);
    expect(writeLauncher(home, "", "/usr/bin/node")).toBe(false);
    expect(existsSync(launcherFile(home))).toBe(false);
  });
});
