import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord } from "../src/record/index.js";

const cli = resolve("dist/cli.js"), temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(register = true) {
  const base = mkdtempSync(join(tmpdir(), "mex-controls-cli-")); temps.push(base);
  const project = join(base, "project"), home = join(base, ".mex");
  mkdirSync(project);
  if (register) openRecord({ home, projectPath: project, isNetwork: () => false }).close();
  const env = { ...process.env, MEX_HOME: base, HOME: base, USERPROFILE: base, MEX_TELEMETRY: "0", MEX_BACKGROUND: "0", MEX_INSTALL_AUTO: "0" };
  return { base, project, home, env, run: (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8", timeout: 15_000 }) };
}

describe("off/on CLI", () => {
  it("saves timed off and on across CLI processes without changing shared rules", () => {
    const f = fixture();
    const rule = join(f.project, "AGENTS.md"); writeFileSync(rule, "Shared rules\r\n");
    const before = Date.now() + 7_200_000;
    const off = JSON.parse(f.run("off", "--for", "2h", "--json"));
    expect(off).toMatchObject({ scope: "checkout", state: "off until" });
    expect(Date.parse(off.offUntil)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(off.offUntil)).toBeLessThanOrEqual(Date.now() + 7_200_000);
    expect(JSON.parse(f.run("on", "--json"))).toEqual({ scope: "checkout", state: "on", offUntil: null });
    expect(f.run("off")).toContain("Shared rule files in git may still be loaded");
    expect(readFileSync(rule, "utf8")).toBe("Shared rules\r\n");
  });
  it("rejects malformed duration before creating a record and refuses unregistered projects", () => {
    const f = fixture(false);
    const invalid = spawnSync(process.execPath, [cli, "off", "--for", "tomorrow"], { cwd: f.project, env: f.env, encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("positive duration");
    expect(existsSync(join(f.home, "record.db"))).toBe(false);
    const absent = spawnSync(process.execPath, [cli, "on"], { cwd: f.project, env: f.env, encoding: "utf8" });
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain("not registered");
  });
  it("lists and switches output levers through the built CLI", () => {
    const f = fixture();
    const invalid = spawnSync(process.execPath, [cli, "config", "set", "unknown.fixture", "on"], { cwd: f.project, env: f.env, encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Supported keys: telemetry, feedback, learning.agent, learning.statements, learning.sessions, delivery.scorer, delivery.surface.<id>, learning.sharing, delivery.aliases, levers.output");
    expect(f.run("status")).toContain("Output levers off; turn on: mex config set levers.output on");
    expect(f.run("config", "set", "levers.output", "on")).toContain("Output levers on.");
    expect(f.run("status")).toContain("Output levers on");
    expect(f.run("config", "set", "levers.output", "off")).toContain("Output levers off.");
  });
  it("keeps global, repo and capture switches independent across processes", () => {
    const f = fixture();
    expect(JSON.parse(f.run("off", "--all", "--json"))).toEqual({ scope: "global", state: "off" });
    expect(f.run("on")).toContain("still off everywhere");
    expect(JSON.parse(f.run("capture", "off", "--all", "--json"))).toEqual({ scope: "global", capture: "off" });
    expect(f.run("capture", "on")).toContain("Capture is still off everywhere");
    expect(JSON.parse(f.run("on", "--all", "--json"))).toEqual({ scope: "global", state: "on" });
    expect(JSON.parse(readFileSync(join(f.home, "controls.json"), "utf8"))).toEqual({ version: 1, off: false, capture: false });
    expect(JSON.parse(f.run("capture", "on", "--all", "--json"))).toEqual({ scope: "global", capture: "on" });
    const invalid = spawnSync(process.execPath, [cli, "off", "--all", "--for", "2h"], { cwd: f.project, env: f.env, encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Use --for for a repo");
  });
});
