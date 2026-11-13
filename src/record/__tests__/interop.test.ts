import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openHooksReadOnly, openRecord, projectIdentity, recordLocation } from "../index.js";
import { fixtureRepos, git } from "./fixtures/repos.js";

const goAvailable = spawnSync("go", ["version"], { windowsHide: true }).status === 0;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const temp = () => mkdtempSync(join(tmpdir(), "mex-record-interop-"));

describe.skipIf(!goAvailable)("real Node/Go interoperability", () => {
  beforeEach(() => {
    for (const key of ["MEX_HOME", "HOME", "LOCALAPPDATA", "XDG_CACHE_HOME"]) vi.stubEnv(key, temp());
  });
  afterEach(() => vi.unstubAllEnvs());
  let binary: string;
  beforeAll(() => {
    binary = join(temp(), process.platform === "win32" ? "record.test.exe" : "record.test");
    execFileSync("go", ["test", "-c", "-o", binary, "./record"], {
      cwd: resolve("native"), env: { ...process.env, CGO_ENABLED: "0" }, timeout: 240000, windowsHide: true, stdio: "pipe",
    });
  }, 250000);

  function peer(mode: string, home: string, cache: string, extra: Record<string, string> = {}) {
    const ready = join(temp(), "ready.json");
    const child = spawn(binary, ["-test.run=^TestPeer$", "-test.timeout=20s"], {
      env: { ...process.env, MEX_HOME: home, MEX_RECORD_TEST_PEER: mode, MEX_RECORD_TEST_CACHE: cache, MEX_RECORD_TEST_READY: ready, ...extra }, windowsHide: true,
    });
    let output = ""; child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => output += data);
    const done = new Promise<void>((accept, reject) => {
      child.on("error", reject); child.on("exit", (code) => code === 0 ? accept() : reject(Error(output)));
    });
    // Attach rejection handling immediately while the parent polls readiness.
    void done.catch(() => {});
    return { child, ready, done };
  }
  async function readyFile(file: string, child: ChildProcess) {
    for (let attempt = 0; attempt < 3000; attempt++) {
      if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
      if (child.exitCode !== null) throw Error("Go peer exited before readiness");
      await sleep(2);
    }
    throw Error("Go peer readiness timeout");
  }

  it("agrees byte for byte on folder, clone, worktree, shallow, unborn, multi-root and submodule ids", async () => {
    const root = temp(); const repos = fixtureRepos(root);
    const [repo] = repos;
    git(repo, "checkout", "--orphan", "additional-root"); git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "additional");
    const subsource = join(root, "subsource"); mkdirSync(subsource);
    git(subsource, "init"); git(subsource, "config", "user.name", "Fixture"); git(subsource, "config", "user.email", "fixture.invalid");
    git(subsource, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "separate submodule root");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", subsource, "sub"); repos.push(subsource, join(repo, "sub"));
    const fixtures = join(root, "ids.json"); writeFileSync(fixtures, JSON.stringify(repos.map((path) => projectIdentity(path))));
    const run = peer("identity", temp(), temp(), { MEX_RECORD_TEST_FIXTURES: fixtures });
    try { await run.done; } finally { run.child.kill(); }
  }, 30000);

  it("Go writes hooks.db while Node reads WAL updates through the same cached network location", async () => {
    const home = temp(); const cache = temp();
    const options = { home, cache, isNetwork: () => true };
    const location = recordLocation(options);
    const run = peer("hooks-write", home, cache);
    let reader: ReturnType<typeof openHooksReadOnly>; const observed = new Set<number>();
    try {
      // Go has created hooks.db in WAL mode before it reports ready, so every read here must succeed.
      expect(await readyFile(run.ready, run.child)).toEqual(location);
      reader = openHooksReadOnly(options);
      expect(reader).toBeDefined();
      for (let attempt = 0; attempt < 3000; attempt++) {
        const finished = run.child.exitCode !== null;
        const count = reader!.get<{ n: number }>("SELECT count(*) n FROM sessions")!.n;
        observed.add(count);
        // Stop once Go exits so a failed writer reports its own error instead of a timeout.
        if (count === 150 || finished) break;
        await sleep(2);
      }
      await run.done;
      expect(observed.has(150)).toBe(true); expect([...observed].some((n) => n > 0 && n < 150)).toBe(true);
      expect(reader!.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
      expect(() => reader!.all("DELETE FROM sessions RETURNING *")).toThrow(/readonly/i);
    } finally { reader?.close(); run.child.kill(); }
  }, 30000);

  it("Node writes record.db while Go reads projects and live settings without writing it", async () => {
    const home = temp(); const cache = temp(); const project = temp();
    const writer = openRecord({ home, cache, isNetwork: () => true, projectPath: project });
    writer.db.prepare("INSERT INTO settings VALUES('interop','progress','starting')").run();
    const run = peer("record-read", home, cache, { MEX_RECORD_TEST_PROJECT: projectIdentity(project).id });
    try {
      expect(await readyFile(run.ready, run.child)).toEqual(writer.location);
      const update = writer.db.prepare("UPDATE settings SET value=? WHERE scope='interop' AND key='progress'");
      for (let index = 0; index < 150; index++) { update.run(String(index)); await sleep(2); }
      update.run("done"); await run.done;
      expect(writer.setting("interop", "progress")).toBe("done");
    } finally { writer.close(); run.child.kill(); }
  }, 30000);

  it("Go recreates a missing cached directory from Node's location without changing the pointer", async () => {
    const home = temp(); const cache = temp();
    const normalizedHome = recordLocation({ home, cache, create: false, isNetwork: () => false }).home;
    const { shortHash, absolutePath } = await import("../project.js");
    const directory = absolutePath(join(cache, shortHash(normalizedHome)));
    writeFileSync(join(home, "location"), `${directory}\n`);
    expect(existsSync(directory)).toBe(false);
    const run = peer("hooks-write", home, cache);
    try {
      expect((await readyFile(run.ready, run.child)).directory).toBe(directory); await run.done;
      expect(existsSync(join(directory, "hooks.db"))).toBe(true);
      expect(readFileSync(join(home, "location"), "utf8")).toBe(`${directory}\n`);
    } finally { run.child.kill(); }
  }, 30000);

  it("agrees on the default MEX_HOME base plus .mex in Node and Go", async () => {
    const base = temp(), cache = temp(), before = process.env.MEX_HOME;
    process.env.MEX_HOME = base;
    let location;
    try { location = recordLocation({ cache, isNetwork: () => true }); }
    finally { if (before === undefined) delete process.env.MEX_HOME; else process.env.MEX_HOME = before; }
    const run = peer("location-env", base, cache);
    try { expect(await readyFile(run.ready, run.child)).toEqual(location); await run.done; }
    finally { run.child.kill(); }
  });

  it("Go reads pinned checkout ids with no Git executable, including links, descendants and Windows case aliases", async () => {
    const [repo] = fixtureRepos(temp()); const home = temp(), cache = temp();
    const writer = openRecord({ home, cache, projectPath: repo, isNetwork: () => false });
    const id = writer.checkout(repo)!.project_id;
    git(repo, "checkout", "--orphan", "new-history"); git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "other root");
    expect(projectIdentity(repo).id).not.toBe(id);
    const alias = join(temp(), "alias"); symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    const nested = join(repo, "nested");
    const fixtures = [{ path: repo, id }, { path: alias, id }, { path: nested, id }, { path: temp(), id: "" }];
    if (process.platform === "win32") fixtures.push({ path: repo.toUpperCase(), id });
    const file = join(temp(), "checkouts.json"); writeFileSync(file, JSON.stringify(fixtures));
    const run = peer("checkout-read", home, cache, { MEX_RECORD_TEST_FIXTURES: file, PATH: "" });
    try { await run.done; }
    finally { writer.close(); run.child.kill(); if (process.platform === "win32") rmdirSync(alias); else unlinkSync(alias); }
  }, 30000);
});
