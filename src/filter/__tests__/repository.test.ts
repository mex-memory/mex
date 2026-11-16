import { beforeEach, afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ calls: [] as Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }>, replies: [] as Array<string | Error> }));
vi.mock("node:child_process", () => ({ execFile: (executable: string, args: string[], options: { env: NodeJS.ProcessEnv }, done: (error: Error | null, stdout: string) => void) => {
  fake.calls.push({ executable, args, env: options.env }); const reply = fake.replies.shift(); done(reply instanceof Error ? reply : null, typeof reply === "string" ? reply : "");
} }));
import { repositoryPolicy } from "../repository.js";
beforeEach(() => { fake.calls = []; fake.replies = []; });
afterEach(() => vi.unstubAllEnvs());
it("checks the origin's host and repo despite inherited Git/GitHub overrides", async () => {
  vi.stubEnv("GIT_DIR", "/other/repo/.git"); vi.stubEnv("GIT_WORK_TREE", "/other/repo"); vi.stubEnv("GH_HOST", "private.example.test"); vi.stubEnv("GH_REPO", "other/project");
  fake.replies = ["git@github.com:team/project.git\n", '{"isPrivate":true,"viewerPermission":"READ"}', '[{"number":7}]'];
  expect(await repositoryPolicy("/intended/repo")).toEqual({ visibility: "private", authorized: true });
  expect(fake.calls).toHaveLength(3);
  for (const call of fake.calls) for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GH_HOST", "GH_REPO"]) expect(call.env[key]).toBeUndefined();
  expect(fake.calls[1]!.args).toContain("https://github.com/team/project"); expect(fake.calls[2]!.args).toContain("https://github.com/team/project");
});
it("accepts known write access without inventing merged-PR evidence", async () => {
  fake.replies = ["https://github.com/team/project.git", '{"isPrivate":false,"viewerPermission":"WRITE"}'];
  expect(await repositoryPolicy("/repo")).toEqual({ visibility: "public", authorized: true }); expect(fake.calls).toHaveLength(2);
});
it("holds unavailable authority and unsupported origins", async () => {
  fake.replies = ["https://github.com/team/project", new Error("unavailable"), new Error("unavailable")];
  expect(await repositoryPolicy("/repo")).toEqual({ visibility: "unknown", authorized: false });
  fake.calls = []; fake.replies = ["https://unsupported.example.test/team/project"];
  expect(await repositoryPolicy("/repo")).toEqual({ visibility: "unknown", authorized: false }); expect(fake.calls).toHaveLength(1);
});
