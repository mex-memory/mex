import { beforeAll, afterAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { note } from "../../knowledge/store.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { hash } from "../../judge/evidence.js";
import { stageReview, learningReviewId } from "../state.js";
import { dailyReviewLine } from "../daily.js";
import { claimDailyReview } from "../daily-receipt.js";

let suite: string, receiptModule: string, base: string, root: string, home: string, writer: RecordWriter, project: string;
const now = Date.parse("2026-11-16T10:00:00Z"), text = "tests use vitest.";
const options = () => ({ home, projectPath: root, isNetwork: () => false });
const cli = resolve("dist/cli.js"), runChild = promisify(execFile);
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
beforeAll(async () => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-review-daily-"))); receiptModule = join(suite, "receipt.mjs");
  await build({ entryPoints: [resolve("src/review/daily-receipt.ts")], outfile: receiptModule, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" } });
});
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, "home", ".mex"); mkdirSync(root);
  git("init", "-q", "-b", "work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "README.md"), "tests use vitest.\n"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOME", join(base, "home")); writer = openRecord(options()); project = writer.checkout(root)!.project_id;
  writer.db.prepare("UPDATE projects SET shared=1").run();
});
afterEach(() => { writer.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });
function queued(at = now) {
  const entry = note({ text }, options(), new Date(at)).entry, raw = serializeEntry(entry), path = join(home, "projects", project, "notes", `${entry.mex.id}.md`);
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `learning.offer.${entry.mex.id}`, JSON.stringify({ state: "review", id: entry.mex.id, checkout: root, personal_hash: hash(raw), review_at: at }));
  stageReview(writer, project, learningReviewId(project, entry), entry, { producer: "learning", key: `learning.offer.${entry.mex.id}`, checkout: root, level: "personal", path, original_hash: hash(raw) }, "its checks need your decision", true, at);
}
const receiptDir = () => join(writer.location.directory, "review-daily", project);
it("emits one line per UTC day only while a rule waits", () => {
  expect(dailyReviewLine(options(), now)).toBeUndefined(); expect(existsSync(receiptDir())).toBe(false);
  queued(); expect(dailyReviewLine(options(), now)).toBe("MEX: 1 rule waits for review. Run mex review.");
  expect(dailyReviewLine(options(), now + 1)).toBeUndefined(); expect(dailyReviewLine(options(), now + 86400000)).toContain("1 rule");
  expect(readdirSync(receiptDir()).sort()).toEqual(["2026-11-16", "2026-11-17"]);
});
it("does not create receipts before a share, while off, in background, or after expiry", () => {
  queued(); writer.db.prepare("UPDATE projects SET shared=0").run(); expect(dailyReviewLine(options(), now)).toBeUndefined();
  writer.db.prepare("UPDATE projects SET shared=1").run(); writer.db.prepare("UPDATE checkouts SET state='off'").run(); expect(dailyReviewLine(options(), now)).toBeUndefined();
  writer.db.prepare("UPDATE checkouts SET state='on'").run(); vi.stubEnv("MEX_BACKGROUND", "1"); expect(dailyReviewLine(options(), now)).toBeUndefined(); vi.stubEnv("MEX_BACKGROUND", "0");
  expect(dailyReviewLine(options(), now + 30 * 86400000)).toBeUndefined(); expect(existsSync(receiptDir())).toBe(false);
});
it("arbitrates a daily claim across concurrent processes", async () => {
  const code = `import {claimDailyReview} from ${JSON.stringify(pathToFileURL(receiptModule).href)}; process.stdout.write(String(claimDailyReview(process.argv[1],process.argv[2],Number(process.argv[3]))));`;
  const results = await Promise.all(Array.from({ length: 12 }, () => runChild(process.execPath, ["--input-type=module", "-e", code, writer.location.directory, project, String(now)])));
  expect(results.filter(r => r.stdout === "true")).toHaveLength(1); expect(results.filter(r => r.stdout === "false")).toHaveLength(11);
});
it("prunes only proved expired receipts and leaves unexpected files untouched", () => {
  expect(claimDailyReview(writer.location.directory, project, now - 40 * 86400000)).toBe(true);
  expect(claimDailyReview(writer.location.directory, project, now)).toBe(true); expect(readdirSync(receiptDir())).toEqual(["2026-11-16"]);
  writeFileSync(join(receiptDir(), "2026-11-17"), "unrelated");
  expect(claimDailyReview(writer.location.directory, project, now + 86400000)).toBe(false);
  expect(readFileSync(join(receiptDir(), "2026-11-17"), "utf8")).toBe("unrelated");
});
it.skipIf(process.platform === "win32")("refuses a redirected receipt directory", () => {
  const outside = join(base, "outside"); mkdirSync(outside); symlinkSync(outside, join(writer.location.directory, "review-daily"));
  expect(() => claimDailyReview(writer.location.directory, project, now)).toThrow(); expect(readdirSync(outside)).toEqual([]);
});
it("provides clean JSON and a bounded text list through the built CLI", () => {
  queued(Date.now());
  const env = { ...process.env, MEX_HOME: join(base, "home"), MEX_BACKGROUND: "0", MEX_TELEMETRY: "0", MEX_SETUP_BACKGROUND_AGENTS: "0", MEX_INSTALL_AUTO: "0" };
  const result = execFileSync(process.execPath, [cli, "review", "--json"], { cwd: root, env, encoding: "utf8" });
  const data = JSON.parse(result); expect(data.ok).toBe(true); expect(data.items).toHaveLength(1); expect(data.items[0].entry.text).toBe(text);
  const human = execFileSync(process.execPath, [cli, "review"], { cwd: root, env, encoding: "utf8" });
  expect(human).toContain("Asking because"); expect(human).toContain("Share:"); expect(human).toContain("Keep for me:"); expect(human).toContain("Edit:");
  expect(existsSync(receiptDir())).toBe(false);
  const preview = JSON.parse(execFileSync(process.execPath, [cli, "review", "keep", "1", "--json"], { cwd: root, env, encoding: "utf8" }));
  expect(preview.ok).toBe(true); expect(preview.applied).toBe(false);
  const applied = JSON.parse(execFileSync(process.execPath, [cli, "review", "keep", "1", "--apply", "--expect", preview.preview.revision, "--json"], { cwd: root, env, encoding: "utf8" }));
  expect(applied.ok).toBe(true); expect(applied.applied).toBe(true);
});
it("keeps an empty CLI queue read from initializing a new home", () => {
  const fresh = join(base, "fresh");
  const result = execFileSync(process.execPath, [cli, "review", "--json"], { cwd: root, env: { ...process.env, MEX_HOME: fresh, MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0" }, encoding: "utf8" });
  expect(JSON.parse(result).items).toEqual([]);
  // The normal CLI may maintain its launcher, but Review creates no record,
  // project data, or daily receipt as a consequence of this empty read.
  expect(existsSync(join(fresh, ".mex", "record.db"))).toBe(false); expect(existsSync(join(fresh, ".mex", "projects"))).toBe(false);
});
