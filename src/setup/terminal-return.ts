import { spawn, type ChildProcess } from "node:child_process";

/** Exit 0 on Enter; exit 3 at end of input (Ctrl+D on POSIX, Ctrl+Z then Enter on Windows). */
const WAIT_FOR_ENTER = "process.stdin.on('data', d => { if (/[\\r\\n]/.test(String(d))) process.exit(0); });"
  + " process.stdin.on('end', () => process.exit(3));";

export interface TerminalReturnOptions {
  readonly spawn?: (command: string, args: readonly string[], options: { stdio: ["inherit", "ignore", "inherit"]; windowsHide: boolean }) => ChildProcess;
}

/**
 * Wait for Enter while the HUD is suspended.
 *
 * A short-lived child reads the inherited terminal, exactly like the native
 * agent handoff, so this process never reads stdin between Ink mounts. On
 * Windows, any parent read there (readline in either mode, or raw `data`)
 * leaves the next Ink renderer without input, and a cooked read still pending
 * at exit holds the process until another Enter. Readline's keypress decoder
 * also consumes the first key after Ink remounts. Ctrl+C reaches this process
 * as SIGINT; callers cancel on that signal and abort, which stops the child.
 */
export function waitForTerminalReturn(signal: AbortSignal, options: TerminalReturnOptions = {}): Promise<"return" | "cancel"> {
  if (signal.aborted) return Promise.resolve("cancel");
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = (options.spawn ?? spawn)(process.execPath, ["-e", WAIT_FOR_ENTER], { stdio: ["inherit", "ignore", "inherit"], windowsHide: true });
    } catch {
      // Without a reader the pause cannot complete; return to the HUD rather than strand it.
      resolve("return");
      return;
    }
    let settled = false;
    const finish = (result: "return" | "cancel") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* Already gone. */ }
      finish("cancel");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => finish("return"));
    child.once("exit", code => finish(code === 0 ? "return" : "cancel"));
  });
}
