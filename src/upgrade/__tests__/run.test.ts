import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shareRepo } from "../../knowledge/__tests__/share-fixtures.js";
import { knowledgeProject } from "../../knowledge/context.js";
import { parseEntry } from "../../knowledge/entry.js";
import { oldAssets } from "../local-plan.js";
import { digest } from "../safe-files.js";
import { prepareUpgrade } from "../plan.js";
import { completedUpgrade, discardUpgrade, finishUpgrade, pendingUpgrade, runUpgrade, type UpgradeStep } from "../run.js";

const now = new Date("2026-11-15T12:00:00Z");
const ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
function put(root: string, path: string, text: string | Buffer) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
function fixture() {
  const f = shareRepo(), root = realpathSync(f.root);
  put(root, ".mex/context/cache.md", `---\nmex:\n  id: ${ID}\n  type: fact\n  status: promoted\n  grounds_to:\n    - node: function:12345678abcdefab\n      fingerprint: mh2:64:Original_CASE\n      bodyHash: historical-body\n---\n# Cache\nThe cache retains a code fact from the original documentation.\n`);
  put(root, "AGENTS.md", "Human prefix.\n<!-- mex-agent:skills:start -->\nOld wiki instructions.\n<!-- mex-agent:skills:end -->\nHuman suffix.\n");
  put(root, ".mex/ROUTER.md", "# Router\nHuman navigation remains.\n");
  put(root, ".mex/SETUP.md", "Old setup instructions.\n");
  put(root, ".mex/inbox/pending.md", "A proposal is still pending.\n");
  put(root, ".mex/relays/open.md", "A Relay is still open.\n");
  f.git("add", "."); f.git("commit", "-qm", "legacy scaffold");
  put(root, ".mex/events/decisions.jsonl", JSON.stringify({ kind: "decision", message: "Keep the shared pool open.", timestamp: "2026-10-03T10:00:00Z", cwd: "/private/source" }) + "\n");
  put(root, ".mex/wiki.db", Buffer.from([0, 1, 2, 255]));
  const options = { projectPath: root };
  return { ...f, root, options };
}
afterEach(() => { vi.unstubAllEnvs(); process.exitCode = 0; });

describe("reviewed legacy upgrade", () => {
  it("previews exact tracked and local changes without creating machine state", () => {
    const f = fixture(), before = f.git("status", "--porcelain=v1");
    const p = prepareUpgrade(f.options, now);
    expect(p.ready).toBe(true);
    expect(p.diff).toContain("deleted file mode");
    expect(p.tracked.find(c => c.path === ".mex/SETUP.md")?.after).toBeNull();
    const entity = p.tracked.find(c => c.path.endsWith(`${ID.toLowerCase()}.md`))!;
    expect(parseEntry(entity.after!).mex.checks.at(-1)).toMatchObject({ kind: "legacy-grounding", saw: { fingerprint: "mh2:64:Original_CASE", bodyHash: "historical-body" }, files: {} });
    expect(parseEntry(p.personal[0].after!).mex.checks).toEqual([]);
    expect(p.personal[0].after).not.toContain("/private/source");
    expect(p.retained).toEqual(expect.arrayContaining([".mex/inbox/pending.md", ".mex/relays/open.md", ".mex/ROUTER.md"]));
    expect(f.git("status", "--porcelain=v1")).toBe(before);
    expect(existsSync(p.home)).toBe(false);
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
    expect(prepareUpgrade(f.options, now).revision).toBe(p.revision);
  });

  it("never executes repository checkout or commit hooks while preparing the upgrade", async () => {
    const f = fixture();
    for (const name of ["post-checkout", "pre-commit", "post-commit"]) {
      const path = `.git/hooks/${name}`;
      put(f.root, path, "#!/bin/sh\nprintf touched > hook-ran\nexit 99\n"); chmodSync(join(f.root, path), 0o755);
    }
    const p = prepareUpgrade(f.options, now);
    const result = await runUpgrade(f.options, p.revision, { now });
    expect(result.commit).toBeTruthy();
    expect(existsSync(join(f.root, "hook-ran"))).toBe(false);
    expect(f.git("ls-tree", "--name-only", result.branch, "--", "hook-ran")).toBe("");
  });

  it("applies local imports immediately and commits tracked output separately, preserving staged work", async () => {
    const f = fixture();
    put(f.root, "README.md", "An unrelated staged edit.\n"); f.git("add", "README.md");
    const staged = f.git("diff", "--cached"), head = f.git("rev-parse", "HEAD");
    const p = prepareUpgrade(f.options, now), result = await runUpgrade(f.options, p.revision, { now });
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(f.git("diff", "--cached")).toBe(staged);
    expect(readFileSync(join(f.root, ".mex/SETUP.md"), "utf8")).toContain("Old setup");
    expect(existsSync(join(f.root, ".mex/wiki.db"))).toBe(false);
    expect(existsSync(join(f.root, ".mex/events/decisions.jsonl"))).toBe(true);
    expect(result.personal).toBe(1);
    const project = knowledgeProject(f.options);
    const note = readFileSync(join(project.location.home, "projects", project.projectId, "notes", p.personal[0].path), "utf8");
    expect(parseEntry(note).mex.checks).toEqual([]);
    expect(f.git("show", `${result.branch}:AGENTS.md`)).toContain("mex recall");
    expect(f.git("show", `${result.branch}:.mex/context/cache.md`)).toContain("historical-body");
    expect(f.git("diff", "--name-only", head, result.branch)).not.toContain("README.md");
    expect(completedUpgrade(f.options)).toEqual(result);
    expect(pendingUpgrade(f.options)).toBeUndefined();
    await expect(runUpgrade(f.options, p.revision, { now })).rejects.toMatchObject({ code: "UPGRADE_DONE" });
  });

  it.each([
    { autocrlf: "true", eol: "\n", bom: "" },
    { autocrlf: "input", eol: "\r\n", bom: "\uFEFF" },
  ])("preserves reviewed bytes across Git line-ending conversion ($autocrlf)", async ({ autocrlf, eol, bom }) => {
    const f = fixture();
    f.git("config", "core.autocrlf", autocrlf); f.git("config", "core.safecrlf", "false");
    put(f.root, "AGENTS.md", bom + readFileSync(join(f.root, "AGENTS.md"), "utf8").replace(/\n/gu, eol));
    f.git("add", "AGENTS.md"); f.git("commit", "--allow-empty", "-qm", "reviewed instruction encoding");
    const original = readFileSync(join(f.root, "AGENTS.md"), "utf8");
    const p = prepareUpgrade(f.options, now);
    const instructions = p.tracked.find(c => c.path === "AGENTS.md")!;
    expect(instructions.before).toBe(original);
    expect(instructions.after!.startsWith(`${bom}Human prefix.${eol}`)).toBe(true);
    expect(instructions.after!.endsWith(`${eol}Human suffix.${eol}`)).toBe(true);
    expect(prepareUpgrade(f.options, now).revision).toBe(p.revision);
    const done = await runUpgrade(f.options, p.revision, { now });
    expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe(original);
    const committed = execFileSync("git", ["-C", f.root, "show", `${done.branch}:AGENTS.md`], { encoding: "utf8" });
    expect(committed).toBe(instructions.after!.replace(/\r\n/gu, "\n"));
  });

  it("rejects an original source's line-ending edit after preview even when Git considers it clean", async () => {
    const f = fixture();
    f.git("config", "core.autocrlf", "true"); f.git("config", "core.safecrlf", "false");
    const p = prepareUpgrade(f.options, now), path = ".mex/context/cache.md";
    put(f.root, path, readFileSync(join(f.root, path), "utf8").replace(/\n/gu, "\r\n"));
    expect(f.git("diff", "--name-only", "HEAD", "--", path)).toBe("");
    await expect(runUpgrade(f.options, p.revision, { now })).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(existsSync(p.home)).toBe(false);
  });

  it.each(["worktree", "written"] as const)("keeps a byte-only human edit after the %s checkpoint", async stopAfter => {
    const f = fixture();
    f.git("config", "core.autocrlf", "true"); f.git("config", "core.safecrlf", "false");
    const p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    const project = knowledgeProject(f.options), dir = join(project.location.home, "projects", project.projectId);
    const state = JSON.parse(readFileSync(join(dir, "upgrade.json"), "utf8")) as { worktree: string };
    const path = join(state.worktree, "AGENTS.md"), edited = readFileSync(path, "utf8").replace(/\n/gu, "\r\n");
    writeFileSync(path, edited);
    await expect(finishUpgrade(f.options)).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    await expect(discardUpgrade(f.options)).rejects.toMatchObject({ code: "UPGRADE_CHANGED" });
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it.each(["source", "base", "destination", "local"])("rejects a stale %s before any upgrade write", async change => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    if (change === "source") put(f.root, ".mex/context/cache.md", "A changed source.\n");
    if (change === "base") { put(f.root, "other.md", "Another commit.\n"); f.git("add", "other.md"); f.git("commit", "-qm", "advance"); }
    if (change === "destination") put(f.root, `.mex/learned/${ID.toLowerCase()}.md`, "User output.\n");
    if (change === "local") put(f.root, ".mex/wiki.db", Buffer.from([1, 2, 3]));
    await expect(runUpgrade(f.options, p.revision, { now })).rejects.toBeDefined();
    expect(existsSync(p.home)).toBe(false);
    expect(existsSync(join(f.root, ".mex/wiki.db"))).toBe(true);
  });

  it.each<UpgradeStep>(["started", "local", "worktree", "written", "committed"])("resumes exact output after stopping at %s", async stopAfter => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    expect(pendingUpgrade(f.options)?.step).toBe(stopAfter);
    const result = await finishUpgrade(f.options);
    expect(result.files).toEqual(p.tracked.map(c => c.path));
    expect(f.git("show", `${result.branch}:.mex/learned/${ID.toLowerCase()}.md`)).toContain("Original_CASE");
    expect(pendingUpgrade(f.options)).toBeUndefined();
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });

  it("asks for a Git identity before changing anything", async () => {
    const f = fixture(), p = prepareUpgrade(f.options, now), before = f.git("status", "--porcelain=v1");
    const isolated = join(f.root, "..", "no-identity");
    mkdirSync(isolated, { recursive: true });
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(isolated, "gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("HOME", isolated); vi.stubEnv("USERPROFILE", isolated); vi.stubEnv("XDG_CONFIG_HOME", isolated);
    vi.stubEnv("GIT_AUTHOR_NAME", ""); vi.stubEnv("GIT_COMMITTER_NAME", ""); vi.stubEnv("EMAIL", "");
    f.git("config", "--unset-all", "user.name"); f.git("config", "--unset-all", "user.email");
    await expect(runUpgrade(f.options, p.revision, { now })).rejects.toMatchObject({ code: "GIT_IDENTITY" });
    expect(pendingUpgrade(f.options)).toBeUndefined();
    expect(f.git("status", "--porcelain=v1")).toBe(before);
  });

  it("finishes after a checkout that failed once it had created the branch", async () => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter: "local" })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    // What `git worktree add -b` leaves when the checkout itself fails (for
    // example a path too long for Windows): the branch, but no worktree.
    f.git("branch", p.branch, p.base);
    const result = await finishUpgrade(f.options);
    expect(result.files).toEqual(p.tracked.map(c => c.path));
    expect(f.git("rev-parse", `${result.branch}^`)).toBe(p.base);
  });

  it("keeps a leftover upgrade branch that no longer points at the base", async () => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter: "local" })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    const moved = f.git("commit-tree", `${p.base}^{tree}`, "-p", p.base, "-m", "someone else's work");
    f.git("branch", p.branch, moved);
    await expect(finishUpgrade(f.options)).rejects.toMatchObject({ code: "UPGRADE_CHANGED" });
    expect(f.git("rev-parse", `refs/heads/${p.branch}`)).toBe(moved);
    expect(pendingUpgrade(f.options)?.step).toBe("local");
  });

  it("keeps edited recovery output and refuses links or unrelated work during discard", async () => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter: "written" })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    const project = knowledgeProject(f.options), dir = join(project.location.home, "projects", project.projectId);
    const state = JSON.parse(readFileSync(join(dir, "upgrade.json"), "utf8")) as { worktree: string };
    put(state.worktree, "unrelated.txt", "Keep me.\n");
    await expect(discardUpgrade(f.options)).rejects.toMatchObject({ code: "UPGRADE_CHANGED" });
    expect(readFileSync(join(state.worktree, "unrelated.txt"), "utf8")).toBe("Keep me.\n");
    expect(pendingUpgrade(f.options)?.step).toBe("written");
  });

  it("discards only its pending tracked output and keeps completed local imports", async () => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter: "written" })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    expect(await discardUpgrade(f.options)).toEqual({ branch: p.branch, branchKept: false, localKept: true });
    expect(existsSync(join(f.root, ".mex/wiki.db"))).toBe(false);
    expect(pendingUpgrade(f.options)).toBeUndefined();
    expect(f.git("branch", "--list", p.branch)).toBe("");
  });

  it.each([false, true])("checks a commit made before the checkpoint was recorded (unrelated output: %s)", async extra => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter: "written" })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    const project = knowledgeProject(f.options), dir = join(project.location.home, "projects", project.projectId);
    const state = JSON.parse(readFileSync(join(dir, "upgrade.json"), "utf8")) as { worktree: string };
    const git = (...args: string[]) => execFileSync("git", ["-C", state.worktree, ...args], { encoding: "utf8" }).trim();
    if (extra) put(state.worktree, "unrelated.txt", "A human commit.\n");
    git("add", "--force", "--", ...p.tracked.map(c => c.path), ...extra ? ["unrelated.txt"] : []);
    git("commit", "-qm", "commit before checkpoint");
    const commit = git("rev-parse", "HEAD");
    if (extra) { await expect(finishUpgrade(f.options)).rejects.toMatchObject({ code: "UPGRADE_CHANGED" }); expect(existsSync(state.worktree)).toBe(true); }
    else expect((await finishUpgrade(f.options)).commit).toBe(commit);
  });

  it("never replaces a human edit to its pending output", async () => {
    const f = fixture(), p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, stopAfter: "written" })).rejects.toMatchObject({ code: "UPGRADE_STOPPED" });
    const project = knowledgeProject(f.options), dir = join(project.location.home, "projects", project.projectId);
    const state = JSON.parse(readFileSync(join(dir, "upgrade.json"), "utf8")) as { worktree: string };
    const path = p.tracked.find(c => c.path.includes("/learned/"))!.path;
    put(state.worktree, path, "Human correction.\n");
    await expect(finishUpgrade(f.options)).rejects.toBeDefined();
    await expect(discardUpgrade(f.options)).rejects.toMatchObject({ code: "UPGRADE_CHANGED" });
    expect(readFileSync(join(state.worktree, path), "utf8")).toBe("Human correction.\n");
  });

  it("removes only an unchanged managed skill and reports user edits", () => {
    const f = fixture(), path = ".agents/skills/mex-inbox";
    put(f.root, `${path}/SKILL.md`, "Managed instructions.\n");
    put(f.root, `${path}/.mex-managed.json`, JSON.stringify({ schemaVersion: 1, owner: "mex-agent", skill: "mex-inbox", files: { "SKILL.md": digest("Managed instructions.\n") } }));
    expect(oldAssets(f.root).skills).toHaveLength(2);
    put(f.root, `${path}/SKILL.md`, "A human edit.\n");
    expect(oldAssets(f.root).skills).toEqual([]);
    expect(oldAssets(f.root).issues).toContainEqual({ code: "SKILL_REVIEW", path });
  });

  it("refuses a cache symlink without reading or deleting its target", () => {
    const f = fixture();
    // The companion cache is absent, so it can be replaced by a redirect.
    symlinkSync(join(f.root, "README.md"), join(f.root, ".mex/wiki.db-wal"));
    const assets = oldAssets(f.root);
    expect(assets.issues).toContainEqual({ code: "CACHE_REVIEW", path: ".mex/wiki.db-wal" });
    expect(assets.caches.map(c => c.path)).not.toContain(".mex/wiki.db-wal");
  });

  it.each([false, true])("uses the PR boundary only with explicit --pr (%s)", async pr => {
    const f = fixture(), remote = join(f.root, "..", "remote.git");
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    f.git("remote", "add", "origin", remote); f.git("push", "--quiet", "origin", "main");
    const p = prepareUpgrade(f.options, now), calls: string[][] = [];
    const gh = (_root: string, args: string[]) => { calls.push(args); if (args[1] === "view") throw new Error("No PR yet"); return "https://example.test/pull/1"; };
    const result = await runUpgrade(f.options, p.revision, { now, pr, gh });
    const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]).toString();
    expect(refs.includes(p.branch)).toBe(pr);
    expect(calls.length).toBe(pr ? 2 : 0);
    expect(result.pr).toBe(pr ? "https://example.test/pull/1" : undefined);
    if (pr) expect(calls[1]).toEqual(expect.arrayContaining(["--base", "main", "--head", p.branch]));
  });

  it("retries a failed PR creation from its recorded commit without importing again", async () => {
    const f = fixture(), remote = join(f.root, "..", "remote.git");
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    f.git("remote", "add", "origin", remote); f.git("push", "--quiet", "origin", "main");
    const p = prepareUpgrade(f.options, now);
    await expect(runUpgrade(f.options, p.revision, { now, pr: true, gh: () => { throw new Error("unavailable"); } })).rejects.toMatchObject({ code: "UPGRADE_PR" });
    expect(pendingUpgrade(f.options)?.step).toBe("committed");
    const commit = f.git("rev-parse", p.branch);
    const result = await finishUpgrade(f.options, { pr: true, gh: () => "https://example.test/pull/2" });
    expect(result.commit).toBe(commit); expect(result.pr).toBe("https://example.test/pull/2");
    expect(pendingUpgrade(f.options)).toBeUndefined();
  });
});
