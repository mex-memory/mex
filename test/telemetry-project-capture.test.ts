import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, openRecordReadOnly } from "../src/record/index.js";
import { __resetTelemetryForTest, __setTransport, createProjectTelemetryCapture, getTelemetryInspection, showFirstRunNotice, flush } from "../src/telemetry/index.js";

const ID = "8c2215bb-bb35-48bc-8f6d-ff8ca8b7fd99";
let root: string, cwd: string;
const capture = vi.fn();
function project(name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".mex"), { recursive: true });
  writeFileSync(join(path, ".mex", "config.json"), JSON.stringify({ scaffold_id: ID, aiTools: ["codex"], origin: "PRIVATE_REMOTE" }));
  return path;
}
function share(path: string): void {
  const writer = openRecord({ projectPath: path, isNetwork: () => false });
  try {
    const id = writer.checkout(path)!.project_id;
    writer.db.prepare("UPDATE projects SET shared=1 WHERE id=?").run(id);
    writer.db.prepare("INSERT INTO settings VALUES(?, 'shared.project_id', ?)").run(id, ID);
  } finally { writer.close(); }
}
function pages(): number | undefined {
  const reader = openRecordReadOnly();
  try { return reader?.get<{ value: number }>("SELECT value FROM counters_node WHERE name='hub.pages'")?.value; }
  finally { reader?.close(); }
}
beforeEach(() => {
  cwd = process.cwd(); root = mkdtempSync(join(tmpdir(), "mex-project-telemetry-")); process.chdir(root);
  vi.stubEnv("MEX_HOME", join(root, "user")); vi.stubEnv("MEX_DEV", ""); vi.stubEnv("MEX_BACKGROUND", "0");
  for (const key of ["CI","CONTINUOUS_INTEGRATION","GITHUB_ACTIONS","GITLAB_CI","TF_BUILD","BUILDKITE","CIRCLECI","JENKINS_URL","MEX_TELEMETRY","MEX_OFFLINE","DO_NOT_TRACK"]) vi.stubEnv(key, "");
  __resetTelemetryForTest(); capture.mockReset(); __setTransport(capture);
});
afterEach(() => {
  __resetTelemetryForTest(); vi.restoreAllMocks(); process.chdir(cwd); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

describe("v3 project capture boundary", () => {
  it("counts a Hub page locally without sending project metadata or creating an identity", () => {
    createProjectTelemetryCapture(project("PRIVATE_SELECTED"))("hub.page_viewed", { page: "knowledge" });
    expect(pages()).toBe(1); expect(capture).not.toHaveBeenCalled();
    expect(existsSync(join(root,"user",".mex","telemetry-id"))).toBe(false);
    expect(JSON.stringify(getTelemetryInspection())).not.toMatch(/PRIVATE|scaffold_id|configured_ai_tools/);
  });
  it("combines usage from separate Hubs without turning their repo names into report fields", () => {
    createProjectTelemetryCapture(project("PRIVATE_LEFT"))("hub.page_viewed", { page: "knowledge" });
    createProjectTelemetryCapture(project("PRIVATE_RIGHT"))("hub.page_viewed", { page: "home" });
    expect(pages()).toBe(2); expect(capture).not.toHaveBeenCalled();
  });
  it("captures nothing while disabled and resumes after enabling", () => {
    const sink = createProjectTelemetryCapture(project("selected"));
    process.env.DO_NOT_TRACK = "1"; sink("hub.page_viewed", { page: "home" });
    expect(existsSync(join(root,"user",".mex"))).toBe(false);
    delete process.env.DO_NOT_TRACK; sink("hub.page_viewed", { page: "home" });
    expect(pages()).toBe(1);
  });
  it("rejects unknown input before any project discovery or recording", () => {
    createProjectTelemetryCapture(root)("hub.page_viewed", { page: "knowledge", secret: "PRIVATE" } as never);
    expect(capture).not.toHaveBeenCalled(); expect(existsSync(join(root,"user",".mex"))).toBe(false);
  });
  it("uses the selected shared project for CI even when cwd is another directory", async () => {
    const selected = project("shared"); share(selected);
    vi.stubEnv("CI","true"); vi.spyOn(process.stderr,"write").mockImplementation(() => true); showFirstRunNotice();
    createProjectTelemetryCapture(selected)("cli.command_completed", { command: "check", outcome: "success", duration_ms: 2 });
    await flush();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]).toEqual(["ci.run", expect.objectContaining({ project_id: ID, source: "ci" })]);
    expect(capture.mock.calls[0][1]).not.toHaveProperty("installation_id");
  });
  it("does not borrow cwd's shared ID for a selected unshared project", async () => {
    const shared = project("shared"), selected = project("unshared"); share(shared); process.chdir(shared);
    vi.stubEnv("CI","true"); vi.spyOn(process.stderr,"write").mockImplementation(() => true); showFirstRunNotice();
    createProjectTelemetryCapture(selected)("cli.command_completed", { command: "check", outcome: "success", duration_ms: 2 });
    await flush();
    expect(capture).toHaveBeenCalledOnce(); expect(capture.mock.calls[0][1]).not.toHaveProperty("project_id");
  });
  it("inspect leaves a repo's private configuration untouched and creates no global state", () => {
    const path = project("inspect"); process.chdir(path);
    const config = join(path, ".mex", "config.json"), before = readFileSync(config);
    const result = getTelemetryInspection();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|scaffold_id|configured_ai_tools/);
    expect(readFileSync(config)).toEqual(before); expect(readdirSync(join(path, ".mex"))).toEqual(["config.json"]);
    expect(existsSync(join(root, "user", ".mex"))).toBe(false);
  });
});
