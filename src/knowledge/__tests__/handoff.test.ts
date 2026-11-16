import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeHandoff, draftHandoff, handoffLeftovers, handoffSlug, newWords, writeHandoff } from "../handoff.js";
import { runHandoff } from "../handoff-cli.js";

let root: string, repo: string, home: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
const options = () => ({ projectPath: repo, home, isNetwork: () => false });
function snapshot(value: Record<string, unknown>): void {
  const name = createHash("sha256").update(`${repo}\0feat/billing`, "utf8").digest("hex").slice(0, 24);
  mkdirSync(join(home, "continuity"), { recursive: true });
  writeFileSync(join(home, "continuity", `${name}.json`), JSON.stringify({ version: 1, checkout: repo, branch: "feat/billing", updated: "2026-11-15T10:00:00Z", ...value }));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-handoff-")); repo = join(root, "repo"); home = join(root, "user", ".mex");
  mkdirSync(repo); mkdirSync(home, { recursive: true });
  repo = realpathSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Alex"); git(repo, "config", "user.email", "alex@example.test");
  writeFileSync(join(repo, "README.md"), "# Billing\nDeploys go to api.example.com.\n"); git(repo, "add", "README.md"); git(repo, "commit", "-m", "init");
  git(repo, "checkout", "-b", "feat/billing");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("mex handoff", () => {
  it("names files the same way the hook reads them", () => {
    // Same vectors as native/capture/handoff_test.go.
    expect(handoffSlug("feat/billing")).toBe("feat-billing");
    expect(handoffSlug("user/ünï code//x")).toBe("user-n-code-x");
    expect(handoffSlug("..hidden.")).toBe("hidden");
    expect(handoffSlug("///")).toBe("branch");
    expect(handoffSlug("a".repeat(120))).toBe("a".repeat(100));
  });

  it("writes the continuity block and one line, with no AI, after a preview", () => {
    snapshot({ last_ask: "wire refunds into the invoice export", last_failure: { command: "npm test", exit: 1 }, next_session: ["the refund total is off by tax"] });
    writeFileSync(join(repo, "refund.ts"), "x");
    const draft = draftHandoff({ line: "Sam: start with the tax rounding", to: "Sam", now: new Date("2026-11-15T12:00:00Z") }, options());
    expect(draft.path).toBe(".mex/handoffs/feat-billing.md");
    expect(existsSync(join(repo, draft.path))).toBe(false);
    expect(draft.content).toBe([
      "---", "mex: handoff", "version: 1", 'branch: "feat/billing"', 'from: "Alex"', 'to: "Sam"', "created: 2026-11-15", "---",
      "Alex handed off feat/billing to Sam:",
      `- Branch: feat/billing (at ${git(repo, "rev-parse", "--short", "HEAD").trim()})`,
      '- Last ask: "wire refunds into the invoice export"',
      "- Last failing command: `npm test` (exit 1)",
      "- Uncommitted when handed off: refund.ts",
      "- Next session: the refund total is off by tax",
      "- From Alex: Sam: start with the tax rounding", "",
    ].join("\n"));
    writeHandoff(draft);
    expect(readFileSync(join(repo, draft.path), "utf8")).toBe(draft.content);
    // MEX never commits.
    expect(git(repo, "status", "--porcelain")).toContain("?? .mex/");
    expect(git(repo, "log", "--oneline")).toHaveLength(git(repo, "log", "--oneline", "-1").length);
  });

  it("holds back lines that fail the secret scan or the new-words check", () => {
    snapshot({ last_ask: "ask priya@corp-mail.test about staging.internal before deploying", last_failure: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' api.example.com", exit: 7 } });
    const draft = draftHandoff({}, options());
    expect(draft.content).not.toMatch(/priya|staging\.internal|abcdefghijklmnop/u);
    expect(draft.held.map(h => h.reason)).toEqual([
      expect.stringMatching(/priya@corp-mail\.test.*staging\.internal|staging\.internal.*priya@corp-mail\.test/u),
      "looks like a secret",
    ]);
    expect(() => draftHandoff({ line: "the password: hunter2hunter2 works" }, options())).toThrow(/secret/u);
    expect(() => draftHandoff({ line: "ping @priya before merging" }, options())).toThrow(/@priya/u);
    // Words the repo already has are fine.
    expect(newWords("deploys go to api.example.com", repo)).toEqual([]);
  });

  it("previews without writing unless asked, and closes with done", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runHandoff(["check", "the", "tax", "rounding"], { projectPath: repo, dryRun: true })).toBe(0);
      expect(existsSync(join(repo, ".mex", "handoffs", "feat-billing.md"))).toBe(false);
      expect(log.mock.calls.flat().join("\n")).toContain("Writes .mex/handoffs/feat-billing.md");
      expect(await runHandoff(["check", "the", "tax", "rounding"], { projectPath: repo, yes: true })).toBe(0);
      expect(readFileSync(join(repo, ".mex", "handoffs", "feat-billing.md"), "utf8")).toContain("- From Alex: check the tax rounding");
      git(repo, "add", ".mex/handoffs/feat-billing.md"); git(repo, "commit", "-m", "Hand off feat/billing");
      expect(closeHandoff(options())).toEqual({ branch: "feat/billing", path: ".mex/handoffs/feat-billing.md", removed: true, tracked: true });
      expect(existsSync(join(repo, ".mex", "handoffs", "feat-billing.md"))).toBe(false);
      expect(git(repo, "status", "--porcelain")).toBe(" D .mex/handoffs/feat-billing.md\n");
      expect(closeHandoff(options()).removed).toBe(false);
    } finally { log.mockRestore(); }
  });

  it("is flagged when left in a pull request to the default branch", () => {
    writeHandoff(draftHandoff({}, options()));
    git(repo, "add", "-A"); git(repo, "commit", "-m", "Hand off");
    expect(handoffLeftovers(repo, "main")).toEqual([{ path: ".mex/handoffs/feat-billing.md", proven: true }]);
    git(repo, "branch", "stack", "main");
    expect(handoffLeftovers(repo, "stack")).toEqual([{ path: ".mex/handoffs/feat-billing.md", proven: false }]);
    closeHandoff(options());
    git(repo, "commit", "-am", "Close handoff");
    expect(handoffLeftovers(repo, "main")).toEqual([]);
  });
});
