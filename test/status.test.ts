import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/hooks/shim/binary.js", async original => ({ ...await original<typeof import("../src/hooks/shim/binary.js")>(), selfTestBinary: () => ({ ok: true, version: "0.9.0-beta.1.1" }) }));
import { formatStatus, readStatus, statusProblems } from "../src/status.js";
import { installAgents } from "../src/install/index.js";
import { openRecord } from "../src/record/index.js";
import { setCaptureEnabled, setCheckoutEnabled } from "../src/controls/index.js";
import { serializeEntry } from "../src/knowledge/entry.js";

const now = Date.parse("2026-11-17T10:00:00Z");
afterEach(() => vi.restoreAllMocks());
function fixture(network = false) {
  const base = mkdtempSync(join(tmpdir(), "mex-status-")), root = join(base, "repo"), home = join(base, "mex");
  mkdirSync(root); mkdirSync(home);
  const storage = { home, cache: join(base, "cache"), isNetwork: () => network };
  const writer = openRecord({ ...storage, projectPath: root, git: () => { throw new Error("No git"); } });
  const projectId = writer.checkout(root)!.project_id, location = writer.location;
  writer.close();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), MEX_OFF: "0" };
  return { base, home, root, projectId, location, env, options: { ...storage, cwd: root, env, now } };
}

it("reads installed agents, cached verdicts and last hook call without writing", async () => {
  const f = fixture(), binary = join(f.base, "native"), entry = join(f.base, "cli.js"), fallback = join(f.base, "fallback.cjs");
  writeFileSync(binary, "fixture"); writeFileSync(entry, ""); writeFileSync(fallback, "");
  await installAgents({ home: f.home, userHome: f.base, cwd: f.root, env: f.env, available: () => true, nativeBinary: binary, entry, fallbackFile: fallback, selfTest: () => ({ ok: true, version: "0.9.0-beta.1.1" }) });
  const writer = openRecord({ home: f.home, isNetwork: () => false });
  writer.db.prepare("INSERT INTO jobs(id,kind,state,created_at,updated_at,finished_at) VALUES('fixture','memory-filter','done',?,?,?)").run("2026-11-17T08:00:00Z", "2026-11-17T08:00:00Z", "2026-11-17T08:00:00Z");
  writer.close();
  const notes = join(f.home, "projects", f.projectId, "notes"); mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "mx_fixture1.md"), serializeEntry({ mex: { id: "mx_fixture1", kind: "rule", scope: ["**"], one_line: "Run tests", source: { type: "person", ref: "fixture", quote: "Run tests" }, evidence: "person", status: "active", created: "2026-11-17", checks: [] }, text: "Run tests" }));
  const db = new DatabaseSync(f.location.hooks);
  db.exec("CREATE TABLE sessions(agent TEXT,last_seen_at TEXT); CREATE TABLE verdicts(entry_id TEXT,verdict TEXT,checkout TEXT,project_id TEXT)");
  db.prepare("INSERT INTO sessions VALUES('claude-code',?)").run("2026-11-17T09:57:00Z");
  // Go keys checkouts by their real path, folded to lower case only on Windows.
  const key = realpathSync(f.root);
  db.prepare("INSERT INTO verdicts VALUES('mx_fixture1','broken',?,?)").run(process.platform === "win32" ? key.toLowerCase() : key, f.projectId);
  db.close();
  const before = readFileSync(f.location.record);
  const view = readStatus(f.options);
  expect(view.agents).toEqual([{ agent: "claude-code", installed: true, events: 12, lastCall: "2026-11-17T09:57:00Z" }, { agent: "codex", installed: true, events: 9 }]);
  expect(view.knowledge).toMatchObject({ personal: 1, team: 0, hints: 0, checks: { broken: 1, held: 0 } });
  expect(view.background).toMatchObject({ waiting: 0, running: 0, lastRun: { name: "memory-filter" } });
  expect(view.binary).toEqual({ state: "native", version: "0.9.0-beta.1.1" });
  expect(readFileSync(f.location.record)).toEqual(before);
  expect(formatStatus(view, { now })).toContain("last call 3 min ago");
  expect(formatStatus(view, { doctor: true, now })).toContain("Codex hook trust is unknown: open Codex, run /hooks.");
  expect(statusProblems(view)).toEqual([]);
  expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  expect(formatStatus(view, { now })).toMatchSnapshot();
  const settingsPath = join(f.env.CLAUDE_CONFIG_DIR, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.SessionStart = [{ hooks: [{ type: "command", command: "echo fixture" }] }];
  writeFileSync(settingsPath, JSON.stringify(settings));
  const changed = readStatus(f.options);
  expect(changed.agents[0]).toMatchObject({ installed: false, events: 11 });
  expect(changed.agents[1]).toMatchObject({ installed: true, events: 9 });
});

it("shows missing installations with fixes", () => {
  const f = fixture(), view = readStatus(f.options);
  expect(view.agents.every(agent => agent.installed === false)).toBe(true);
  expect(statusProblems(view)).toContain("Hook binary missing: run mex install");
  expect(statusProblems(view)).toContain("Codex hooks missing or incomplete: run mex install");
});

it("reads hook errors from the location pointer even when hooks.db is absent", () => {
  const f = fixture(true);
  const first = "2026-11-17T09:57:00Z", counts = { delivery: 1 };
  const recent = [{ at: first, agent: "claude-code", event: "Stop", kind: "delivery", detail: "could not save result" }];
  expect(f.location.directory).not.toBe(f.location.home);
  writeFileSync(join(f.location.directory, "hook-errors.json"), JSON.stringify({ version: 1, counts, first, recent }));
  expect(readStatus(f.options).hookErrors).toEqual({ total: 1, announced: 1, counts, first, recent });
  expect(existsSync(f.location.hooks)).toBe(false);
});

const firstHookError = new Date(2026, 10, 24, 12).toISOString();
const busyError = { at: firstHookError, agent: "claude-code", event: "Stop", kind: "busy", detail: "database is locked" };
const busyErrors = { version: 1, counts: { busy: 1 }, first: firstHookError, recent: [busyError] };

it.each([
  ["missing", null],
  ["version 2", JSON.stringify({ ...busyErrors, version: 2 })],
  ["oversized", JSON.stringify(busyErrors).padEnd((64 << 10) + 1)],
])("omits the hook error section for a %s file", (_name, text) => {
  const f = fixture();
  if (text !== null) writeFileSync(join(f.location.directory, "hook-errors.json"), text);
  const view = readStatus(f.options);
  expect(view.hookErrors).toBeNull();
  expect(formatStatus(view, { doctor: true })).not.toContain("Hook errors:");
});

it("lists busy errors in doctor without adding a problem or a status summary", () => {
  const f = fixture(), before = readStatus(f.options);
  writeFileSync(join(f.location.directory, "hook-errors.json"), JSON.stringify(busyErrors));
  const view = readStatus(f.options);
  const doctor = formatStatus(view, { doctor: true });
  expect(doctor).toContain("Hook errors: 1 since 24 Nov (1 busy (a locked database; expected under load)) · your agents kept working");
  expect(doctor).toContain("24 Nov 12:00  claude-code Stop  busy  database is locked");
  expect(formatStatus(view)).not.toContain("Hook errors:");
  expect(statusProblems(view)).toEqual(statusProblems(before));
});

it("lists the five newest hook errors and adds one problem for the non-busy count", () => {
  const f = fixture(), before = readStatus(f.options);
  const counts = { busy: 2, delivery: 2, panic: 1, parse: 1 };
  const recent = [busyError, ...[
    { minute: 38, agent: "claude-code", kind: "busy", detail: "database deadline exceeded" },
    { minute: 39, agent: "claude-code", kind: "delivery", detail: "could not save result" },
    { minute: 40, agent: "codex", kind: "parse", detail: "invalid input" },
    { minute: 41, agent: "claude-code", kind: "delivery", detail: "could not send event" },
    { minute: 42, agent: "codex", kind: "panic", detail: "\x1b[31munexpected result\x1b[0m" },
  ].map(({ minute, ...error }) => ({ at: new Date(2026, 10, 25, 10, minute).toISOString(), event: "Stop", ...error }))];
  writeFileSync(join(f.location.directory, "hook-errors.json"), JSON.stringify({ version: 1, counts, first: firstHookError, recent }));
  const view = readStatus(f.options);
  const doctor = formatStatus(view, { doctor: true });
  expect(doctor.split("\n\n").find(section => section.startsWith("Hook errors:"))).toBe([
    "Hook errors: 6 since 24 Nov (2 busy (a locked database; expected under load), 2 delivery, 1 panic, 1 parse) · your agents kept working",
    "  25 Nov 10:42  codex Stop  panic  unexpected result",
    "  25 Nov 10:41  claude-code Stop  delivery  could not send event",
    "  25 Nov 10:40  codex Stop  parse  invalid input",
    "  25 Nov 10:39  claude-code Stop  delivery  could not save result",
    "  25 Nov 10:38  claude-code Stop  busy  database deadline exceeded",
  ].join("\n"));
  expect(formatStatus(view).split("\n\n").find(section => section.startsWith("Hook errors:"))).toBe("Hook errors: 4 since 24 Nov · see mex doctor for details");
  const problem = "4 hook errors since 24 Nov: see the list above; if they repeat, run mex install and report the details";
  expect(statusProblems(view)).toEqual([...statusProblems(before), problem]);
  expect(doctor).toContain(`  ✗ ${problem}`);
});

it("reads repo and capture switches, including a timed off that has ended", () => {
  const f = fixture(), writer = openRecord({ home: f.home, isNetwork: () => false });
  setCheckoutEnabled(writer, f.root, false); setCaptureEnabled(writer, false, f.root); writer.close();
  expect(readStatus(f.options).repository).toEqual({ state: "off", capture: "off" });
  const again = openRecord({ home: f.home, isNetwork: () => false });
  setCheckoutEnabled(again, f.root, false, "2026-11-16T10:00:00Z"); again.close();
  expect(readStatus(f.options).repository?.state).toBe("on");
});

it("handles no record and outside a repo without creating state", () => {
  const f = fixture(), absent = join(f.base, "absent");
  const view = readStatus({ ...f.options, home: absent, cwd: f.base });
  expect(view.repository).toBeNull();
  expect(view.background).toEqual({ waiting: 0, running: 0 });
  const text = formatStatus(view);
  expect(text).not.toContain("Knowledge here");
  expect(text).toContain("share of your usage unknown");
  expect(text).toMatch(/Next: run mex in a repo to turn MEX on there$/u);
});

it("keeps independent sections when one part is unreadable", () => {
  const f = fixture(), writer = openRecord({ home: f.home, isNetwork: () => false });
  writer.db.exec("DROP TABLE model_calls"); writer.close();
  const view = readStatus(f.options);
  expect(view.modelUse).toBeNull();
  expect(view.background?.waiting).toBe(0);
  expect(view.repository?.state).toBe("on");
  expect(formatStatus(view)).toContain("Model use: unknown");
});

it("never throws for a damaged record", () => {
  const base = mkdtempSync(join(tmpdir(), "mex-status-"));
  writeFileSync(join(base, "record.db"), "unreadable"); mkdirSync(join(base, ".git"));
  const view = readStatus({ home: base, cwd: base, isNetwork: () => false });
  expect(view.repository).toEqual({ state: "unknown", capture: "unknown" });
  expect(view.background).toBeNull();
  expect(view.agents.every(agent => agent.installed === null)).toBe(true);
});

it("uses the existing reference-price budget for an estimated usage share", () => {
  const f = fixture(), writer = openRecord({ home: f.home, isNetwork: () => false });
  writer.db.prepare("INSERT INTO own_usage VALUES('2026-11-17','claude',100000,0,0,0,0)").run();
  writer.db.prepare("INSERT INTO settings VALUES('own-usage','status.claude',?)").run(JSON.stringify({ agent: "claude", status: "readable", files: 1, bytes: 100, pending: false }));
  writer.db.prepare("INSERT INTO model_calls(ts,purpose,agent,model,input,cache_write,cache_read,output,estimated,kind) VALUES('2026-11-17T09:00:00Z','fixture','claude','haiku',10000,0,0,0,0,'headless')").run();
  writer.close();
  const view = readStatus(f.options);
  expect(view.modelUse).toMatchObject({ runs: 1, capPercent: 3, estimated: true });
  expect(view.modelUse!.percent).toBeCloseTo(100 * 1_000_000 / 360_000_000);
  expect(formatStatus(view)).toContain("0.3% of your usage (estimate)");
});
