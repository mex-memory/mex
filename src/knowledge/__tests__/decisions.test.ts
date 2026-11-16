import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecord, projectIdentity } from "../../record/index.js";
import { note } from "../store.js";
import { acceptDecisions, commitFacts, decisionWords, DECISION_TRIGGER, DECISION_WORDS, inForcePath, runGit } from "../decisions.js";
import { ground } from "../grounding.js";

let root: string, repo: string, home: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
const write = (file: string, text: string) => writeFileSync(join(repo, file), text);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-decisions-")); repo = join(root, "repo"); home = join(root, "user", ".mex");
  mkdirSync(repo);
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  write("README.md", "# Fixture\n"); git("add", "."); git("commit", "-m", "Initial fixture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = () => ({ projectPath: repo, home, isNetwork: () => false });

/** A decision commit on a feature branch, and a note that cites it. */
function decide(): { sha: string; id: string } {
  git("checkout", "-q", "-b", "feature");
  write("dates.ts", "export const lib = 'date-fns';\n");
  git("add", "."); git("commit", "-m", "Switch to date-fns instead of moment");
  const sha = git("rev-parse", "HEAD");
  const facts = commitFacts(runGit(repo), sha)!;
  const { subject, ...rest } = facts;
  const saved = note({ text: "Dates use date-fns, not moment, because moment is unmaintained.", kind: "decision", commit: { ...rest, subject } }, options());
  git("checkout", "-q", "main");
  return { sha, id: saved.entry.mex.id };
}
const state = () => acceptDecisions(options()).map(r => [r.state, r.events.at(-1)?.matched_by]);

describe("commit-anchored decisions", () => {
  it("records the commit's patch id, subject and files, and saves the decision as proposed", () => {
    const { sha, id } = decide();
    const facts = commitFacts(runGit(repo), sha)!;
    expect(facts).toMatchObject({ sha, subject: "Switch to date-fns instead of moment", files: ["dates.ts"] });
    expect(facts.patch_id).toMatch(/^[a-f0-9]{40}$/u);
    expect(acceptDecisions(options())).toMatchObject([{ id, state: "proposed", events: [] }]);
  });
  it("is accepted when the commit is merged", () => {
    decide();
    git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
    expect(state()).toEqual([["accepted", "sha"]]);
  });
  it("matches a squash copy by patch id", () => {
    decide();
    git("merge", "-q", "--squash", "feature"); git("commit", "-q", "-m", "Dates: one squashed change");
    git("branch", "-q", "-D", "feature");
    expect(state()).toEqual([["accepted", "patch-id"]]);
  });
  it("matches a rebased copy by patch id", () => {
    const { sha } = decide();
    write("other.ts", "x\n"); git("add", "."); git("commit", "-q", "-m", "Unrelated change on main");
    git("cherry-pick", sha);
    expect(git("rev-parse", "HEAD")).not.toBe(sha);
    expect(state()).toEqual([["accepted", "patch-id"]]);
  });
  it("falls back to the subject plus the files when the patch changed on the way in", () => {
    decide();
    write("dates.ts", "export const lib = 'date-fns'; // reviewed\n");
    git("add", "."); git("commit", "-q", "-m", "Switch to date-fns instead of moment");
    expect(state()).toEqual([["accepted", "subject-files"]]);
  });
  it("is withdrawn by a revert, in an append-only log", () => {
    const { sha, id } = decide();
    git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
    expect(state()).toEqual([["accepted", "sha"]]);
    // A reverted pull request names the merge commit, not the cited one.
    git("revert", "--no-edit", "-m", "1", "HEAD");
    const rows = acceptDecisions(options());
    expect(rows[0].events.map(e => [e.event, e.matched_by])).toEqual([["accepted", "sha"], ["withdrawn", "revert"]]);
    expect(JSON.parse(readFileSync(inForcePath(home, projectIdentity(repo).id), "utf8"))).toEqual({ version: 1, ids: [] });
    const writer = openRecord(options());
    try {
      expect(() => writer.db.exec(`UPDATE decision_events SET event='accepted' WHERE entry_id='${id}'`)).toThrow(/append-only/u);
      expect(() => writer.db.exec("DELETE FROM decision_events")).toThrow(/append-only/u);
    } finally { writer.close(); }
  });
  it("is withdrawn by a revert of the cited commit itself", () => {
    const { sha } = decide();
    git("merge", "-q", "--ff-only", "feature");
    expect(state()).toEqual([["accepted", "sha"]]);
    git("revert", "--no-edit", sha);
    expect(state()).toEqual([["withdrawn", "revert"]]);
  });
  it("stays proposed when the commit never lands, and publishes the in-force set when one does", () => {
    const { id } = decide();
    expect(state()).toEqual([["proposed", undefined]]);
    expect(acceptDecisions(options())).toHaveLength(1);
    git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
    acceptDecisions(options());
    expect(JSON.parse(readFileSync(inForcePath(home, projectIdentity(repo).id), "utf8"))).toEqual({ version: 1, ids: [id] });
    expect(acceptDecisions(options())[0].events).toHaveLength(1);
  });
});

describe("the decision-word trigger", () => {
  it("needs two distinct phrases on word boundaries", () => {
    expect(decisionWords("Switch to date-fns instead of moment")).toEqual(["instead of", "switch to"]);
    expect(decisionWords("Fix the dropdown")).toEqual([]);
    expect(decisionWords("Drop Node 18").length).toBeLessThan(DECISION_TRIGGER);
    expect(decisionWords("We chose pnpm rather than yarn; avoid npm")).toEqual(["avoid", "chose", "rather than"]);
  });
  it("uses the same list as the hook", () => {
    const go = readFileSync(join(__dirname, "../../../native/delivery/decision.go"), "utf8");
    const list = /var decisionWords = \[\]string\{([^}]*)\}/u.exec(go)![1].match(/"([^"]+)"/gu)!.map(s => s.slice(1, -1));
    expect(list).toEqual([...DECISION_WORDS]);
  });
});

describe("grounding extracted fields", () => {
  const sources = ["Switch to date-fns instead of moment\n\nmoment is unmaintained and large."];
  it("scores exact, fuzzy and missing, and drops below the floor", () => {
    expect(ground("moment is unmaintained", sources)).toEqual({ match: "exact", confidence: 1, kept: true });
    expect(ground("Moment is UNMAINTAINED, and large", sources)).toEqual({ match: "fuzzy", confidence: .85, kept: true });
    expect(ground("we picked luxon", sources)).toEqual({ match: "missing", confidence: .6, kept: true });
    expect(ground("we picked luxon", sources, .9)).toEqual({ match: "missing", confidence: .54, kept: false });
  });
});
