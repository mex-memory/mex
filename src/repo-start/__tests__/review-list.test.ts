import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEntry, serializeEntry } from "../../knowledge/entry.js";
import { propose, type Proposal } from "../../knowledge/gate.js";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { enqueueJob } from "../../record/jobs.js";
import { learnedTrialKey, reviewRowsKey, type ReviewRow } from "../../learn-deeper/pipeline.js";
import { LEARNED_TRIAL_LABEL } from "../../learn-deeper/trial-outcomes.js";
import { parseEdits } from "../../learn-deeper/would-fire.js";
import { parseVerify, VERIFY_TIMEOUT_MS } from "../../learn-deeper/verify.js";
import { learnedRefusalKey, learnedReviewedKey } from "../../knowledge/mutations.js";
import { ZERO } from "../../record/usage.js";
import { reviewLearned } from "../review-list.js";

let suite: string, binary: string, base: string, root: string, home: string, project: string, writer: RecordWriter;
const options = () => ({ home, projectPath: root, isNetwork: () => false });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const notePath = (id: string) => join(home, "projects", project, "notes", `${id}.md`);

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-review-list-")));
  binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, "home");
  mkdirSync(join(root, "src"), { recursive: true });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  writeFileSync(join(root, "src", "api.ts"), "export const ok = 1;\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOOK_BINARY", binary); vi.stubEnv("MEX_HOME", home);
  writer = openRecord(options()); project = writer.checkout(root)!.project_id;
});
afterEach(() => { vi.unstubAllEnvs(); writer.close(); rmSync(base, { recursive: true, force: true }); });

const learned = (key: string, claim: string, pattern: string, status: "active" | "proposed"): Proposal => ({
  producer: "learn-deeper", key, kind: "rule", text: `${claim} The reviewers asked for it.`, oneLine: claim, evidenceClass: "review",
  source: { type: "review", ref: "https://github.com/acme/app/pull/1" }, model: { id: "fixture", version: "fixture-1" },
  anchors: { scope: ["src/**"], when: [{ type: "anti", match: "literal", pattern }] },
  checks: [{ kind: "source", role: "supporting", target: { file: "package.json" } }], status, label: "Learned from 2 PRs, 1 maintainer",
});

async function finishedRun(rows: Array<{ id: string; claim: string; status: "active" | "proposed" }>): Promise<string> {
  await import("../../learn-deeper/job.js");
  const { job } = enqueueJob(writer, { kind: "learn-deeper", projectId: project, params: {} });
  writer.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  const review: ReviewRow[] = rows.map(row => ({ entryId: row.id, claim: row.claim, label: "Learned from 2 PRs, 1 maintainer", support: 2, reviewers: 1,
    proven: true, status: row.status, route: "code-rule", signal: "strong", link: "https://github.com/acme/app/pull/1" }));
  writer.db.prepare("INSERT INTO settings(scope,key,value) VALUES(?,?,?)").run(project, reviewRowsKey(job.id), JSON.stringify(review));
  return job.id;
}

it("reads past commits' added lines with their line numbers", () => {
  const edits = parseEdits(["\u0000commit abc", "diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -3,0 +4,2 @@",
    "+console.log(a)", "+keep()", "\u0000commit def", "diff --git a/old.ts b/old.ts", "+++ /dev/null"].join("\n"));
  expect(edits).toEqual([{ commit: "abc", path: "src/x.ts", added: "console.log(a)\nkeep()\n", removed: "", addedLines: [{ line: 4, text: "console.log(a)" }, { line: 5, text: "keep()" }] }]);
  expect(parseEdits(["\u0000commit abc", "+++ b/src\\api.ts", "@@ -0,0 +1,1 @@", "+x"].join("\n"))[0]?.path).toBe("src/api.ts");
});

it("lists learned rules, shows what would have stopped the person's own commits, and applies ticks", async () => {
  const [a, b] = await propose([{ ...learned("a", "Log through apiLogger, not console.log.", "console.log(", "active"),
    label: LEARNED_TRIAL_LABEL + "Fixture" },
    learned("b", "Read config through loadConfig, not process.env.", "process.env.", "proposed")], options());
  if (a?.status !== "accepted" || b?.status !== "accepted") throw new Error(JSON.stringify([a, b]));
  writeFileSync(join(root, "src", "api.ts"), "export const ok = 1;\nconsole.log(ok);\n");
  git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "debug");
  await finishedRun([{ id: a.entryId, claim: "Log through apiLogger, not console.log.", status: "active" },
    { id: b.entryId, claim: "Read config through loadConfig, not process.env.", status: "proposed" }]);
  const lines: string[] = [];
  const keys = ["1", "2", "enter"];
  const result = await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { color: false, ascii: true } as never,
    interactive: true, env: process.env, home, keys: async () => keys.shift()! });
  expect(result).toEqual({ kept: 2, trials: 0, waiting: 0, dropped: 0 });
  const text = lines.join("\n");
  expect(text).toContain("Scoped trials");
  expect(text).toContain("1. [ ] Log through apiLogger");
  expect(text).toContain("2. [ ] Read config");
  expect(text).toMatch(/Would have stopped an edit at [0-9a-f]{7} src\/api\.ts:2/u);
  expect(text).toContain(a.entryId);
  expect(text).toContain("mex rules --learned");
  expect(writer.setting(project, learnedTrialKey(a.entryId))).toBe("permanent");
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.source.label).not.toContain(LEARNED_TRIAL_LABEL);
  expect(parseEntry(readFileSync(notePath(b.entryId), "utf8")).mex.status).toBe("active");
  // Reviewed once: the next `mex` doesn't ask again.
  expect(await reviewLearned({ root, projectId: project, write: () => {}, mode: { color: false, ascii: true } as never, interactive: true, env: process.env, home, keys: async () => "enter" })).toBeUndefined();
});

it("leaves unticked rules waiting, and asks nothing without a terminal", async () => {
  const [a] = await propose([learned("c", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  const quiet: string[] = [];
  expect(await reviewLearned({ root, projectId: project, write: line => quiet.push(line), mode: { color: false, ascii: true } as never, interactive: false, env: process.env, home })).toBeUndefined();
  expect(quiet.join("\n")).toContain("1 learned rule waits for your review");
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("proposed");
  const result = await reviewLearned({ root, projectId: project, write: () => {}, mode: { color: false, ascii: true } as never, interactive: true, env: process.env, home, keys: async () => "enter" });
  // Enter alone never retires a rule: an unticked one keeps waiting, and `mex rules --learned` still lists it.
  expect(result).toEqual({ kept: 0, trials: 0, waiting: 1, dropped: 0 });
  expect(writer.setting(project, `knowledge.retired.${a.entryId}`)).toBeUndefined();
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("proposed");
});

it("drops only unticked trials when the bulk choice is saved", async () => {
  const trial = (key: string, claim: string, pattern: string) => ({
    ...learned(key, claim, pattern, "active"), label: LEARNED_TRIAL_LABEL + "Fixture",
  });
  const [kept, dropped, waiting] = await propose([
    trial("keep-trial", "Use the checked loader.", "bareLoad("),
    { ...trial("drop-trial", "Publish from the signed release lane.", "barePublish("), anchors: { scope: ["**"] } },
    learned("waiting", "Use the pooled client.", "new Client(", "proposed"),
  ], options());
  if (kept?.status !== "accepted" || dropped?.status !== "accepted" || waiting?.status !== "accepted") {
    throw new Error(JSON.stringify([kept, dropped, waiting]));
  }
  const job = await finishedRun([kept, dropped, waiting].map((result, i) => ({
    id: result.entryId, claim: "", status: i < 2 ? "active" : "proposed",
  })));
  const lines: string[] = [];
  const review = (keys: string[]) => reviewLearned({ root, projectId: project, write: line => lines.push(line),
    mode: { plain: true, color: false, ascii: true, width: 80 }, interactive: true, env: process.env, home,
    keys: async () => keys.shift() ?? "quit" });

  expect(await review(["d", "q"])).toBeUndefined();
  expect(writer.setting(project, learnedReviewedKey(job))).toBeUndefined();
  expect(parseEntry(readFileSync(notePath(dropped.entryId), "utf8")).mex.status).toBe("active");
  expect(await review(["1", "d", "enter"])).toEqual({ kept: 1, trials: 0, waiting: 1, dropped: 1 });
  expect(lines).toContain("Repo-wide trials");
  expect(lines).toContain("Enter drops unticked trials. Press d to undo.");
  expect(writer.setting(project, learnedTrialKey(kept.entryId))).toBe("permanent");
  expect(parseEntry(readFileSync(notePath(dropped.entryId), "utf8")).mex.status).toBe("retired");
  expect(writer.setting(project, learnedRefusalKey(dropped.entryId))).toBeTruthy();
  expect(parseEntry(readFileSync(notePath(waiting.entryId), "utf8")).mex.status).toBe("proposed");
});

it("lists a review row from a weekly run that failed", async () => {
  const [a] = await propose([learned("w", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  const id = await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  writer.db.prepare("UPDATE jobs SET kind='learn-deeper-weekly', state='failed', reason='the run stopped' WHERE id=?").run(id);
  const lines: string[] = [];
  expect(await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { color: false, ascii: true } as never,
    interactive: true, env: process.env, home, keys: async () => "q" })).toBeUndefined();
  expect(lines.join("\n")).toContain("Use the pooled client");
});

it("leaves everything as it is when the person decides later", async () => {
  const [a] = await propose([learned("d", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  expect(await reviewLearned({ root, projectId: project, write: () => {}, mode: { color: false, ascii: true } as never, interactive: true, env: process.env, home, keys: async () => "q" })).toBeUndefined();
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("proposed");
});

it("checks a waiting rule from pinned evidence only after consent and stages the answer until save", async () => {
  const [a] = await propose([learned("e", "Use the pooled client in src.", "new Client(", "proposed")], options());
  if (a?.status !== "accepted") throw new Error(JSON.stringify(a));
  await finishedRun([{ id: a.entryId, claim: "Use the pooled client in src.", status: "proposed" }]);
  vi.spyOn(await import("../../learn-deeper/offer.js"), "chooseAgent").mockReturnValue("claude");
  const model = vi.fn(async (request: Parameters<typeof import("../../model-runner/index.js").runModel>[0]) => {
    expect(request.readOnlyTools).toBeUndefined();
    expect(request.executionDirectory).toBeUndefined();
    expect(request.projectRoot).toBe(root);
    expect(request.timeoutMs).toBe(VERIFY_TIMEOUT_MS);
    expect(request.prompt).toContain("export const ok = 1;");
    return { text: JSON.stringify({ verdict: "keep", evidence: ["src/api.ts:1"] }), selectedModel: "fixture", usage: { ...ZERO, model: "fixture", estimated: false } };
  });
  const keys = ["v", "1", "n", "v", "1", "enter", "enter"], lines: string[] = [];
  const result = await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { color: false, ascii: true } as never,
    interactive: true, env: process.env, home, keys: async () => {
      if (keys.length === 4) expect(model).not.toHaveBeenCalled();
      if (keys.length === 1) expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("proposed");
      return keys.shift()!;
    }, model: model as never });
  expect(lines.join(" ").replace(/ +/gu, " ")).toMatch(/About 32,000 tokens, estimated/u);
  expect(model).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ kept: 1, trials: 0, waiting: 0, dropped: 0 });
  expect(parseEntry(readFileSync(notePath(a.entryId), "utf8")).mex.status).toBe("active");
});

it("requires a verify answer to cite a file and lines shown in the evidence", () => {
  const files = [{ path: "src/api.ts", lines: [{ line: 1, text: "export const ok = 1;" }] }];
  const parse = (site: string) => parseVerify(JSON.stringify({ verdict: "drop", evidence: [site] }), files);
  for (const site of ["src/missing.ts:3", "src/api.ts", "src:1", "src/api.ts:99", "src/api.ts:1-99", "C:\\src\\api.ts:1", "../src/api.ts:1"]) {
    expect(parse(site)).toBeUndefined();
  }
  expect(parse("src\\api.ts:1")).toEqual({ verdict: "drop", evidence: ["src/api.ts:1"] });
  expect(parseVerify("not json", files)).toBeUndefined();
});

it("keeps all older review rows accessible and applies the choices only on Enter", async () => {
  const proposals = Array.from({ length: 12 }, (_, i) =>
    learned(`page-${i}`, `Use adapter ${i + 1} when serving its endpoint.`, `specificAdapter${i + 1}(`, "active"));
  const rows = (await propose(proposals, options())).map((result, i) => {
    if (result.status !== "accepted") throw new Error(JSON.stringify(result));
    return { id: result.entryId, claim: proposals[i]!.oneLine!, status: "active" as const };
  });
  const job = await finishedRun(rows);
  const lines: string[] = [];
  const review = (keys: string[]) => reviewLearned({ root, projectId: project, write: line => lines.push(line),
    mode: { plain: true, color: false, ascii: true, width: 80 }, interactive: true, env: process.env, home,
    keys: async () => keys.shift() ?? "quit" });

  expect(await review(["1", "12", "q"])).toBeUndefined();
  expect(writer.setting(project, learnedReviewedKey(job))).toBeUndefined();
  expect(writer.setting(project, learnedRefusalKey(rows[0]!.id))).toBeUndefined();
  expect(rows.every(({ id }) => parseEntry(readFileSync(notePath(id), "utf8")).mex.status === "active")).toBe(true);

  expect(await review(["1", "12", "enter"])).toEqual({ kept: 10, trials: 0, waiting: 2, dropped: 0 });
  expect(lines.join("\n")).toContain("12 learned - 12 to confirm");
  expect(lines.join("\n")).toContain("12. [ ] Use adapter 12 when serving its endpoint.");
  expect(writer.setting(project, learnedReviewedKey(job))).toBeTruthy();
  for (const row of [rows[0]!, rows[11]!]) {
    expect(parseEntry(readFileSync(notePath(row.id), "utf8")).mex.status).toBe("proposed");
    expect(writer.setting(project, `knowledge.retired.${row.id}`)).toBeUndefined();
  }
});

it("renders the entry rationale, short fix and source safely at 80 columns", async () => {
  const [result] = await propose([learned("details", "Use the checked decoder.", "bareDecode(", "proposed")], options());
  if (result?.status !== "accepted") throw new Error(JSON.stringify(result));
  const raw = readFileSync(notePath(result.entryId), "utf8");
  const entry = parseEntry(raw);
  entry.text = "Use the checked decoder. It handles caf\u00e9 records and \x1b[31mrecovers\x1b[0m safely. " + "More context. ".repeat(8);
  entry.mex.fix = { snippet: "return checkedDecode(record);", path: "src/api.ts", commit: git("rev-parse", "HEAD"), lines: "1-1" };
  writeFileSync(notePath(result.entryId), serializeEntry(entry));
  await finishedRun([{ id: result.entryId, claim: "Old receipt claim", status: "proposed" }]);
  const lines: string[] = [];
  await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { plain: true, color: false, ascii: true, width: 80 },
    interactive: true, env: process.env, home, keys: async () => "q" });
  expect(lines).toContain("1. [ ] Use the checked decoder.");
  expect(lines.join(" ")).toContain("Why: It handles cafe records and recovers safely.");
  expect(lines).toContain("   Fix: return checkedDecode(record);");
  expect(lines.join(" ")).toContain("Source: PR #1 - https://github.com/acme/app/pull/1");
  expect(lines.every(line => line.length <= 80 && /^[ -~]*$/u.test(line))).toBe(true);
  expect(lines.join(" ")).not.toContain("Old receipt claim");
});

it.each(["keep", "drop"] as const)("leaves a verify recommendation to %s unapplied on quit", async verdict => {
  const [entry] = await propose([learned("verify-quit", "Use the checked loader.", "bareLoad(", "proposed")], options());
  if (entry?.status !== "accepted") throw new Error(JSON.stringify(entry));
  const job = await finishedRun([{ id: entry.entryId, claim: "Use the checked loader.", status: "proposed" }]);
  const choose = vi.spyOn(await import("../../learn-deeper/offer.js"), "chooseAgent").mockReturnValue("codex");
  const model: NonNullable<Parameters<typeof reviewLearned>[0]["model"]> = async () => ({
    text: JSON.stringify({ verdict, evidence: ["src/api.ts:1"] }), selectedModel: "fixture", usage: { ...ZERO, model: "fixture", estimated: false },
  });
  const keys = ["v", "1", "enter", "q"];
  try {
    expect(await reviewLearned({ root, projectId: project, write: () => {}, mode: { plain: true, color: false, ascii: true, width: 80 },
      interactive: true, env: process.env, home, model, keys: async () => keys.shift() ?? "quit" })).toBeUndefined();
  } finally { choose.mockRestore(); }
  expect(parseEntry(readFileSync(notePath(entry.entryId), "utf8")).mex.status).toBe("proposed");
  expect(writer.setting(project, `knowledge.retired.${entry.entryId}`)).toBeUndefined();
  expect(writer.setting(project, learnedReviewedKey(job))).toBeUndefined();
});

it("leaves the whole review pending if an entry changes before saving", async () => {
  const rows = (await propose([learned("stale1", "Use client A for mail.", "new MailClient(", "proposed"),
    learned("stale2", "Use client B for photos.", "new PhotoClient(", "proposed")], options())).map(result => {
    if (result.status !== "accepted") throw new Error(JSON.stringify(result));
    return { id: result.entryId, claim: "", status: "proposed" as const };
  });
  const job = await finishedRun(rows);
  const lines: string[] = [];
  const keys = ["1", "2", "enter"];
  expect(await reviewLearned({ root, projectId: project, write: line => lines.push(line), mode: { plain: true, ascii: true, color: false, width: 80 },
    interactive: true, env: process.env, home, keys: async () => {
      const key = keys.shift() ?? "quit";
      if (key === "enter") {
        const file = notePath(rows[1]!.id);
        const entry = parseEntry(readFileSync(file, "utf8"));
        writeFileSync(file, serializeEntry({ ...entry, text: entry.text + " A teammate added context." }));
      }
      return key;
    } })).toBeUndefined();
  expect(lines).toContain("Could not save the review. Run mex to open it again.");
  expect(writer.setting(project, learnedReviewedKey(job))).toBeUndefined();
  expect(rows.every(({ id }) => parseEntry(readFileSync(notePath(id), "utf8")).mex.status === "proposed")).toBe(true);
});
