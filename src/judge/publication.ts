import { execFile, execFileSync } from "node:child_process";
import { KnowledgeError } from "../knowledge/contract.js";
import type { Position } from "./evidence.js";

/** Git owns the HEAD/ref locks and aborts on stdin EOF, including if the Node
 * worker dies. This verify-only transaction never commits or changes a ref. */
export async function withCheckoutPublication<T>(checkout: string, at: Position, publish: () => T): Promise<T> {
  if (!at.branch?.startsWith("refs/heads/") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(at.head ?? "")) {
    throw new KnowledgeError("GIT_BUSY", "A named Git position is required before publishing a team fix.");
  }
  let prepared = false, pending = "";
  let finish!: () => void, ready!: () => void, reject!: (error: unknown) => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const preparation = new Promise<void>((resolve, failed) => { ready = resolve; reject = failed; });
  const redirects = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_PREFIX"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !redirects.has(key)));
  const child = execFile("git", ["-C", checkout, "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false", "update-ref", "--stdin"], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16 << 10,
  }, () => {
    if (!prepared) reject(new KnowledgeError("GIT_BUSY", "Git could not guard the checkout; keep the fix in Review."));
    finish();
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split("\n"); pending = lines.pop()!.slice(-256);
    if (lines.some(line => line.replace(/\r$/u, "") === "prepare: ok")) { prepared = true; ready(); }
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.write(`start\nverify HEAD ${at.head}\nprepare\n`);
  try {
    await preparation;
    if (child.exitCode !== null || child.signalCode !== null) throw new KnowledgeError("GIT_BUSY", "The checkout guard ended before publication.");
    const read = (args: string[]) => execFileSync("git", ["-C", checkout, ...args], {
      env, encoding: "utf8", windowsHide: true, timeout: 1500, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    let matches = false;
    try { matches = read(["symbolic-ref", "--quiet", "HEAD"]) === at.branch && read(["rev-parse", "--verify", "HEAD"]) === at.head; }
    catch { /* A detached or unavailable position cannot authorize publication. */ }
    if (!matches) {
      throw new KnowledgeError("STALE_PREVIEW", "The branch changed before the publication guard was prepared.");
    }
    // The caller rechecks source, entry and consent under these same locks.
    return publish();
  } finally {
    if (!child.stdin?.writableEnded) child.stdin?.end("abort\n");
    await finished;
  }
}
