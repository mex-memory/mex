import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PinnedTree } from "../git.js";
import { Gaps } from "../harvest/evidence.js";
import { localInventory, readRevert, revertedPulls } from "../harvest/local.js";
import type { HarvestOptions, HarvestPlan } from "../harvest/types.js";

let root = "";
const ids: Record<string, string> = {};
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, ".none"), GIT_TERMINAL_PROMPT: "0" } }).trim();
}
function commit(name: string, day: number, subject: string, content: string) {
  writeFileSync(join(root, "context.ts"), content + "\n");
  git(["add", "context.ts"]);
  const date = `2026-0${Math.floor(day / 28) + 6}-${String(day % 28 + 1).padStart(2, "0")}T10:00:00Z`;
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "commit", "-qm", subject],
    { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_NOSYSTEM: "1" } });
  ids[name] = git(["rev-parse", "HEAD"]);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mex-revert-links-"));
  git(["init", "-q", "--initial-branch=main"]);
  commit("base", 1, "Add the context", "export const json = (o) => send(JSON.stringify(o));");
  // Hono's shape (OSS-92): a conventional subject names the PR it undoes, with no body.
  commit("fast", 2, "perf(context): add fast path to c.json() (#4707)", "export const json = (o) => Response.json(o);");
  commit("undo", 3, "fix(context): revert PR #4707 (#4757)", "export const json = (o) => send(JSON.stringify(o));");
  commit("tune", 4, "Tune the router (#4800)", "export const json = (o) => send(JSON.stringify(o)); // tuned");
  commit("untune", 5, 'Revert "Tune the router (#4800)" (#4801)', "export const json = (o) => send(JSON.stringify(o));");
  commit("reland", 6, "Re-land: Tune the router (#4802)", "export const json = (o) => send(JSON.stringify(o)); // tuned again");
  commit("lru", 7, "perf(cache): add the LRU (#4890)", "export const json = (o) => send(JSON.stringify(o)); // lru");
  commit("unlru", 8, "revert: perf(cache): add the LRU (#4891)", "export const json = (o) => send(JSON.stringify(o)); // tuned again");
});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it("links a conventional revert to the pull request it undid, unless it was re-landed", async () => {
  const head = ids.unlru!;
  const tree = (await PinnedTree.open(root, head))!;
  const options = { checkout: root, head, since: "2026-06-01T00:00:00Z", until: "2026-07-30T00:00:00Z" } as unknown as HarvestOptions;
  const inventory = await localInventory(options, head, tree, new Gaps());
  expect(inventory.local.revert.map(point => point.id).sort()).toEqual([ids.undo, ids.untune, ids.unlru].sort());
  expect(inventory.revertLinks[ids.undo!]).toEqual({ original: ids.fast, pull: 4707 });
  expect(inventory.revertLinks[ids.unlru!]).toEqual({ original: ids.lru, pull: 4890 });
  expect(inventory.revertLinks[ids.untune!]).toMatchObject({ original: ids.tune, pull: 4800, reland: ids.reland });
  expect([...revertedPulls(inventory)].sort()).toEqual([4707, 4890]);
  const plan = { checkout: root, inventory } as unknown as HarvestPlan;
  const evidence = await readRevert(plan, { id: ids.undo!, at: "2026-06-04T10:00:00.000Z" });
  expect(evidence?.original?.id).toBe(ids.fast);
  expect(evidence?.reasonPulls).toEqual([4757, 4707]);
});
