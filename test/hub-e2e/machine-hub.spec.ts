import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

test("opens the machine Hub, keeps bookmarks signed in across restarts, and rejects a used link", async ({ page, browser }) => {
  const root = mkdtempSync(join(tmpdir(), "mex-machine-hub-e2e-"));
  const env = {
    ...process.env,
    MEX_HOME: join(root, "home"),
    MEX_BACKGROUND: "0",
    MEX_TELEMETRY: "0",
    MEX_OFF: "0",
    DO_NOT_TRACK: "1",
    GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_GLOBAL: join(root, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;

  try {
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    registerRepo(root, "alder", env);
    registerRepo(root, "birch", env);
    const port = await freePort();
    hub = await startHub(root, env, port);
    const usedLink = hub.link;
    const origin = new URL(usedLink).origin;
    expect(origin).toBe(`http://127.0.0.1:${port}`);

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(usedLink);
    const switcher = page.getByRole("combobox", { name: "Repo switcher" });
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByText("· All repos", { exact: true })).toBeVisible();
    await expect(page.getByText("Nothing learned yet.")).toBeVisible();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(switcher.getByRole("option")).toHaveText(["All repos", "alder", "birch"]);
    await expect(page.getByText("Running from this terminal; closing it stops the Hub.")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.setViewportSize({ width: 360, height: 780 });
    await expect(page.getByRole("link", { name: "Home" })).toBeHidden();
    const menu = page.getByRole("button", { name: "Open menu" });
    await menu.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Home" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

    await switcher.selectOption({ label: "birch" });
    await expect(page).toHaveURL(/\/repos\/g-[a-f0-9]{24}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(page.getByText("· birch", { exact: true })).toBeVisible();
    await page.getByText("1 checkout", { exact: true }).click();
    await expect(page.getByText("MEX is on")).toBeVisible();
    const pathFont = await page.getByRole("list", { name: "Checkouts" }).locator("code")
      .evaluate((code) => getComputedStyle(code).fontFamily);
    expect(pathFont).toContain("IBM Plex Mono");
    await page.reload();
    await expect(page.getByText("· birch", { exact: true })).toBeVisible();

    await stopHub(hub.child);
    hub = await startHub(root, env, port);
    expect(new URL(hub.link).origin).toBe(origin);
    await page.goto(`${origin}/`);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByText("· All repos", { exact: true })).toBeVisible();
    await expect(page.getByText("Nothing learned yet.")).toBeVisible();
    await expect(switcher.getByRole("option")).toHaveText(["All repos", "alder", "birch"]);
    expect(pageErrors).toEqual([]);

    const freshContext = await browser.newContext();
    try {
      const freshPage = await freshContext.newPage();
      await freshPage.goto(usedLink);
      await expect(freshPage.getByRole("heading", { name: "Open the Hub from the terminal" })).toBeVisible();
      await expect(freshPage.getByText("That sign-in link was already used or has expired.")).toBeVisible();
      await expect(freshPage).toHaveURL(`${origin}/`);
      expect((await new AxeBuilder({ page: freshPage }).analyze()).violations).toEqual([]);
    } finally {
      await freshContext.close();
    }
  } finally {
    try { if (hub) await stopHub(hub.child); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("reads every main page from a real empty MEX home with no accessibility violations", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "mex-empty-hub-e2e-"));
  const env = {
    ...process.env, MEX_HOME: join(root, "home"), MEX_BACKGROUND: "0", MEX_TELEMETRY: "0", MEX_OFF: "0", DO_NOT_TRACK: "1",
    PATH: join(root, "empty-bin"), CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"),
    COPILOT_HOME: join(root, "copilot"), XDG_CONFIG_HOME: join(root, "config"),
  };
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    hub = await startHub(root, env, await freePort());
    const outbound: string[] = [];
    const origin = new URL(hub.link).origin;
    page.on("request", (request) => { if (new URL(request.url()).origin !== origin) outbound.push(request.url()); });
    await page.goto(hub.link);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByText("No agent sessions in the last 7 days.")).toBeVisible();
    await expect(page.getByText("share of your usage unknown")).toBeVisible();
    await expect(page.getByText("Nothing waiting", { exact: true })).toBeVisible();
    await expect(page.getByText("Nothing learned yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole("link", { name: "Jobs", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Jobs", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("No jobs to show.")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/review`);
    await expect(page.getByRole("heading", { name: "Nothing to review.", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("link", { name: "Knowledge", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/knowledge`);
    await expect(page.getByRole("heading", { name: "Knowledge", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("Nothing learned yet. Add a note, or let MEX learn from your sessions.")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/agents`);
    const claude = page.getByRole("article", { name: "Claude Code" });
    await expect(claude.getByText("Not found", { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(4);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await claude.getByRole("link", { name: "Details for Claude Code" }).click();
    await expect(page.getByRole("heading", { name: "Claude Code", exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText("No hook error history is recorded.")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/settings`);
    await expect(page.getByText("No registered checkouts.")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Telemetry" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("region", { name: "Storage" }).getByText(/record\.db$/)).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const capture = page.getByRole("switch", { name: "Capture everywhere" });
    await expect(capture).toBeChecked();
    await capture.click();
    await expect(page.getByText("Setting saved", { exact: true })).toBeVisible();
    await expect(capture).not.toBeChecked();
    await page.getByRole("button", { name: "Dismiss settings message" }).click();

    await page.getByRole("button", { name: "Preview uninstall" }).click();
    const uninstall = page.getByRole("dialog", { name: "Uninstall preview" });
    await expect(uninstall.getByText("No recorded installation changes.")).toBeVisible();
    await expect(uninstall.getByText("mex uninstall", { exact: true })).toBeVisible();
    await expect(uninstall).toHaveCSS("opacity", "1");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(outbound).toEqual([]);
  } finally {
    try { if (hub) await stopHub(hub.child); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});


function registerRepo(root: string, name: string, env: NodeJS.ProcessEnv) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const git = (args: string[]) => execFileSync("git", args, { cwd, env, timeout: 5_000 });
  git(["init", "--quiet"]);
  git(["-c", "user.name=MEX Test", "-c", "user.email=mex@example.test", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", `Create ${name}`]);
  execFileSync(process.execPath, [cli, "index", "status", "--json"], { cwd, env, timeout: 10_000 });
}

async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address() as AddressInfo;
  const closed = once(listener, "close");
  listener.close();
  await closed;
  return port;
}

async function startHub(root: string, env: NodeJS.ProcessEnv, port: number) {
  const child = spawn(process.execPath, [cli, "hub", "--foreground", "--no-open", "--port", String(port)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    return { child, link: await readSignInLink(child) };
  } catch (error) {
    await stopHub(child);
    throw error;
  }
}

function readSignInLink(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for mex hub.\n${stderr}`)), 10_000);

    function finish(result: string | Error) {
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", finish);
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    function onOutput(chunk: Buffer) {
      output = (output + chunk.toString()).slice(-16_384);
      const link = /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+(?=\r?\n)/u.exec(output)?.[0];
      if (link) finish(link);
    }

    function onStderr(chunk: Buffer) {
      stderr = (stderr + chunk.toString()).slice(-16_384);
    }

    function onExit(code: number | null, signal: string | null) {
      finish(new Error(`mex hub exited before signing in (${code ?? signal}).\n${stderr}`));
    }

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

async function stopHub(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(8_000) });
  const forceStop = setTimeout(() => child.kill("SIGKILL"), 5_000);
  child.kill("SIGTERM");
  try { await exited; }
  finally { clearTimeout(forceStop); }
}
