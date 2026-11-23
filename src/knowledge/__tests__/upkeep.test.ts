import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { hash, position } from "../../judge/evidence.js";
import { evaluate } from "../../judge/native.js";
import { refreshRuleChanges } from "../../judge/rule-change.js";
import { openHooksReadOnly, openRecord } from "../../record/index.js";
import { reviewQueue } from "../../review/queue.js";
import { AGENT_VARIABLES } from "../../repo-start/caller.js";
import { parseWrongReason } from "../agent-report.js";
import { buildKnowledgeCommands } from "../cli.js";
import { parseEntry, serializeEntry, type KnowledgeEntry } from "../entry.js";
import { tickLearned, untickLearned } from "../mutations.js";
import { CAPS, renderNative, type NativeFormat } from "../native-render.js";
import { upkeepAction, upkeepScan } from "../upkeep.js";
import { entry } from "./fixtures.js";

let scratch: string, writer: ReturnType<typeof openRecord>, project: string, checkout: string, notes: string;
const options = () => ({ projectPath: checkout });
const learned = (id: string, overrides: Partial<KnowledgeEntry["mex"]> = {}) => entry(id, {
  source: { type: "review", producer: "learn-deeper", ref: "https://github.com/example/repo/pull/4" }, evidence: "review",
  created: "2026-08-01", ...overrides,
}, "Keep request IDs in log records.");

function save(entry: KnowledgeEntry) {
  const path = join(notes, entry.mex.id + ".md"), raw = serializeEntry(entry);
  writeFileSync(path, raw);
  return { id: entry.mex.id, entry, level: "personal" as const, path, entry_hash: hash(raw) };
}

// The probe and the evaluator are the native binary; build it from this tree, as CI has no installed one.
let built: string, binary: string;
beforeAll(() => {
  built = realpathSync(mkdtempSync(join(tmpdir(), "mex-upkeep-hook-")));
  binary = join(built, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(built, { recursive: true, force: true }));

beforeEach(() => {
  vi.stubEnv("MEX_HOOK_BINARY", binary);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "mex-upkeep-")));
  const repo = join(scratch, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "logger.ts"), "export const logger = {};\n\n");
  // Rule signals are tied to a commit, so the checkout must be a repository with one.
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOME", join(scratch, "home"));
  vi.stubEnv("MEX_BACKGROUND", "1");
  for (const key of AGENT_VARIABLES) vi.stubEnv(key, undefined);
  writer = openRecord({ projectPath: repo, create: true });
  const registered = writer.checkout(repo)!;
  project = registered.project_id; checkout = registered.path;
  notes = join(writer.location.home, "projects", project, "notes"); mkdirSync(notes, { recursive: true });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  writer.close(); rmSync(scratch, { recursive: true, force: true });
});

it("parses typed and free-text reasons and validates the exact checkout line", () => {
  expect(parseWrongReason("contradicted src/logger.ts:2", checkout)).toEqual({ kind: "contradicted", reason: "contradicted src/logger.ts:2", file: "src/logger.ts" });
  for (const reason of ["contradicted", "contradicted src/logger.ts:3", "contradicted ../missing:1", "contradicted src/logger.ts:0"]) {
    expect(() => parseWrongReason(reason, checkout)).toThrow("with a line in this checkout");
  }
  for (const [reason, kind] of [["outdated", "outdated"], ["wrong-scope", "wrong-scope"], ["noisy", "noisy"], ["rejected-by-ci", "other"], ["not-applicable", "wrong-scope"], ["The convention has changed.", "other"]]) {
    expect(parseWrongReason(reason!, checkout)).toEqual({ reason, kind });
  }
});

it("reports through the real probe from an agent shell and retires only from a person's shell", async () => {
  const item = save(learned("mx_upkeep1"));
  vi.stubEnv("CODEX_THREAD_ID", "fixture-thread");
  vi.spyOn(process, "cwd").mockReturnValue(checkout);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const wrong = () => buildKnowledgeCommands().find(cmd => cmd.name() === "wrong")!;
  await wrong().parseAsync([item.id, "contradicted src/logger.ts:3", "--json"], { from: "user" });
  expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ ok: false, error: { code: "INVALID_ENTRY" } });
  process.exitCode = undefined;
  await wrong().parseAsync([item.id, "contradicted src/logger.ts:1", "--json"], { from: "user" });
  const result = JSON.parse(log.mock.lastCall![0]);
  expect(result).toMatchObject({ ok: true, status: "proposed", kind: "contradicted", reason: "contradicted src/logger.ts:1" });
  expect(writer.db.prepare("SELECT kind,state FROM jobs WHERE id=?").get(result.job)).toMatchObject({ kind: "judge", state: "queued" });
  expect(writer.setting(project, `knowledge.retired.${item.id}`)).toBeUndefined();
  expect(parseEntry(readFileSync(item.path, "utf8")).mex.status).toBe("active");
  const db = openHooksReadOnly()!;
  try {
    const followups = db.all<{ detail: string }>("SELECT detail FROM followups WHERE kind='wrong'");
    expect(followups).toHaveLength(1);
    expect(JSON.parse(followups[0]!.detail)).toMatchObject({ kind: "contradicted", type: "agent-report", entry_hash: item.entry_hash });
  } finally { db.close(); }
  expect(reviewQueue(options()).items[0]).toMatchObject({ upkeep: "report", reason: expect.stringContaining("contradicted src/logger.ts:1") });
  const request = { checkout, project_id: project, mex_home: writer.location.home, record_directory: writer.location.directory };
  await refreshRuleChanges(writer, project, checkout, await evaluate(request), await position(checkout));
  expect((await evaluate(request)).items?.[0]).toMatchObject({ verdict: "changed", rule_evidence: [expect.stringContaining("src/logger.ts:1")] });
  vi.stubEnv("CODEX_THREAD_ID", undefined);
  await wrong().parseAsync([item.id, "rejected-by-ci", "--json"], { from: "user" });
  expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ ok: true, status: "retired" });
  expect(writer.setting(project, `knowledge.retired.${item.id}`)).toContain("rejected-by-ci");
});

it("keeps the report instruction inside the byte cap of every rule-file renderer", () => {
  const candidates = Array.from({ length: 30 }, (_, index) => ({ level: "personal" as const, entry: entry(`mx_rules${index}`, {}, "A".repeat(599)) }));
  for (const format of Object.keys(CAPS) as NativeFormat[]) {
    const result = renderNative(format, "src", candidates);
    expect(result.text).toContain('Report a wrong rule with `mex wrong <id> "<reason>"`.');
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(CAPS[format]);
    expect(result.dropped.length).toBeGreaterThan(0);
  }
});

it("demotes only noisy entries, counts each stop once, and restarts at restore", () => {
  const inputs = ["mx_noisy1", "mx_noisy2", "mx_noisy3"].map(id => save(learned(id, {
    scope: ["src/**"], when: [{ type: "anti", match: "literal", pattern: "console.log(" }],
    checks: [{ kind: "scope", role: "complete", target: { glob: "src/**" }, saw: { count: 1 }, files: {} }],
  })));
  const hooks = new DatabaseSync(writer.location.hooks);
  const first = Date.parse("2026-11-20T00:00:00Z"), restored = first + 40_000;
  try {
    hooks.exec("CREATE TABLE deliveries(id TEXT,session_id TEXT,agent_id TEXT,epoch INTEGER,entry_id TEXT,project_id TEXT,checkout TEXT,ts TEXT,moment TEXT,action TEXT,detail TEXT); CREATE TABLE followups(delivery_id TEXT,kind TEXT)");
    const insert = hooks.prepare("INSERT INTO deliveries VALUES(?,?,'',1,?,?,?,?,'bump',?,?)");
    for (const [j, [stops, ignored]] of [[20, 3], [20, 1], [19, 18]].entries()) {
      for (let i = 0; i < stops!; i++) {
        const id = `${j}:${i}`, stamp = new Date(first + 1000 * i).toISOString();
        insert.run(id, id, inputs[j]!.id, project, checkout, stamp, "given", "");
        if (i < ignored!) insert.run(`${id}:again`, id, inputs[j]!.id, project, checkout, stamp, "control", "override");
        if (i === 0) hooks.prepare("INSERT INTO followups VALUES(?,'wrong')").run(id);
      }
    }
    upkeepScan(writer, project, checkout, inputs, first + 30_000);
    expect(JSON.parse(writer.setting(project, "learning.noise.mx_noisy1")!)).toMatchObject({ ignored: 3, stops: 20 });
    expect(writer.setting(project, "learning.noise.mx_noisy2")).toBeUndefined();
    expect(writer.setting(project, "learning.noise.mx_noisy3")).toBeUndefined();
    expect(reviewQueue(options(), restored).items).toMatchObject([{ upkeep: "noise", reason: expect.stringContaining("3 of 20") }]);
    expect(hash(readFileSync(inputs[0]!.path, "utf8"))).toBe(inputs[0]!.entry_hash);
    upkeepAction("restore", "mx_noisy1", options(), restored);
    upkeepScan(writer, project, checkout, inputs, restored + 1000);
    expect(writer.setting(project, "learning.noise.mx_noisy1")).toBeUndefined();
    expect(reviewQueue(options(), restored + 1000).items).toEqual([]);
  } finally { hooks.close(); }
});

it("sends only an unrenewed unanchored rule to Review and clears its age after a tick", () => {
  const at = Date.parse("2026-10-31T00:00:00Z");
  const scope = (glob: string) => ({ kind: "scope", role: "complete", target: { glob }, saw: { count: 1 }, files: {} } as const);
  const unanchored = save(learned("mx_age001", { checks: [scope("**")] }));
  const anchored = save(learned("mx_age002", { checks: [scope("src/**")] }));
  upkeepScan(writer, project, checkout, [unanchored, anchored], at);
  expect(reviewQueue(options(), at).items).toMatchObject([{ upkeep: "age", entry: { mex: { id: "mx_age001" } } }]);
  expect(parseEntry(readFileSync(unanchored.path, "utf8")).mex.status).toBe("active");
  untickLearned(unanchored.id, options(), new Date(at + 1000));
  tickLearned(unanchored.id, options(), new Date(at + 2000));
  upkeepScan(writer, project, checkout, [unanchored, anchored], at + 3000);
  expect(reviewQueue(options(), at + 3000).items).toEqual([]);
  expect(JSON.parse(writer.setting(project, `knowledge.verified.${unanchored.id}`)!)).toMatchObject({ how: "person" });
});
