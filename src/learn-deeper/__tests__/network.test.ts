import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { evaluate } from "../../judge/native.js";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { serializeEntry, type EntryCheck } from "../../knowledge/entry.js";
import { queueJob } from "../../record/background.js";
import { openRecord } from "../../record/index.js";
import { ownerId, registerJobKind, runOneBatch } from "../../record/jobs.js";
import { ForgeClient, SourceError } from "../forge.js";
import { evidenceDigest } from "../harvest/index.js";
import { networkGroups, networkProofKey, networkRowKey, NETWORK_KIND, type NetworkGroup } from "../network-proof.js";
import { networkKind, networkObservations } from "../network.js";
import type { Candidate } from "../harvest/types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/network.json", import.meta.url), "utf8")) as {
  bodies: Record<string, string | null>; denied: unknown;
};
const repo = { host: "github.com", slug: "example/repo" } as const;
const url = "https://github.com/example/repo/pull/1";
const at = Date.parse("2026-11-23T00:00:00Z");
const description = fixture.bodies.PR_fixture!;
const cases: Array<NetworkGroup & { id: string; state?: "same" | "edited" | "deleted" }> = [
  { id: "mx_net001", url, nodes: ["IC_fixture", "PR_fixture"], hash: evidenceDigest([fixture.bodies.IC_fixture!, description]), complete: true, state: "same" },
  { id: "mx_net002", url, nodes: ["PR_fixture"], hash: evidenceDigest([description]), complete: true, state: "same" },
  { id: "mx_net003", url, nodes: ["PRRC_edited"], hash: evidenceDigest(["Use the original request logger."]), complete: true, state: "edited" },
  { id: "mx_net004", url, nodes: ["PRRC_deleted"], hash: evidenceDigest(["Keep stable request IDs."]), complete: true, state: "deleted" },
  { id: "mx_net005", url, nodes: ["PRRC_deleted"], hash: evidenceDigest(["Incomplete evidence."]), complete: false },
];

function check(url: string, hash: string): EntryCheck {
  return { kind: "source", role: "supporting", target: { url }, saw: { hash }, files: {} };
}

// The evaluator is the native binary; build it from this tree, as CI has no installed one.
let built: string, binary: string;
beforeAll(() => {
  built = realpathSync(mkdtempSync(join(tmpdir(), "mex-net-hook-")));
  binary = join(built, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(built, { recursive: true, force: true }));

it("writes captured-hash rows from recorded nodes and the native evaluator holds, changes, or reports Gone", async () => {
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-net-")));
  const checkout = join(root, "repo"), home = join(root, "home");
  mkdirSync(checkout);
  const writer = openRecord({ projectPath: checkout, home, create: true });
  const registered = writer.checkout(checkout)!;
  const project = registered.project_id;
  const requests: string[][] = [];
  const client = new ForgeClient(repo, "fixture", async (_input, options) => {
    if (options?.method !== "POST") return Response.json({ full_name: repo.slug });
    const request = JSON.parse(String(options.body));
    expect(request.query).toContain("nodes(ids: $ids)");
    const ids: string[] = request.variables.ids;
    requests.push(ids);
    return Response.json({ data: { nodes: ids.map(id => fixture.bodies[id] === null ? null : { id, body: fixture.bodies[id] }) } });
  });
  try {
    const notes = join(writer.location.home, "projects", project, "notes");
    mkdirSync(notes, { recursive: true });
    for (const { id, state: _state, ...group } of cases) {
      const saved = entry(id, { source: { type: "review", ref: url, producer: "learn-deeper" }, evidence: "review", checks: [check(group.url, group.hash)] });
      writeFileSync(join(notes, id + ".md"), serializeEntry(saved));
      writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, networkProofKey(id), JSON.stringify([group]));
    }
    registerJobKind(networkKind(() => at, async () => client));
    const job = queueJob(writer, { kind: NETWORK_KIND, projectId: project, params: {
      checkout: registered.path, origin: repo, source: repo, visibility: "public", agent: "codex", setup: "best-only", preferred: [],
      head: "a".repeat(40), since: new Date(at).toISOString(), due: at,
    } }).job;
    const owner = ownerId("background");
    expect(await runOneBatch(writer, owner)).toBe("ran");
    expect(await runOneBatch(writer, owner)).toBe("ran");
    expect(writer.db.prepare("SELECT state FROM jobs WHERE id=?").get(job.id)?.state).toBe("done");
    expect(requests).toEqual([["IC_fixture", "PR_fixture", "PRRC_edited", "PRRC_deleted"]]);
    for (const { url, hash, state } of cases) expect(writer.setting(project, networkRowKey(url, hash)))
      .toBe(state ? JSON.stringify({ state, at: new Date(at).toISOString() }) : undefined);
    const report = await evaluate({ checkout: registered.path, project_id: project, mex_home: writer.location.home, record_directory: writer.location.directory });
    expect(report.results?.map(item => [item.entry_id, item.verdict, item.checks[0]?.status])).toEqual([
      ["mx_net001", "held", "pass"], ["mx_net002", "held", "pass"], ["mx_net003", "changed", "fail"],
      ["mx_net004", "changed", "gone"], ["mx_net005", "unknown", "floor"],
    ]);
  } finally {
    registerJobKind(networkKind());
    writer.close();
    rmSync(root, { force: true, recursive: true });
  }
});

it("leaves mismatched and inaccessible groups unchecked, and batches up to 100 nodes", async () => {
  const denied = new ForgeClient(repo, "fixture", async () => Response.json(fixture.denied));
  expect(await networkObservations(denied, [cases[3]!])).toEqual([]);
  const ids = Array.from({ length: 101 }, (_, i) => `IC_${i}`);
  const groups = [ids.slice(0, 64), ids.slice(64)].map(nodes => ({ url, nodes, complete: true, hash: evidenceDigest(nodes) }));
  const graphql = vi.fn(async (_query, { ids }: { ids: string[] }) => ({ nodes: ids.map(id => ({ id, body: id })) }));
  expect((await networkObservations({ graphql: graphql as ForgeClient["graphql"] }, groups)).map(item => item.state)).toEqual(["same", "same"]);
  expect(graphql.mock.calls.map(([, { ids }]) => ids.length)).toEqual([100, 1]);
});

it("records unavailable when a complete source cannot be read, and floors a stale same", async () => {
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-net-")));
  const checkout = join(root, "repo"), home = join(root, "home");
  mkdirSync(checkout);
  const writer = openRecord({ projectPath: checkout, home, create: true });
  const registered = writer.checkout(checkout)!;
  const project = registered.project_id;
  const denied = new ForgeClient(repo, "fixture", async () => { throw new SourceError("unavailable"); });
  try {
    const notes = join(writer.location.home, "projects", project, "notes");
    mkdirSync(notes, { recursive: true });
    const { id, state: _state, ...group } = cases[0]!;
    const saved = entry(id, { source: { type: "review", ref: url, producer: "learn-deeper" }, evidence: "review", checks: [check(group.url, group.hash)] });
    writeFileSync(join(notes, id + ".md"), serializeEntry(saved));
    writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, networkProofKey(id), JSON.stringify([group]));
    registerJobKind(networkKind(() => at, async () => denied));
    queueJob(writer, { kind: NETWORK_KIND, projectId: project, params: {
      checkout: registered.path, origin: repo, source: repo, visibility: "public", agent: "codex", setup: "best-only", preferred: [],
      head: "a".repeat(40), since: new Date(at).toISOString(), due: at,
    } });
    const owner = ownerId("background");
    expect(await runOneBatch(writer, owner)).toBe("ran");
    expect(JSON.parse(writer.setting(project, networkRowKey(group.url, group.hash))!).state).toBe("unavailable");
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify({ state: "same", at: "2020-01-01T00:00:00.000Z" }), project, networkRowKey(group.url, group.hash));
    const stale = await evaluate({ checkout: registered.path, project_id: project, mex_home: writer.location.home, record_directory: writer.location.directory });
    expect(stale.results?.[0]?.checks[0]).toMatchObject({ status: "floor", reason: "the linked source check is stale" });
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify({ state: "unavailable", at: new Date(at).toISOString() }), project, networkRowKey(group.url, group.hash));
    const unread = await evaluate({ checkout: registered.path, project_id: project, mex_home: writer.location.home, record_directory: writer.location.directory });
    expect(unread.results?.[0]?.checks[0]).toMatchObject({ status: "floor", reason: "the linked source could not be read" });
  } finally {
    registerJobKind(networkKind());
    writer.close();
    rmSync(root, { force: true, recursive: true });
  }
});

it("imports portable node ids and notices one changed comment", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-net-share-")));
  const checkout = join(root, "repo"), home = join(root, "home");
  mkdirSync(join(checkout, ".mex"), { recursive: true });
  const hash = evidenceDigest(["kept"]);
  writeFileSync(join(checkout, ".mex", "sources.json"), JSON.stringify({ version: 1, rule_files: [], learn_deeper_network: [
    { id: "mx_net009", url, hash, nodes: ["IC_fixture"], commentHashes: { IC_fixture: evidenceDigest(["kept"]) } },
  ] }));
  const writer = openRecord({ projectPath: checkout, home, create: true });
  const registered = writer.checkout(checkout)!;
  const graphql = vi.fn(async (_query: string, input: { ids: string[] }) => ({ nodes: input.ids.map(id => ({ id, body: "kept" })) }));
  const client = new ForgeClient(repo, "fixture", async (_input, options) => {
    if (options?.method !== "POST") return Response.json({ full_name: repo.slug });
    const request = JSON.parse(String(options.body));
    return Response.json({ data: await graphql(request.query, request.variables) });
  });
  try {
    registerJobKind(networkKind(() => at, async () => client));
    queueJob(writer, { kind: NETWORK_KIND, projectId: registered.project_id, params: {
      checkout: registered.path, origin: repo, source: repo, visibility: "public", agent: "codex", setup: "best-only", preferred: [],
      head: "a".repeat(40), since: new Date(at).toISOString(), due: at,
    } });
    expect(await runOneBatch(writer, ownerId("background"))).toBe("ran");
    expect(JSON.parse(writer.setting(registered.project_id, networkProofKey("mx_net009"))!)[0].nodes).toEqual(["IC_fixture"]);
    const changed = await networkObservations({ graphql: async (_query, input: { ids: string[] }) => ({ nodes: input.ids.map(id => ({ id, body: "edited" })) }) },
      [{ url, hash, nodes: ["IC_fixture"], complete: true, commentHashes: { IC_fixture: evidenceDigest(["kept"]) } }]);
    expect(changed.map(item => item.state)).toEqual(["edited"]);
  } finally {
    registerJobKind(networkKind());
    writer.close();
    rmSync(root, { force: true, recursive: true });
  }
});

it("stores only the groups behind the saved URL checks and marks oversized groups incomplete", () => {
  const saved = entry("mx_net001", { checks: cases.slice(0, 3).map(({ url, hash }) => check(url, hash)) });
  const candidates = cases.slice(0, 2).map(group => ({ link: group.url, hash: group.hash, nodeIds: group.nodes }) as Candidate);
  candidates[0]!.nodeIds = Array.from({ length: 65 }, (_, i) => `IC_${i}`);
  const proof = networkGroups(saved, candidates);
  expect(proof.map(group => [group.complete, group.nodes.length])).toEqual([[false, 64], [true, 1], [false, 0]]);
});
