import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { rankNative } from "../native-rank.js";
import type { KnowledgeEntry } from "../entry.js";
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const entry: KnowledgeEntry = { mex: { id: "mx_poolaa", kind: "pitfall", scope: ["src/**"], source: { type: "docs", ref: "docs/pool.md" }, evidence: "docs", one_line: "Keep the pool open.", checks: [], status: "active", created: "2026-11-15" }, text: "Keep the pool open because requests share it." };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("native recall ranking", () => {
 it("sends gated entries to the shared ranker and retains its explanation", () => {
  vi.stubEnv("MEX_HOOK_BINARY", "fixture-native");
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: JSON.stringify({ ok: true, results: [{ selected: [[{ id: entry.mex.id, score: .7, matched: ["pool"], exact: true }]] }] }) } as never);
  expect(rankNative("pool", [entry]).hits).toEqual([{ id: entry.mex.id, score: .7, matched: ["pool"], exact: true }]);
  const args = vi.mocked(spawnSync).mock.calls[0];
  expect(args[1]).toEqual(["--recall"]);
  expect(JSON.parse((args[2] as { input: string }).input).entries[0]).toMatchObject({ id: entry.mex.id, text: entry.text });
 });
 it("fails back to legacy search when the process or its response is unavailable", () => {
  vi.stubEnv("MEX_HOOK_BINARY", "fixture-native");
  for (const result of [{ status: 1 }, { status: 0, stdout: "{}" }, { status: 0, stdout: JSON.stringify({ ok: true, results: [{ selected: [[{ id: "unknown", score: 1 }]] }] }) }]) {
   vi.mocked(spawnSync).mockReturnValue(result as never);
   expect(rankNative("pool", [entry]).reason).toBe("native-ranker-unavailable");
  }
 });
});
