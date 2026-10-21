#!/usr/bin/env node
// A single isolated dependency installation shared by all session checkouts.
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../compare/lib/process.mjs";
import { git } from "./lib/workspace.mjs";

export function prepareDependencies({ subject, base, output, installer = null }) {
  const workspace = join(output, "project");
  if (existsSync(workspace)) throw new Error("dependency checkout already exists; reuse its node_modules");
  mkdirSync(output, { recursive: true });
  git(subject, ["worktree", "add", "--detach", workspace, base]);
  // Resolve the package-manager JS shim, since native spawn cannot execute .cmd files.
  const command = installer ?? [process.execPath, join(process.execPath, "..", "node_modules", "corepack", "dist", "pnpm.js")];
  const result = runSync(command[0], [...command.slice(1), "install", "--frozen-lockfile"], { cwd: workspace, timeoutMs: 1_800_000 });
  if (result.code !== 0) throw new Error(`dependency install failed: ${result.stderr || result.stdout}`);
  const deps = join(workspace, "node_modules");
  if (!existsSync(deps)) throw new Error("install produced no node_modules");
  writeFileSync(join(output, "dependencies.json"), `${JSON.stringify({ base: git(workspace, ["rev-parse", "HEAD"]).stdout.trim(), workspace, deps, command }, null, 2)}\n`);
  return deps;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), value = (key) => argv[argv.indexOf(key) + 1];
  if (!["--subject", "--base", "--output"].every((f) => argv.includes(f) && value(f))) throw new Error("--subject --base --output are required");
  process.stdout.write(`${prepareDependencies({ subject: resolve(value("--subject")), base: value("--base"), output: resolve(value("--output")), installer: argv.includes("--pnpm-entry") ? [process.execPath, resolve(value("--pnpm-entry"))] : null })}\n`);
}
