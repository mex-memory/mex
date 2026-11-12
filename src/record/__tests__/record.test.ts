import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { openRecord, openRecordReadOnly, openHooksReadOnly, migrateRecord, schemaVersion, projectIdentity, recordLocation, projectDataDirectory, JOB_STATES } from "../index.js";
import { absolutePath, realPath, shortHash } from "../project.js";
import { mexHomeDir } from "../../global-config.js";
import { darwinNetworkMount, windowsNetworkHome, WINDOWS_NETWORK_QUERY_TIMEOUT_MS } from "../location.js";

const closes: Array<() => void> = [];
beforeEach(() => {
  for (const key of ["MEX_HOME", "HOME", "LOCALAPPDATA", "XDG_CACHE_HOME"]) vi.stubEnv(key, temp());
});
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); vi.unstubAllEnvs(); });
function temp(): string { return mkdtempSync(join(tmpdir(), "mex-record-")); }
function open(home = temp()) { const record = openRecord({ home, isNetwork: () => false }); closes.push(() => record.close()); return record; }
import { git, fixtureRepos } from "./fixtures/repos.js";

describe("record schema and ownership", () => {
  it("creates every Node-owned table with WAL, version 3, and idempotent project/checkout registration", () => {
    const directory = temp(); const project = temp();
    const writer = openRecord({ home: directory, projectPath: project, isNetwork: () => false }); closes.push(() => writer.close());
    writer.register(projectIdentity(project));
    expect(schemaVersion(writer.db)).toBe(3);
    expect(writer.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
    expect(writer.db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
    expect(writer.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((row) => row.name))
      .toEqual(["background", "checkouts", "counters_node", "installs", "job_results", "jobs", "judgements", "model_calls", "notices", "own_usage", "projects", "review", "settings", "usage_events", "usage_files", "usage_snapshots", "usage_windows"]);
    expect(writer.db.prepare("SELECT count(*) n FROM checkouts").get()!.n).toBe(1);
    expect(writer.project(projectIdentity(project).id)?.kind).toBe("folder");
    expect(existsSync(join(directory, "projects"))).toBe(false);
    expect(existsSync(projectDataDirectory(writer.location, projectIdentity(project).id))).toBe(true);
    expect(() => projectDataDirectory(writer.location, "../escape")).toThrow("Invalid project id");
  });
  it("reserves exactly the requested job states and requires a waiting reason or failure cause", () => {
    const writer = open();
    const insert = writer.db.prepare("INSERT INTO jobs(id,kind,state,reason,created_at,updated_at) VALUES(?,'test',?,?, 'now','now')");
    for (const state of JOB_STATES) insert.run(state, state, ["waiting", "failed"].includes(state) ? "one reason" : null);
    expect(() => insert.run("bad", "succeeded", null)).toThrow();
    expect(() => insert.run("wait", "waiting", null)).toThrow();
    expect(() => insert.run("fail", "failed", " ")).toThrow();
    expect(() => writer.db.exec("INSERT INTO judgements VALUES('missing','e','h','invalid','now')")).toThrow();
  });
  it("migrates an empty version 0 and a compatible pre-release subset without losing settings", () => {
    for (const synthetic of [false, true]) {
      const home = temp(); const file = join(home, "record.db"); const db = new DatabaseSync(file);
      if (synthetic) db.exec("CREATE TABLE settings(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(scope,key)); INSERT INTO settings VALUES('global','kept','yes')");
      db.close(); const writer = open(home);
      expect(schemaVersion(writer.db)).toBe(3);
      if (synthetic) expect(writer.setting("global", "kept")).toBe("yes");
    }
  });
  it("rolls back both partial migration SQL and user_version on failure", () => {
    const db = new DatabaseSync(join(temp(), "record.db")); closes.push(() => db.close());
    expect(() => migrateRecord(db, [{ version: 1, sql: "CREATE TABLE partial(n); INSERT INTO no_such_table VALUES(1)" }])).toThrow();
    expect(schemaVersion(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='partial'").get()).toBeUndefined();
    migrateRecord(db); expect(schemaVersion(db)).toBe(3);
  });
  it("refuses to write a newer schema, reports it to readers, and reads older tables without migrating", () => {
    const writer = open(); const home = writer.location.home;
    writer.db.exec("PRAGMA user_version=99"); writer.close();
    expect(() => openRecord({ home })).toThrow("schema version 99 is newer");
    const reader = openRecordReadOnly({ home })!; closes.push(() => reader.close());
    expect(reader.diagnostic).toContain("99");
    expect(() => reader.all("INSERT INTO settings VALUES('a','b','c') RETURNING *")).toThrow();
    const old = temp(); const db = new DatabaseSync(join(old, "record.db"));
    db.exec("CREATE TABLE settings(scope,key,value); INSERT INTO settings VALUES('g','k','v')"); db.close();
    const older = openRecordReadOnly({ home: old, isNetwork: () => false })!; closes.push(() => older.close());
    expect(older.version).toBe(0); expect(older.setting("g", "k")).toBe("v");
    expect(older.all("SELECT name FROM sqlite_schema WHERE name='projects'")).toEqual([]);
  });
  it("never creates a missing hooks file or gives its Node reader write permission", () => {
    const home = temp(); expect(openHooksReadOnly({ home, isNetwork: () => false })).toBeUndefined();
    expect(existsSync(join(home, "location"))).toBe(false);
    const db = new DatabaseSync(join(home, "hooks.db"));
    db.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('one'); PRAGMA user_version=1"); db.close();
    const reader = openHooksReadOnly({ home, isNetwork: () => false })!; closes.push(() => reader.close());
    expect(reader.all("SELECT * FROM sessions")).toEqual([{ session_id: "one" }]);
    expect(() => reader.all("INSERT INTO sessions VALUES('two') RETURNING *")).toThrow(/readonly/i);
    expect(() => reader.all("PRAGMA query_only=OFF")).not.toThrow();
    expect(() => reader.all("DELETE FROM sessions RETURNING *")).toThrow(/readonly/i);
  });
  it("keeps the supported hooks version at 1 when record.db advances to 2", () => {
    const home = temp(); const db = new DatabaseSync(join(home, "hooks.db"));
    db.exec("PRAGMA user_version=2"); db.close();
    const reader = openHooksReadOnly({ home, isNetwork: () => false })!; closes.push(() => reader.close());
    expect(reader.diagnostic).toContain("hooks.db schema version 2 is newer than supported version 1");
  });
});

describe("location and identity", () => {
  it("recognizes macOS network mounts with spaces and chooses the longest mount prefix", () => {
    const mounts = "/dev/disk on / (apfs, local)\nserver:/data on /Volumes/Remote\\040Files (nfs, nodev)\n/dev/disk2 on /Volumes/Remote\\040Files/local (apfs, local)";
    expect(darwinNetworkMount("/Volumes/Remote Files/home", mounts)).toBe(true);
    expect(darwinNetworkMount("/Volumes/Remote Files/local/home", mounts)).toBe(false);
    expect(darwinNetworkMount("/Volumes/Remote Files-other/home", mounts)).toBe(false);
  });
  it("uses exactly the existing home resolver for config, telemetry, records and project data", () => {
    const previous = process.env.MEX_HOME; const home = temp(); process.env.MEX_HOME = home;
    try {
      expect(mexHomeDir()).toBe(join(home, ".mex"));
      const writer = openRecord({ isNetwork: () => false }); closes.push(() => writer.close());
      expect(writer.location.home).toBe(realPath(mexHomeDir()));
      expect(writer.location.record).toBe(join(realPath(mexHomeDir()), "record.db"));
      expect(existsSync(join(home, "record.db"))).toBe(false);
    } finally { if (previous === undefined) delete process.env.MEX_HOME; else process.env.MEX_HOME = previous; }
  });
  it("recognizes native UNC expansion before a bounded 5-second drive query and caches failure as local", () => {
    const home = temp(); let queries = 0;
    expect(windowsNetworkHome(home, { realPath: () => "\\\\server\\share", driveType: () => { throw Error("unnecessary query"); } })).toBe(true);
    expect(windowsNetworkHome(home, { realPath: () => home, driveType: (_, timeout) => { queries++; expect(timeout).toBe(5000); return "4\n"; } })).toBe(true);
    expect(WINDOWS_NETWORK_QUERY_TIMEOUT_MS).toBe(5000);
    const options = { home, cache: temp(), isNetwork: () => windowsNetworkHome(home, {
      realPath: () => home, driveType: () => { queries++; throw Error("detection failed"); },
    }) };
    const fallback = recordLocation(options);
    expect(fallback.directory).toBe(fallback.home);
    expect(readFileSync(join(home, "location"), "utf8")).toBe(`${fallback.home}\n`);
    expect(recordLocation({ ...options, isNetwork: () => { throw Error("cached"); } })).toEqual(fallback);
    expect(queries).toBe(2);
  });
  it("uses an isolated local cache for a network home and follows the cached pointer on second open", () => {
    const home = temp(); const cache = temp(); let calls = 0;
    const options = { home, cache, isNetwork: () => { calls++; return true; } };
    const location = recordLocation(options);
    expect(location.directory).toBe(absolutePath(join(cache, shortHash(location.home))));
    expect(readFileSync(join(home, "location"), "utf8")).toBe(`${location.directory}\n`);
    expect(recordLocation({ ...options, isNetwork: () => { throw new Error("must not detect"); } })).toEqual(location);
    expect(calls).toBe(1);
    const writer = openRecord(options); closes.push(() => writer.close());
    expect(existsSync(location.record)).toBe(true); expect(existsSync(join(home, "record.db"))).toBe(false);
  });
  it("recreates a stale cached destination and tolerates detector failure and malformed pointers", () => {
    const home = temp(); const cache = temp();
    const location = recordLocation({ home, cache, isNetwork: () => true });
    rmdirSync(location.directory);
    expect(recordLocation({ home, cache, isNetwork: () => { throw Error("cached"); } })).toEqual(location);
    expect(existsSync(location.directory)).toBe(true);
    const fallback = temp(); writeFileSync(join(fallback, "location"), "invalid\n");
    expect(recordLocation({ home: fallback, isNetwork: () => { throw Error("unavailable"); } }).directory).toBe(realPath(fallback));
  });
  it("shares ids across clones/worktrees, handles shallow/unborn folders, and resolves links", () => {
    const root = temp(); const [repo, clone, worktree, shallow, empty, folder, nested, unicode] = fixtureRepos(root);
    expect(projectIdentity(repo).id).toBe(projectIdentity(clone).id);
    expect(projectIdentity(repo).id).toBe(projectIdentity(worktree).id);
    expect(projectIdentity(repo).id).toBe(projectIdentity(nested).id);
    expect(projectIdentity(shallow).kind).toBe("folder"); expect(projectIdentity(empty).kind).toBe("folder");
    const alias = join(root, "alias"); symlinkSync(folder, alias, process.platform === "win32" ? "junction" : "dir");
    try { expect(projectIdentity(alias)).toEqual(projectIdentity(folder)); } finally { if (process.platform === "win32") rmdirSync(alias); else unlinkSync(alias); }
    expect(projectIdentity(folder, () => { throw Error("git missing"); }).kind).toBe("folder");
    if (process.platform === "win32") expect(projectIdentity(folder.toUpperCase())).toEqual(projectIdentity(folder));
    if (process.platform === "win32") expect(projectIdentity(unicode.replace("ΟΣ", "οσ"))).toEqual(projectIdentity(unicode));
    expect(projectIdentity(unicode).rootPath).toBe(realPath(unicode));
  });
  it("chooses the smallest hash among several roots and treats a submodule as its own repository", () => {
    const root = temp(); const [repo] = fixtureRepos(root);
    git(repo, "checkout", "--orphan", "other-root"); git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "other");
    git(repo, "checkout", "main");
    git(repo, "-c", "commit.gpgsign=false", "merge", "other-root", "--allow-unrelated-histories", "-m", "merge roots");
    const smallest = git(repo, "rev-list", "--max-parents=0", "HEAD").split(/\s+/).sort()[0];
    expect(projectIdentity(repo).id).toBe(`g-${shortHash(smallest)}`);
    const subsource = join(root, "subsource"); mkdirSync(subsource);
    git(subsource, "init"); git(subsource, "config", "user.name", "Fixture"); git(subsource, "config", "user.email", "fixture.invalid");
    git(subsource, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "separate submodule root");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", subsource, "sub");
    expect(projectIdentity(join(repo, "sub")).id).toBe(projectIdentity(subsource).id);
    expect(projectIdentity(join(repo, "sub")).id).not.toBe(projectIdentity(repo).id);
  });
  it("registers clone/worktree checkouts under one project and preserves checkout switches on reopen", () => {
    const [repo, clone, worktree] = fixtureRepos(temp());
    const writer = open();
    for (const folder of [repo, clone, worktree]) writer.register(projectIdentity(folder));
    expect(writer.db.prepare("SELECT count(*) n FROM projects").get()!.n).toBe(1);
    expect(writer.db.prepare("SELECT count(*) n FROM checkouts").get()!.n).toBe(3);
    writer.db.prepare("UPDATE checkouts SET state='off' WHERE path=?").run(realPath(repo));
    writer.register(projectIdentity(repo));
    expect(writer.db.prepare("SELECT state FROM checkouts WHERE path=?").get(realPath(repo))!.state).toBe("off");
  });
});

describe("pinned checkout identity", () => {
  it("ignores fetched orphan refs and uses the stored id even after switching HEAD, without invoking Git", () => {
    const [repo, clone] = fixtureRepos(temp()); const home = temp();
    const writer = openRecord({ home, projectPath: clone, isNetwork: () => false }); closes.push(() => writer.close());
    const before = writer.checkout(clone)!.project_id;
    const data = projectDataDirectory(writer.location, before); writeFileSync(join(data, "kept"), "same data");
    git(repo, "checkout", "--orphan", "unrelated"); git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unrelated root");
    git(clone, "fetch", "origin", "unrelated:refs/heads/unrelated");
    expect(projectIdentity(clone).id).toBe(before);
    git(clone, "checkout", "unrelated");
    expect(projectIdentity(clone).id).not.toBe(before);
    let calls = 0;
    const reopened = openRecord({ home, projectPath: clone, isNetwork: () => false, git: () => { calls++; throw Error("must not run Git"); } });
    closes.push(() => reopened.close());
    expect(calls).toBe(0); expect(reopened.checkout(clone)!.project_id).toBe(before);
    expect(reopened.register(projectIdentity(clone)).id).toBe(before);
    expect(readFileSync(join(data, "kept"), "utf8")).toBe("same data");
  });
  it("promotes an unborn checkout, moves its data, updates references and preserves switches", () => {
    const [, , , , repo] = fixtureRepos(temp()); const home = temp();
    const writer = openRecord({ home, projectPath: repo, isNetwork: () => false }); closes.push(() => writer.close());
    const old = writer.checkout(repo)!; expect(old.provisional).toBe("unborn");
    const source = projectDataDirectory(writer.location, old.project_id); writeFileSync(join(source, "kept"), "saved output");
    writer.db.prepare("INSERT INTO jobs(id,project_id,kind,state,created_at,updated_at) VALUES('j',?,'test','queued','now','now')").run(old.project_id);
    writer.db.prepare("INSERT INTO model_calls(ts,project_id,purpose,agent,model,input,cache_write,cache_read,output,estimated) VALUES('now',?,'test','test','fixture',0,0,0,0,0)").run(old.project_id);
    writer.db.prepare("INSERT INTO review VALUES('r',?,'e','test','pending','now')").run(old.project_id);
    writer.db.prepare("INSERT INTO settings VALUES(?,'journal.consumed','7')").run(old.project_id);
    writer.db.prepare("INSERT INTO judgements VALUES(?,'e','h','still-true','now')").run(old.project_id);
    writer.db.prepare("UPDATE checkouts SET state='off' WHERE project_id=?").run(old.project_id);
    git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture.invalid");
    git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "first commit");
    const opened = openRecord({ home, projectPath: repo, isNetwork: () => false }); closes.push(() => opened.close());
    const current = opened.checkout(repo)!;
    expect(current.project_id).toBe(projectIdentity(repo).id); expect(current.provisional).toBeNull(); expect(current.state).toBe("off");
    expect(opened.db.prepare("SELECT project_id FROM jobs WHERE id='j'").get()!.project_id).toBe(current.project_id);
    expect(opened.db.prepare("SELECT project_id FROM model_calls").get()!.project_id).toBe(current.project_id);
    expect(opened.db.prepare("SELECT project_id FROM review WHERE id='r'").get()!.project_id).toBe(current.project_id);
    expect(opened.setting(current.project_id, "journal.consumed")).toBe("7");
    expect(opened.db.prepare("SELECT project_id FROM judgements WHERE entry_id='e'").get()!.project_id).toBe(current.project_id);
    expect(opened.setting("global", `project.alias.${old.project_id}`)).toBe(current.project_id);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(projectDataDirectory(opened.location, current.project_id), "kept"), "utf8")).toBe("saved output");
  });
  it("keeps shallow registrations usable and promotes them when complete history arrives", () => {
    const [, , , repo] = fixtureRepos(temp()); const home = temp();
    const options = { home, projectPath: repo, isNetwork: () => false };
    const writer = openRecord(options); closes.push(() => writer.close());
    const old = writer.checkout(repo)!; expect(old.provisional).toBe("shallow");
    const source = projectDataDirectory(writer.location, old.project_id); writeFileSync(join(source, "kept"), "shallow data");
    const again = openRecord(options); closes.push(() => again.close()); expect(again.checkout(repo)!.project_id).toBe(old.project_id);
    git(repo, "fetch", "--unshallow");
    const complete = openRecord(options); closes.push(() => complete.close());
    const next = complete.checkout(repo)!; expect(next.project_id.startsWith("g-")).toBe(true); expect(next.provisional).toBeNull();
    expect(readFileSync(join(projectDataDirectory(complete.location, next.project_id), "kept"), "utf8")).toBe("shallow data");
  });
  it("keeps both data folders and records one notice if the Git target already exists", () => {
    const [, , , repo] = fixtureRepos(temp()); const home = temp();
    const writer = openRecord({ home, projectPath: repo, isNetwork: () => false }); closes.push(() => writer.close());
    const old = writer.checkout(repo)!.project_id;
    const source = projectDataDirectory(writer.location, old); writeFileSync(join(source, "kept"), "old");
    git(repo, "fetch", "--unshallow"); const targetId = projectIdentity(repo).id;
    const target = projectDataDirectory(writer.location, targetId); writeFileSync(join(target, "kept"), "target");
    writer.db.prepare("INSERT INTO projects VALUES(?,?,'git',0,'now')").run(targetId, realPath(repo));
    writer.db.prepare("INSERT INTO settings VALUES(?,'conflict','old')").run(old);
    writer.db.prepare("INSERT INTO settings VALUES(?,'conflict','target')").run(targetId);
    const promoted = openRecord({ home, projectPath: repo, isNetwork: () => false }); closes.push(() => promoted.close());
    promoted.finishProjectMoves();
    expect(promoted.checkout(repo)!.project_id).toBe(targetId);
    expect(readFileSync(join(source, "kept"), "utf8")).toBe("old"); expect(readFileSync(join(target, "kept"), "utf8")).toBe("target");
    expect(promoted.setting(old, "conflict")).toBe("old"); expect(promoted.setting(targetId, "conflict")).toBe("target");
    expect(promoted.db.prepare("SELECT count(*) n FROM notices WHERE kind='project-data-conflict'").get()!.n).toBe(1);
    expect(promoted.db.prepare("SELECT count(*) n FROM notices WHERE kind='project-record-conflict'").get()!.n).toBe(1);
  });
  it("replays a committed pending folder move on a later open without recomputing identity", () => {
    const writer = open(); const project = temp(); writer.register(projectIdentity(project));
    const old = writer.checkout(project)!.project_id; const next = `g-${"a".repeat(24)}`;
    const source = projectDataDirectory(writer.location, old); writeFileSync(join(source, "kept"), "crash-safe");
    writer.db.prepare("INSERT INTO settings VALUES('global',?,?)").run(`project.move.${old}`, next);
    const reopened = openRecord({ home: writer.location.home, isNetwork: () => false }); closes.push(() => reopened.close());
    expect(readFileSync(join(projectDataDirectory(reopened.location, next), "kept"), "utf8")).toBe("crash-safe");
    expect(reopened.setting("global", `project.move.${old}`)).toBeUndefined();
  });
});

it("two real Node processes write concurrently without busy errors or lost rows and both see every row", async () => {
  const home = temp(); const writer = open(home);
  const bundle = join(temp(), "peer.mjs");
  buildSync({ entryPoints: [resolve("src/record/__tests__/fixtures/peer.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm" });
  const peers = ["a", "b"].map((worker) => new Promise<string>((done, reject) => {
    const child = spawn(process.execPath, [bundle, home, worker], { env: { ...process.env, MEX_HOME: home }, windowsHide: true });
    let out = "", errors = ""; child.stdout.on("data", (data) => out += data); child.stderr.on("data", (data) => errors += data);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? done(out) : reject(Error(errors)));
  }));
  writeFileSync(join(home, "start"), "go");
  expect((await Promise.all(peers)).map((out) => JSON.parse(out))).toEqual([{ seen: 300 }, { seen: 300 }]);
  expect(writer.db.prepare("SELECT count(*) n FROM settings WHERE scope='concurrent'").get()!.n).toBe(300);
}, 30000);
