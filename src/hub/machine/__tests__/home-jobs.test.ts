import { MachineChangeEventSchema, MachineHomeSchema, MachineJobActionResponseSchema, MachineJobConflictSchema, MachineJobsSchema } from "@mex/hub-contracts/machine";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "../../../judge/evidence.js";
import { serializeEntry, type KnowledgeEntry } from "../../../knowledge/entry.js";
import { saveTombstone } from "../../../knowledge/state.js";
import { openRecord, projectIdentity, type JobState, type RecordWriter } from "../../../record/index.js";
import * as background from "../../../record/background.js";
import * as recordJobs from "../../../record/jobs.js";
import { stageConflict } from "../../../review/conflicts.js";
import { stageReview, learningReviewId } from "../../../review/state.js";
import { readStatus } from "../../../status.js";
import { createMachineHubApp } from "../app.js";
import { HubSessions } from "../security.js";
import { startMachineHub } from "../serve.js";
import { ensureHomeId } from "../state.js";

const ORIGIN = "http://127.0.0.1:41917";
const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const at = (offset = 0) => new Date(NOW + offset).toISOString();

let base: string;
let home: string;
let clock: number;
let writer: RecordWriter;
let hooks: DatabaseSync;
let app: ReturnType<typeof createMachineHubApp>;
let cookie: string;
let csrfToken: string;
const location = () => ({ home, isNetwork: () => false });
const now = () => clock;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-hub-home-jobs-")));
  home = join(base, "home");
  clock = NOW;
  writer = openRecord(location());
  hooks = new DatabaseSync(writer.location.hooks);
  const schema = resolve("native/record/schema/hooks");
  for (const file of readdirSync(schema).filter((name) => name.endsWith(".sql")).sort()) {
    hooks.exec(readFileSync(join(schema, file), "utf8"));
    hooks.exec(`PRAGMA user_version=${Number(file.slice(0, 4))}`);
  }
  hooks.exec("PRAGMA journal_mode=WAL");
  const sessions = new HubSessions(home, now);
  const signed = sessions.create();
  cookie = `${sessions.cookieName}=${signed.cookie}`;
  csrfToken = signed.session.csrfToken;
  app = createMachineHubApp({
    ...location(), sessions, homeId: ensureHomeId(writer), version: "test", mode: "background", env: { MEX_OFF: "1" }, now,
  });
});

afterEach(async () => {
  app.close();
  await setImmediate();
  hooks.close();
  writer.close();
  rmSync(base, { recursive: true, force: true });
  vi.useRealTimers();
});

function request(path: string, init: RequestInit = {}, signed = true) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(ORIGIN).host);
  if (signed) headers.set("cookie", cookie);
  return app.request(ORIGIN + "/api/v1" + path, { ...init, headers });
}

function project(name: string) {
  const path = join(base, name);
  mkdirSync(path);
  const registered = writer.register(projectIdentity(path, () => ""));
  return { id: registered.id, path: registered.root_path };
}

function checkout(projectId: string, name: string, state: "on" | "off" = "on", exists = true) {
  const path = join(base, name);
  if (exists) mkdirSync(path);
  writer.db.prepare("INSERT INTO checkouts(project_id,path,state) VALUES(?,?,?)").run(projectId, path, state);
  return path;
}

function session(id: string, repo: ReturnType<typeof project>, agent: string, time: string) {
  hooks.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,0)").run(id, agent, repo.id, repo.path, time, time);
  hooks.prepare("INSERT INTO epochs(session_id,epoch,started_at) VALUES(?,0,?)").run(id, time);
}

let deliveryId = 0;
function receipt(id: string, time: string, action: string, options: { moment?: string; entry?: string; detail?: string; agent?: string } = {}) {
  const agent = options.agent ?? "";
  if (agent) hooks.prepare("INSERT OR IGNORE INTO epochs(session_id,agent_id,epoch,started_at) VALUES(?,?,0,?)").run(id, agent, time);
  hooks.prepare(`INSERT INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action,project_id,checkout,detail)
    SELECT ?,session_id,?,0,?,?,?,'one-line',0,?,project_id,checkout,? FROM sessions WHERE session_id=?`)
    .run(String(deliveryId++), agent, time, options.moment ?? "read", options.entry ?? "mx_fixture", action, options.detail ?? "", id);
}

async function getHome(zone = "UTC") {
  const response = await request(`/home?${new URLSearchParams({ tz: zone })}`);
  expect(response.status).toBe(200);
  return MachineHomeSchema.parse(await response.json());
}

async function waitForSnapshot() {
  for (let attempt = 0; attempt < 30; attempt++) {
    await setImmediate();
    const data = await getHome();
    if (!data.pending && !Object.values(data.knowledge).some((entry) => entry.updatingSince)) return data;
  }
  throw new Error("Home snapshot did not settle");
}

function entry(id: string, kind: KnowledgeEntry["mex"]["kind"], text = "Run the project checks", status: "active" | "proposed" = "active"): KnowledgeEntry {
  return {
    mex: { id: `mx_${id}`, kind, scope: ["**"], evidence: "person",
      source: { type: "person", ref: "fixture", quote: text, producer: "note" },
      one_line: text, checks: [], status, created: at().slice(0, 10) },
    text,
  };
}

function saveEntry(dir: string, item: KnowledgeEntry) {
  const file = join(dir, `${item.mex.id}.md`);
  mkdirSync(dir, { recursive: true });
  const raw = serializeEntry(item);
  writeFileSync(file, raw);
  return { file, originalHash: hash(raw) };
}

function notesDir(projectId: string) {
  return join(home, "projects", projectId, "notes");
}

function verdict(projectId: string, path: string, item: KnowledgeEntry, value: string, time = at()) {
  hooks.prepare("INSERT OR REPLACE INTO verdicts VALUES(?,?,?,?,?,?)").run(projectId, path, item.mex.id, value, "fixture", time);
}

function stage(repo: ReturnType<typeof project>, id: string, time: number) {
  const item = entry(id, "rule", `run checks for rule ${id}`);
  const { file, originalHash } = saveEntry(notesDir(repo.id), item);
  const key = `learning.offer.${item.mex.id}`;
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(repo.id, key, JSON.stringify({
    state: "review", id: item.mex.id, checkout: repo.path, personal_hash: originalHash, review_at: time,
  }));
  stageReview(writer, repo.id, learningReviewId(repo.id, item), item,
    { producer: "learning", key, checkout: repo.path, level: "personal", path: file, original_hash: originalHash },
    "waiting on a decision", true, time);
  return item;
}

function seedJob(id: string, state: JobState, fields: {
  kind?: string; projectId?: string; reason?: string; progress?: string; request?: "pause" | "cancel";
  results?: number; failures?: number; used?: number; estimate?: number; finished?: string;
} = {}) {
  writer.db.prepare(`INSERT INTO jobs(id,project_id,kind,state,reason,progress,request,results,failures,
    tokens_used,tokens_estimate,created_at,updated_at,owner,finished_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, fields.projectId ?? null, fields.kind ?? "file-index", state, fields.reason ?? (state === "failed" || state === "waiting" ? "fixture reason" : null), fields.progress ?? null,
    fields.request ?? null, fields.results ?? 0, fields.failures ?? 0, fields.used ?? 0, fields.estimate ?? null,
    at(-4000), at(-4000), state === "running" ? `background:${process.pid}:fixture` : null, fields.finished ?? null,
  );
}

function action(id: string, body: unknown, withHeaders?: (headers: Headers) => void) {
  const headers = new Headers({ "content-type": "application/json", "x-mex-csrf": csrfToken, origin: ORIGIN, "sec-fetch-site": "same-origin" });
  withHeaders?.(headers);
  return request(`/jobs/${id}/actions`, { method: "POST", body: JSON.stringify(body), headers });
}

describe("machine Hub Home", () => {
  it.each([
    ["UTC", [1, 2]],
    ["Asia/Kolkata", [0, 3]],
    ["America/Los_Angeles", [2, 1]],
    ["invalid/zone", [1, 2]],
  ])("folds UTC buckets and session counts into the last seven local days in %s", async (zone, sessionCounts) => {
    const alder = project("alder"), birch = project("birch");
    const first = "2026-11-23T18:31:45.123456789Z", second = "2026-11-24T07:57:00Z", third = "2026-11-24T08:02:00Z";
    session("first", alder, "claude-code", first);
    session("second", birch, "codex", second);
    session("third", alder, "other_agent", third);
    session("unregistered", { id: "removed", path: "/removed" }, "other", at());
    session("earlier", alder, "claude-code", "2026-11-16T20:00:00Z");
    receipt("first", first, "given");
    receipt("second", second, "given");
    receipt("third", third, "given");
    receipt("unregistered", at(), "given");
    receipt("earlier", "2026-11-16T20:00:00Z", "given");

    const data = await getHome(zone);
    expect(data.activity.map((day) => day.day)).toEqual(
      ["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24"],
    );
    expect(data.activity.map((day) => day.sessions)).toEqual([0, 0, 0, 0, 0, ...sessionCounts]);
    expect(data.activity.map((day) => day.gave)).toEqual(data.activity.map((day) => day.sessions));
    expect(data.activity.reduce((total, day) => total + day.sessions, 0)).toBe(3);
    expect(data.agents).toEqual(["Claude Code", "Codex", "Other Agent"]);
    expect(data.byRepo[alder.id].agents).toEqual(["Claude Code", "Other Agent"]);
    expect(data.byRepo[birch.id].activity.reduce((total, day) => total + day.sessions, 0)).toBe(1);
    expect(data.byRepo[alder.id].week).toEqual(data.week);
  });

  it("splits the bucket when midnight falls at a quarter-hour offset", async () => {
    const repo = project("repo");
    for (const [id, time] of [["before", "2026-11-23T18:14:00Z"], ["after", "2026-11-23T18:16:00Z"]]) {
      session(id, repo, "codex", time);
      receipt(id, time, "given");
    }
    const { activity } = await getHome("Asia/Kathmandu");
    expect(activity.slice(-2)).toEqual([
      { day: "2026-11-23", sessions: 1, gave: 1, heldBack: 0, replaced: 0 },
      { day: "2026-11-24", sessions: 1, gave: 1, heldBack: 0, replaced: 0 },
    ]);
  });

  it("counts the receipt rules in activity and the 20 latest registered sessions", async () => {
    const repo = project("repo");
    for (let index = 0; index < 24; index++) session(`history-${index}`, repo, "codex", at(-10_000 - index * 1_000));
    session("latest", repo, "claude-code", at(-1_000));
    session("orphan", { id: "unknown", path: "/unknown" }, "claude-code", at());
    for (const action of ["given", "replaced", "withheld"]) receipt("latest", at(-100), action);
    receipt("latest", at(-100), "given", { moment: "correction" });
    receipt("latest", at(-100), "given", { entry: "mex:internal-marker" });
    receipt("latest", at(-100), "withheld", { entry: "mex:internal-marker" });
    receipt("latest", at(-100), "withheld", { detail: "queue full" });
    receipt("latest", at(-100), "withheld", { moment: "correction" });
    const lever = { moment: "lever-observation", entry: "mex:lever:file-outline" };
    receipt("latest", at(-100), "control", { ...lever, detail: '{"kind":"saving","tokens_removed":9999}' });
    receipt("latest", at(-100), "control", { ...lever, detail: '{"kind":"saving"}', agent: "child" });
    receipt("latest", at(-100), "control", { ...lever, detail: '{"kind":"refetch"}' });
    receipt("latest", at(-100), "control", { ...lever, detail: "invalid JSON" });
    const data = await getHome();
    expect(data.sessions).toHaveLength(20);
    expect(data.sessions[0]).toEqual({ id: "latest", repoId: repo.id, agent: "Claude Code", at: at(-1_000), gave: 2, heldBack: 1, replaced: 1 });
    expect(data.sessions.at(-1)?.id).toBe("history-18");
    expect(data.activity.at(-1)).toEqual({ day: "2026-11-24", sessions: 25, gave: 2, heldBack: 1, replaced: 1 });
    expect(JSON.stringify(data)).not.toMatch(/tokens_removed|saving/u);
  });

  it("counts active notes and the most recent on checkout's team entries by kind and cached status", async () => {
    const repo = project("old-checkout");
    const newer = checkout(repo.id, "new-checkout");
    const offline = checkout(repo.id, "off-checkout", "off");
    checkout(repo.id, "deleted-checkout", "on", false);
    session("older", repo, "codex", at(-4000));
    session("newer", { id: repo.id, path: newer }, "codex", at(-3000));
    session("off", { id: repo.id, path: offline }, "codex", at(-1000));
    const rule = entry("personal1", "rule"), decision = entry("personal2", "decision"), recipe = entry("teamdoc1", "recipe");
    const pitfall = entry("teamdoc2", "pitfall"), fact = entry("teamdoc3", "fact"), procedure = entry("teamdoc4", "procedure");
    const retired = entry("personal3", "decision");
    for (const item of [rule, decision, retired, entry("pending1", "rule", "Proposed", "proposed"), entry("memory1", "hint")]) {
      saveEntry(notesDir(repo.id), item);
    }
    saveTombstone(writer, repo.id, retired, { by: "fixture", at: at().slice(0, 10), reason: "No longer applies" });
    for (const item of [recipe, pitfall, fact, procedure]) {
      saveEntry(join(newer, ".mex", "learned", item.mex.kind), item);
    }
    saveEntry(join(repo.path, ".mex", "learned"), entry("skipped1", "recipe"));
    saveEntry(join(offline, ".mex", "learned"), entry("skipped2", "rule"));
    verdict(repo.id, newer, rule, "held");
    verdict(repo.id, newer, decision, "changed");
    verdict(repo.id, newer, recipe, "broken");
    verdict(repo.id, newer, pitfall, "unknown");
    verdict(repo.id, repo.path, rule, "broken");
    verdict(repo.id, repo.path, fact, "held");

    expect(await getHome()).toMatchObject({ pending: true, needs: [], needsCount: {}, knowledge: {} });
    const data = await waitForSnapshot();
    expect(data.pending).toBeUndefined();
    expect(data.knowledge[repo.id]).toMatchObject({
      total: 6, onlyYou: 2, team: 4, upToDate: 1, codeChanged: 1, outOfDate: 1, notChecked: 3,
      byKind: {
        rule: { upToDate: 1 }, decision: { codeChanged: 1 }, recipe: { outOfDate: 1 },
        pitfall: { notChecked: 1 }, fact: { notChecked: 1 }, procedure: { notChecked: 1 },
      },
    });
    expect(data.knowledge[repo.id].byKind).not.toHaveProperty("hint");
  });

  it("deduplicates cross-checkout review cards, ranks contradictions first, and counts beyond the preview", async () => {
    const repo = project("repo"), another = project("second");
    const linked = checkout(repo.id, "worktree"), off = checkout(repo.id, "off", "off");
    const missing = checkout(repo.id, "missing", "on", false);
    writer.db.prepare("UPDATE projects SET shared=1").run();
    const earliest = NOW - 60_000;
    const one = stage(repo, "standard01", earliest);
    for (let index = 0; index < 22; index++) stage(repo, `standard${20 + index}`, NOW - 30_000 + index);
    stage(another, "standard99", earliest - 60_000);
    for (const [path, name] of [[linked, "conflict1"], [off, "conflict2"], [missing, "conflict3"]]) {
      stageConflict(writer, repo.id, {
        entry: entry(name, "rule", `Resolve ${name}`),
        checkout: path, evidence: ["fixture"], conflicts: [{ id: one.mex.id, level: "personal", revision: "fixture" }],
      }, new Date(NOW - 100));
    }

    await getHome();
    const data = await waitForSnapshot();
    expect(data.needs).toHaveLength(20);
    expect(data.needs.slice(0, 3).map(({ rule }) => rule)).toEqual(["Resolve conflict1", "run checks for rule standard99", "run checks for rule standard01"]);
    expect(data.needsCount).toEqual({
      [repo.id]: { count: 24, oldest: new Date(earliest).toISOString() },
      [another.id]: { count: 1, oldest: new Date(earliest - 60_000).toISOString() },
    });
  });

  it("keeps last good counts during refresh and after a project read fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repo = project("repo");
    const good = entry("count123", "rule");
    saveEntry(notesDir(repo.id), good);
    await getHome();
    const first = await waitForSnapshot();
    expect(first.knowledge[repo.id]).toMatchObject({ total: 1, notChecked: 1 });
    verdict(repo.id, repo.path, good, "held", at(1000));
    clock += 14_999;
    vi.advanceTimersByTime(14_999);
    expect((await getHome()).knowledge[repo.id].updatingSince).toBeUndefined();
    clock += 1;
    vi.advanceTimersByTime(1);
    const updating = await getHome();
    expect(updating.generatedAt).toBe(first.generatedAt);
    expect(updating.knowledge[repo.id]).toMatchObject({ total: 1, notChecked: 1, updatingSince: at(15_000) });
    expect((await waitForSnapshot()).knowledge[repo.id]).toMatchObject({ total: 1, upToDate: 1 });

    writeFileSync(join(notesDir(repo.id), "invalid.md"), "invalid Markdown");
    seedJob("finished", "done", { kind: "graph-verify", finished: at(19_000) });
    clock += 15_000;
    vi.advanceTimersByTime(15_000);
    expect((await getHome()).knowledge[repo.id]).toMatchObject({ total: 1, upToDate: 1, updatingSince: at(30_000) });
    expect((await waitForSnapshot()).knowledge[repo.id]).toMatchObject({ total: 1, upToDate: 1 });
  });

  it("waits two minutes for ordinary refreshes and stops scheduling when a tab goes idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repo = project("repo");
    await getHome();
    const original = await waitForSnapshot();
    expect(original.knowledge[repo.id].total).toBe(0);
    saveEntry(notesDir(repo.id), entry("newnote", "fact"));
    clock += 119_000;
    vi.advanceTimersByTime(119_000);
    expect((await getHome()).knowledge[repo.id].total).toBe(0);
    clock += 1_000;
    vi.advanceTimersByTime(1_000);
    expect((await getHome()).knowledge[repo.id]).toMatchObject({ total: 0, updatingSince: at(120_000) });
    expect((await waitForSnapshot()).knowledge[repo.id].total).toBe(1);
    clock += 120_000;
    vi.advanceTimersByTime(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the CLI's cached usage estimate and leaves both databases and WALs untouched on GET", async () => {
    const repo = project("repo");
    session("latest", repo, "codex", at(-1000));
    receipt("latest", at(-1000), "given");
    writer.db.prepare("INSERT INTO own_usage(day,agent,input,cache_write,cache_read,output,estimated) VALUES(?, 'codex', 10000, 0, 0, 0, 1)")
      .run(at().slice(0, 10));
    writer.db.prepare("INSERT INTO settings VALUES('own-usage','status.codex',?)")
      .run(JSON.stringify({ agent: "codex", status: "readable", files: 1, bytes: 100, pending: false }));
    writer.db.prepare(`INSERT INTO model_calls(ts,agent,model,purpose,kind,input,cache_write,cache_read,output,estimated)
      VALUES(?, 'codex', 'gpt-5', 'fixture', 'headless', 100, 0, 0, 0, 0)`).run(at(-1000));
    const expected = readStatus({ ...location(), cwd: repo.path, now: NOW }).modelUse!;
    const files = [writer.location.record, writer.location.hooks].flatMap((path) => [path, path + "-wal"]);
    const fileStats = () => files.map((path) => {
      const { size, mtimeNs } = statSync(path, { bigint: true });
      return { size, mtimeNs };
    });
    const before = fileStats();
    const data = await getHome();
    expect(expected.percent).toBeGreaterThan(0);
    expect(data.week).toEqual({ percent: expected.percent, capPercent: expected.capPercent });
    expect(data.byRepo[repo.id].week).toEqual(data.week);
    await waitForSnapshot();
    expect((await request("/jobs")).status).toBe(200);
    const stream = await request("/events");
    await stream.body?.cancel();
    expect(fileStats()).toEqual(before);
  });
});

describe("machine Hub Jobs", () => {
  it("requires the signed cookie on every new endpoint", async () => {
    for (const path of ["/home", "/jobs", "/events", "/jobs/unknown/actions"]) {
      const response = await request(path, path.endsWith("/actions") ? { method: "POST" } : {}, false);
      expect(response.status, path).toBe(401);
    }
  });

  it("maps every job state, registry labels, progress, committed results and costs", async () => {
    const repo = project("repo");
    seedJob("running", "running", { projectId: repo.id, progress: "Reading 412 of 1,180 files", results: 412 });
    seedJob("pausing", "running", { request: "pause", progress: "1.2 of 8 files" });
    seedJob("stopping", "running", { request: "cancel", progress: "2 of 0" });
    seedJob("paused", "paused", { progress: "1234 of 2345", used: 4 });
    seedJob("queued", "queued", { kind: "learn-deeper-weekly", estimate: 100, progress: "Reading batch 1 of 3 and 2 of 5 files" });
    seedJob("waiting", "waiting", { kind: "learn-deeper-weekly", reason: "Waiting: offline", estimate: 100 });
    seedJob("done", "done", { kind: "learn-deeper", results: 8, progress: "Finished work", estimate: 100, used: 75 });
    seedJob("gaps", "done with gaps", { kind: "graph-verify", results: 5 });
    seedJob("cancelled", "cancelled", { kind: "future-kind", results: 2, used: 1 });
    seedJob("failed", "failed", { reason: "Could not read the checkout", failures: 3 });
    const jobs = MachineJobsSchema.parse(await (await request("/jobs")).json());
    const byId = Object.fromEntries(jobs.map((job) => [job.id, job]));
    expect(byId.running).toMatchObject({
      repoId: repo.id, label: "File index", kind: "file-index", state: { phase: "running" },
      activity: "Reading 412 of 1,180 files", progress: { completed: 412, total: 1180 },
      result: { verb: "Mapped", unit: "file", count: 412 }, cost: null, started: at(-4000),
    });
    expect(byId.pausing).toMatchObject({ state: { phase: "running", pausing: true } });
    expect(byId.pausing.progress).toBeUndefined();
    expect(byId.stopping).toMatchObject({ state: { phase: "running", stopping: true } });
    expect(byId.stopping.progress).toBeUndefined();
    expect(byId.paused).toMatchObject({ state: { phase: "paused" }, progress: { completed: 1234, total: 2345 }, cost: { usedTokens: 4 } });
    expect(byId.queued).toMatchObject({ state: { phase: "queued" }, cost: { estimatedTokens: 100, startsWhenIdle: true } });
    expect(byId.queued.progress).toBeUndefined();
    expect(byId.waiting).toMatchObject({ state: { phase: "waiting", reason: "Waiting: offline" }, cost: { startsWhenIdle: true } });
    expect(byId.done).toMatchObject({ state: { phase: "done" }, result: { verb: "Learned", count: 8 }, cost: { estimatedTokens: 100, usedTokens: 75 } });
    expect(byId.done.activity).toBeUndefined();
    expect(byId.gaps).toMatchObject({ state: { phase: "doneWithGaps" }, result: { verb: "Checked", count: 5 } });
    expect(byId.cancelled.state).toEqual({ phase: "stopped" });
    expect(byId.cancelled.result).toBeUndefined();
    expect(byId.failed.state).toEqual({ phase: "failed", cause: "Could not read the checkout", identicalFailures: 3 });
  });

  it("rejects cross-origin writes, missing CSRF, bad bodies, and unknown IDs", async () => {
    seedJob("job", "running");
    const pause = { action: "pause", expectedState: "running" };
    expect((await action("job", pause, (headers) => headers.delete("origin"))).status).toBe(403);
    expect((await action("job", pause, (headers) => headers.set("origin", "http://127.0.0.1:8192"))).status).toBe(403);
    expect((await action("job", pause, (headers) => headers.set("sec-fetch-site", "same-site"))).status).toBe(403);
    expect((await action("job", pause, (headers) => headers.delete("x-mex-csrf"))).status).toBe(403);
    expect((await action("job", { action: "pause", expectedState: "stopped" })).status).toBe(400);
    expect((await action("unknown", pause)).status).toBe(404);
    expect(writer.db.prepare("SELECT request FROM jobs WHERE id='job'").get()?.request).toBeNull();
  });

  it("returns the current job on stale actions and keeps double pause harmless", async () => {
    seedJob("job", "running");
    const stale = await action("job", { action: "pause", expectedState: "queued" });
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).toContain("application/problem+json");
    expect(MachineJobConflictSchema.parse(await stale.json()).job.state).toEqual({ phase: "running" });
    expect(writer.db.prepare("SELECT request FROM jobs WHERE id='job'").get()?.request).toBeNull();

    const body = { action: "pause", expectedState: "running" };
    const accepted = await action("job", body);
    expect(accepted.status).toBe(200);
    expect(MachineJobActionResponseSchema.parse(await accepted.json()).state).toEqual({ phase: "running", pausing: true });
    const sql = writer.db.prepare("SELECT * FROM jobs WHERE id='job'");
    const before = sql.get();
    const repeated = await action("job", body);
    expect(repeated.status).toBe(409);
    expect(MachineJobConflictSchema.parse(await repeated.json()).job.state).toEqual({ phase: "running", pausing: true });
    expect(sql.get()).toEqual(before);
    const stopped = await action("job", { action: "stop", expectedState: "running" });
    expect(MachineJobActionResponseSchema.parse(await stopped.json()).state).toEqual({ phase: "running", stopping: true });
    expect(sql.get()?.request).toBe("cancel");
  });

  it("rejects changes to parameters between validation and the request transaction", async () => {
    seedJob("job", "queued");
    const original = recordJobs.requestJob;
    vi.spyOn(recordJobs, "requestJob").mockImplementationOnce((...args) => {
      writer.db.prepare("UPDATE jobs SET params=? WHERE id='job'").run('{"changed":true}');
      return original(...args);
    });
    const response = await action("job", { action: "pause", expectedState: "queued" });
    expect(response.status).toBe(409);
    expect(MachineJobConflictSchema.parse(await response.json()).job.state).toEqual({ phase: "queued" });
  });

  it("resets only failed jobs with three identical failures and wakes the same home's background process", async () => {
    const wake = vi.spyOn(background, "ensureBackground");
    seedJob("weak", "failed", { failures: 2 });
    seedJob("failed", "failed", { failures: 3, results: 9, kind: "learn-deeper" });
    seedJob("paused", "paused");
    expect((await action("weak", { action: "reset", expectedState: "failed" })).status).toBe(409);
    expect((await action("failed", { action: "resume", expectedState: "failed" })).status).toBe(409);
    expect((await action("paused", { action: "reset", expectedState: "paused" })).status).toBe(409);
    expect(wake).not.toHaveBeenCalled();

    const reset = await action("failed", { action: "reset", expectedState: "failed" });
    expect(reset.status).toBe(200);
    expect(MachineJobActionResponseSchema.parse(await reset.json())).toMatchObject({ state: { phase: "queued" }, result: { count: 9 } });
    expect(writer.db.prepare("SELECT failures FROM jobs WHERE id='failed'").get()?.failures).toBe(0);
    expect((await action("paused", { action: "resume", expectedState: "paused" })).status).toBe(200);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ force: true, home }));
  });
});

describe("machine Hub events", () => {
  const decode = new TextDecoder();
  const chunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => decode.decode((await reader.read()).value);
  function change(frame: string) {
    expect(frame).toContain("event: change\n");
    return MachineChangeEventSchema.parse(JSON.parse(frame.split("\n")[1].slice(6)));
  }

  it("broadcasts progress, token and activity changes and a keepalive from one poller", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const repo = project("repo");
    session("first", repo, "codex", at(-1000));
    seedJob("job", "running", { progress: "1 of 3" });
    const response = await request("/events");
    const another = await request("/events");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader(), second = another.body!.getReader();
    expect(await chunk(reader)).toContain(": connected");
    expect(await chunk(second)).toContain(": connected");
    expect(vi.getTimerCount()).toBe(2);

    writer.db.prepare("UPDATE jobs SET progress='2 of 3' WHERE id='job'").run();
    vi.advanceTimersByTime(2000);
    expect(change(await chunk(reader))).toEqual({ topics: ["jobs"] });
    expect(change(await chunk(second))).toEqual({ topics: ["jobs"] });

    writer.db.prepare("UPDATE jobs SET tokens_used=10 WHERE id='job'").run();
    receipt("first", at(-100), "given");
    vi.advanceTimersByTime(2000);
    expect(change(await chunk(reader))).toEqual({ topics: ["jobs", "home"] });
    expect(change(await chunk(second))).toEqual({ topics: ["jobs", "home"] });

    vi.advanceTimersByTime(21_000);
    expect(await chunk(reader)).toBe(": keepalive\n\n");
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(2);
    await second.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps streams at eight, frees a cancelled slot and closes all clients with the app", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const abort = new AbortController();
    const readers = [];
    for (let index = 0; index < 8; index++) {
      const response = await request("/events", index === 0 ? { signal: abort.signal } : {});
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await chunk(reader);
      readers.push(reader);
    }
    const overCapacity = await request("/events");
    expect(overCapacity.status).toBe(503);
    expect(overCapacity.headers.get("content-type")).toContain("application/problem+json");
    expect((await request("/events", { method: "HEAD" })).status).toBe(200);
    abort.abort();
    expect((await readers[0].read()).done).toBe(true);
    const replacement = (await request("/events")).body!.getReader();
    await chunk(replacement);
    app.close();
    expect((await replacement.read()).done).toBe(true);
    for (const reader of readers.slice(1)) expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("extends the tab lease on the shared timer at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = (await request("/events")).body!.getReader();
    const until = () => writer.db.prepare("SELECT hub_until FROM background WHERE id=1").get()?.hub_until;
    const before = until();
    clock += 59_999;
    vi.advanceTimersByTime(59_999);
    expect(until()).toBe(before);
    clock += 1;
    vi.advanceTimersByTime(1);
    expect(until()).toBe(at(180_000));
    clock += 2_000;
    vi.advanceTimersByTime(2_000);
    expect(until()).toBe(at(180_000));
    await stream.cancel();
  });

  it("lets the real HTTP listener close promptly with an open stream", async () => {
    const running = await startMachineHub({ ...location(), mode: "terminal", port: 0, now, assetRoot: null });
    try {
      const result = await fetch(`${running.origin}/api/v1/events`, { headers: { cookie }, signal: AbortSignal.timeout(3_000) });
      expect(result.status).toBe(200);
      const reader = result.body!.getReader();
      expect(await chunk(reader)).toBe(": connected\n\n");
      const started = performance.now();
      await running.close();
      expect(performance.now() - started).toBeLessThan(1_500);
      expect((await reader.read()).done).toBe(true);
    } finally { await running.close(); }
  });
});
