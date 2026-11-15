import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecordReadOnly } from "../../record/index.js";
import { note } from "../store.js";
import { changeAid } from "../aid-store.js";
import { applyEnrich, planEnrich, runEnrich } from "../enrich.js";
import type { AidRanker } from "../aids.js";

let root: string, repo: string, home: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-aids-")); repo = join(root, "repo"); home = join(root, "user", ".mex");
  mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "README.md"), "# Fixture\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "Initial fixture");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const options = () => ({ projectPath: repo, home, isNetwork: () => false });
/** Ranks a query to the entry whose one line shares its first word, else nothing. */
const byFirstWord: AidRanker = (entries, queries) => new Map(queries.map(q => {
  const word = q.text.split(" ")[0].toLowerCase();
  return [q.id, entries.filter(e => e.mex.one_line.toLowerCase().includes(word) || (e.mex.aliases ?? []).some(a => a.toLowerCase().startsWith(word))).map((e, i) => ({ id: e.mex.id, score: 1 / (i + 1) }))];
}));

describe("mex alias and mex ask on a personal note", () => {
  it("keeps a filtered alias, records every verdict, and removes by hand", () => {
    const saved = note({ text: "Webhook retries back off, because providers rate-limit." }, options());
    note({ text: "Deploys run from the release branch, because main is protected." }, options());
    const id = saved.entry.mex.id;
    const kept = changeAid({ id, kind: "alias", op: "add", text: "webhook storm" }, options(), undefined, byFirstWord);
    expect(kept).toMatchObject({ level: "personal", changed: true, verdict: { kept: true } });
    expect(kept.entry.mex.aliases).toEqual(["webhook storm"]);
    const dropped = changeAid({ id, kind: "ask", op: "add", text: "deploys keep failing, why?" }, options(), undefined, byFirstWord);
    expect(dropped).toMatchObject({ changed: false, verdict: { kept: false } });
    const reader = openRecordReadOnly(options())!;
    try {
      expect(reader.all<{ text: string; kept: number; source: string }>("SELECT text,kept,source FROM aid_verdicts ORDER BY text"))
        .toEqual([{ text: "deploys keep failing, why?", kept: 0, source: "hand" }, { text: "webhook storm", kept: 1, source: "hand" }]);
    } finally { reader.close(); }
    const removed = changeAid({ id, kind: "alias", op: "remove", text: "Webhook Storm" }, options(), undefined, byFirstWord);
    expect(removed.entry.mex.aliases).toBeUndefined();
    expect(() => changeAid({ id, kind: "alias", op: "remove", text: "missing" }, options(), undefined, byFirstWord)).toThrow(/no such alias/u);
  });
});

describe("mex entries enrich", () => {
  it("plans at $0, makes one call, previews only filtered aids, and writes exactly the preview", async () => {
    const a = note({ text: "Webhook retries back off, because providers rate-limit." }, options()).entry.mex.id;
    const b = note({ text: "Deploys run from the release branch, because main is protected." }, options()).entry.mex.id;
    const plan = planEnrich(options());
    expect(plan.entries.map(e => e.id).sort()).toEqual([a, b].sort());
    let calls = 0;
    const preview = await runEnrich(options(), async prompt => {
      calls++;
      expect(prompt).toContain("doesn't know the entry exists");
      return `Here you go: {"entries":[{"id":"${a}","aliases":["webhook 429s","deploys wrong"],"asks":["webhook retries keep failing?"]},{"id":"mx_unknown","aliases":["x"]}]}`;
    }, byFirstWord);
    expect(calls).toBe(1);
    expect(preview.changes).toEqual([expect.objectContaining({ id: a, aliases: ["webhook 429s"], asks: ["webhook retries keep failing?"] })]);
    expect(preview.verdicts.find(v => v.text === "deploys wrong")).toMatchObject({ kept: false, top: b });
    expect(() => applyEnrich(options(), "wrong")).toThrow(/revision/u);
    const done = applyEnrich(options(), preview.revision);
    expect(done).toEqual({ written: [a], stale: [] });
    expect(planEnrich(options()).entries.map(e => e.id)).toEqual([b]);
    expect(() => applyEnrich(options(), preview.revision)).toThrow(/--run first/u);
  });
});
