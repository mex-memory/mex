import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord, type RecordWriter } from "../../record/index.js";
import { expandPersonal, note } from "../../knowledge/store.js";
import { propose, type Proposal } from "../../knowledge/gate.js";
import { producerEntryId } from "../../knowledge/producers.js";
import { parseEntry, serializeEntry, type KnowledgeEntry } from "../../knowledge/entry.js";
import { recordChecks } from "../../judge/native.js";
import { hash, position } from "../../judge/evidence.js";
import { shortHash } from "../../record/project.js";
import { claimHash } from "../../knowledge/state.js";
import { reviewQueue } from "../queue.js";
import { reviewAction, type ReviewAction } from "../actions.js";
import { stageReview, learningReviewId, reviewQuiet } from "../state.js";
import * as teamWrites from "../../knowledge/team.js";

let suite: string, binary: string, base: string, root: string, home: string, project: string, writer: RecordWriter;
const now = Date.parse("2026-11-16T10:00:00Z"), text = "tests use vitest because this project chose it.";
const options = () => ({ home, projectPath: root, isNetwork: () => false });
const deps = () => ({ clock: () => now, recordChecks, repository: async () => ({ visibility: "public" as const, authorized: true }) });
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const personalPath = (id: string) => join(home, "projects", project, "notes", `${id}.md`);
beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), "mex-review-suite-"))); binary = join(suite, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterAll(() => rmSync(suite, { recursive: true, force: true }));
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(suite, "case-"))); root = join(base, "repo"); home = join(base, "home"); mkdirSync(root);
  git("init", "-q", "-b", "work"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n'); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  vi.stubEnv("MEX_HOOK_BINARY", binary); vi.stubEnv("MEX_HOME", home);
  writer = openRecord(options()); project = writer.checkout(root)!.project_id;
  writer.db.prepare("UPDATE projects SET shared=1 WHERE id=?").run(project);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); writer.close(); rmSync(base, { recursive: true, force: true }); });

async function queued(words = text, at = now, eligible = true): Promise<KnowledgeEntry> {
  // Model offers can predate the producer gate and contain repeated claims.
  const entry = {
    mex: {
      id: producerEntryId("note"), kind: "rule", scope: ["**"], evidence: "person",
      source: { type: "person", ref: `mex note ${new Date(at).toISOString().slice(0, 10)}`, quote: words },
      one_line: words, checks: [], status: "active", created: new Date(at).toISOString().slice(0, 10),
    }, text: words,
  } satisfies KnowledgeEntry;
  const saved = { ...entry, mex: { ...entry.mex, checks: (await recordChecks({ checkout: root },
    [{ kind: "key", role: "complete", target: { file: "package.json", pointer: "/scripts/test" } }]))! } };
  mkdirSync(join(home, "projects", project, "notes"), { recursive: true });
  writeFileSync(personalPath(entry.mex.id), serializeEntry(saved));
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `learning.note.${entry.mex.id}`, JSON.stringify({ at: new Date(at).toISOString(), holds: eligible ? [] : ["model-private"], sessions: [], sources: [{ quote: words, label: "lasting", source: { session: null, row: null, at: new Date(at).toISOString(), marks: "", delivered: [], private_tag: false, note_id: entry.mex.id } }] }));
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, `learning.offer.${entry.mex.id}`, JSON.stringify({ state: "review", id: entry.mex.id, checkout: root, personal_hash: hash(serializeEntry(saved)), reason: "public-session", review_at: at }));
  stageReview(writer, project, learningReviewId(project, saved), saved, { producer: "learning", key: `learning.offer.${entry.mex.id}`, checkout: root, level: "personal", path: personalPath(entry.mex.id), original_hash: hash(serializeEntry(saved)) }, "this repository is public", eligible, at);
  return saved;
}
const queue = (at = now) => reviewQueue(options(), at);
async function apply(action: ReviewAction, card = "1", input: { text?: string } = {}) {
  const preview = await reviewAction(card, action, options(), input, deps());
  return reviewAction(card, action, options(), { ...input, apply: true, expect: preview.preview.revision }, deps());
}
it("merges duplicates, shows the oldest five, and reading does not write", async () => {
  for (let i = 0; i < 7; i++) await queued(`tests use vitest for project rule ${i}.`, now - i * 1000);
  await queued("tests use vitest for project rule 6.");
  const before = writer.db.prepare("SELECT * FROM settings ORDER BY key").all();
  const result = queue(); expect(result.items).toHaveLength(5); expect(result.waiting).toBe(7); expect(result.hidden).toBe(2);
  expect(result.items[0]!.sources).toBe(2); expect(result.items[0]!.entry.text).toContain("rule 6");
  expect(writer.db.prepare("SELECT * FROM settings ORDER BY key").all()).toEqual(before);
});
it("keeps claims permanently quiet across new identities and normalized whitespace", async () => {
  const entry = await queued(); await queued();
  const team = join(root, ".mex", "learned"); mkdirSync(team, { recursive: true }); writeFileSync(join(team, `${entry.mex.id}.md`), serializeEntry(entry));
  const before = readFileSync(join(team, `${entry.mex.id}.md`), "utf8");
  await apply("keep"); expect(queue().waiting).toBe(0);
  const again = await queued(text.replaceAll(" ", "  ")); expect(queue().waiting).toBe(0);
  expect(reviewQuiet(writer, project, again, now)).toBe("kept-for-me");
  expect(writer.setting(project, `review.keep.${claimHash(text).slice(7)}`)).toBeDefined();
  expect(readFileSync(join(team, `${entry.mex.id}.md`), "utf8")).toBe(before);
});
it("expires at thirty days, keeps bytes personal and never resets first-seen", async () => {
  const first = await queued(text, now - 30 * 86400000 + 1);
  expect(queue().waiting).toBe(1); expect(queue(now + 1).waiting).toBe(0);
  await queued(); expect(queue(now + 1).waiting).toBe(0);
  expect(reviewQuiet(writer, project, first, now + 1)).toBe("review-expired");
  expect(existsSync(personalPath(first.mex.id))).toBe(true);
  expect(existsSync(join(root, ".mex", "learned"))).toBe(false);
});
it("respects the age of legacy offers without writing a migration", async () => {
  const entry = await queued(text, now - 31 * 86400000);
  writer.db.prepare("DELETE FROM review").run(); writer.db.prepare("DELETE FROM settings WHERE key LIKE 'review.item.%'").run();
  expect(queue().waiting).toBe(0); expect(reviewQuiet(writer, project, entry, now)).toBe("review-expired");
  expect(writer.db.prepare("SELECT * FROM review").all()).toEqual([]);
});
it("hides personal preferences, private vocabulary, hints and weak evidence", async () => {
  await queued("i prefer my terminal wide.", now, false);
  await queued("send reports to Ada.");
  const entry = await queued("the agent observed this.");
  const key = `review.item.${learningReviewId(project, entry)}`, item = JSON.parse(writer.setting(project, key)!); item.entry.mex.evidence = "observed";
  writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(item), project, key);
  expect(queue().items).toEqual([]);
});
it("hides before the first share and when shared knowledge is explicitly disabled", async () => {
  await queued(); writer.db.prepare("UPDATE projects SET shared=0").run(); expect(queue().waiting).toBe(0);
  writer.db.prepare("UPDATE projects SET shared=1").run(); mkdirSync(join(root, ".mex")); writeFileSync(join(root, ".mex", "config.json"), '{"knowledge":{"version":1,"shared":false}}'); expect(queue().waiting).toBe(0);
});
it("shares an exact checked diff into the current working tree, without commit or staging", async () => {
  const entry = await queued(), head = git("rev-parse", "HEAD");
  const preview = await reviewAction("1", "share", options(), {}, deps());
  expect(preview.preview.diff).toContain("+tests use vitest"); expect(existsSync(join(root, ".mex", "learned"))).toBe(false);
  const result = await reviewAction("1", "share", options(), { apply: true, expect: preview.preview.revision }, deps());
  expect(result.applied).toBe(true); expect(queue().waiting).toBe(0);
  expect(readFileSync(join(root, ".mex", "learned", `${entry.mex.id}.md`), "utf8")).toBe(serializeEntry(entry));
  expect(git("rev-parse", "HEAD")).toBe(head); expect(git("diff", "--cached", "--name-only")).toBe("");
});
it("never re-baselines a failing check to make Share pass", async () => {
  const entry = await queued(), before = readFileSync(personalPath(entry.mex.id), "utf8");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"other"}}\n');
  await expect(reviewAction("1", "share", options(), {}, deps())).rejects.toMatchObject({ code: "CHECKS_CHANGED" });
  expect(readFileSync(personalPath(entry.mex.id), "utf8")).toBe(before); expect(queue().waiting).toBe(1);
});
it("recovers a team write before its database receipt using only the approved output", async () => {
  const entry = await queued(), preview = await reviewAction("1", "share", options(), {}, deps()), original = teamWrites.applyTeamWrite;
  vi.spyOn(teamWrites, "applyTeamWrite").mockImplementationOnce((...args) => { original(...args); throw new Error("fixture: lost receipt"); });
  await expect(reviewAction("1", "share", options(), { apply: true, expect: preview.preview.revision }, deps())).rejects.toThrow("lost receipt");
  expect(queue().waiting).toBe(1); expect(writer.setting(project, `review.share.${preview.preview.revision.slice(7)}`)).toBeDefined();
  expect((await reviewAction(preview.preview.id, "share", options(), { apply: true, expect: preview.preview.revision }, deps())).applied).toBe(true);
  expect(queue().waiting).toBe(0); expect(readFileSync(join(root, ".mex", "learned", `${entry.mex.id}.md`), "utf8")).toBe(serializeEntry(entry));
  expect(writer.setting(project, `review.share.${preview.preview.revision.slice(7)}`)).toBeUndefined();
});
it.each(["entry", "checks", "head", "privacy", "authority", "source"])("refuses Share after %s changes", async what => {
  const entry = await queued(), preview = await reviewAction("1", "share", options(), {}, deps());
  if (what === "entry") writeFileSync(personalPath(entry.mex.id), serializeEntry({ ...entry, text: "changed rule" }));
  if (what === "checks") writeFileSync(join(root, "package.json"), '{}\n');
  if (what === "head") git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "new head");
  if (what === "privacy" || what === "source") {
    const key = `learning.note.${entry.mex.id}`, value = JSON.parse(writer.setting(project, key)!);
    if (what === "privacy") value.holds = ["model-private"]; else value.sources = [];
    writer.db.prepare("UPDATE settings SET value=? WHERE scope=? AND key=?").run(JSON.stringify(value), project, key);
  }
  await expect(reviewAction(preview.preview.id, "share", options(), { apply: true, expect: preview.preview.revision }, { ...deps(), ...(what === "authority" ? { repository: async () => ({ visibility: "public" as const, authorized: false }) } : {}) })).rejects.toThrow();
  expect(existsSync(join(root, ".mex", "learned"))).toBe(false);
});
it("applies an edited personal correction, clearing old checks and leaving team bytes alone", async () => {
  const entry = await queued(), words = "tests use vitest for deterministic results.";
  await apply("edit", "1", { text: words });
  const changed = parseEntry(readFileSync(personalPath(entry.mex.id), "utf8")); expect(changed.text).toBe(words); expect(changed.mex.checks).toEqual([]);
  expect(changed.mex.source.quote).toBe(words); expect(queue().waiting).toBe(0); expect(writer.setting(project, `learning.note.${entry.mex.id}`)).toBeUndefined();
});
it("keeps a judge proposal personally without changing its team source, including legacy rows", async () => {
  const entry = await queued(), beforeEntry = { ...entry, text: "the previous team rule." }, before = serializeEntry(beforeEntry);
  const path = join(root, ".mex", "learned", `${entry.mex.id}.md`); mkdirSync(join(root, ".mex", "learned"), { recursive: true }); writeFileSync(path, before);
  // The candidate is private; only its old source is present in the team tree.
  writer.db.prepare("DELETE FROM settings WHERE key LIKE 'learning.%' OR key LIKE 'review.item.%'").run(); writer.db.prepare("DELETE FROM review").run(); rmSync(personalPath(entry.mex.id));
  const key = `judge.fix.${shortHash(entry.mex.id)}`;
  const judgement = { version: 1, id: entry.mex.id, inputs_hash: hash("inputs"), checkout: root, position: await position(root), entry_hash: hash(before), checks_hash: hash("checks"),
    files: [], result: "rewritten", label: "checked by model", model: "fixture", at: new Date(now).toISOString(), rewrite: entry };
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, key, JSON.stringify({ judgement, before, state: "review", agent: "codex", item: { id: entry.mex.id, path, level: "team" } }));
  writer.db.prepare("INSERT INTO review VALUES(?,?,?,?,'pending',?)").run(key, project, entry.mex.id, "the model needs your decision (checked by model)", new Date(now).toISOString());
  expect(queue().items[0]!.checkedByModel).toBe(true);
  await apply("keep"); expect(readFileSync(path, "utf8")).toBe(before); expect(readFileSync(personalPath(entry.mex.id), "utf8")).toBe(serializeEntry(entry));
  expect(queue().waiting).toBe(0); expect(JSON.parse(writer.setting(project, key)!).state).toBe("discarded");
});
it("preserves an unrelated personal edit made after the action preview", async () => {
  const entry = await queued(), preview = await reviewAction("1", "keep", options(), {}, deps());
  const changed = serializeEntry({ ...entry, text: "my newer correction" }); writeFileSync(personalPath(entry.mex.id), changed);
  await expect(reviewAction("1", "keep", options(), { apply: true, expect: preview.preview.revision }, deps())).rejects.toThrow();
  expect(readFileSync(personalPath(entry.mex.id), "utf8")).toBe(changed); expect(writer.setting(project, `review.keep.${claimHash(text).slice(7)}`)).toBeUndefined();
});
it.skipIf(process.platform === "win32")("withholds redirected personal storage", async () => {
  const entry = await queued(), outside = join(base, "outside.md"); writeFileSync(outside, serializeEntry(entry));
  rmSync(personalPath(entry.mex.id)); symlinkSync(outside, personalPath(entry.mex.id));
  expect(() => queue()).toThrow(); expect(readFileSync(outside, "utf8")).toBe(serializeEntry(entry));
});
it("reads an unregistered project without creating a home", () => {
  writer.close(); rmSync(home, { recursive: true, force: true });
  expect(reviewQueue(options(), now).waiting).toBe(0); expect(existsSync(home)).toBe(false);
  expect(readdirSync(root).sort()).toEqual([".git", "package.json"]);
});

async function contradiction(key: string, type: "anti" | "required", words: string) {
  const proposal: Proposal = { producer: "code-facts", key, kind: "rule", text: words, source: { type: "mined", ref: "imports" },
    model: "none", anchors: { scope: ["src/**"], when: [{ type, match: "literal", pattern: "from Internal" }] } };
  return (await propose([proposal], { ...options(), now: new Date(now) }))[0]!;
}

it("shows contradictions ahead of sharing cards and allows keeping the current entry with sharing off", async () => {
  await queued();
  await contradiction("old", "anti", "Internal imports stay in the adapter.");
  const result = await contradiction("pending", "required", "The adapter boundary uses this internal import.");
  if (result.status !== "review") throw new Error("Expected a conflict");
  expect(queue().items[0]).toMatchObject({ id: result.reviewId, reason: "contradiction", conflictsWith: result.conflictsWith });
  writer.db.prepare("UPDATE projects SET shared=0 WHERE id=?").run(project);
  expect(queue().items).toHaveLength(1);
  expect(queue(now + 30 * 86400000).items).toHaveLength(0);
  expect((await apply("keep")).applied).toBe(true);
  expect(queue().items).toHaveLength(0);
  expect(expandPersonal(result.conflictsWith[0]!, options()).entry.text).toBe("Internal imports stay in the adapter.");
});

it("removes a learned proposal's source proof when its contradiction card is kept", async () => {
  await contradiction("old", "anti", "Internal imports stay in the adapter.");
  const words = "The adapter boundary uses this internal import.";
  const learned: Proposal = { producer: "learn-deeper", key: "pending", kind: "rule", text: words, evidenceClass: "docs",
    source: { type: "docs", ref: "README.md", quote: words, text: words }, model: { id: "fixture", version: "fixture-1" },
    anchors: { scope: ["src/**"], when: [{ type: "required", match: "literal", pattern: "from Internal" }] },
    // A learned entry always carries a check: one that never holds can't be withheld when it goes stale.
    checks: [{ kind: "source", role: "supporting", target: { file: "package.json" } }] };
  const result = (await propose([learned], { ...options(), now: new Date(now) }))[0]!;
  if (result.status !== "review") throw new Error("Expected a conflict");
  const proof = `learning.deep.note.${producerEntryId("learn-deeper", "pending")}`, other = "learning.deep.note.mx_deepkept";
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, proof, "{}");
  writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(project, other, "{}");
  expect((await apply("keep")).applied).toBe(true);
  expect(writer.setting(project, proof)).toBeUndefined();
  expect(writer.setting(project, other)).toBe("{}");
});

it("uses a conflicting proposal through the gate and retires only the personal entry", async () => {
  writer.db.prepare("UPDATE projects SET shared=0 WHERE id=?").run(project);
  await contradiction("old", "anti", "Internal imports stay in the adapter.");
  const originalId = producerEntryId("code-facts", "old");
  const personal = expandPersonal(originalId, options()).entry;
  const team = { ...personal, mex: { ...personal.mex, id: "mx_team000", scope: ["src/**"], source: { type: "docs" as const, ref: "Repository guide" } } };
  const folder = join(root, ".mex", "learned");
  mkdirSync(folder, { recursive: true });
  const teamPath = join(folder, team.mex.id + ".md");
  const teamRaw = serializeEntry(team);
  writeFileSync(teamPath, teamRaw);
  const proposed = "The adapter boundary uses this internal import.";
  expect(await contradiction("pending", "required", proposed)).toMatchObject({ status: "review" });
  expect((await apply("use")).applied).toBe(true);
  expect(queue().items).toHaveLength(0);
  expect(expandPersonal(producerEntryId("code-facts", "pending"), options()).entry.text).toBe(proposed);
  const retired = parseEntry(readFileSync(personalPath(originalId), "utf8"));
  expect(retired.mex.retired?.reason).toBe("replaced in review");
  expect(readFileSync(teamPath, "utf8")).toBe(teamRaw);
  expect(await contradiction("pending", "required", proposed)).toMatchObject({ status: "accepted", change: "unchanged" });
  expect(queue().items).toHaveLength(0);
});
