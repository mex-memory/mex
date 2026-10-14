import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupError } from "../errors.js";
import {
  ensureSetupIgnoreProtection,
  renderSetupIgnoreProtection,
  SetupIgnoreProtectionError,
  verifySetupIgnoreProtection,
} from "../ignore.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
    lstatSync: vi.fn(actual.lstatSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const roots: string[] = [];

afterEach(() => {
  for (const mocked of [appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync, spawnSync]) {
    vi.mocked(mocked).mockReset();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("setup local-data ignore protection", () => {
  it("creates .mex/.gitignore with all required rules", () => {
    const root = fixture();

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result).toEqual({
      path: ".mex/.gitignore",
      action: "create",
      dryRun: false,
      applied: true,
      changed: true,
      addedRules: ["graph.db*", "wiki.db*", "local/"],
    });
    expect(readIgnore(root)).toBe("graph.db*\nwiki.db*\nlocal/\n");
    expect(renderSetupIgnoreProtection(result)).toBe(
      "Created .mex/.gitignore with graph.db*, wiki.db*, local/",
    );
  });

  it("preserves existing content and appends only missing rules", () => {
    const root = fixtureWithMex();
    writeIgnore(root, "# User rule\ngraph.db*\n*.scratch\n");

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result).toMatchObject({
      action: "update",
      addedRules: ["wiki.db*", "local/"],
    });
    expect(readIgnore(root)).toBe(
      "# User rule\ngraph.db*\n*.scratch\nwiki.db*\nlocal/\n",
    );
  });

  it("uses the existing CRLF style for appended rules", () => {
    const root = fixtureWithMex();
    const before = "# User rule\r\ngraph.db*\r\n";
    writeIgnore(root, before);

    ensureSetupIgnoreProtection({ projectRoot: root });

    expect(readIgnore(root)).toBe(`${before}wiki.db*\r\nlocal/\r\n`);
  });

  it("adds one separator when an existing file has no final newline", () => {
    const root = fixtureWithMex();
    writeIgnore(root, "# User rule");

    ensureSetupIgnoreProtection({ projectRoot: root });

    expect(readIgnore(root)).toBe(
      "# User rule\ngraph.db*\nwiki.db*\nlocal/\n",
    );
  });

  it("retains existing duplicate lines without adding another required rule", () => {
    const root = fixtureWithMex();
    const before = "graph.db*\ngraph.db*\nwiki.db*\n";
    writeIgnore(root, before);

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result.addedRules).toEqual(["local/"]);
    expect(readIgnore(root)).toBe(`${before}local/\n`);
  });

  it("is a byte-preserving no-op on rerun", () => {
    const root = fixture();
    ensureSetupIgnoreProtection({ projectRoot: root });
    const afterFirstRun = readFileSync(join(root, ".mex/.gitignore"));

    const result = ensureSetupIgnoreProtection({ projectRoot: root });

    expect(result).toMatchObject({
      action: "unchanged",
      applied: false,
      changed: false,
      addedRules: [],
    });
    expect(readFileSync(join(root, ".mex/.gitignore"))).toEqual(afterFirstRun);
  });

  it("reports a dry run without creating files", () => {
    const root = fixture();

    const result = ensureSetupIgnoreProtection({ projectRoot: root, dryRun: true });

    expect(result).toMatchObject({
      action: "create",
      dryRun: true,
      applied: false,
      changed: true,
    });
    expect(existsSync(join(root, ".mex"))).toBe(false);
    expect(renderSetupIgnoreProtection(result)).toContain("Would create");
  });

  it("fails closed when .mex/.gitignore is a symlink", () => {
    const root = fixtureWithMex();
    const outside = join(fixture(), "outside.gitignore");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, ".mex/.gitignore"), "file");

    const error = ignoreError(() => ensureSetupIgnoreProtection({ projectRoot: root }));
    expect(error.message).toContain(root);
    expect(error.userMessage).toContain(".mex/.gitignore path must be a regular file");
    expect(error.userMessage).not.toContain(root);
    expect(error.userMessage).not.toContain(outside);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("fails closed when .mex/.gitignore is not a regular file", () => {
    const root = fixtureWithMex();
    mkdirSync(join(root, ".mex/.gitignore"));

    expect(() => ensureSetupIgnoreProtection({ projectRoot: root })).toThrow(
      SetupIgnoreProtectionError,
    );
  });

  it.each(["file", "symlink"] as const)("explains an unsafe .mex %s without exposing its absolute path", (kind) => {
    const root = fixture();
    const outside = fixture();
    if (kind === "file") writeFileSync(join(root, ".mex"), "existing file\n");
    else symlinkSync(outside, join(root, ".mex"), process.platform === "win32" ? "junction" : "dir");

    const error = ignoreError(() => ensureSetupIgnoreProtection({ projectRoot: root }));

    expect(error.message).toContain(root);
    expect(error.userMessage).toBe("The .mex path must be a regular directory, not a symlink. Fix that path, then rerun setup.");
    expect(error.userMessage).not.toContain(outside);
    expect(existsSync(join(outside, ".gitignore"))).toBe(false);
  });

  it("explains an invalid project root without exposing its absolute path", () => {
    const root = join(fixture(), "not-a-directory");
    writeFileSync(root, "existing file\n");

    const error = ignoreError(() => ensureSetupIgnoreProtection({ projectRoot: root }));

    expect(error.message).toContain(root);
    expect(error.userMessage).toContain("Run setup from a valid project directory");
    expect(error.userMessage).not.toContain(root);
    expect(readFileSync(root, "utf8")).toBe("existing file\n");
  });

  it.each(["inspect", "read", "create", "append", "write"] as const)("keeps %s failure diagnostics private and retains their cause", (operation) => {
    const root = operation === "read" || operation === "append" ? fixtureWithMex() : fixture();
    if (operation === "read" || operation === "append") writeIgnore(root, "# unchanged\n");
    const cause = Object.assign(new Error(`EACCES private details at ${root}`), { code: "EACCES" });
    const fail = () => { throw cause; };
    if (operation === "inspect") vi.mocked(lstatSync).mockImplementationOnce(fail);
    if (operation === "read") vi.mocked(readFileSync).mockImplementationOnce(fail);
    if (operation === "create") vi.mocked(mkdirSync).mockImplementationOnce(fail);
    if (operation === "append") vi.mocked(appendFileSync).mockImplementationOnce(fail);
    if (operation === "write") vi.mocked(writeFileSync).mockImplementationOnce(fail);

    const error = ignoreError(() => ensureSetupIgnoreProtection({ projectRoot: root }));

    expect(error.cause).toBe(cause);
    expect(error.message).toContain(root);
    if (operation === "read") expect(error.message).toBe(cause.message);
    expect(error.userMessage).not.toContain(root);
    expect(error.userMessage).not.toContain("private details");
    expect(error.userMessage).toMatch(/permissions.*retry setup/u);
    if (operation === "read" || operation === "append") expect(readIgnore(root)).toBe("# unchanged\n");
  });

  it.each([
    ["ENOSPC", "Storage is full"],
    ["EROFS", "filesystem is read-only"],
  ])("uses the %s recovery guidance for ignore-file writes", (code, recovery) => {
    const root = fixtureWithMex();
    writeIgnore(root, "# unchanged\n");
    const cause = Object.assign(new Error(`private filesystem failure at ${root}`), { code });
    vi.mocked(appendFileSync).mockImplementationOnce(() => { throw cause; });

    const error = ignoreError(() => ensureSetupIgnoreProtection({ projectRoot: root }));

    expect(error.cause).toBe(cause);
    expect(error.userMessage).toContain(recovery);
    expect(error.userMessage).not.toContain("permissions");
    expect(error.userMessage).not.toContain(root);
    expect(readIgnore(root)).toBe("# unchanged\n");
  });

  it("verifies derived files are ignored and canonical config remains trackable", () => {
    const root = fixture();
    initGit(root);
    ensureSetupIgnoreProtection({ projectRoot: root });

    expect(() => verifySetupIgnoreProtection(root)).not.toThrow();
  });

  it("rejects a broad root rule that hides canonical MEX files", () => {
    const root = fixture();
    initGit(root);
    ensureSetupIgnoreProtection({ projectRoot: root });
    writeFileSync(join(root, ".gitignore"), ".mex/\n", "utf8");

    const error = ignoreError(() => verifySetupIgnoreProtection(root));
    expect(error.message).toMatch(/hides \.mex\/config\.json/u);
    expect(error.userMessage).toBe(error.message);
    expect(error.userMessage).toContain("Remove the broad .mex ignore");
    expect(error.userMessage).not.toContain(root);
  });

  it("explains how to repair a negation that exposes local MEX data", () => {
    const root = fixture();
    initGit(root);
    ensureSetupIgnoreProtection({ projectRoot: root });
    writeIgnore(root, "graph.db*\nwiki.db*\nlocal/\n!graph.db\n");

    const error = ignoreError(() => verifySetupIgnoreProtection(root));

    expect(error.message).toBe("Local MEX path is not ignored by Git: .mex/graph.db");
    expect(error.userMessage).toContain("Check .mex/.gitignore and conflicting negation rules");
    expect(error.userMessage).not.toContain(root);
  });

  it("reports a Git launch failure with remediation instead of its private cause", () => {
    const root = fixture();
    const cause = Object.assign(new Error(`spawn git ENOENT private ${root}`), { code: "ENOENT" });
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error: cause,
    });

    const error = ignoreError(() => verifySetupIgnoreProtection(root));

    expect(error.message).toBe("Could not run Git to verify local MEX data protection.");
    expect(error.cause).toBe(cause);
    expect(error.userMessage).toContain("Git is installed and available on PATH");
    expect(error.userMessage).not.toContain(root);
  });

  it("preserves terminal Git stderr while exposing only authored browser guidance", () => {
    const root = fixture();
    const stderr = `fatal: private token and path ${root}\n`;
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 123, output: [], stdout: "", stderr, status: 128, signal: null,
    });

    const error = ignoreError(() => verifySetupIgnoreProtection(root));

    expect(error.message).toBe(`Git could not verify local MEX data protection: ${stderr.trim()}`);
    expect(error.userMessage).toContain("valid Git repository");
    expect(error.userMessage).toContain("git status");
    expect(error.userMessage).not.toContain(root);
    expect(error.userMessage).not.toContain("private token");
  });
});

function ignoreError(run: () => unknown): SetupIgnoreProtectionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SetupIgnoreProtectionError);
    expect(error).toBeInstanceOf(SetupError);
    return error as SetupIgnoreProtectionError;
  }
  throw new Error("Expected an ignore-protection failure.");
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-setup-ignore-"));
  roots.push(root);
  return root;
}

function fixtureWithMex(): string {
  const root = fixture();
  mkdirSync(join(root, ".mex"));
  return root;
}

function writeIgnore(root: string, content: string): void {
  writeFileSync(join(root, ".mex/.gitignore"), content, "utf8");
}

function readIgnore(root: string): string {
  return readFileSync(join(root, ".mex/.gitignore"), "utf8");
}

function initGit(root: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: root });
}
