// ============================================================================
// `mex ui` — command entry
// ============================================================================
//
// Starts the local server, optionally opens a browser, and blocks until
// interrupted. Deliberately side-effect free with respect to project state:
// nothing is scaffolded, no identity is minted, and no config is written just
// because someone opened the dashboard.

import chalk from "chalk";
import crossSpawn from "cross-spawn";
import { resolve } from "node:path";
import { startUiServer, type UiServer } from "./server.js";
import { readSnapshot } from "./snapshot.js";

export interface UiCommandOptions {
  /** Project directory to inspect. Defaults to the current directory. */
  root?: string;
  port?: number;
  host?: string;
  /** False suppresses the browser launch (`--no-open`). */
  open?: boolean;
}

export interface UiCommandDeps {
  /** Injected for tests so `runUi` can be driven without a real browser or TTY. */
  openBrowser?: (url: string) => void;
  log?: (message: string) => void;
  /** Resolves when the server should shut down. Defaults to SIGINT/SIGTERM. */
  waitForShutdown?: () => Promise<void>;
}

/**
 * Start the dashboard server and keep it running. Resolves once the server has
 * shut down, so the CLI action can simply await it.
 */
export async function runUi(
  options: UiCommandOptions = {},
  deps: UiCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const root = resolve(options.root ?? process.cwd());

  const server = await startUiServer({
    root,
    port: options.port,
    host: options.host,
    // An explicit --port should fail loudly rather than land somewhere else.
    strictPort: options.port !== undefined,
  });

  printBanner(server, root, log);

  if (options.open !== false) {
    (deps.openBrowser ?? openBrowser)(server.url);
  }

  const waitForShutdown = deps.waitForShutdown ?? waitForSignal;
  try {
    await waitForShutdown();
  } finally {
    await server.close().catch(() => {
      // Shutting down is best-effort; the process is exiting either way.
    });
  }
}

function printBanner(server: UiServer, root: string, log: (message: string) => void): void {
  const snapshot = readSnapshot({ root });

  log("");
  log(`  ${chalk.bold("mex dashboard")}  ${chalk.dim(`— ${snapshot.projectName}`)}`);
  log("");
  log(`  ${chalk.green("➜")}  ${chalk.bold(server.url)}`);
  log(`  ${chalk.dim("   watching")} ${chalk.dim(snapshot.projectRoot)}`);

  switch (snapshot.status) {
    case "empty":
      log(`  ${chalk.dim("   no .mex/ yet — the dashboard will walk you through setup")}`);
      break;
    case "error":
      log(`  ${chalk.yellow("!")}  ${chalk.yellow(snapshot.error?.message ?? "Scaffold could not be loaded")}`);
      break;
    case "ready":
      log(
        `  ${chalk.dim("   scaffold")} ${chalk.dim(
          `${snapshot.scaffold.populated}/${snapshot.scaffold.total} populated`,
        )}${chalk.dim(snapshot.graph.present ? ", code graph ready" : ", no code graph yet")}`,
      );
      break;
  }

  if (!server.assetDir) {
    log("");
    log(`  ${chalk.yellow("!")}  ${chalk.yellow("Frontend assets are missing.")} Run ${chalk.bold("npm run build:ui")}.`);
  }

  log("");
  log(`  ${chalk.dim("Press Ctrl+C to stop.")}`);
  log("");
}

/** Resolve on the first SIGINT/SIGTERM so the server can close cleanly. */
function waitForSignal(): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolvePromise();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

/**
 * Open `url` in the platform browser. Detached and fully ignored: a machine
 * without a browser (CI, a remote shell) must not fail or block `mex ui`.
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? // The empty title argument is required — `start "url"` treats a single
        // quoted argument as the window title and opens nothing.
        (["cmd", ["/c", "start", "", url]] as const)
      : process.platform === "darwin"
        ? (["open", [url]] as const)
        : (["xdg-open", [url]] as const);

  try {
    const child = crossSpawn(command, [...args], { stdio: "ignore", detached: true });
    child.on("error", () => {
      // No browser available — the printed URL is the fallback.
    });
    child.unref();
  } catch {
    // Same: never let opening a browser break the command.
  }
}
