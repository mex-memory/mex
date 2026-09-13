import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const branch = "codex/setup-commit-fixture";
const unrelatedPaths = ["README.md", "src/index.ts"];
const changedAfterReview = "This architecture sentence changed after the review was opened.";
const architecturePath = ".mex/context/architecture.md";
const architectureContext = "The repository keeps project memory beside the code.";
const architectureRemoved = "Setup population requires copying a prompt into a terminal.";
const architectureAdded = "Setup population runs in a background session with readable live activity.";
const architectureExtra = "Review generated files before creating a local setup commit.";
const architectureBefore = ["# Architecture", "", "## Setup workflow", "", architectureContext,
  architectureRemoved, "", "Project knowledge remains Markdown tracked in Git.", ""].join("\n");
const architectureAfter = architectureBefore.replace(architectureRemoved, `${architectureAdded}\n${architectureExtra}`);
interface CommitPreview { revision: string; files: Array<{ path: string; status: string }>; }

test.describe("built setup commit checkpoint", () => {
  test("reviews and commits only setup files while preserving unrelated staged work", async ({ page }, testInfo) => {
    const fixture = createFixture();
    let hub: ChildProcess | undefined;
    try {
      const opened = await openFixtureHub(page, fixture);
      hub = opened.hub;
      const preview = await reviewAllFiles(page, "Review setup changes", fixture.setupPaths);
      expect(git(fixture, "rev-parse", "HEAD").trim()).toBe(fixture.initialHead);
      assertUnrelatedPreserved(fixture);
      await expect(page.getByLabel("Diff for .mex/.gitignore", { exact: true })).toContainText("# MEX generated state");
      expect(preview.files.find((file) => file.path === architecturePath)?.status).toBe("modified");
      const architectureDiff = page.getByRole("region", { name: `Diff for ${architecturePath}`, exact: true });
      const addition = architectureDiff.locator('[data-diff-kind="addition"]').filter({ hasText: architectureAdded });
      const deletion = architectureDiff.locator('[data-diff-kind="deletion"]').filter({ hasText: architectureRemoved });
      const context = architectureDiff.locator('[data-diff-kind="context"]').filter({ hasText: architectureContext });
      await expect(addition.locator("[data-diff-content]")).toHaveText(architectureAdded);
      await expect(deletion.locator("[data-diff-content]")).toHaveText(architectureRemoved);
      await expect(context.locator("[data-diff-content]")).toHaveText(architectureContext);
      await expect(addition.locator('[data-line-side="old"]')).toHaveText("");
      await expect(addition.locator('[data-line-side="new"]')).toHaveText("6");
      await expect(deletion.locator('[data-line-side="old"]')).toHaveText("6");
      await expect(deletion.locator('[data-line-side="new"]')).toHaveText("");
      await expect(context.locator('[data-line-side="old"]')).toHaveText("5");
      await expect(context.locator('[data-line-side="new"]')).toHaveText("5");
      await expect(architectureDiff).not.toContainText(/diff --git|index [0-9a-f]+\.\.[0-9a-f]+|--- a\/|\+\+\+ b\//u);
      await expect(page.locator("details").filter({ has: architectureDiff })
        .getByLabel("2 added lines, 1 deleted lines", { exact: true })).toBeVisible();
      const rowBackgrounds = await Promise.all([addition, deletion, context]
        .map((row) => row.evaluate((element) => getComputedStyle(element).backgroundColor)));
      expect(rowBackgrounds[0]).not.toBe(rowBackgrounds[1]);
      expect(rowBackgrounds[0]).not.toBe(rowBackgrounds[2]);
      expect(rowBackgrounds[1]).not.toBe(rowBackgrounds[2]);
      await page.getByLabel("Commit message", { exact: true }).fill("Initialize reviewed MEX setup");
      for (const file of preview.files) {
        if (file.path === architecturePath) continue;
        const diff = page.getByLabel(`Diff for ${file.path}`, { exact: true });
        await page.locator("details").filter({ has: diff }).locator("summary").first().click();
      }
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        window.scrollTo(0, 0);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("setup-commit-review.png"), fullPage: true });
      const committed = await commitAndOpenHub(page, opened.origin);
      assertSetupCommit(fixture, preview.files.map((file) => file.path), committed.commit, "Initialize reviewed MEX setup");
      expect(opened.pageErrors).toEqual([]);
      expect(opened.externalRequests).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("setup-commit-dashboard.png"), fullPage: true });
    } finally {
      try { if (hub) await stopHub(hub); }
      finally { rmSync(fixture.root, { recursive: true, force: true }); }
    }
  });

  test("rejects stale reviewed bytes and requires a fresh review before committing", async ({ page }, testInfo) => {
    const fixture = createFixture();
    let hub: ChildProcess | undefined;
    try {
      const opened = await openFixtureHub(page, fixture);
      hub = opened.hub;
      const first = await reviewAllFiles(page, "Review setup changes", fixture.setupPaths);
      const architecture = join(fixture.project, ".mex/context/architecture.md");
      writeFileSync(architecture, readFileSync(architecture, "utf8") + `\n${changedAfterReview}\n`);
      await page.getByLabel("Commit message", { exact: true }).fill("Initialize reviewed MEX setup after refresh");
      const rejectedResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/v1/setup/commit" && response.request().method() === "POST");
      await page.getByRole("button", { name: "Commit setup and open Hub", exact: true }).click();
      const rejected = await rejectedResponse;
      expect(rejected.status()).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "REVISION_CONFLICT" });
      expect(git(fixture, "rev-parse", "HEAD").trim()).toBe(fixture.initialHead);
      assertUnrelatedPreserved(fixture);
      await expect(page.getByRole("button", { name: "Refresh review", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Commit setup and open Hub", exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("setup-commit-stale-review.png"), fullPage: true });
      const refreshed = await reviewAllFiles(page, "Refresh review", fixture.setupPaths);
      expect(refreshed.revision).not.toBe(first.revision);
      await expect(page.getByLabel("Diff for .mex/context/architecture.md", { exact: true })).toContainText(changedAfterReview);
      await page.getByLabel("Commit message", { exact: true }).fill("Initialize reviewed MEX setup after refresh");
      const committed = await commitAndOpenHub(page, opened.origin);
      assertSetupCommit(fixture, refreshed.files.map((file) => file.path), committed.commit, "Initialize reviewed MEX setup after refresh");
      expect(git(fixture, "show", "HEAD:.mex/context/architecture.md")).toContain(changedAfterReview);
      expect(opened.pageErrors).toEqual([]);
      expect(opened.externalRequests).toEqual([]);
    } finally {
      try { if (hub) await stopHub(hub); }
      finally { rmSync(fixture.root, { recursive: true, force: true }); }
    }
  });
});

async function reviewAllFiles(page: Page, action: string, expectedPaths: string[]): Promise<CommitPreview> {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/setup/commit/preview" && response.request().method() === "POST");
  await page.getByRole("button", { name: action, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const preview = await response.json() as CommitPreview;
  expect(preview.files.map((file) => file.path).sort()).toEqual([...expectedPaths].sort());
  const commit = page.getByRole("button", { name: "Commit setup and open Hub", exact: true });
  for (const file of preview.files) {
    const diff = page.getByLabel(`Diff for ${file.path}`, { exact: true });
    const details = page.locator("details").filter({ has: diff });
    await details.locator("summary").first().click();
    await expect(diff).toBeVisible();
    await expect(details.locator("summary").first()).toContainText("Viewed");
  }
  await expect(commit).toBeEnabled();
  // With every diff open, wide rows scroll inside their diff; review actions stay inside the card.
  // The card clips overflow, so hidden width there is exactly what hid the actions.
  const card = page.locator("section[aria-labelledby='setup-title']");
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  for (const button of [commit, page.getByRole("button", { name: "Refresh review", exact: true })]) {
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  }
  const stack = page.getByRole("region", { name: "Diff for .mex/context/stack.md", exact: true });
  expect(await stack.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  return preview;
}

async function commitAndOpenHub(page: Page, origin: string): Promise<{ commit: string }> {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/setup/commit" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Commit setup and open Hub", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const result = await response.json() as { commit: string; run: { ready: boolean } };
  expect(result.run.ready).toBe(true);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByRole("link", { name: "Context", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Code", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.locator("#setup-main")).toHaveCount(0);
  return result;
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-setup-commit-browser-")));
  const project = join(root, "project");
  const bin = join(root, "bin");
  const remote = join(root, "remote.git");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, ".mex/context"), { recursive: true });
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = { ...process.env, MEX_HOME: join(root, "home"), MEX_TELEMETRY: "0", NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-gitconfig"), GIT_TRACE: join(root, "git-trace.log") };
  writeFileSync(env.GIT_CONFIG_GLOBAL!, "");
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].includes(key)) delete env[key];
  }
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  const fixtureBase = { root, project, env };
  writeFileSync(join(project, "README.md"), "# Original project README\n");
  writeFileSync(join(project, "src/index.ts"), "export const value = 'original';\n");
  writeFileSync(join(project, ".gitignore"), "node_modules/\n# Original ignore rules\n");
  writeFileSync(join(project, ".mex/.gitignore"), "# Original local index exclusions\n");
  writeFileSync(join(project, architecturePath), architectureBefore);
  git(fixtureBase, "init", "--quiet", "--initial-branch", branch);
  git(fixtureBase, "config", "user.name", "Setup Browser Fixture");
  git(fixtureBase, "config", "user.email", "setup-browser@example.test");
  git(fixtureBase, "config", "commit.gpgsign", "false");
  git(fixtureBase, "add", "--", ".gitignore", ".mex/.gitignore", architecturePath, ...unrelatedPaths);
  git(fixtureBase, "commit", "--quiet", "-m", "Initial disposable fixture");
  const initialHead = git(fixtureBase, "rev-parse", "HEAD").trim();
  git(fixtureBase, "init", "--bare", "--quiet", remote);
  git(fixtureBase, "remote", "add", "origin", remote);
  const remoteRefs = git(fixtureBase, "--git-dir", remote, "for-each-ref");
  for (const path of unrelatedPaths) {
    writeFileSync(join(project, path), `${readFileSync(join(project, path), "utf8")}Unrelated staged content in ${path}.\n`);
  }
  git(fixtureBase, "add", "--", ...unrelatedPaths);
  for (const path of unrelatedPaths) {
    writeFileSync(join(project, path), `${readFileSync(join(project, path), "utf8")}Unrelated unstaged content in ${path}.\n`);
  }
  const unrelated = unrelatedPaths.map((path) => ({ path,
    index: gitBytes(fixtureBase, "show", `:${path}`), worktree: readFileSync(join(project, path)),
    committed: gitBytes(fixtureBase, "show", `HEAD:${path}`) }));
  const indexEntries = git(fixtureBase, "ls-files", "--stage", "--", ...unrelatedPaths);
  const setupPaths = [".mex/.gitignore", ".mex/config.json", "AGENTS.md", "CLAUDE.md"];
  mkdirSync(join(project, ".mex/context"), { recursive: true });
  for (const name of ["AGENTS.md", "ROUTER.md", "context/architecture.md", "context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md"]) {
    const path = `.mex/${name}`;
    writeFileSync(join(project, path), path === architecturePath ? architectureAfter
      // One unwrapped line far wider than the review card, as real populated prose often is.
      : path === ".mex/context/stack.md" ? `# Setup review fixture\n\n${"Populated stack detail without a break. ".repeat(60)}\n`
      : "# Setup review fixture\n\nPopulated project fixture content.\n");
    setupPaths.push(path);
  }
  writeFileSync(join(project, ".mex/config.json"), JSON.stringify({ scaffold_id: randomUUID(), scaffold_name: "Setup commit fixture", setupMode: "code-repo", aiTools: ["codex", "claude"] }, null, 2) + "\n");
  writeFileSync(join(project, "AGENTS.md"), "# Codex project instructions\n\nRead .mex/AGENTS.md and .mex/ROUTER.md before project work.\n");
  writeFileSync(join(project, "CLAUDE.md"), "# Claude project instructions\n\nRead .mex/AGENTS.md and .mex/ROUTER.md before project work.\n");
  writeFileSync(join(project, ".mex/.gitignore"), readFileSync(join(project, ".mex/.gitignore"), "utf8") + "# MEX generated state\ngraph.db*\nwiki.db*\nlocal/\n");
  // Match the readiness boundary's completed-scaffold fixture. Index presence
  // reaches the commit checkpoint; the promoted Hub reports index health using
  // its real adapters. No Graph build, population session, or fixture API exists.
  mkdirSync(join(project, ".mex/local"), { recursive: true });
  writeFileSync(join(project, ".mex/graph.db"), "");
  writeFileSync(join(project, ".mex/wiki.db"), "");
  writeFileSync(join(project, ".mex/local/fixture-private.db"), "Private generated state must not be committed.\n");
  const providerScript = join(root, "blocked-provider.cjs");
  writeFileSync(providerScript, `require('node:fs').appendFileSync(${JSON.stringify(join(root, "provider-invoked"))}, 'unexpected provider invocation\\n'); process.exit(55);\n`);
  for (const provider of ["claude", "codex"]) {
    if (process.platform === "win32") {
      writeFileSync(join(bin, `${provider}.cmd`), `@"${process.execPath}" "${providerScript}" %*\r\n`);
    } else {
      const executable = join(bin, provider);
      writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(providerScript)} "$@"\n`);
      chmodSync(executable, 0o755);
    }
  }
  return { ...fixtureBase, remote, remoteRefs, initialHead, setupPaths, unrelated, indexEntries };
}

type Fixture = ReturnType<typeof createFixture>;
type GitFixture = Pick<Fixture, "project" | "env">;

function assertUnrelatedPreserved(fixture: Fixture): void {
  expect(git(fixture, "ls-files", "--stage", "--", ...unrelatedPaths)).toBe(fixture.indexEntries);
  for (const file of fixture.unrelated) {
    expect(gitBytes(fixture, "show", `:${file.path}`).equals(file.index)).toBe(true);
    expect(readFileSync(join(fixture.project, file.path)).equals(file.worktree)).toBe(true);
    expect(gitBytes(fixture, "show", `HEAD:${file.path}`).equals(file.committed)).toBe(true);
  }
}

function assertSetupCommit(fixture: Fixture, reviewedPaths: string[], commit: string, message: string): void {
  expect(git(fixture, "rev-parse", "HEAD").trim()).toBe(commit);
  expect(commit).not.toBe(fixture.initialHead);
  expect(git(fixture, "rev-parse", "HEAD^").trim()).toBe(fixture.initialHead);
  expect(git(fixture, "branch", "--show-current").trim()).toBe(branch);
  expect(git(fixture, "log", "-1", "--format=%B").trim()).toBe(message);
  expect(git(fixture, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim().split("\n").sort())
    .toEqual([...reviewedPaths].sort());
  for (const path of reviewedPaths) expect(gitBytes(fixture, "show", `HEAD:${path}`).equals(readFileSync(join(fixture.project, path)))).toBe(true);
  assertUnrelatedPreserved(fixture);
  expect(git(fixture, "diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual([...unrelatedPaths].sort());
  expect(git(fixture, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/\.mex\/(?:graph\.db|wiki\.db|local\/)/u);
  expect(git(fixture, "--git-dir", fixture.remote, "for-each-ref")).toBe(fixture.remoteRefs);
  expect(git(fixture, "remote", "get-url", "origin").trim()).toBe(fixture.remote);
  expect(readFileSync(join(fixture.root, "git-trace.log"), "utf8")).not.toMatch(/built-in: git (?:push|pull|fetch|ls-remote)\b/u);
  expect(existsSync(join(fixture.root, "provider-invoked"))).toBe(false);
}

function gitBytes(fixture: GitFixture, ...args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd: fixture.project, env: fixture.env, timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Fixture Git command failed (${args[0]}): ${result.error?.message ?? result.stderr.toString("utf8")}`);
  return result.stdout;
}

function git(fixture: GitFixture, ...args: string[]): string { return gitBytes(fixture, ...args).toString("utf8"); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function openFixtureHub(page: Page, fixture: Fixture) {
  const hub = spawn(process.execPath, [join(repositoryRoot, "dist/cli.js"), "hub", "--no-open"], {
    cwd: fixture.project, env: fixture.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    const bootstrap = await readBootstrapUrl(hub);
    const origin = new URL(bootstrap).origin;
    const pageErrors: string[] = [];
    const externalRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    await page.goto(bootstrap);
    await expect(page.getByRole("button", { name: "Review setup changes", exact: true })).toBeVisible();
    return { hub, origin, pageErrors, externalRequests };
  } catch (error) { await stopHub(hub); throw error; }
}

function readBootstrapUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for fixture Hub startup.")); }, 10_000);
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) { cleanup(); resolveUrl(match[0]); }
    };
    const onExit = () => { cleanup(); reject(new Error(`Fixture Hub exited before startup.\n${output}`)); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData); child.stderr?.off("data", onData);
      child.off("exit", onExit); child.off("error", onError);
      child.stdout?.resume(); child.stderr?.resume();
    };
    child.stdout?.on("data", onData); child.stderr?.on("data", onData);
    child.once("exit", onExit); child.once("error", onError);
  });
}

async function stopHub(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!await waitForExit(child, 5_000)) {
    child.kill("SIGKILL");
    if (!await waitForExit(child, 3_000)) throw new Error("Fixture Hub did not stop before cleanup.");
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => { clearTimeout(timer); resolveExit(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolveExit(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}
