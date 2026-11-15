import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyCandidateAids, corpusDigest, filterAids, refilterCorpus, withAids, type AidRanker } from "../aids.js";
import { entry } from "./fixtures.js";

const webhook = entry("mx_webhk1", { kind: "pitfall", one_line: "Webhook retries back off exponentially." }, "Webhook retries back off exponentially, because providers rate-limit bursts.");
const client = entry("mx_client", { one_line: "Requests go through the API client." }, "Requests go through the API client, which adds auth headers.");
const logging = entry("mx_logged", { one_line: "Every delivery writes one log line." }, "Every delivery writes one log line, so support can trace it.");
const corpus = [webhook, client, logging];

describe("alias filter rules (scripted ranker)", () => {
  const scripted = (lists: Record<string, Array<{ id: string; score: number }>>): AidRanker => (_entries, queries) => new Map(queries.map(q => [q.id, lists[q.id] ?? []]));
  it("keeps a candidate that ranks its own entry first with a margin, and records why others were dropped", () => {
    const result = filterAids(webhook, [
      { kind: "alias", text: "429 storm" }, { kind: "alias", text: "auth headers" }, { kind: "ask", text: "close call?" }, { kind: "alias", text: "nothing" },
    ], corpus, scripted({
      "0": [{ id: "mx_webhk1", score: 1 }, { id: "mx_client", score: .2 }],
      "1": [{ id: "mx_client", score: .9 }, { id: "mx_webhk1", score: .4 }],
      "2": [{ id: "mx_webhk1", score: 1 }, { id: "mx_logged", score: .9 }],
    }));
    expect(result.aliases).toEqual(["429 storm"]);
    expect(result.asks).toEqual([]);
    expect(result.verdicts.map(v => [v.text, v.kept, v.reason])).toEqual([
      ["429 storm", true, "ranks its own entry first"],
      ["auth headers", false, "ranks mx_client above its own entry"],
      ["close call?", false, "leads mx_logged by less than 25%"],
      ["nothing", false, "matches no words of its entry"],
    ]);
  });
  it("drops empty, too long, duplicate and title-repeating candidates before ranking", () => {
    const result = filterAids(webhook, [
      { kind: "alias", text: "   " }, { kind: "alias", text: "x".repeat(41) }, { kind: "alias", text: "Same" }, { kind: "alias", text: "same" },
      { kind: "alias", text: "Webhook retries back off exponentially." },
    ], corpus, scripted({ "0": [{ id: "mx_webhk1", score: 1 }] }));
    expect(result.verdicts.map(v => v.reason)).toEqual(["empty", "longer than 40 characters", "duplicate", "repeats the entry's one line", "ranks its own entry first"]);
  });
  it("sends an alias another entry already keeps to Review instead of keeping it twice", () => {
    const holder = withAids(client, ["rate limit"], []);
    const result = filterAids(webhook, [{ kind: "alias", text: "Rate limit" }], [webhook, holder, logging], scripted({ "0": [{ id: "mx_webhk1", score: 1 }, { id: "mx_client", score: .5 }] }));
    expect(result.aliases).toEqual([]);
    expect(result.verdicts[0]).toMatchObject({ kept: false, review: true, top: "mx_client" });
  });
  it("is deterministic, and the corpus digest changes only with what the filter ranks", () => {
    const rank = scripted({ "0": [{ id: "mx_webhk1", score: 1 }] });
    expect(filterAids(webhook, [{ kind: "alias", text: "429 storm" }], corpus, rank)).toEqual(filterAids(webhook, [{ kind: "alias", text: "429 storm" }], corpus, rank));
    expect(corpusDigest(corpus)).toBe(corpusDigest([...corpus].reverse()));
    expect(corpusDigest([withAids(webhook, ["x"], []), client, logging])).not.toBe(corpusDigest(corpus));
  });
  it("gives AI writers one seam that keeps only filtered candidates", () => {
    const out = applyCandidateAids(webhook, { aliases: ["429 storm", 7, "auth headers"], asks: "not a list" }, corpus, scripted({
      "0": [{ id: "mx_webhk1", score: 1 }], "1": [{ id: "mx_client", score: 1 }],
    }));
    expect(out.entry.mex.aliases).toEqual(["429 storm"]);
    expect(out.entry.mex.asks).toBeUndefined();
    expect(applyCandidateAids(webhook, undefined, corpus).entry).toBe(webhook);
  });
});

const enabled = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const roots: string[] = [];
afterAll(() => { for (const path of roots) rmSync(path, { recursive: true, force: true }); });

describe.skipIf(!enabled)("alias filter through the real ranker", () => {
  let previous: string | undefined;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "mex-aids-bin-")); roots.push(base);
    const binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../native"), timeout: 240_000, stdio: "pipe" });
    previous = process.env.MEX_HOOK_BINARY; process.env.MEX_HOOK_BINARY = binary;
  }, 300_000);
  afterAll(() => { if (previous === undefined) delete process.env.MEX_HOOK_BINARY; else process.env.MEX_HOOK_BINARY = previous; });

  it("keeps a symptom alias for its own entry and drops one that pulls in another entry", () => {
    const result = filterAids(webhook, [{ kind: "alias", text: "429 storm" }, { kind: "alias", text: "API client auth headers" }, { kind: "ask", text: "why do providers send 429 errors?" }], corpus);
    const byText = Object.fromEntries(result.verdicts.map(v => [v.text, v]));
    expect(byText["429 storm"]).toMatchObject({ kept: true });
    expect(byText["API client auth headers"]).toMatchObject({ kept: false, top: "mx_client" });
    expect(byText["why do providers send 429 errors?"]).toMatchObject({ kept: true });
    expect(result).toEqual(filterAids(webhook, [{ kind: "alias", text: "429 storm" }, { kind: "alias", text: "API client auth headers" }, { kind: "ask", text: "why do providers send 429 errors?" }], corpus));
  });

  it("reruns over the corpus and reports an alias that now collides", () => {
    const kept = withAids(webhook, ["auth storm"], []);
    const rival = entry("mx_rival1", { one_line: "Auth storms come from token refresh loops." }, "Auth storms come from token refresh loops in the API client.");
    const rerun = refilterCorpus([kept, client, logging, rival]);
    expect(rerun).toHaveLength(1);
    expect(rerun[0]).toMatchObject({ changed: true });
    expect(rerun[0].result.aliases).toEqual([]);
  });
});
