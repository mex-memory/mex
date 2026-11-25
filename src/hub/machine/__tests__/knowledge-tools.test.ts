import { MachineChangeEventSchema, MachineKnowledgeBriefSchema, MachineKnowledgeRulesSchema, type MachineKnowledgeCheckout } from "@mex/hub-contracts/machine";
import * as children from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ruleCache from "../../../knowledge/rule-cache.js";
import * as ruleFiles from "../../../knowledge/rule-files.js";
import { fileHash } from "../../../knowledge/sections.js";
import { openRecord, projectIdentity, type RecordWriter } from "../../../record/index.js";
import { createMachineHubApp } from "../app.js";
import { HubSessions } from "../security.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile), execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync), spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

const ORIGIN = "http://127.0.0.1:41923";
const host = new URL(ORIGIN).host;
const now = () => Date.parse("2026-11-25T12:00:00.000Z");
const RULE = "# Testing\n\nRun `npm run test:legacy` before committing.\n";
const MISSING_EVALUATOR = "A brief needs MEX's native check evaluator; reinstall MEX or set MEX_HOOK_BINARY.";
const childCalls = [children.execFile, children.execFileSync, children.execSync, children.spawn, children.spawnSync];
let base: string, home: string, binary: string, writer: RecordWriter, cookie: string, csrf: string;
let app: ReturnType<typeof createMachineHubApp>;

const location = () => ({ home, isNetwork: () => false });
const git = (root: string, ...args: string[]) => children.execFileSync("git",
  ["-C", root, "-c", "user.name=MEX Test", "-c", "user.email=mex@example.test", "-c", "commit.gpgsign=false", ...args], { timeout: 5_000, stdio: "pipe" });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-hub-knowledge-tools-")));
  home = join(base, "home");
  binary = join(base, "mex-hook");
  writer = openRecord(location());
  const sessions = new HubSessions(home, now);
  const signed = sessions.create();
  cookie = `${sessions.cookieName}=${signed.cookie}`;
  csrf = signed.session.csrfToken;
  app = createMachineHubApp({ ...location(), sessions, now, homeId: "test", version: "test", mode: "terminal",
    env: { MEX_HOOK_BINARY: binary } });
});

afterEach(() => {
  app.close();
  writer.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

function repo(name = "project"): MachineKnowledgeCheckout {
  const checkout = join(base, name);
  mkdirSync(checkout);
  git(checkout, "init", "-qb", "main");
  git(checkout, "commit", "--allow-empty", "-qm", "Create " + name);
  return { repoId: writer.register(projectIdentity(checkout)).id, checkout };
}

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function cachePath({ repoId }: MachineKnowledgeCheckout) { return join(home, "projects", repoId, ruleCache.RULE_CACHE); }
function scan({ checkout }: MachineKnowledgeCheckout) {
  return ruleCache.refreshRuleFiles({ ...location(), projectPath: checkout }, new Date(now()));
}

function generated(scope: MachineKnowledgeCheckout, sharing: "local" | "shared") {
  const file = sharing === "local" ? ".claude/rules/mex-local.md" : ".claude/rules/mex.md";
  const body = "<!-- mex:generated -->\nKeep the build reproducible.\n";
  const manifest = sharing === "local" ? join(dirname(cachePath(scope)), "native-local.json") : join(scope.checkout, ".mex/native.json");
  put(join(scope.checkout, file), body);
  put(manifest, JSON.stringify({ version: 1, files: { [file]: fileHash(body) } }));
  return { file, manifest };
}

function filesUnder(directory: string) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(file => file.isFile()).map(file => join(file.parentPath, file.name)).sort();
}

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(ORIGIN + "/api/v1" + path, { headers: { host, cookie, ...headers } });
}

function post(path: string, body: unknown, key: string | null = randomUUID(), headers: Record<string, string> = {}) {
  return app.request(ORIGIN + "/api/v1/knowledge" + path, {
    method: "POST", body: JSON.stringify(body),
    headers: { host, cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-mex-csrf": csrf, "content-type": "application/json",
      ...(key === null ? {} : { "idempotency-key": key }), ...headers },
  });
}

function rulesUrl({ repoId, checkout }: MachineKnowledgeCheckout) {
  return "/knowledge/rules?" + new URLSearchParams({ repo: repoId, checkout });
}

async function rules(scope: MachineKnowledgeCheckout) {
  return vi.waitFor(async () => {
    const reply = await get(rulesUrl(scope));
    expect(reply.status).toBe(200);
    const result = MachineKnowledgeRulesSchema.parse(await reply.json());
    expect(result.updatingSince).toBeUndefined();
    return result;
  }, { interval: 15, timeout: 2_500 });
}

describe("Rule files", () => {
  it("reads the saved rows and manifests without changing bytes or running a process", async () => {
    const scope = repo("repo with spaces");
    put(join(scope.checkout, "AGENTS.md"), RULE);
    put(join(scope.checkout, "package.json"), "{}");
    const team = generated(scope, "shared");
    const local = generated(scope, "local");
    scan(scope);
    const repoFiles = filesUnder(scope.checkout);
    const paths = [writer.location.record, cachePath(scope), local.manifest, ...repoFiles];
    const before = paths.map(path => readFileSync(path));
    const refresh = vi.spyOn(ruleCache, "refreshRuleFiles");
    const network = vi.fn(() => { throw new Error("network on GET"); });
    vi.stubGlobal("fetch", network);
    for (const child of childCalls) vi.mocked(child).mockClear();

    const start = MachineKnowledgeRulesSchema.parse(await (await get(rulesUrl(scope))).json());
    expect(start.updatingSince).toBeTruthy();
    expect(await rules(scope)).toEqual({
      cache: { state: "current",
        files: [{ path: "AGENTS.md", agents: ["claude-code", "codex", "cursor", "copilot", "opencode"], scope: ["**"], entryCount: 1 }],
        findings: [{ kind: "stale", paths: ["AGENTS.md"], heading: "Testing",
          message: 'Names the command "npm run test:legacy", which the repo doesn\'t define.' }] },
      generated: [{ path: team.file, sharing: "shared" }, { path: local.file, sharing: "local" }],
    });
    expect(paths.map(path => readFileSync(path))).toEqual(before);
    expect(filesUnder(scope.checkout)).toEqual(repoFiles);
    for (const call of [...childCalls, network, refresh]) expect(call).not.toHaveBeenCalled();
  });

  it("leaves an unscanned checkout missing until a refresh", async () => {
    const scope = repo();
    expect(await rules(scope)).toEqual({ cache: { state: "missing" }, generated: [] });
    expect(existsSync(cachePath(scope))).toBe(false);
    const reply = await post("/rules/refresh", scope);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ cache: { state: "current", files: [], findings: [] } });
    expect(existsSync(cachePath(scope))).toBe(true);
  });

  it.each([
    ["edited without a timestamp or size change", (path: string) => {
      const { atime, mtime } = statSync(path);
      writeFileSync(path, RULE.replace("Testing", "Linting"));
      utimesSync(path, atime, mtime);
    }],
    ["removed", (path: string) => rmSync(path)],
    ["grown beyond the read bound", (path: string) => writeFileSync(path, " ".repeat(ruleFiles.MAX_RULE_FILE_BYTES + 1))],
  ] as const)("marks a rule file %s as stale without replacing the saved rows", async (_case, change) => {
    const scope = repo();
    const path = join(scope.checkout, "AGENTS.md");
    put(path, RULE);
    scan(scope);
    const before = readFileSync(cachePath(scope));
    change(path);
    expect((await rules(scope)).cache).toMatchObject({ state: "stale", files: [{ path: "AGENTS.md", entryCount: 1 }] });
    expect(readFileSync(cachePath(scope))).toEqual(before);
  });

  function scannedAMinuteAgo(scope: MachineKnowledgeCheckout) {
    scan(scope);
    const scannedAt = new Date(Date.now() - 60_000);
    utimesSync(cachePath(scope), scannedAt, scannedAt);
    return scannedAt;
  }

  it("notices a rule file added after the scan", async () => {
    const scope = repo();
    scannedAMinuteAgo(scope);
    put(join(scope.checkout, "CLAUDE.md"), RULE);
    expect((await rules(scope)).cache).toMatchObject({ state: "stale", files: [] });
  });

  it("ignores rule files the scan leaves out on purpose", async () => {
    const scope = repo();
    const scannedAt = scannedAMinuteAgo(scope);
    // Written by MEX, or untouched since the scan (for example, git-ignored).
    put(join(scope.checkout, ".claude", "rules", "mex.md"), "<!-- mex:generated -->\nGenerated");
    const older = new Date(scannedAt.getTime() - 60_000);
    put(join(scope.checkout, "GEMINI.md"), RULE);
    utimesSync(join(scope.checkout, "GEMINI.md"), older, older);
    expect((await rules(scope)).cache).toMatchObject({ state: "current", files: [] });
  });

  it("treats a cache from another registered worktree as stale even with identical source bytes", async () => {
    const scope = repo();
    const checkout = join(base, "other worktree");
    git(scope.checkout, "worktree", "add", "-qb", "other", checkout);
    expect(writer.register(projectIdentity(checkout)).id).toBe(scope.repoId);
    put(join(scope.checkout, "AGENTS.md"), RULE);
    put(join(checkout, "AGENTS.md"), RULE);
    generated(scope, "local");
    scan(scope);
    const team = generated({ ...scope, checkout }, "shared");
    expect(await rules({ ...scope, checkout })).toEqual({
      cache: { state: "stale", files: [], findings: [] }, generated: [{ path: team.file, sharing: "shared" }],
    });
    expect((await rules(scope)).cache.state).toBe("current");
  });

  it("refreshes just the cache, publishes knowledge, and replays the result once", async () => {
    const scope = repo();
    put(join(scope.checkout, "AGENTS.md"), RULE);
    const local = generated(scope, "local");
    generated(scope, "shared");
    const repoFiles = filesUnder(scope.checkout);
    const paths = [local.manifest, ...repoFiles];
    const before = paths.map(path => readFileSync(path));
    const refresh = vi.spyOn(ruleCache, "refreshRuleFiles");
    const stream = (await get("/events")).body!.getReader();
    try {
      expect(new TextDecoder().decode((await stream.read()).value)).toContain(": connected");
      const [first, second] = await Promise.all([post("/rules/refresh", scope, "refresh"), post("/rules/refresh", scope, "refresh")]);
      expect([first.status, second.status]).toEqual([200, 200]);
      const result = MachineKnowledgeRulesSchema.parse(await first.json());
      expect(await second.json()).toEqual(result);
      expect((await (await post("/rules/refresh", scope, "refresh")).json())).toEqual(result);
      expect(await rules(scope)).toEqual(result);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result.cache).toMatchObject({ state: "current", files: [{ path: "AGENTS.md", entryCount: 1 }] });
      expect(JSON.parse(readFileSync(cachePath(scope), "utf8")).root).toBe(scope.checkout);
      expect(filesUnder(scope.checkout)).toEqual(repoFiles);
      expect(paths.map(path => readFileSync(path))).toEqual(before);
      const change = new TextDecoder().decode((await stream.read()).value);
      expect(MachineChangeEventSchema.parse(JSON.parse(change.split("\n")[1].slice(6))).topics).toEqual(["knowledge"]);
    } finally { await stream.cancel(); }
  });

  it("rejects a second refresh while the first is listing the same checkout", async () => {
    const scope = repo();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const list = vi.spyOn(ruleFiles, "listRepositoryFilesAsync").mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const first = post("/rules/refresh", scope);
    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      const busy = await post("/rules/refresh", scope);
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "MEX_BUSY", detail: "Rule files are already refreshing for this checkout." });
    } finally {
      release();
      expect((await first).status).toBe(200);
    }
  });

  it("returns a retryable 503 if another process holds the record writer", async () => {
    const scope = repo();
    writer.db.exec("BEGIN IMMEDIATE");
    try {
      const busy = await post("/rules/refresh", scope, "retry");
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "MEX_BUSY" });
      expect(existsSync(cachePath(scope))).toBe(false);
    } finally { writer.db.exec("ROLLBACK"); }
    expect((await post("/rules/refresh", scope, "retry")).status).toBe(200);
  });
});

const nativeReply = {
  ok: true, text: "[mex start-preview]\nKeep the build reproducible.", token_bound: 57,
  items: [{ id: "mx_buildnote", line: "[personal] Keep the build reproducible.", level: "personal", verdict: "held", tokens: 12 }],
  corrections: [{ id: "mx_oldrule", line: "Correction: set the old note aside.", level: "team", verdict: "broken", tokens: 8 }],
  coverage: { files: [{ path: "AGENTS.md", agents: ["codex"], scope: ["**"], ids: ["mx_ruleone"], hash: fileHash(RULE) }] },
};

function stubBrief(gate?: string, overflow = false) {
  const input = join(base, "brief-input.json");
  writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
fs.writeFileSync(${JSON.stringify(input)}, JSON.stringify({ ...input, command: process.argv[2], background: process.env.MEX_BACKGROUND }));
const reply = () => process.stdout.write(${JSON.stringify(JSON.stringify(nativeReply))}${overflow ? ' + " ".repeat(512 * 1024)' : ""});
${gate ? `const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(wait); reply(); } }, 10);` : "reply();"}
`, { mode: 0o700 });
  return input;
}

describe("Brief preview", () => {
  it.skipIf(process.platform === "win32")("passes normalized scope to the native binary and records no delivery", async () => {
    const scope = repo();
    const input = stubBrief();
    const before = readFileSync(writer.location.record);
    vi.mocked(children.execFile).mockClear();
    const response = await post("/brief", { ...scope, agent: "codex", path: join(scope.checkout, "apps") + "/../src/" });
    expect(response.status).toBe(200);
    expect(MachineKnowledgeBriefSchema.parse(await response.json())).toEqual({
      text: nativeReply.text, tokenBound: 57, tokenLimit: 550, items: [...nativeReply.corrections, ...nativeReply.items],
      coverage: { files: [{ path: "AGENTS.md", agents: ["codex"], scope: ["**"], entryCount: 1 }] },
    });
    expect(JSON.parse(readFileSync(input, "utf8"))).toEqual({
      agent: "codex", path: "src", checkout: scope.checkout, mex_home: home, record_directory: writer.location.directory,
      project_id: scope.repoId, command: "--brief-run", background: "1",
    });
    expect(children.execFile).toHaveBeenCalledWith(binary, ["--brief-run"], expect.objectContaining({ timeout: 5_000, maxBuffer: 512 * 1024 }), expect.any(Function));
    expect(readFileSync(writer.location.record)).toEqual(before);
    expect(existsSync(writer.location.hooks)).toBe(false);
  });

  it("rejects paths escaping the checkout or exceeding the native path bound", async () => {
    const scope = repo();
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(scope.checkout, "external"), process.platform === "win32" ? "junction" : "dir");
    for (const path of ["../outside", outside, "external/missing", "apps\\..\\..\\outside", "a\0b", "ü".repeat(1_025)]) {
      const invalid = await post("/brief", { ...scope, agent: "codex", path });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ detail: "The brief's path must be inside this checkout." });
    }
  });

  it("returns the evaluator's unavailable message", async () => {
    const response = await post("/brief", { ...repo(), agent: "claude-code" });
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ code: "CHECKS_UNAVAILABLE", detail: MISSING_EVALUATOR });
  });

  it.skipIf(process.platform === "win32")("rejects evaluator output beyond 512 KiB", async () => {
    const scope = repo();
    stubBrief(undefined, true);
    const result = await post("/brief", { ...scope, agent: "codex" });
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ code: "BRIEF_UNAVAILABLE" });
  });

  it.skipIf(process.platform === "win32")("serves reads and rejects a second preview while the native runner waits", async () => {
    const scope = repo();
    const gate = join(base, "release-brief");
    const input = stubBrief(gate);
    const payload = { ...scope, agent: "codex" };
    let completed = false;
    const first = Promise.resolve(post("/brief", payload, "first")).finally(() => { completed = true; });
    try {
      await vi.waitFor(() => expect(existsSync(input)).toBe(true), { timeout: 2_500 });
      expect((await get("/projects")).status).toBe(200);
      expect((await rules(scope)).cache.state).toBe("missing");
      const busy = await post("/brief", payload, "second");
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ code: "MEX_BUSY", detail: "A brief preview is already running for this checkout." });
      expect(completed).toBe(false);
    } finally {
      writeFileSync(gate, "");
      expect((await first).status).toBe(200);
    }
  });
});

it("rejects unauthenticated, malformed, and mismatched rules reads", async () => {
  const scope = repo();
  expect((await get(rulesUrl(scope), { cookie: "" })).status).toBe(401);
  expect((await get("/knowledge/rules")).status).toBe(400);
  expect((await get(rulesUrl(scope) + "&repo=" + scope.repoId)).status).toBe(400);
  expect((await get(rulesUrl({ ...scope, checkout: repo("other").checkout }))).status).toBe(404);
});

it.each(["/rules/refresh", "/brief"])("guards %s with the shared write checks and registered scope", async (path) => {
  const scope = repo();
  const other = repo("other");
  const body = path === "/brief" ? { ...scope, agent: "codex" } : scope;
  expect((await post(path, body, "auth", { cookie: "" })).status).toBe(401);
  expect((await post(path, body, "origin", { origin: "https://example.test" })).status).toBe(403);
  expect((await post(path, body, "site", { "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await post(path, body, "csrf", { "x-mex-csrf": "" })).status).toBe(403);
  expect((await post(path, body, null)).status).toBe(400);
  expect((await post(path, body, "invalid key")).status).toBe(400);
  expect((await post(path, { ...body, junk: "x".repeat(64 << 10) })).status).toBe(400);
  expect((await post(path, { ...body, repoId: "../other" })).status).toBe(400);
  expect((await post(path, { ...body, checkout: other.checkout })).status).toBe(404);
  expect((await post(path, { ...body, checkout: join(base, "missing") })).status).toBe(404);
  expect(existsSync(cachePath(scope))).toBe(false);
});
