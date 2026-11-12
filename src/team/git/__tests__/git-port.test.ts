import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GitPage, GitWorkingTreeEntry } from "../../contracts/git.js";
import {
  createRepositoryGitPort,
  requireCanonicalGitBranch,
} from "../git-port.js";

const repositories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("read-only repository GitPort", () => {
  it("reads repository state, effective identity, and NUL-delimited working-tree entries", async () => {
    const repository = createRepository();
    write(repository, "tracked.txt", "tracked\n");
    write(repository, "rename source.txt", `${Array.from({ length: 20 }, (_, index) => index).join("\n")}\n`);
    write(repository, "both.txt", "base\n");
    git(repository, ["add", "--", "."]);
    commit(repository, "initial");
    git(repository, ["branch", "upstream"]);
    git(repository, ["branch", "--set-upstream-to=upstream", "main"]);

    appendFileSync(join(repository, "tracked.txt"), "unstaged\n");
    write(repository, "both.txt", "base\nstaged\n");
    git(repository, ["add", "--", "both.txt"]);
    appendFileSync(join(repository, "both.txt"), "unstaged\n");
    git(repository, ["mv", "--", "rename source.txt", "renamed target.txt"]);
    write(repository, "untracked name.txt", "new\n");

    const observedAt = new Date("2026-08-23T00:00:00.000Z");
    const port = createRepositoryGitPort(repository, { now: () => observedAt });
    const [state, identity, workingTree] = await Promise.all([
      port.getRepoState(),
      port.getIdentity(),
      collectWorkingTree(port.getWorkingTree.bind(port), 2),
    ]);

    expect(state).toEqual({
      branch: "main",
      head: git(repository, ["rev-parse", "HEAD"]),
      dirty: true,
      observedAt: observedAt.toISOString(),
    });
    expect(identity).toEqual({ name: "MEX Test", email: "mex@example.test" });
    expect(workingTree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "both.txt",
          indexStatus: "modified",
          workingTreeStatus: "modified",
        }),
        expect.objectContaining({
          path: "tracked.txt",
          indexStatus: "unmodified",
          workingTreeStatus: "modified",
        }),
        expect.objectContaining({
          path: "renamed target.txt",
          previousPath: "rename source.txt",
          indexStatus: "renamed",
          workingTreeStatus: "unmodified",
        }),
        expect.objectContaining({
          path: "untracked name.txt",
          indexStatus: "unmodified",
          workingTreeStatus: "untracked",
        }),
      ]),
    );
  });

  it("accepts equivalent top-level roots when Git and Node preserve different casing", async () => {
    const repository = createRepository(true);
    const repositoryName = basename(repository);
    const alternateName = repositoryName.replace(/[A-Za-z]/u, (character) =>
      character === character.toUpperCase()
        ? character.toLowerCase()
        : character.toUpperCase(),
    );
    const alternateRoot = join(dirname(repository), alternateName);

    let requestedRoot: string;
    let reportedRoot: string;
    try {
      requestedRoot = realpathSync(alternateRoot);
      const reported = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        { cwd: requestedRoot, encoding: "utf8" },
      ).trim();
      reportedRoot = realpathSync(reported);
    } catch {
      // Case-sensitive or case-normalizing filesystems cannot expose this alias.
      return;
    }
    if (requestedRoot === reportedRoot) return;

    const requestedIdentity = statSync(requestedRoot, { bigint: true });
    const reportedIdentity = statSync(reportedRoot, { bigint: true });
    expect({
      device: requestedIdentity.dev,
      inode: requestedIdentity.ino,
      birthtimeNs: requestedIdentity.birthtimeNs,
    }).toEqual({
      device: reportedIdentity.dev,
      inode: reportedIdentity.ino,
      birthtimeNs: reportedIdentity.birthtimeNs,
    });

    await expect(createRepositoryGitPort(alternateRoot).getRepoState()).resolves.toMatchObject({
      branch: "main",
      dirty: false,
    });
  });

  it("supports detached and unborn repositories and rejects stale working-tree cursors", async () => {
    const unborn = createRepository(false);
    const unbornPort = createRepositoryGitPort(unborn);
    expect(await unbornPort.getRepoState()).toMatchObject({
      branch: "main",
      head: null,
      dirty: false,
    });
    expect(await unbornPort.getHistory()).toEqual({
      items: [],
      nextCursor: null,
      truncated: false,
    });

    const repository = createRepository();
    write(repository, "tracked.txt", "base\n");
    git(repository, ["add", "--", "tracked.txt"]);
    commit(repository, "initial");
    write(repository, "one.txt", "one\n");
    write(repository, "two.txt", "two\n");
    const port = createRepositoryGitPort(repository);
    const first = await port.getWorkingTree({ limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    write(repository, "three.txt", "three\n");
    await expect(
      port.getWorkingTree({ limit: 1, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });

    git(repository, ["checkout", "--detach", "-q"]);
    expect(await port.getRepoState()).toMatchObject({ branch: null });
  }, 20_000);

  it("accepts a canonical repository branch of exactly 1,024 UTF-8 bytes", () => {
    const branch = asciiBranchWithBytes(1_024);
    expect(requireCanonicalGitBranch(branch)).toBe(branch);
  });

  it("rejects a 1,025-byte repository branch with a safe typed failure", async () => {
    const branch = asciiBranchWithBytes(1_025);

    await expect(
      Promise.resolve().then(() => requireCanonicalGitBranch(branch)),
    ).rejects.toMatchObject({
      problem: {
        title: "Git read failed",
        status: 500,
        code: "INTERNAL_ERROR",
        detail: "Git returned malformed branch name data.",
      },
    });
  });

  it("rejects non-trimmed and control-bearing repository branches", () => {
    for (const branch of [" main", "main ", "feature/\u0001hidden", "feature/\u0085hidden"]) {
      expect(() => requireCanonicalGitBranch(branch)).toThrow(
        "Git returned malformed branch name data.",
      );
    }
  });

  it("accepts NFC repository branches and safely rejects decomposed Unicode", async () => {
    const canonicalRepository = createRepository();
    const canonicalBranch = "feature/caf\u00e9";
    expect(canonicalBranch.normalize("NFC")).toBe(canonicalBranch);
    writeFileSync(
      join(canonicalRepository, ".git", "HEAD"),
      `ref: refs/heads/${canonicalBranch}\n`,
      "utf8",
    );
    await expect(
      createRepositoryGitPort(canonicalRepository).getRepoState(),
    ).resolves.toMatchObject({ branch: canonicalBranch, head: null });

    const decomposedRepository = createRepository();
    const decomposedBranch = "feature/cafe\u0301";
    expect(decomposedBranch.normalize("NFC")).toBe(canonicalBranch);
    writeFileSync(
      join(decomposedRepository, ".git", "HEAD"),
      `ref: refs/heads/${decomposedBranch}\n`,
      "utf8",
    );
    await expect(
      createRepositoryGitPort(decomposedRepository).getRepoState(),
    ).rejects.toMatchObject({
      problem: {
        title: "Git read failed",
        status: 500,
        code: "INTERNAL_ERROR",
        detail: "Git returned malformed branch name data.",
      },
    });
  });

  it("separates staged and unstaged diffs, treats pathspec-looking names literally, and bounds output", async () => {
    const repository = createRepository();
    write(repository, "tracked.txt", "base\n");
    write(repository, "[glob].txt", "literal\n");
    write(repository, "g.txt", "glob match\n");
    // Windows filenames cannot contain ":", so the pathspec-magic name is POSIX-only.
    const magicName = process.platform === "win32" ? null : ":(glob).txt";
    if (magicName) write(repository, magicName, "magic literal\n");
    write(repository, "other.txt", "other\n");
    git(repository, ["add", "--", "."]);
    commit(repository, "initial");
    const base = git(repository, ["rev-parse", "HEAD"]);

    write(repository, "tracked.txt", "base\nstaged\n");
    git(repository, ["add", "--", "tracked.txt"]);
    appendFileSync(join(repository, "tracked.txt"), "unstaged\n");
    appendFileSync(join(repository, "[glob].txt"), "literal change\n");
    appendFileSync(join(repository, "g.txt"), "must not match glob\n");
    if (magicName) appendFileSync(join(repository, magicName), "magic literal change\n");
    appendFileSync(join(repository, "other.txt"), "must not match\n");
    const port = createRepositoryGitPort(repository);

    const staged = await port.getDiff({
      target: { kind: "working-tree", includeStaged: true, includeUnstaged: false },
      maxBytes: 64 * 1024,
    });
    expect(staged.diff).toContain("+staged");
    expect(staged.diff).not.toContain("+unstaged");

    const unstaged = await port.getDiff({
      target: { kind: "working-tree", includeStaged: false, includeUnstaged: true },
      paths: ["[glob].txt"],
      maxBytes: 64 * 1024,
    });
    expect(unstaged.diff).toContain("[glob].txt");
    expect(unstaged.diff).toContain("+literal change");
    expect(unstaged.diff).not.toContain("other.txt");
    expect(unstaged.diff).not.toContain("diff --git a/g.txt");

    if (magicName) {
      const magic = await port.getDiff({
        target: { kind: "working-tree", includeStaged: false, includeUnstaged: true },
        paths: [magicName],
        maxBytes: 64 * 1024,
      });
      expect(magic.diff).toContain(magicName);
      expect(magic.diff).toContain("+magic literal change");
      expect(magic.diff).not.toContain("+literal change\n");
      expect(magic.diff).not.toContain("other.txt");
    }

    const combined = await port.getDiff({
      target: { kind: "working-tree", includeStaged: true, includeUnstaged: true },
      paths: ["tracked.txt"],
      maxBytes: 64 * 1024,
    });
    expect(combined.diff).toContain("+staged");
    expect(combined.diff).toContain("+unstaged");

    git(repository, ["add", "--", "."]);
    commit(repository, "second");
    const head = git(repository, ["rev-parse", "HEAD"]);
    const range = await port.getDiff({
      target: { kind: "range", base, head },
      maxBytes: 40,
    });
    expect(range.bytes).toBeLessThanOrEqual(40);
    expect(range.truncated).toBe(true);
  }, 20_000);

  it("anchors history pagination to the first resolved revision", async () => {
    const repository = createRepository();
    write(repository, "history.txt", "one\n");
    git(repository, ["add", "--", "history.txt"]);
    commit(repository, "one");
    appendFileSync(join(repository, "history.txt"), "two\n");
    commit(repository, "two", true);
    appendFileSync(join(repository, "history.txt"), "three\n");
    commit(repository, "three", true);
    const port = createRepositoryGitPort(repository);

    const first = await port.getHistory({ limit: 2 });
    expect(first.items.map((item) => item.subject)).toEqual(["three", "two"]);
    expect(first.items[0]).toMatchObject({
      author: { name: "MEX Test", email: "mex@example.test" },
      committer: { name: "MEX Test", email: "mex@example.test" },
    });
    expect(first.nextCursor).not.toBeNull();

    appendFileSync(join(repository, "history.txt"), "four\n");
    commit(repository, "four", true);
    const second = await port.getHistory({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.subject)).toEqual(["one"]);
    expect(second.nextCursor).toBeNull();
  });

  it("reads bounded binary blobs at immutable revisions and reports missing paths", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3, 255]));
    git(repository, ["add", "--", "binary.dat"]);
    commit(repository, "binary");
    const head = git(repository, ["rev-parse", "HEAD"]);
    const port = createRepositoryGitPort(repository);

    expect(
      await port.readFileAtRevision({ revision: "HEAD", path: "binary.dat", maxBytes: 3 }),
    ).toEqual({ content: new Uint8Array([0, 1, 2]), bytes: 3, truncated: true });
    expect(
      await port.readFileAtRevision({ revision: head, path: "missing.txt", maxBytes: 10 }),
    ).toBeNull();
    await expect(
      port.readFileAtRevision({ revision: "HEAD", path: "../outside", maxBytes: 10 }),
    ).rejects.toMatchObject({ problem: { code: "PATH_OUTSIDE_PROJECT" } });
  });

  it("reports added, modified, deleted, and renamed files with stable pagination", async () => {
    const repository = createRepository();
    write(repository, "modify.txt", "before\n");
    write(repository, "delete.txt", "delete\n");
    write(repository, "rename.txt", `${Array.from({ length: 20 }, (_, index) => index).join("\n")}\n`);
    git(repository, ["add", "--", "."]);
    commit(repository, "base");
    const base = git(repository, ["rev-parse", "HEAD"]);

    write(repository, "modify.txt", "after\n");
    git(repository, ["rm", "--", "delete.txt"]);
    git(repository, ["mv", "--", "rename.txt", "renamed.txt"]);
    write(repository, "added.txt", "added\n");
    git(repository, ["add", "--", "."]);
    commit(repository, "changes");
    const head = git(repository, ["rev-parse", "HEAD"]);
    const port = createRepositoryGitPort(repository);

    const first = await port.getChangedFiles({ base, head: "HEAD", page: { limit: 2 } });
    const second = await port.getChangedFiles({
      base,
      head: "HEAD",
      page: { limit: 2, cursor: first.nextCursor! },
    });
    expect([...first.items, ...second.items]).toEqual(
      expect.arrayContaining([
        { path: "added.txt", status: "added" },
        { path: "delete.txt", status: "deleted" },
        { path: "modify.txt", status: "modified" },
        { path: "renamed.txt", previousPath: "rename.txt", status: "renamed" },
      ]),
    );

    const movingFirst = await port.getChangedFiles({
      base,
      head: "HEAD",
      page: { limit: 1 },
    });
    write(repository, "later.txt", "later\n");
    git(repository, ["add", "--", "later.txt"]);
    commit(repository, "later");
    await expect(
      port.getChangedFiles({
        base,
        head: "HEAD",
        page: { limit: 1, cursor: movingFirst.nextCursor! },
      }),
    ).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
  });

  it("rejects non-NFC, control-bearing, and overlong UTF-8 paths from callers and Git", async () => {
    const repository = createRepository();
    write(repository, "base.txt", "base\n");
    git(repository, ["add", "--", "base.txt"]);
    commit(repository, "base");
    const base = git(repository, ["rev-parse", "HEAD"]);
    const controlPath = "line\nbreak.txt";
    // Git trees can contain control-bearing names even when the host filesystem cannot.
    git(repository, ["config", "core.protectNTFS", "false"]);
    const controlBlob = git(repository, ["hash-object", "-w", "--stdin"], "control\n");
    git(repository, ["update-index", "--add", "--cacheinfo", `100644,${controlBlob},${controlPath}`]);
    const port = createRepositoryGitPort(repository);

    await expect(port.getWorkingTree()).rejects.toMatchObject({
      problem: { code: "INTERNAL_ERROR" },
    });
    commit(repository, "control path");
    await expect(port.getChangedFiles({ base, head: "HEAD" })).rejects.toMatchObject({
      problem: { code: "INTERNAL_ERROR" },
    });

    const decomposedPath = "cafe\u0301.txt";
    const decomposedBlob = git(
      repository,
      ["hash-object", "-w", "--stdin"],
      "decomposed\n",
    );
    const emptyTree = git(repository, ["mktree"], "");
    const decomposedTree = git(
      repository,
      ["mktree", "-z"],
      `100644 blob ${decomposedBlob}\t${decomposedPath}\0`,
    );
    const emptyCommit = git(repository, ["commit-tree", emptyTree, "-m", "empty"]);
    const decomposedCommit = git(repository, [
      "commit-tree",
      decomposedTree,
      "-p",
      emptyCommit,
      "-m",
      "decomposed path",
    ]);
    await expect(
      port.getChangedFiles({ base: emptyCommit, head: decomposedCommit }),
    ).rejects.toMatchObject({ problem: { code: "INTERNAL_ERROR" } });

    const overlongPath = `src/${"é".repeat(2_047)}`;
    await expect(
      port.getDiff({
        target: { kind: "working-tree", includeStaged: false, includeUnstaged: true },
        paths: [decomposedPath],
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ problem: { code: "PATH_OUTSIDE_PROJECT" } });
    await expect(
      port.readFileAtRevision({ revision: "HEAD", path: controlPath, maxBytes: 100 }),
    ).rejects.toMatchObject({ problem: { code: "PATH_OUTSIDE_PROJECT" } });
    await expect(port.getHistory({ paths: [overlongPath] })).rejects.toMatchObject({
      problem: { code: "PATH_OUTSIDE_PROJECT" },
    });
  });

  it("invalidates a cached adapter when its Git control file is retargeted", async () => {
    const repository = createRepository();
    write(repository, "tracked.txt", "primary\n");
    git(repository, ["add", "--", "tracked.txt"]);
    commit(repository, "primary");
    const other = createRepository(true);
    const external = mkdtempSync(join(tmpdir(), "mex-team-git-dir-"));
    repositories.push(external);
    const originalGitDirectory = join(external, "control");
    renameSync(join(repository, ".git"), originalGitDirectory);
    writeFileSync(join(repository, ".git"), `gitdir: ${originalGitDirectory}\n`, "utf8");
    const port = createRepositoryGitPort(repository);

    expect(await port.getRepoState()).toMatchObject({ branch: "main" });
    writeFileSync(join(repository, ".git"), `gitdir: ${join(other, ".git")}\n`, "utf8");
    await expect(port.getRepoState()).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
  }, 20_000);

  it("reports merge conflicts as unmerged without modifying conflict state", async () => {
    const repository = createRepository();
    write(repository, "conflict.txt", "base\n");
    write(repository, "tracked.txt", "stable\n");
    git(repository, ["add", "--", "conflict.txt", "tracked.txt"]);
    commit(repository, "base");
    git(repository, ["checkout", "-q", "-b", "side"]);
    write(repository, "conflict.txt", "side\n");
    commit(repository, "side", true);
    git(repository, ["checkout", "-q", "main"]);
    write(repository, "conflict.txt", "main\n");
    commit(repository, "main", true);
    expect(() => git(repository, ["merge", "--no-edit", "side"])).toThrow();
    const before = repositoryFingerprint(repository);
    const port = createRepositoryGitPort(repository);

    expect(await port.getWorkingTree()).toMatchObject({
      items: [
        {
          path: "conflict.txt",
          indexStatus: "unmerged",
          workingTreeStatus: "unmerged",
        },
      ],
    });
    expect(repositoryFingerprint(repository)).toEqual(before);
  }, 20_000);

  it("surfaces a dirty submodule in repository state and working-tree status", async () => {
    const submodule = createRepository();
    write(submodule, "module.txt", "base\n");
    git(submodule, ["add", "--", "module.txt"]);
    commit(submodule, "module base");
    const repository = createRepository();
    git(repository, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submodule,
      "modules/example",
    ]);
    git(repository, ["add", "--", ".gitmodules", "modules/example"]);
    commit(repository, "add submodule");
    appendFileSync(join(repository, "modules/example/module.txt"), "dirty\n");
    const port = createRepositoryGitPort(repository);

    expect(await port.getRepoState()).toMatchObject({ dirty: true });
    expect(await port.getWorkingTree()).toMatchObject({
      items: [
        expect.objectContaining({
          path: "modules/example",
          indexStatus: "unmodified",
          workingTreeStatus: "modified",
        }),
      ],
    });
  }, 20_000);

  it("resolves effective global and branch-conditional Git identity", async () => {
    const repository = createRepository();
    write(repository, "tracked.txt", "base\n");
    git(repository, ["add", "--", "tracked.txt"]);
    commit(repository, "base");
    git(repository, ["config", "--unset-all", "user.name"]);
    git(repository, ["config", "--unset-all", "user.email"]);
    const settings = mkdtempSync(join(tmpdir(), "mex-team-git-config-"));
    repositories.push(settings);
    const conditionalConfig = join(settings, "feature.config");
    const globalConfig = join(settings, "global.config");
    writeFileSync(
      conditionalConfig,
      "[user]\n\tname = Feature Person\n\temail = feature@example.test\n",
      "utf8",
    );
    writeFileSync(
      globalConfig,
      `[user]\n\tname = Global Person\n\temail = global@example.test\n[includeIf "onbranch:feature/**"]\n\tpath = ${conditionalConfig.replaceAll("\\", "/")}\n`,
      "utf8",
    );
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const port = createRepositoryGitPort(repository);
      expect(await port.getIdentity()).toEqual({
        name: "Global Person",
        email: "global@example.test",
      });
      git(repository, ["checkout", "-q", "-b", "feature/identity"]);
      expect(await port.getIdentity()).toEqual({
        name: "Feature Person",
        email: "feature@example.test",
      });
    } finally {
      restoreEnvironment("GIT_CONFIG_GLOBAL", previousGlobalConfig);
    }
  });

  it("returns only coherent changed-file snapshots while HEAD moves", async () => {
    const repository = createRepository();
    const emptyTree = git(repository, ["mktree"], "");
    const base = git(repository, ["commit-tree", emptyTree, "-m", "base"]);
    const aBlob = git(repository, ["hash-object", "-w", "--stdin"], "a\n");
    const bBlob = git(repository, ["hash-object", "-w", "--stdin"], "b\n");
    const aTree = git(repository, ["mktree"], `100644 blob ${aBlob}\ta.txt\n`);
    const bTree = git(repository, ["mktree"], `100644 blob ${bBlob}\tb.txt\n`);
    const aCommit = git(repository, ["commit-tree", aTree, "-p", base, "-m", "a"]);
    const bCommit = git(repository, ["commit-tree", bTree, "-p", base, "-m", "b"]);
    git(repository, ["update-ref", "refs/heads/main", aCommit]);
    const port = createRepositoryGitPort(repository);
    let racing = true;
    let moves = 0;
    const racer = (async () => {
      let target = bCommit;
      while (racing) {
        await gitAsync(repository, ["update-ref", "refs/heads/main", target]);
        moves += 1;
        target = target === aCommit ? bCommit : aCommit;
      }
    })();

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const page = await port.getChangedFiles({ base, head: "HEAD" });
        expect([
          JSON.stringify([{ path: "a.txt", status: "added" }]),
          JSON.stringify([{ path: "b.txt", status: "added" }]),
        ]).toContain(JSON.stringify(page.items));
      }
    } finally {
      racing = false;
      await racer;
    }
    expect(moves).toBeGreaterThan(0);
  }, 20_000);

  it("terminates a Git read when its configured deadline expires", async () => {
    const repository = createRepository(true);
    const port = createRepositoryGitPort(repository, { timeoutMs: 1 });
    await expect(port.getRepoState()).rejects.toMatchObject({
      problem: {
        code: "INTERNAL_ERROR",
        detail: expect.stringContaining("Timed out"),
      },
    });
  });

  it("rejects unsafe refs, invalid bounds, and repository subdirectories", async () => {
    const repository = createRepository();
    write(repository, "tracked.txt", "tracked\n");
    git(repository, ["add", "--", "tracked.txt"]);
    commit(repository, "initial");
    mkdirSync(join(repository, "nested"));
    const port = createRepositoryGitPort(repository);

    await expect(port.resolveRevision("--help")).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    await expect(port.resolveRevision("HEAD:tracked.txt")).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    await expect(port.getHistory({ limit: 201 })).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    await expect(
      port.getDiff({
        target: { kind: "range", base: "HEAD", head: "HEAD" },
        maxBytes: 0,
      }),
    ).rejects.toMatchObject({ problem: { code: "INVALID_REQUEST" } });
    await expect(createRepositoryGitPort(join(repository, "nested")).getRepoState()).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
  });

  it("does not change HEAD, index bytes, or working-tree state while serving reads", async () => {
    const repository = createRepository();
    write(repository, "tracked.txt", "base\n");
    git(repository, ["add", "--", "tracked.txt"]);
    commit(repository, "initial");
    appendFileSync(join(repository, "tracked.txt"), "working\n");
    write(repository, "untracked.txt", "untracked\n");
    const before = repositoryFingerprint(repository);
    const port = createRepositoryGitPort(repository);

    const redirect = createRepository(true);
    const tracePath = join(repository, "git-trace.log");
    const previousGitDir = process.env.GIT_DIR;
    const previousGitTrace = process.env.GIT_TRACE;
    process.env.GIT_DIR = join(redirect, ".git");
    process.env.GIT_TRACE = tracePath;
    try {
      await port.getRepoState();
      await port.getIdentity();
      await port.getWorkingTree();
      await port.resolveRevision("HEAD");
      await port.getDiff({
        target: { kind: "working-tree", includeStaged: true, includeUnstaged: true },
        maxBytes: 64 * 1024,
      });
      await port.getHistory();
      await port.readFileAtRevision({ revision: "HEAD", path: "tracked.txt", maxBytes: 64 });
      await port.getChangedFiles({ base: "HEAD", head: "HEAD" });
    } finally {
      restoreEnvironment("GIT_DIR", previousGitDir);
      restoreEnvironment("GIT_TRACE", previousGitTrace);
    }

    expect(repositoryFingerprint(repository)).toEqual(before);
    expect(existsSync(tracePath)).toBe(false);
  }, 20_000);
});

function createRepository(withInitialCommit = false): string {
  const repository = mkdtempSync(join(tmpdir(), "mex-team-git-"));
  repositories.push(repository);
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.name", "MEX Test"]);
  git(repository, ["config", "user.email", "mex@example.test"]);
  if (withInitialCommit) {
    commit(repository, "empty", false, true);
  }
  return repository;
}

function asciiBranchWithBytes(bytes: 1_024 | 1_025): string {
  const directoryPrefix = `${"a".repeat(200)}/`.repeat(5);
  const branch = `${directoryPrefix}${"b".repeat(bytes - Buffer.byteLength(directoryPrefix))}`;
  if (Buffer.byteLength(branch, "utf8") !== bytes) {
    throw new Error("Failed to construct the requested test branch length.");
  }
  return branch;
}

function write(repository: string, path: string, content: string): void {
  const segments = path.split("/");
  if (segments.length > 1) {
    mkdirSync(join(repository, ...segments.slice(0, -1)), { recursive: true });
  }
  writeFileSync(join(repository, path), content, "utf8");
}

function commit(
  repository: string,
  subject: string,
  all = false,
  allowEmpty = false,
): void {
  git(repository, [
    "commit",
    "-q",
    ...(all ? ["-a"] : []),
    ...(allowEmpty ? ["--allow-empty"] : []),
    "-m",
    subject,
  ]);
}

function git(
  repository: string,
  arguments_: readonly string[],
  input?: string | Buffer,
): string {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).replace(/\r?\n$/u, "");
}

async function gitAsync(repository: string, arguments_: readonly string[]): Promise<void> {
  await execFileAsync("git", [...arguments_], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
}

async function collectWorkingTree(
  read: (page: { limit: number; cursor?: string }) => Promise<GitPage<GitWorkingTreeEntry>>,
  limit: number,
): Promise<readonly GitWorkingTreeEntry[]> {
  const entries: GitWorkingTreeEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await read({ limit, ...(cursor === undefined ? {} : { cursor }) });
    entries.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return entries;
}

function repositoryFingerprint(repository: string): {
  readonly head: string;
  readonly index: Buffer;
  readonly status: Buffer;
  readonly tracked: Buffer;
} {
  return {
    head: git(repository, ["rev-parse", "HEAD"]),
    index: readFileSync(join(repository, ".git", "index")),
    status: execFileSync(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      {
        cwd: repository,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
    ),
    tracked: readFileSync(join(repository, "tracked.txt")),
  };
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
