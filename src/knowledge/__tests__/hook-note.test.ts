import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdentity } from "../../record/index.js";
import { hookNote } from "../hook-note.js";

let root: string, repo: string, saved: string | undefined;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-hook-note-")); repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
  writeFileSync(join(repo, "README.md"), "# Fixture\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "Initial fixture");
  saved = process.env.MEX_HOME; process.env.MEX_HOME = join(root, "user");
});
afterEach(() => {
  if (saved === undefined) delete process.env.MEX_HOME; else process.env.MEX_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("mex note: typed in a session", () => {
  it("saves a personal note at once through the note writer", async () => {
    const result = await hookNote(JSON.stringify({ project: repo, text: "Integration tests need Docker running." }));
    expect(result).toMatchObject({ ok: true, id: expect.stringMatching(/^mx_[a-f0-9]{24}$/u) });
    const notes = readdirSync(join(root, "user", ".mex", "projects", projectIdentity(repo).id, "notes"));
    expect(notes).toEqual([`${result.id}.md`]);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
  it("answers with a reason and saves nothing on bad input or a secret", async () => {
    expect(await hookNote("not json")).toEqual({ ok: false, message: "MEX couldn't read the note." });
    expect(await hookNote(JSON.stringify({ project: repo, text: "  " }))).toMatchObject({ ok: false });
    const secret = await hookNote(JSON.stringify({ project: repo, text: "Deploy with api_key=abcdefgh12345678 from the vault." }));
    expect(secret.ok).toBe(false);
    expect(secret.message).toMatch(/secret/u);
  });
});
