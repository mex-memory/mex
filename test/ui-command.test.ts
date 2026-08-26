import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUi } from "../src/ui/index.js";

// `runUi` blocks until shutdown, so every case injects a resolver and captures
// the banner instead of spawning a browser or waiting on a signal.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-ui-cmd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface RunResult {
  banner: string;
  opened: string[];
}

async function run(options: Parameters<typeof runUi>[0]): Promise<RunResult> {
  const lines: string[] = [];
  const opened: string[] = [];
  let release = () => {};
  const shutdown = new Promise<void>((resolve) => {
    release = resolve;
  });

  const finished = runUi(options, {
    log: (message) => {
      lines.push(message);
      // Release only once the banner is fully printed, so a case can assert on
      // it without racing the server's startup output.
      if (message.includes("Ctrl+C")) release();
    },
    openBrowser: (url) => opened.push(url),
    waitForShutdown: () => shutdown,
  });

  await finished;
  return { banner: lines.join("\n"), opened };
}

describe("mex ui", () => {
  it("prints the URL it bound and opens a browser by default", async () => {
    const result = await run({ root, port: 0 });
    expect(result.banner).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(result.opened).toHaveLength(1);
    expect(result.opened[0]).toBe(result.banner.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
  });

  it("does not open a browser with --no-open", async () => {
    const result = await run({ root, port: 0, open: false });
    expect(result.opened).toEqual([]);
  });

  it("tells you setup is the next step in a project with no .mex/", async () => {
    const result = await run({ root, port: 0, open: false });
    expect(result.banner).toContain("no .mex/ yet");
  });

  it("summarizes scaffold coverage for a project that is set up", async () => {
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n\nReal content.\n");
    const result = await run({ root, port: 0, open: false });
    expect(result.banner).toMatch(/scaffold \d+\/\d+ populated/);
    expect(result.banner).toContain("no code graph yet");
  });

  it("warns loudly when the scaffold cannot be loaded", async () => {
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(join(root, ".mex", "AGENTS.md"), "# Agents\n");
    const result = await run({ root, port: 0, open: false });
    expect(result.banner).toMatch(/ROUTER\.md/);
  });

  it("reports the project name of the inspected root, not the cwd", async () => {
    const result = await run({ root, port: 0, open: false });
    expect(result.banner).toContain(root.split(/[/\\]/).pop() as string);
  });

  it("releases the port once it shuts down", async () => {
    const lines: string[] = [];
    let release = () => {};
    const shutdown = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = runUi(
      { root, port: 0, open: false },
      {
        log: (message) => {
          lines.push(message);
          if (message.includes("Ctrl+C")) release();
        },
        waitForShutdown: () => shutdown,
        openBrowser: () => {},
      },
    );
    await finished;

    const url = lines.join("\n").match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
  });
});
