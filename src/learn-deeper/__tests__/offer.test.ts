import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as cliTools from "../../cli-tools.js";
import { setCheckoutEnabled } from "../../controls/index.js";
import * as launcher from "../../hooks/shim/launcher.js";
import * as background from "../../record/background.js";
import { openRecord, openRecordReadOnly } from "../../record/index.js";
import { offerLearning } from "../offer.js";
import { CURSOR_KEY } from "../pipeline.js";
import { SCHEDULE } from "../weekly-schedule.js";

let root: string, projectId: string, base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "mex-learn-offer-")));
  root = join(base, "repo");
  mkdirSync(root);
  vi.stubEnv("MEX_HOME", base);
  vi.stubEnv("MEX_OFF", "");
  vi.stubEnv("MEX_BACKGROUND", "0");
  vi.stubEnv("MEX_SETUP_BACKGROUND_AGENTS", "0");
  vi.stubEnv("GH_TOKEN", "forge-fixture");
  vi.stubEnv("GITLAB_TOKEN", "forge-fixture");
  vi.stubEnv("MEX_HOOK_BINARY", process.execPath);
  vi.spyOn(cliTools, "isCliAvailable").mockImplementation(name => name === "codex");
  vi.spyOn(launcher, "writeLauncher").mockReturnValue(false);
  vi.spyOn(background, "ensureBackground");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected forge request"); }));
  git("init", "-qb", "main");
  writeFileSync(join(root, "CONTRIBUTING.md"), "# Development\n\nRun tests before releasing.\n");
  git("add", "CONTRIBUTING.md");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Add contributor guide");
  const writer = openRecord({ isNetwork: () => false, projectPath: root });
  try {
    const checkout = setCheckoutEnabled(writer, root, true);
    root = checkout.path;
    projectId = checkout.project_id;
  } finally { writer.close(); }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function assertNoLearningSaved(): void {
  const reader = openRecordReadOnly()!;
  try {
    expect(reader.get("SELECT count(*) AS n FROM jobs")).toEqual({ n: 0 });
    expect(reader.setting(projectId, CURSOR_KEY)).toBeUndefined();
    expect(reader.setting(projectId, SCHEDULE)).toBeUndefined();
  } finally { reader.close(); }
  expect(background.ensureBackground).not.toHaveBeenCalled();
}

it("prints the normal estimate and measured source counts through the non-interactive CLI", async () => {
  git("remote", "add", "origin", "https://github.com/example/memory.git");
  const writer = openRecord();
  try { writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run(projectId, "learning.deep.issues", "true"); }
  finally { writer.close(); }
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://api.github.com/repos/example/memory") return Response.json({ full_name: "example/memory", private: false });
    expect(url).toBe("https://api.github.com/graphql");
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string | null> };
    expect(query).toContain("HarvestSearch");
    expect(query).not.toContain("nodes{");
    const seen = new Set<string>();
    return Response.json({ data: Object.fromEntries(Object.entries(variables).flatMap(([key, term]) => {
      if (!term) return [];
      const lane = term.includes("is:issue") ? "issue" : term.includes("is:merged") ? "merged" : "closed";
      const issueCount = seen.has(lane) ? 0 : { merged: 3, closed: 2, issue: 10 }[lane];
      seen.add(lane);
      return [[`s${key.slice(1)}`, { issueCount, pageInfo: { hasNextPage: false } }]];
    })) });
  });
  vi.stubGlobal("fetch", fetch);
  const confirm = vi.fn(async (_quote: readonly string[], _details: readonly string[]) => false);
  const offer = vi.fn();
  await offerLearning({ root, projectId, write: offer, interactive: true, explicit: true, confirm });
  expect(offer.mock.calls.flat()).toEqual([]);
  expect(confirm).toHaveBeenCalledTimes(1);
  const [quote, details] = confirm.mock.calls[0]!;
  expect(quote).toContain("Estimate 90,268 tokens · ceiling 135,402 tokens.");
  expect(details).toContain("Counted 5 merged or closed pull requests, 0 reverts and past fixes, and 1 doc or decision record.");
  expect(details).toContain("Counted 10 closed issues for the issues trial.");

  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { program } = await import("../../cli.js");
  const original = process.cwd();
  try {
    process.chdir(root);
    await program.parseAsync(["learn", "--dry-run"], { from: "user" });
  } finally { process.chdir(original); }
  expect(log.mock.calls.flat()).toEqual([
    "Learn deeper dry run. Read review history and local Git history. Spent no tokens.",
    quote.find(line => line.startsWith("Estimate ")),
    ...details.filter(line => line.startsWith("Counted ")),
  ]);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(launcher.writeLauncher).not.toHaveBeenCalled();
  assertNoLearningSaved();
});

it("reports the same source gap in the offer and preview, even without a local runner or checker", async () => {
  git("remote", "add", "origin", "https://gitlab.com/example/memory.git");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    expect(decodeURIComponent(url)).toBe("https://gitlab.com/api/v4/projects/example/memory");
    return Response.json({ path_with_namespace: "example/memory", visibility: "public" });
  }));
  const confirm = vi.fn(async (_quote: readonly string[], _details: readonly string[]) => false);
  const offer = vi.fn();
  await offerLearning({ root, projectId, write: offer, interactive: true, explicit: true, confirm });
  expect(offer.mock.calls.flat()).toEqual([]);
  expect(confirm).toHaveBeenCalledTimes(1);
  const gap = "Source gap: Review history requires an authenticated GitHub source.";
  expect(confirm.mock.calls[0]?.[1]).toContain(gap);

  vi.mocked(cliTools.isCliAvailable).mockReturnValue(false);
  vi.stubEnv("MEX_HOOK_BINARY", join(base, "absent"));
  const write = vi.fn();
  await offerLearning({ root, projectId, write, interactive: false, dryRun: true, explicit: true, confirm });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(write.mock.calls.flat()).toEqual([
    "Learn deeper dry run. Read local Git history. Spent no tokens.",
    "The estimate assumes Codex because no supported model runner is installed.",
    confirm.mock.calls[0]?.[0].find(line => line.startsWith("Estimate ")),
    confirm.mock.calls[0]?.[1].find(line => line.startsWith("Counted ")),
    gap,
  ]);
  assertNoLearningSaved();
});
