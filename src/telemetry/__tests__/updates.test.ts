import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showUpdateNotice, newerVersion } from "../updates.js";
let root: string, cwd: string;
const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
beforeEach(() => {
  cwd = process.cwd(); root = mkdtempSync(join(tmpdir(), "mex-update-")); process.chdir(root);
  vi.stubEnv("MEX_HOME", root); vi.stubEnv("MEX_DEV", "");
  for (const key of ["CI","CONTINUOUS_INTEGRATION","GITHUB_ACTIONS","GITLAB_CI","TF_BUILD","BUILDKITE","CIRCLECI","JENKINS_URL","MEX_OFFLINE","MEX_BACKGROUND","CLAUDECODE","CODEX_THREAD_ID"]) vi.stubEnv(key, "");
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
});
afterEach(() => {
  process.chdir(cwd); vi.unstubAllEnvs();
  if (descriptor) Object.defineProperty(process.stderr, "isTTY", descriptor); else delete (process.stderr as { isTTY?: boolean }).isTTY;
  rmSync(root, { recursive: true, force: true });
});
describe("the daily front-door update notice", () => {
  it("checks and displays at most once per UTC day", async () => {
    const readVersion = vi.fn(async () => "99.0.0"), write = vi.fn();
    const options = { now: Date.parse("2026-11-13T12:00:00Z"), readVersion, write };
    expect(await showUpdateNotice(options)).toBe(true);
    expect(await showUpdateNotice(options)).toBe(false);
    expect(readVersion).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain("npm install -g mex-agent");
  });
  it.each(["MEX_OFFLINE","MEX_BACKGROUND","CLAUDECODE","CODEX_THREAD_ID","CI"])("does no fetching or configuration writes under %s", async (key) => {
    vi.stubEnv(key,"1"); const readVersion = vi.fn(async () => "99.0.0");
    expect(await showUpdateNotice({ readVersion })).toBe(false);
    expect(readVersion).not.toHaveBeenCalled(); expect(existsSync(join(root,".mex"))).toBe(false);
  });
  it("stays silent for an older release, invalid response or failure", async () => {
    const write = vi.fn();
    expect(await showUpdateNotice({ now: 0, readVersion: async () => "0.0.1", write })).toBe(false);
    expect(await showUpdateNotice({ now: 86400000, readVersion: async () => "private/error\ntext", write })).toBe(false);
    expect(await showUpdateNotice({ now: 2*86400000, readVersion: async () => { throw new Error("private failure"); }, write })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("compares numeric releases and prereleases in the right order", () => {
    expect(newerVersion("0.9.0-beta.10","0.9.0-beta.2")).toBe(true);
    expect(newerVersion("0.9.0","0.9.0-beta.10")).toBe(true);
    expect(newerVersion("0.8.5","0.9.0-beta.1")).toBe(false);
    expect(newerVersion("0.9.0-beta.2","0.9.0")).toBe(false);
    expect(newerVersion("0.10.0","0.9.99")).toBe(true);
  });
});
