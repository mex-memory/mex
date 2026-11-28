import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { entry } from "../../knowledge/__tests__/fixtures.js";
import { serializeEntry } from "../../knowledge/entry.js";
import { claimHash } from "../../knowledge/state.js";
import { MANIFEST_PATH, readTeamCoverage, teamRetired, type SourceRef } from "../coverage.js";
import { sourceDigest } from "../source.js";

it("matches a reworded default-branch deletion by id and stable comment source, without sweeping another lesson on the same PR", async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-retirement-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git("add", "-A");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message);
  };
  const repository = { host: "github.com", slug: "example/repo" };
  const url = "https://github.com/example/repo/pull/1";
  const source = (id: string, body: string): SourceRef => ({ id, hash: sourceDigest(body), link: url });
  const shared = entry("mx_shared1", { source: { type: "review", ref: url }, evidence: "review", scope: ["src/**"] }, "Keep the stable request logger.");
  const sameId = entry(shared.mex.id, { ...shared.mex, one_line: "Keep request logs stable." }, "Keep request logs stable.");
  const differentId = { ...sameId, mex: { ...sameId.mex, id: "mx_shared2" } };
  const raw = serializeEntry(differentId);
  const proof = (evidence: SourceRef[], content = raw) => JSON.stringify({ hash: sourceDigest(content), source: repository, origin: repository, visibility: "public", sources: evidence });
  try {
    git("init", "-qb", "main");
    mkdirSync(join(root, ".mex", "learned"), { recursive: true });
    const path = join(root, ".mex", "learned", `${shared.mex.id}.md`);
    const manifest = join(root, MANIFEST_PATH);
    writeFileSync(path, serializeEntry(shared));
    writeFileSync(manifest, JSON.stringify({ version: 1, rule_files: [], learn_deeper: [{ id: shared.mex.id,
      claim: claimHash(shared.text), sources: [source("gh:thread:PRRT_1", "old comment")] }] }));
    commit("Keep the shared rule");
    unlinkSync(path);
    writeFileSync(manifest, JSON.stringify({ version: 1, rule_files: [] }));
    commit("Delete the shared rule and its manifest row");
    const coverage = await readTeamCoverage(root, git("rev-parse", "HEAD"), "2020-01-01T00:00:00Z");
    expect(teamRetired(coverage, sameId)).toBe(true);
    expect(teamRetired(coverage, differentId, raw, proof([source("gh:thread:PRRT_1", "edited comment")]))).toBe(true);
    expect(teamRetired(coverage, differentId, raw, proof([source("gh:thread:PRRT_2", "other comment")]))).toBe(false);
    expect(teamRetired(coverage, differentId, raw, proof([source("gh:pr:1", "same PR")]))).toBe(false);
    expect(teamRetired(coverage, differentId, raw, proof([source("gh:thread:PRRT_1", "old comment")], "changed entry bytes"))).toBe(false);
  } finally { rmSync(root, { force: true, recursive: true }); }
});
