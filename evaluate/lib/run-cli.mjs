// Black-box CLI runner for the eval harness. Every measurement shells out to the
// built CLI (`dist/cli.js`) exactly as an agent would, and never imports MEX
// internals. Commands read `.mex/graph.db` from their cwd, so we spawn with
// cwd = the subject root.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
const CLI = resolve(REPO_ROOT, "dist", "cli.js");

/** Run `node dist/cli.js <args>` in `root`; returns { stdout, stderr, code }. */
export function runCli(args, root = REPO_ROOT) {
  if (!existsSync(CLI)) throw new Error(`dist/cli.js not found at ${CLI} — run \`npm run build\` first.`);
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", code: res.status ?? 1 };
}

/** Parse JSONL, skipping blank lines. Non-JSON lines throw (agents can't parse them either). */
export function parseJsonl(stdout) {
  return stdout.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/** (Re)build the graph in `root`. */
export function buildGraph(root = REPO_ROOT) {
  const { code, stderr } = runCli(["graph", "--json"], root);
  if (code !== 0) throw new Error(`graph build failed: ${stderr}`);
}
