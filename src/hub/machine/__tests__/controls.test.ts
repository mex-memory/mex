import {
  MachineAgentRepairPreviewSchema, MachineAgentRepairResultSchema, MachineAgentsSnapshotSchema, MachineAgentSnapshotSchema,
  MachineSettingsSnapshotSchema, MachineUninstallSnapshotSchema,
} from "@mex/hub-contracts/machine";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLearningSharing } from "../../../controls/index.js";
import * as globalConfig from "../../../global-config.js";
import { installAgents, installationChanges } from "../../../install/index.js";
import { writeNative } from "../../../knowledge/native-write.js";
import { GENERATED_MARK } from "../../../knowledge/rule-files.js";
import { openRecord, projectIdentity, type RecordWriter } from "../../../record/index.js";
import { ensureExcludeBlock, REPO_START_BLOCK } from "../../../repo-start/exclude.js";
import { makeReport } from "../../../telemetry/report-schema.js";
import { createMachineHubApp } from "../app.js";
import { HubSessions } from "../security.js";

const HOST = "127.0.0.1:41917";
const ORIGIN = "http://" + HOST;
let base: string, home: string, entry: string, writer: RecordWriter, hooks: DatabaseSync, env: NodeJS.ProcessEnv;
let app: ReturnType<typeof createMachineHubApp>, sessions: HubSessions, cookie: string, csrf: string;
const location = () => ({ home, isNetwork: () => false });
const claude = () => join(env.CLAUDE_CONFIG_DIR!, "settings.json");
const codex = () => join(env.CODEX_HOME!, "hooks.json");
const copilot = () => join(env.COPILOT_HOME!, "hooks.json");
const opencode = () => join(env.XDG_CONFIG_HOME!, "opencode", "plugin", "mex.js");
const git = (path: string, ...args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
const set = (scope: string, key: string, value: string) => writer.db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?,?)").run(scope, key, value);

function worktree() {
  const path = join(base, "fixture-repo");
  mkdirSync(path);
  git(path, "init", "-q");
  git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "start");
  const project = writer.register(projectIdentity(path));
  return { path, repoId: project.id };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-machine-controls-")));
  home = join(base, ".mex");
  entry = join(base, "package", "cli.js");
  mkdirSync(dirname(entry));
  writeFileSync(entry, "// test CLI");
  const agentBin = join(base, "agents");
  mkdirSync(agentBin);
  env = {
    ...process.env, CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex-home"),
    COPILOT_HOME: join(base, "copilot-home"), XDG_CONFIG_HOME: join(base, "xdg"),
    PATH: [agentBin, process.env.PATH].filter(Boolean).join(delimiter), MEX_OFF: "0", MEX_OFFLINE: "0", MEX_TELEMETRY: "0",
  };
  vi.stubEnv("MEX_HOME", base);
  writer = openRecord(location());
  hooks = new DatabaseSync(writer.location.hooks);
  const migrations = resolve("native/record/schema/hooks");
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    hooks.exec(readFileSync(join(migrations, file), "utf8"));
    hooks.exec(`PRAGMA user_version=${Number(file.slice(0, 4))}`);
  }
  hooks.exec("PRAGMA journal_mode=WAL");
  sessions = new HubSessions(home);
  const signed = sessions.create();
  cookie = `${sessions.cookieName}=${signed.cookie}`;
  csrf = signed.session.csrfToken;
  app = createMachineHubApp({ ...location(), homeId: "control-fixture", sessions, env,
    agentEntry: entry, agentUserHome: base, version: "0.9.0", mode: "terminal" });
});

afterEach(() => {
  app.close();
  hooks.close();
  writer.close();
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function request(path: string, init: RequestInit = {}, sign = true) {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", HOST);
  if (sign && !headers.has("cookie")) headers.set("cookie", cookie);
  return app.request(ORIGIN + "/api/v1" + path, { ...init, headers });
}

function post(path: string, body: unknown, key = randomUUID() as string, override: Record<string, string> = {}, sign = true) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin",
      "x-mex-csrf": csrf, "idempotency-key": key, ...override },
    body: JSON.stringify(body),
  }, sign);
}

async function snapshot<T>(path: string, schema: { parse(data: unknown): T }, ready: (value: T) => boolean): Promise<T> {
  return vi.waitFor(async () => {
    const response = await request(path);
    expect(response.status).toBe(200);
    const value = schema.parse(await response.json());
    expect(ready(value), JSON.stringify(value).slice(0, 512)).toBe(true);
    return value;
  }, { timeout: 4_000, interval: 30 });
}

const waitAgents = () => snapshot("/agents", MachineAgentsSnapshotSchema, data => !!data.agents && !data.updatingSince);
const waitSettings = async () => (await snapshot("/settings", MachineSettingsSnapshotSchema, data => !!data.settings && !data.updatingSince)).settings!;
const waitUninstall = async () => (await snapshot("/settings/uninstall", MachineUninstallSnapshotSchema, data => !!data.preview && !data.updatingSince)).preview!;

async function installFixture() {
  const fallback = join(base, "fallback.cjs");
  const shim = join(base, "shim");
  writeFileSync(fallback, "// fallback fixture");
  writeFileSync(shim, '#!/bin/sh\nprintf \'{"ok":true}\'', { mode: 0o755 });
  mkdirSync(dirname(claude()), { recursive: true });
  writeFileSync(claude(), '{"env":{"KEEP_ME":"present"},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"own-check"}]}]}}');
  await installAgents({ ...location(), entry, fallbackFile: fallback, nativeBinary: shim, env, userHome: base,
    selfTest: () => ({ ok: true }), available: () => true, cwd: base });
}

function breakClaude() {
  const config = JSON.parse(readFileSync(claude(), "utf8"));
  config.hooks.PreToolUse.pop();
  writeFileSync(claude(), JSON.stringify(config) + "\n");
}

const repairPreviewPath = "/agents/claude-code/repair/preview";
const repairPath = "/agents/claude-code/repair";
async function makeRepairPreview() {
  const response = await post(repairPreviewPath, {});
  expect(response.status).toBe(200);
  const preview = MachineAgentRepairPreviewSchema.parse(await response.json());
  if (preview.type !== "browser" || !preview.previewToken) throw new Error("A browser repair was expected.");
  return { preview, confirmation: { revision: preview.revision, previewToken: preview.previewToken } };
}

describe("machine Agents and Settings", () => {
  it("projects every GET without changing either database or any agent config", async () => {
    await installFixture();
    const { path, repoId } = worktree();
    const projectDir = join(home, "projects", repoId);
    mkdirSync(projectDir, { recursive: true });
    const relative = ".claude/rules/mex-local.md";
    writeNative({ notes: [], files: [{
      path: relative, format: "claude-rules", agents: ["claude-code"], area: "", sharing: "local", text: GENERATED_MARK + " -->\nLocal rule",
      ids: ["note"], dropped: [],
    }] }, { root: path, projectDirectory: projectDir, only: "local" });
    const exclude = join(path, ".git", "info", "exclude");
    ensureExcludeBlock(writer, exclude, REPO_START_BLOCK, ["/.mex/*"]);
    const fired = new Date(Date.now() + 1_000).toISOString();
    hooks.prepare("INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at) VALUES(?,?,?,?,?,?)")
      .run("claude-session", "claude-code", repoId, path, fired, fired);
    set(repoId, "knowledge.hint_expiry_months", "7");
    set(repoId, "knowledge.hint.mx_one", '{"confirmed": false}');
    const report = makeReport("daily", { counts: { commands: "1" } }, randomUUID())!;
    set("telemetry.v3", "history:" + report.timestamp + ":" + report.uuid, JSON.stringify(report));
    writer.db.prepare("INSERT INTO model_calls(ts,purpose,agent,model,input,cache_write,cache_read,output,estimated) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(fired, "learn-deeper", "codex", "gpt-5", 40, 1, 9, 10, 1);
    writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    hooks.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const paths = [writer.location.record, writer.location.hooks, claude(), codex(), copilot(), opencode()];
    const before = paths.map(file => readFileSync(file));

    const { agents } = await waitAgents();
    const claudeAgent = agents!.find(agent => agent.id === "claude-code");
    expect(claudeAgent).toMatchObject({ state: "working", detected: true, lastFiredAt: fired, errors: [],
      hooks: { canVerify: true, events: expect.arrayContaining([{ name: "PreToolUse", status: "installed" }]) } });
    expect(claudeAgent?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: claude(), kind: "hookConfig", hiddenFromGit: false }),
      expect.objectContaining({ path: join(path, relative), kind: "rule", hiddenFromGit: true }),
      expect.objectContaining({ path: exclude, kind: "gitExclude" }),
    ]));
    expect(agents!.find(agent => agent.id === "codex")).toMatchObject({ state: "needsApproval", repair: "unavailable" });
    expect(agents!.find(agent => agent.id === "copilot")?.hooks.events.every(({ status }) => status === "installed")).toBe(true);
    expect(agents!.find(agent => agent.id === "opencode")?.hooks.events.every(({ status }) => status === "installed")).toBe(true);
    expect((await snapshot("/agents/claude-code", MachineAgentSnapshotSchema, data => !!data.agent)).agent).toEqual(claudeAgent);

    const settings = await waitSettings();
    expect(settings.storage.recordBytes).toBeGreaterThanOrEqual(statSync(writer.location.record).size);
    expect(settings.storage.paths).toMatchObject({ record: writer.location.record, hooks: writer.location.hooks });
    expect(settings.hints).toMatchObject({ active: 1, confirmed: 0, expiryMonths: 7, source: "repo" });
    expect(settings.ai.capPercent).toBe(3);
    expect(settings.outbound.telemetry).toEqual([expect.objectContaining({ id: report.uuid, event: "daily", fields: expect.arrayContaining(["counts"]) })]);
    expect(settings.outbound.modelCalls).toEqual([expect.objectContaining({ purpose: "learn-deeper", tokens: 60, estimated: true })]);

    const uninstall = await waitUninstall();
    const installerPaths = new Set([...installationChanges(location()).map(row => row.path), exclude]);
    expect(new Set(uninstall.changes.map(row => row.path))).toEqual(installerPaths);
    expect(uninstall.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: claude(), mexValue: expect.stringMatching(/^MEX hook on 12 events: .*SessionStart/) }),
      expect.objectContaining({ path: exclude, mexValue: expect.stringContaining("/.mex/*"), restores: null }),
    ]));
    expect(JSON.stringify(uninstall)).not.toContain("KEEP_ME");
    expect(uninstall.notRemoved).toEqual(expect.arrayContaining([
      { path: join(path, relative), kind: "personalRule" }, { path: exclude, kind: "gitExclude" },
    ]));
    expect(paths.map(file => readFileSync(file))).toEqual(before);
  });

  it.skipIf(process.platform === "win32")("previews and repairs one missing hook, publishes an event, and replays without another write", async () => {
    await installFixture();
    breakClaude();
    const before = readFileSync(claude());
    const other = [codex(), copilot(), opencode()].map(file => readFileSync(file));
    const installed = installationChanges(location());
    expect((await waitAgents()).agents?.[0]?.state).toBe("needsRepair");
    const { preview, confirmation } = await makeRepairPreview();
    expect(preview.changes).toEqual([{ path: claude(), diff: expect.stringContaining("+  \"PreToolUse\"") }]);
    expect(JSON.stringify(preview)).not.toContain("own-check");
    expect(preview.revision).toBe(createHash("sha256").update(before).digest("hex"));
    expect(readFileSync(claude())).toEqual(before);
    expect(installationChanges(location())).toEqual(installed);

    const stream = (await request("/events")).body!.getReader();
    await stream.read();
    try {
      const response = await post(repairPath, confirmation, "repair-confirmation");
      expect(response.status).toBe(200);
      const result = MachineAgentRepairResultSchema.parse(await response.json());
      expect(result.agent).toMatchObject({ state: "working", repair: "unavailable" });
      expect(new TextDecoder().decode((await stream.read()).value)).toContain('"agents"');
      const mtime = statSync(claude(), { bigint: true }).mtimeNs;
      const replay = await post(repairPath, confirmation, "repair-confirmation");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(result);
      expect(statSync(claude(), { bigint: true }).mtimeNs).toBe(mtime);
      expect([codex(), copilot(), opencode()].map(file => readFileSync(file))).toEqual(other);
      expect((await waitAgents()).agents?.[0]?.hooks.events).toEqual(result.agent.hooks.events);
    } finally { await stream.cancel(); }
  });

  it.skipIf(process.platform === "win32")("rejects stale previews and reports a busy record without touching the config", async () => {
    await installFixture();
    breakClaude();
    const { confirmation } = await makeRepairPreview();
    writeFileSync(claude(), readFileSync(claude(), "utf8") + "  \n");
    const changed = readFileSync(claude());
    const stale = await post(repairPath, confirmation);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_PREVIEW" });
    const next = (await makeRepairPreview()).confirmation;
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = post(repairPath, next, "retriable-repair");
      // Reads keep working while the installer is waiting on the record writer.
      expect((await request("/agents")).status).toBe(200);
      const busy = await pending;
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "MEX_BUSY" });
      expect(readFileSync(claude())).toEqual(changed);
    } finally { writer.db.exec("ROLLBACK"); }
    expect((await post(repairPath, next, "retriable-repair")).status).toBe(200);
  }, 12_000);

  it("offers the real terminal command when the shim is missing or the config is unreadable", async () => {
    await installFixture();
    rmSync(join(home, "bin", process.platform === "win32" ? "mex-hook.exe" : "mex-hook"));
    writeFileSync(claude(), "{ broken JSON");
    expect((await waitAgents()).agents?.[0]).toMatchObject({ state: "needsRepair", repair: "terminal", hooks: { canVerify: false } });
    const response = await post(repairPreviewPath, {});
    expect(response.status).toBe(200);
    expect(MachineAgentRepairPreviewSchema.parse(await response.json())).toMatchObject({ type: "terminal", command: "mex install" });
  });

  it("reports other mex executables in PATH order alongside the Hub entry", async () => {
    const first = join(base, "agents", process.platform === "win32" ? "mex.exe" : "mex");
    const second = join(base, "old-install", process.platform === "win32" ? "mex.exe" : "mex");
    mkdirSync(dirname(second));
    for (const file of [first, second]) writeFileSync(file, "fixture", { mode: 0o700 });
    env.PATH = [dirname(first), dirname(second), env.PATH].join(delimiter);
    expect((await waitAgents()).pathWarning).toMatchObject({ paths: expect.arrayContaining([first, second]), hubEntry: entry });
    expect((await waitAgents()).pathWarning?.paths.slice(0, 2)).toEqual([first, second]);
  });

  it("doesn’t classify disabled Codex hooks as a trust issue", async () => {
    await installFixture();
    writeFileSync(join(env.CODEX_HOME!, "config.toml"), "[features]\nhooks=false\n");
    expect((await waitAgents()).agents?.find(agent => agent.id === "codex")).toMatchObject({
      state: "notSetUp", trust: "unknown", repair: "unavailable", statusNote: "Codex has hooks turned off.",
    });
  });

  it("applies existing delivery, capture and sharing setters with revision checks", async () => {
    const { path, repoId } = worktree();
    const initial = await waitSettings();
    const project = initial.repos[0];
    const power = { change: { type: "globalPower", enabled: false }, expectedRevision: initial.everywhere.revision };
    const first = await post("/settings", power, "switch-off");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ saved: true });
    expect(writer.setting("global", "enabled")).toBe("false");
    expect((await post("/settings", power, "switch-off")).status).toBe(200);
    const changedBody = await post("/settings", { ...power, change: { type: "globalPower", enabled: true } }, "switch-off");
    expect(changedBody.status).toBe(409);
    expect(await changedBody.json()).toMatchObject({ code: "REQUEST_KEY_USED" });

    const off = await waitSettings();
    expect(off.everywhere.enabled).toBe(false);
    expect((await post("/settings", {
      change: { type: "globalPower", enabled: true }, expectedRevision: off.everywhere.revision,
    })).status).toBe(200);
    const on = await waitSettings();
    const until = new Date(Date.now() + 60_000).toISOString();
    expect((await post("/settings", {
      change: { type: "checkoutPower", path, power: { state: "offUntil", until } }, expectedRevision: on.repos[0].checkouts[0].revision,
    })).status).toBe(200);
    expect(writer.checkout(path)).toMatchObject({ state: "off until", off_until: until });

    expect((await post("/settings", {
      change: { type: "capture", repoId, enabled: false }, expectedRevision: project.capture.revision,
    })).status).toBe(200);
    expect(writer.setting(repoId, "capture.enabled")).toBe("false");
    expect((await post("/settings", {
      change: { type: "capture", enabled: false }, expectedRevision: initial.capture.revision,
    })).status).toBe(200);
    expect(writer.setting("global", "capture.enabled")).toBe("false");

    setLearningSharing(writer, "manual", path);
    const stale = await post("/settings", { change: { type: "sharing", repoId, mode: "automatic" }, expectedRevision: project.sharing.revision });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(writer.setting(repoId, "learning.sharing")).toBe("manual");
    const latest = await waitSettings();
    expect((await post("/settings", {
      change: { type: "sharing", repoId, mode: "automatic" }, expectedRevision: latest.repos[0].sharing.revision,
    })).status).toBe(200);
    expect(writer.setting(repoId, "learning.sharing")).toBe("automatic");
  });

  it("switches real telemetry preferences and preserves a newer terminal choice", async () => {
    vi.spyOn(globalConfig, "isDevRepo").mockReturnValue(false);
    Object.assign(env, { MEX_TELEMETRY: "1", DO_NOT_TRACK: "0" });
    const settings = await waitSettings();
    const command = { change: { type: "telemetry", enabled: false }, expectedRevision: settings.telemetry.revision };
    expect(settings.telemetry).toMatchObject({ enabled: true });
    const off = await post("/settings", command, "telemetry-off");
    expect(off.status).toBe(200);
    expect(globalConfig.readTelemetryPreference(home)).toBe("off");
    expect(existsSync(join(home, "telemetry-disabled"))).toBe(true);
    expect((await post("/settings", command, "telemetry-off")).status).toBe(200);
    const stale = await post("/settings", { ...command, change: { type: "telemetry", enabled: true } });
    expect(stale.status).toBe(409);
    expect(globalConfig.readTelemetryPreference(home)).toBe("off");
    const latest = await waitSettings();
    expect((await post("/settings", { change: { type: "telemetry", enabled: true }, expectedRevision: latest.telemetry.revision })).status).toBe(200);
    expect(globalConfig.readTelemetryPreference(home)).toBe("on");
  });

  it("rejects unauthenticated requests, bad origins, cross-site posts, missing CSRF, request keys and oversized bodies", async () => {
    for (const path of ["/agents", "/agents/claude-code", "/settings", "/settings/uninstall"]) {
      expect((await request(path, {}, false)).status).toBe(401);
    }
    for (const path of [repairPreviewPath, repairPath, "/settings"]) {
      expect((await post(path, {}, "test-key", {}, false)).status).toBe(401);
      expect((await post(path, {}, "test-key", { origin: "https://example.invalid" })).status).toBe(403);
      expect((await post(path, {}, "test-key", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await post(path, {}, "test-key", { "x-mex-csrf": "" })).status).toBe(403);
      expect((await post(path, {}, "")).status).toBe(400);
      const oversized = await post(path, { extra: "x".repeat(65_536) });
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toMatchObject({ detail: expect.stringContaining("64 KiB") });
    }
  });

  it("reports a newer schema and leaves the record byte-identical", async () => {
    writer.db.exec("PRAGMA user_version=999; PRAGMA wal_checkpoint(TRUNCATE)");
    const before = readFileSync(writer.location.record);
    const response = await snapshot("/settings", MachineSettingsSnapshotSchema, data => !!data.issue);
    expect(response.settings).toBeUndefined();
    expect(response.issue).toMatch(/record\.db schema version 999.*Upgrade MEX/);
    expect(readFileSync(writer.location.record)).toEqual(before);
  });
});
