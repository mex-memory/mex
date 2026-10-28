#!/usr/bin/env node
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { git } from "./lib/workspace.mjs";

export function captureScaffold({ workspace, subject, ref, replace = false }) {
  if (!/^refs\/eval\/scaffold-[\w-]+$/.test(ref)) throw new Error("use refs/eval/scaffold-<name>");
  if (!existsSync(join(workspace, ".mex", "AGENTS.md"))) throw new Error("finished workspace needs .mex/AGENTS.md");
  const previous = git(subject, ["rev-parse", "--verify", ref], { allowFailure: true }).stdout.trim();
  if (previous && !replace) throw new Error("scaffold ref already exists; pass --replace to update it");
  const files = []; let bytes = 0;
  function walk(path) {
    const full = join(workspace, path), stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`scaffold symlink refused: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(full)) if (!["local", "node_modules", ".git"].includes(name)) walk(`${path}/${name}`);
    } else if (!/\.(?:db|sqlite)(?:[.-].*)?$|\.tmp$|\.lock$/.test(path)) {
      bytes += stat.size; files.push(path);
      if (files.length > 10_000 || bytes > 64 * 1024 * 1024) throw new Error("canonical scaffold exceeds capture limit");
    }
  }
  walk(".mex");
  for (const name of ["AGENTS.md", "CLAUDE.md"]) if (existsSync(join(workspace, name))) walk(name);
  const temp = mkdtempSync(join(tmpdir(), "arm-scaffold-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(temp, "index") };
  const run = (args, input) => {
    const r = spawnSync("git", ["-C", subject, "-c", "user.name=mex-eval", "-c", "user.email=eval@localhost", ...args], { env, input, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout.trim();
  };
  try {
    run(["read-tree", "--empty"]);
    for (const file of files.sort()) {
      const sha = run(["hash-object", "-w", "--stdin"], readFileSync(join(workspace, file)));
      run(["update-index", "--add", "--cacheinfo", `100644,${sha},${file}`]);
    }
    const tree = run(["write-tree"]), commit = run(["commit-tree", tree], "eval: captured canonical scaffold\n");
    run(["update-ref", ref, commit, previous || "0".repeat(40)]);
    return { ref, commit, files, bytes, boundary: "subject-local Git ref; requires explicit Git sharing" };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), get = (name) => argv[argv.indexOf(name) + 1];
  for (const key of ["--workspace", "--subject", "--ref"]) if (!argv.includes(key) || !get(key)) throw new Error(`${key} required`);
  console.log(JSON.stringify(captureScaffold({ workspace: resolve(get("--workspace")), subject: resolve(get("--subject")), ref: get("--ref"), replace: argv.includes("--replace") }), null, 2));
}
