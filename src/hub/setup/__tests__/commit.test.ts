import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupCommitPreviewSchema, SetupCommitResultSchema } from "@mex/hub-contracts/setup";

const faults = vi.hoisted(() => ({
  beforeRename: null as null | ((from: string, to: string) => void),
  beforeGit: null as null | ((args: string[], cwd: string) => void),
  losePublishAck: false,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: unknown[]) => {
    faults.beforeGit?.(args[1] as string[], (args[2] as { cwd: string }).cwd);
    const child = Reflect.apply(actual.execFile, undefined, args) as ReturnType<typeof actual.execFile>;
    if (faults.losePublishAck && (args[1] as string[]).includes("update-ref") && (args[1] as string[]).includes("--stdin") && child.stdout) {
      const on = child.stdout.on.bind(child.stdout);
      child.stdout.on = ((event: string, listener: (...values: unknown[]) => void) => event === "data"
        ? on(event, (chunk: Buffer | string) => listener(chunk.toString().replace("commit: ok\n", "")))
        : on(event, listener)) as typeof child.stdout.on;
    }
    return child;
  } };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: async (from: string, to: string) => { faults.beforeRename?.(from, to); return actual.rename(from, to); } };
});
import { SetupCommitService } from "../commit.js";

const fixtures: string[] = [];
afterEach(() => {
  faults.beforeRename = null;
  faults.beforeGit = null;
  faults.losePublishAck = false;
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"] });
}
function write(root: string, path: string, contents: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}
function fixture(unborn = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-setup-commit-test-")));
  fixtures.push(root);
  git(root, "init", "-b", "setup-test");
  git(root, "config", "user.name", "Setup Test");
  git(root, "config", "user.email", "setup@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.hooksPath", ".git/hooks");
  if (!unborn) {
    write(root, "README.md", "Original readme\n");
    write(root, "src/app.ts", "export const version = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "Initial project");
  }
  return root;
}
function setup(root: string): void {
  write(root, ".mex/config.json", '{"scaffold_id":"test-scaffold"}\n');
  write(root, ".mex/.gitignore", "local/\ngraph.db*\nwiki.db*\n");
  write(root, ".mex/ROUTER.md", "# Router\nRead the architecture first.\n");
  write(root, ".mex/context/architecture.md", "# Architecture\nThis application serves a local UI.\n");
  write(root, ".mex/patterns/example.md", "# Pattern\nUse bounded operations.\n");
}
async function review(root: string, tools: ("claude" | "codex" | "cursor" | "copilot" | "windsurf" | "opencode")[] = []) {
  const service = new SetupCommitService({ projectRoot: root });
  const preview = SetupCommitPreviewSchema.parse(await service.preview(tools));
  expect(preview.blockedReason).toBeNull();
  expect(preview.canCommit).toBe(true);
  return { service, preview };
}

describe("reviewed setup commits using real Git", () => {
  it("commits only reviewed setup files and preserves distinct unrelated staged and working bytes", async () => {
    const root = fixture();
    const before = git(root, "rev-parse", "HEAD").trim();
    write(root, "README.md", "Staged readme\n");
    write(root, "src/app.ts", "export const version = 2;\n");
    git(root, "add", "README.md", "src/app.ts");
    const stagedBefore = git(root, "ls-files", "--stage", "--", "README.md", "src/app.ts");
    write(root, "README.md", "Unstaged readme\n");
    write(root, "src/app.ts", "export const version = 3;\n");
    setup(root);
    write(root, "AGENTS.md", "# Instructions\nRead MEX.\n");
    const { service, preview } = await review(root, ["codex"]);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(root, "ls-files", "--stage", "--", "README.md", "src/app.ts")).toBe(stagedBefore);
    expect(preview.files.map((file) => file.path)).toContain("AGENTS.md");
    const result = SetupCommitResultSchema.parse(await service.commit({ revision: preview.revision, message: "  Initialize MEX  " }));
    expect(git(root, "show", "-s", "--format=%B", result.commit).trim()).toBe("Initialize MEX");
    expect(git(root, "rev-parse", "HEAD^").trim()).toBe(before);
    expect(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit).trim().split("\n")).toEqual(result.files);
    expect(git(root, "ls-files", "--stage", "--", "README.md", "src/app.ts")).toBe(stagedBefore);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("Unstaged readme\n");
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe("export const version = 3;\n");
    expect(git(root, "diff", "--name-only", "--", ".mex", "AGENTS.md")).toBe("");
    expect(git(root, "diff", "--cached", "--name-only").trim().split("\n")).toEqual(["README.md", "src/app.ts"]);
    expect(await service.commit({ revision: preview.revision, message: "Initialize MEX" })).toEqual(result);
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
    await service.shutdown();
  });

  it("excludes local data, team records, arbitrary files, root ignore and unselected tool assets", async () => {
    const root = fixture();
    setup(root);
    for (const path of [".mex/local/secrets.md", ".mex/graph.db", ".mex/wiki.db-wal", ".mex/team/proposal.md", ".mex/activity.jsonl", ".gitignore", "private.txt", "CLAUDE.md", ".claude/skills/mex-inbox/SKILL.md", ".agents/skills/other/SKILL.md"]) write(root, path, "Private bytes\n");
    write(root, "AGENTS.md", "Codex instructions\n");
    write(root, ".agents/skills/mex-inbox/SKILL.md", "Inbox skill\n");
    write(root, ".agents/skills/mex-inbox/.mex-managed.json", "{}\n");
    write(root, ".agents/skills/mex-statechart/SKILL.md", "Statechart skill\n");
    write(root, ".agents/skills/mex-statechart/scripts/runtime.mjs", "export const helper = true;\n");
    const { service, preview } = await review(root, ["codex"]);
    expect(preview.files.map((file) => file.path)).toEqual([
      ".agents/skills/mex-inbox/.mex-managed.json", ".agents/skills/mex-inbox/SKILL.md",
      ".agents/skills/mex-statechart/SKILL.md", ".agents/skills/mex-statechart/scripts/runtime.mjs",
      ".mex/.gitignore", ".mex/ROUTER.md", ".mex/config.json", ".mex/context/architecture.md", ".mex/patterns/example.md", "AGENTS.md",
    ]);
    const result = await service.commit({ revision: preview.revision, message: "Setup" });
    expect(git(root, "ls-tree", "-r", "--name-only", result.commit)).not.toMatch(/Private|team|local|\.db|CLAUDE|private|other/);
  });

  it.each(["file", "index", "head", "branch", "config", "attributes", "hooks"])("rejects a stale %s before committing or changing staging", async (change) => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    if (change === "file") write(root, ".mex/config.json", '{"scaffold_id":"changed"}\n');
    if (change === "index") { write(root, "README.md", "new staged\n"); git(root, "add", "README.md"); }
    if (change === "head") git(root, "commit", "--allow-empty", "-m", "Concurrent commit");
    if (change === "branch") git(root, "switch", "-c", "another-branch");
    if (change === "config") git(root, "config", "user.name", "Changed identity");
    if (change === "attributes") write(root, ".gitattributes", ".mex/** text eol=lf\n");
    if (change === "hooks") { write(root, ".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n"); chmodSync(join(root, ".git/hooks/pre-commit"), 0o755); }
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git/index"));
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow(/changed|hooks/u);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });

  it("expires previews, replaces old reviews and rejects changes to the returned preview", async () => {
    const root = fixture();
    setup(root);
    let time = Date.now();
    const service = new SetupCommitService({ projectRoot: root, now: () => new Date(time) });
    const first = await service.preview([]);
    first.files[0]!.additions = 999;
    const second = await service.preview([]);
    await expect(service.commit({ revision: first.revision, message: "Setup" })).rejects.toThrow("Review the latest diff");
    time += 5 * 60_000;
    await expect(service.commit({ revision: second.revision, message: "Setup" })).rejects.toThrow("expired");
  });

  it("creates an initial commit without accidentally including pre-staged unrelated files", async () => {
    const root = fixture(true);
    write(root, "README.md", "Pre-staged project\n");
    git(root, "add", "README.md");
    setup(root);
    const { service, preview } = await review(root);
    expect(preview.head).toBeNull();
    const result = await service.commit({ revision: preview.revision, message: "Initial MEX" });
    expect(git(root, "ls-tree", "-r", "--name-only", result.commit)).not.toContain("README.md");
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("README.md");
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("reviews modified/deleted files against exact normalized Git blobs with CRLF attributes", async () => {
    const root = fixture();
    write(root, ".gitattributes", ".mex/** text eol=lf\n");
    setup(root);
    git(root, "add", ".gitattributes", ".mex");
    git(root, "commit", "-m", "Old setup");
    write(root, ".mex/context/architecture.md", "# Architecture\r\nUpdated with CRLF.\r\n");
    rmSync(join(root, ".mex/patterns/example.md"));
    const { service, preview } = await review(root);
    expect(preview.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: ".mex/context/architecture.md", status: "modified" }, { path: ".mex/patterns/example.md", status: "deleted" },
    ]);
    const { diff } = service.diff({ revision: preview.revision, path: ".mex/context/architecture.md" });
    expect(diff).toContain("+Updated with CRLF.\n");
    expect(diff).not.toContain("\r");
    expect(preview.files[0]).toMatchObject({ additions: 1, deletions: 1, diffCharacters: diff.length });
    const result = await service.commit({ revision: preview.revision, message: "Update setup" });
    expect(git(root, "show", `${result.commit}:.mex/context/architecture.md`)).toBe("# Architecture\nUpdated with CRLF.\n");
    expect(readFileSync(join(root, ".mex/context/architecture.md"), "utf8")).toContain("\r\n");
  });

  it("blocks executable hooks at a relative custom hooksPath, while sample files remain harmless", async () => {
    const root = fixture();
    setup(root);
    git(root, "config", "core.hooksPath", ".custom-hooks");
    write(root, ".custom-hooks/pre-commit.sample", "#!/bin/sh\nexit 1\n");
    chmodSync(join(root, ".custom-hooks/pre-commit.sample"), 0o755);
    const service = new SetupCommitService({ projectRoot: root });
    expect((await service.preview([])).canCommit).toBe(true);
    write(root, ".custom-hooks/reference-transaction", "#!/bin/sh\nexit 1\n");
    chmodSync(join(root, ".custom-hooks/reference-transaction"), 0o755);
    expect(await service.preview([])).toMatchObject({ canCommit: false, blockedReason: expect.stringContaining("hooks") });
  });

  it("blocks custom clean filters before executing them", async () => {
    const root = fixture();
    setup(root);
    write(root, ".gitattributes", ".mex/** filter=private\n");
    git(root, "config", "filter.private.clean", "touch filter-was-run; cat");
    const service = new SetupCommitService({ projectRoot: root });
    expect(await service.preview([])).toMatchObject({ canCommit: false, blockedReason: expect.stringContaining("filter") });
    expect(existsSync(join(root, "filter-was-run"))).toBe(false);
  });

  it("preserves staged bytes when signing fails and requires a fresh review", async () => {
    const root = fixture();
    setup(root);
    git(root, "config", "commit.gpgsign", "true");
    git(root, "config", "gpg.program", "mex-no-such-signing-program");
    const { service, preview } = await review(root);
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git/index"));
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("signing");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("Review the latest diff");
  });

  it("atomically rolls back its own commit if installing the preserved index fails", async () => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    const head = git(root, "rev-parse", "HEAD");
    const index = readFileSync(join(root, ".git/index"));
    faults.beforeRename = (_from, to) => { if (to === join(root, ".git/index")) throw new Error("injected failure"); };
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("manually");
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });

  it("returns a retry-safe success receipt if a concurrent ref change prevents post-commit recovery", async () => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    let setupCommit = "";
    let newerCommit = "";
    faults.beforeRename = (_from, to) => {
      if (to !== join(root, ".git/index")) return;
      setupCommit = git(root, "rev-parse", "HEAD").trim();
      const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
      newerCommit = git(root, "commit-tree", tree, "-p", setupCommit, "-m", "Concurrent descendant").trim();
      git(root, "update-ref", "HEAD", newerCommit, setupCommit);
      throw new Error("injected failure after concurrent commit");
    };
    const result = await service.commit({ revision: preview.revision, message: "Setup" });
    expect(result.commit).toBe(setupCommit);
    expect(result.message).toContain("index.lock recovery");
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(newerCommit);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(true);
    expect(await service.commit({ revision: preview.revision, message: "Setup" })).toEqual(result);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(newerCommit);
    expect(result.recoveryRequired).toBe(true);
    await expect(service.verifyRecovery()).rejects.toThrow("recovery is still pending");
    rmSync(join(root, ".git/index.lock"));
    await expect(service.verifyRecovery()).rejects.toThrow("still differ");
    git(root, "reset", "HEAD", "--", ...result.files);
    await expect(service.verifyRecovery()).resolves.toBeUndefined();
    expect((await service.commit({ revision: preview.revision, message: "Setup" })).recoveryRequired).toBeUndefined();
  });

  it("works with linked Git worktrees and preserves staging there", async () => {
    const main = fixture();
    const worktree = join(realpathSync(tmpdir()), `mex-setup-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fixtures.push(worktree);
    git(main, "worktree", "add", "-b", "setup-worktree", worktree);
    // The fixture's deliberately relative custom hook config resolves from each worktree root.
    setup(worktree);
    write(worktree, "README.md", "staged in worktree\n");
    git(worktree, "add", "README.md");
    const staged = git(worktree, "ls-files", "--stage", "--", "README.md");
    const { service, preview } = await review(worktree);
    const result = await service.commit({ revision: preview.revision, message: "Setup worktree" });
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(result.commit);
    expect(git(worktree, "ls-files", "--stage", "--", "README.md")).toBe(staged);
    expect(git(main, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("preserves unrelated index entries and intent-to-add flags from a split index", async () => {
    const root = fixture();
    setup(root);
    write(root, "README.md", "Staged readme\n");
    git(root, "add", "README.md");
    write(root, "new-source.ts", "export const newFile = true;\n");
    git(root, "add", "--intent-to-add", "new-source.ts");
    git(root, "update-index", "--split-index");
    const entries = git(root, "ls-files", "--stage", "--", "README.md", "new-source.ts");
    const intent = git(root, "ls-files", "--debug", "--", "new-source.ts");
    const { service, preview } = await review(root);
    await service.commit({ revision: preview.revision, message: "Setup with split index" });
    expect(git(root, "ls-files", "--stage", "--", "README.md", "new-source.ts")).toBe(entries);
    expect(git(root, "ls-files", "--debug", "--", "new-source.ts")).toBe(intent);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("README.md");
  });

  it("does not publish over a ref advanced during commit object creation", async () => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    const index = readFileSync(join(root, ".git/index"));
    let concurrent = "";
    faults.beforeGit = (args) => {
      if (!args.includes("commit-tree")) return;
      faults.beforeGit = null;
      const head = git(root, "rev-parse", "HEAD").trim();
      concurrent = git(root, "commit-tree", git(root, "rev-parse", "HEAD^{tree}").trim(), "-p", head, "-m", "Concurrent commit").trim();
      git(root, "update-ref", "HEAD", concurrent, head);
    };
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("changed");
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(concurrent);
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });

  it("aborts publication if HEAD switches to a same-oid branch immediately before prepare", async () => {
    const root = fixture();
    setup(root);
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "branch", "other-branch");
    const { service, preview } = await review(root);
    const index = readFileSync(join(root, ".git/index"));
    faults.beforeGit = (args) => {
      if (!args.includes("update-ref") || !args.includes("--stdin")) return;
      faults.beforeGit = null;
      git(root, "symbolic-ref", "HEAD", "refs/heads/other-branch");
    };
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("changed");
    expect(git(root, "rev-parse", "setup-test").trim()).toBe(head);
    expect(git(root, "rev-parse", "other-branch").trim()).toBe(head);
    expect(git(root, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/other-branch");
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, ".git/HEAD.lock"))).toBe(false);
    expect(existsSync(join(root, ".git/refs/heads/other-branch.lock"))).toBe(false);
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
  });

  it("holds Git's HEAD lock while verifying the prepared transaction", async () => {
    const root = fixture();
    setup(root);
    git(root, "branch", "other-branch");
    const { service, preview } = await review(root);
    let preparing = false;
    let attempted = false;
    faults.beforeGit = (args) => {
      if (args.includes("update-ref") && args.includes("--stdin")) preparing = true;
      else if (preparing && args.includes("--show-toplevel")) {
        faults.beforeGit = null;
        attempted = true;
        expect(() => git(root, "symbolic-ref", "HEAD", "refs/heads/other-branch")).toThrow();
      }
    };
    const result = await service.commit({ revision: preview.revision, message: "Setup" });
    expect(attempted).toBe(true);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(result.commit);
    expect(git(root, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/setup-test");
  });

  it("retains explicit Git author/committer and config-location environment settings", async () => {
    const root = fixture();
    setup(root);
    vi.stubEnv("GIT_AUTHOR_NAME", "Explicit Author");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "author@example.invalid");
    vi.stubEnv("GIT_COMMITTER_NAME", "Explicit Committer");
    vi.stubEnv("GIT_COMMITTER_EMAIL", "committer@example.invalid");
    const config = join(root, "external-git-config");
    writeFileSync(config, "[user]\n  name = External User\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    const { service, preview } = await review(root);
    const result = await service.commit({ revision: preview.revision, message: "Setup" });
    expect(git(root, "show", "-s", "--format=%an <%ae> %cn <%ce>", result.commit).trim()).toBe("Explicit Author <author@example.invalid> Explicit Committer <committer@example.invalid>");
    const next = await service.preview([]);
    expect(next.canCommit).toBe(false);
  });

  it("never removes an index lock owned by another Git operation", async () => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    write(root, ".git/index.lock", "Another operation owns this lock\n");
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("Git is busy");
    expect(readFileSync(join(root, ".git/index.lock"), "utf8")).toBe("Another operation owns this lock\n");
  });

  it("reconciles the exact published ref when Git's commit acknowledgement is lost", async () => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    faults.losePublishAck = true;
    const result = await service.commit({ revision: preview.revision, message: "Setup" });
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(result.commit);
    expect(result.recoveryRequired).toBeUndefined();
    expect(git(root, "diff", "--cached", "--name-only")).toBe("");
    expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
    expect(await service.commit({ revision: preview.revision, message: "Setup" })).toEqual(result);
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("retains the prepared recovery index if acknowledgement and publication readback are unavailable", async () => {
    const root = fixture();
    setup(root);
    const { service, preview } = await review(root);
    const originalIndex = readFileSync(join(root, ".git/index"));
    faults.losePublishAck = true;
    faults.beforeGit = (args) => {
      if (args.includes("rev-parse") && args.includes("refs/heads/setup-test")) throw new Error("injected readback failure");
    };
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("index.lock recovery file was retained");
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(readFileSync(join(root, ".git/index"))).toEqual(originalIndex);
    expect(readFileSync(join(root, ".git/index.lock")).length).toBeGreaterThan(0);
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("Review the latest diff");
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it.each(["review", "commit"])("enforces one overall %s deadline before starting subsequent Git work", async (operation) => {
    const root = fixture();
    setup(root);
    const service = new SetupCommitService({ projectRoot: root });
    const preview = operation === "commit" ? await service.preview([]) : null;
    const originalNow = Date.now();
    faults.beforeGit = (args) => {
      if (operation === "commit" && !args.includes("commit-tree")) return;
      faults.beforeGit = null;
      vi.spyOn(Date, "now").mockReturnValue(originalNow + (operation === "review" ? 60_001 : 120_001));
    };
    if (operation === "review") {
      expect(await service.preview([])).toMatchObject({ canCommit: false, blockedReason: expect.stringContaining("time limit") });
    } else {
      await expect(service.commit({ revision: preview!.revision, message: "Setup" })).rejects.toThrow("time limit");
      expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");
      expect(existsSync(join(root, ".git/index.lock"))).toBe(false);
    }
  });

  it.each(["large", "binary", "symlink", "directory", "many", "truncated", "merge"])("blocks unsupported %s setup changes without mutating Git", async (kind) => {
    const root = fixture();
    setup(root);
    if (kind === "large") write(root, ".mex/context/large.md", "x".repeat(262_145));
    if (kind === "binary") write(root, ".mex/context/binary.md", Buffer.from([1, 0, 255]));
    if (kind === "symlink") symlinkSync(join(root, "README.md"), join(root, ".mex/context/link.md"));
    if (kind === "directory") mkdirSync(join(root, ".mex/context/directory.md"));
    if (kind === "many") for (let index = 0; index < 201; index++) write(root, `.mex/context/${index}.md`, "a\n");
    // Under the 256 KiB file limit, but its diff exceeds one file's 128 Ki-character review.
    if (kind === "truncated") write(root, ".mex/context/long.md", "This is a long line in a large review.\n".repeat(5_000));
    if (kind === "merge") write(root, ".git/MERGE_HEAD", git(root, "rev-parse", "HEAD"));
    const index = readFileSync(join(root, ".git/index"));
    const service = new SetupCommitService({ projectRoot: root });
    const preview = SetupCommitPreviewSchema.parse(await service.preview([]));
    if (kind === "directory") {
      // Git does not version empty directories, so there is no hidden file to commit.
      expect(preview.canCommit).toBe(true);
    } else {
      expect(preview.canCommit).toBe(false);
      expect(preview.blockedReason).not.toBeNull();
    }
    if (kind === "truncated") expect(preview.files.some((file) => file.truncated)).toBe(true);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
  });

  it("commits a populated-size review whose diffs are served one file at a time", async () => {
    const root = fixture();
    setup(root);
    // Larger in total than the former 128 Ki-character inline preview, as a real populated scaffold is.
    for (let index = 0; index < 3; index++) {
      write(root, `.mex/context/topic-${index}.md`, `# Topic ${index}\n${"Documented project behavior.\n".repeat(1_800)}`);
    }
    const { service, preview } = await review(root);
    expect(preview.files.reduce((total, file) => total + file.diffCharacters, 0)).toBeGreaterThan(131_072);
    expect(JSON.stringify(preview)).not.toContain("Documented project behavior");
    const topic = preview.files.find((file) => file.path === ".mex/context/topic-2.md")!;
    expect(topic).toMatchObject({ status: "added", additions: 1_801, deletions: 0, truncated: false });
    const diff = service.diff({ revision: preview.revision, path: topic.path });
    expect(diff).toMatchObject({ revision: preview.revision, path: topic.path, truncated: false });
    expect(diff.diff).toHaveLength(topic.diffCharacters);
    expect(diff.diff).toContain("+# Topic 2\n");
    const result = await service.commit({ revision: preview.revision, message: "Setup" });
    expect(result.files).toHaveLength(preview.files.length);
  }, 60_000);

  it("serves diffs only for the current review, including a blocked one, and never authorizes it", async () => {
    const root = fixture();
    setup(root);
    write(root, ".mex/context/long.md", "This is a long line in a large review.\n".repeat(5_000));
    let time = Date.now();
    const service = new SetupCommitService({ projectRoot: root, now: () => new Date(time) });
    const blockedReview = await service.preview([]);
    expect(blockedReview.canCommit).toBe(false);
    const long = service.diff({ revision: blockedReview.revision, path: ".mex/context/long.md" });
    expect(long.truncated).toBe(true);
    expect(long.diff.length).toBeLessThanOrEqual(131_072);
    await expect(service.commit({ revision: blockedReview.revision, message: "Setup" })).rejects.toThrow("Review the latest diff");
    expect(git(root, "rev-list", "--count", "HEAD").trim()).toBe("1");

    rmSync(join(root, ".mex/context/long.md"));
    const current = await service.preview([]);
    expect(() => service.diff({ revision: blockedReview.revision, path: ".mex/ROUTER.md" })).toThrow("Review the latest diff");
    expect(() => service.diff({ revision: current.revision, path: "README.md" })).toThrow("not part of the current setup review");
    time += 5 * 60_000;
    expect(() => service.diff({ revision: current.revision, path: ".mex/ROUTER.md" })).toThrow("expired");
  }, 60_000);

  it("serializes operations, clears pending authorization and shuts down without mutation", async () => {
    const root = fixture();
    setup(root);
    const service = new SetupCommitService({ projectRoot: root });
    const pending = service.preview([]);
    await expect(service.preview([])).rejects.toThrow("Wait for the current");
    const preview = await pending;
    service.clear();
    await expect(service.commit({ revision: preview.revision, message: "Setup" })).rejects.toThrow("Review the latest diff");
    await service.shutdown();
    await expect(service.preview([])).rejects.toThrow("closed");
  });
});
