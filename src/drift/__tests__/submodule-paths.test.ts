import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractClaims } from "../claims.js";
import { checkPaths } from "../checkers/path.js";
import { RepositoryInventory } from "../repository.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Mex Test",
  GIT_AUTHOR_EMAIL: "mex-test@example.com",
  GIT_COMMITTER_NAME: "Mex Test",
  GIT_COMMITTER_EMAIL: "mex-test@example.com",
};

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}

function commitFile(cwd: string, relative: string, contents: string) {
  const target = join(cwd, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
  git(cwd, ["add", "--", relative]);
  git(cwd, ["commit", "-q", "-m", `add ${relative}`]);
}

describe("paths inside git submodules", () => {
  it("does not report a file that exists in a checked-out submodule", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-sub-"));
    const child = join(root, "child");
    const parent = join(root, "parent");
    mkdirSync(child);
    mkdirSync(parent);
    git(child, ["init", "-q"]);
    commitFile(child, "script.sh", "echo ok\n");
    commitFile(child, "dir/run.sh", "echo run\n");
    git(parent, ["init", "-q"]);
    commitFile(parent, "README.md", "# parent\n");
    git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "--", child, "sub-a"]);

    const inventory = new RepositoryInventory(parent);
    expect(inventory.files).toEqual(expect.arrayContaining(["sub-a/script.sh", "sub-a/dir/run.sh"]));

    const scaffoldRoot = join(parent, ".mex");
    mkdirSync(scaffoldRoot);
    const docPath = join(scaffoldRoot, "ROUTER.md");
    writeFileSync(
      docPath,
      "# Stack\n\n`script.sh` starts the service and `dir/run.sh` follows.\n",
    );
    const claims = extractClaims(docPath, ".mex/ROUTER.md");
    const missing = checkPaths(claims, parent, scaffoldRoot, inventory)
      .filter((issue) => issue.code === "MISSING_PATH")
      .map((issue) => issue.claim?.value);
    expect(missing).toEqual([]);
  });
});
