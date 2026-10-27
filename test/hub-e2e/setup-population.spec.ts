import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPTED_FACT_TITLE, SCRIPTED_PATTERN, installScriptedAgent } from "../support/scripted-agent.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repositoryRoot, "dist", "cli.js");

// The full Hub flow (#292): a code repository set up from the browser, with
// the population agent launched in the background by the Hub, through the
// finish step to the commit review. The agent is the scripted one the Vitest
// end-to-end suite uses, behind `claude` and `codex` shims.
test.describe("built Hub code-repository setup", () => {
  for (const provider of ["claude", "codex"] as const) {
    test(`${provider} populates in the background and setup reaches the commit review`, async ({ page }) => {
      test.setTimeout(180_000);
      const fixture = createFixture();
      let hub: ChildProcess | undefined;
      try {
        hub = spawn(process.execPath, [cli, "hub", "--no-open"], {
          cwd: fixture.project, env: fixture.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
        await page.goto(await readBootstrapUrl(hub));
        await page.getByRole("button", { name: "Set up this project", exact: true }).click();
        await page.getByRole("radio", { name: /Code repository/ }).check();
        for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
        await page.locator(`input[name="setup-tools"][value="${provider}"]`).check();
        await page.getByRole("button", { name: "Start setup", exact: true }).click();

        await expect(page.getByRole("button", { name: "Review setup changes", exact: true }))
          .toBeVisible({ timeout: 150_000 });
        const response = await page.request.get(new URL("/api/v1/setup", page.url()).href);
        expect(response.ok()).toBe(true);
        expect(await response.json()).toMatchObject({ graphReady: true, wikiReady: true, populated: true });

        const mex = join(fixture.project, ".mex");
        expect(readFileSync(join(mex, "context", "architecture.md"), "utf8")).toContain(SCRIPTED_FACT_TITLE);
        expect(existsSync(join(mex, SCRIPTED_PATTERN))).toBe(true);
        const log = readFileSync(join(mex, "local", "e2e-agent.log"), "utf8");
        expect(log.split("\n").filter((line) => line.startsWith("start:"))).toEqual([`start:${provider}`]);
        expect(log).toContain(`exit:${provider}`);
      } finally {
        if (hub) await stopHub(hub);
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mex-hub-setup-population-")));
  const project = join(root, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "checkout.ts"), [
    "export function calculateCheckoutTotal(items: number[]): number {",
    "  const subtotal = items.reduce((sum, item) => sum + item, 0);",
    "  return subtotal + subtotal * 0.18;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, "src", "cart.ts"), [
    'import { calculateCheckoutTotal } from "./checkout";',
    "export function cartTotal(prices: number[]): number {",
    "  return calculateCheckoutTotal(prices);",
    "}",
    "",
  ].join("\n"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore", windowsHide: true });
  git("init", "--quiet");
  git("config", "user.name", "Hub Setup Fixture");
  git("config", "user.email", "hub-setup@example.test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "--quiet", "-m", "Fixture");
  const bin = installScriptedAgent(join(root, "agent"), cli);
  const env: NodeJS.ProcessEnv = { ...process.env, MEX_HOME: join(root, "home"), MEX_TELEMETRY: "0", MEX_SETUP_BACKGROUND_AGENTS: "1", MEX_SETUP_PER_SUBSYSTEM: "0", NO_COLOR: "1" };
  // Windows environment names are case-insensitive; do not leave two PATHs.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
  return { root, project, env };
}

function readBootstrapUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for fixture Hub startup.\n${output}`)); }, 15_000);
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) { cleanup(); resolveUrl(match[0]); }
    };
    const onExit = () => { cleanup(); reject(new Error(`Fixture Hub exited before startup.\n${output}`)); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.stdout?.resume();
      child.stderr?.resume();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopHub(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}
