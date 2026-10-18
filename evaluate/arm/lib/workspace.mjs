// Per-session subject checkouts for the agent-arm test.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, join } from "node:path";
import { runSync } from "../../compare/lib/process.mjs";

// Line endings follow the subject clone's core.autocrlf: grounding baselines hash the
// checked-out bytes, so checkouts must match the platform the scaffold was written on.
const GIT_IDENTITY = ["-c", "user.name=mex-eval", "-c", "user.email=eval@localhost"];
const SCAFFOLD_PATHS = [".mex", "CLAUDE.md", ".claude"];
const INDEX_FILES = ["graph.db", "wiki.db"];
// The product hooks read these from `.mex/local/`: the ranking index and the optional alias overlay.
const CONTEXT_INDEX = "context-index.json";
const CONTEXT_ALIASES = "context-aliases.json";

export function git(cwd, args, { allowFailure = false } = {}) {
  const result = runSync("git", [...GIT_IDENTITY, ...args], { cwd });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

export function resolveCommit(subjectRoot, ref) {
  return git(subjectRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
}

/** PATH for an arm: the frozen MEX bin first for the MEX arm; no other mex anywhere. */
export function armPath(basePath, { cliBin = null, withMex }) {
  const entries = String(basePath ?? "").split(delimiter).filter(Boolean)
    .filter((entry) => !/[\\/]AppData[\\/]Roaming[\\/]npm[\\/]?$/i.test(entry));
  return [...(withMex && cliBin ? [cliBin] : []), ...entries].join(delimiter);
}

/** The installed CLI entry point behind the frozen `mex` shim in `cliBin`. */
export function mexEntrypoint(cliBin) {
  return join(cliBin, "..", "mex-agent", "dist", "cli.js");
}

export function runMex(cliBin, args, cwd, env) {
  return runSync(process.execPath, [mexEntrypoint(cliBin), ...args], { cwd, env });
}

function linkDependencies(workspace, depsDir) {
  if (!depsDir) return;
  const target = join(workspace, "node_modules");
  if (existsSync(target)) throw new Error(`${target} already exists`);
  symlinkSync(depsDir, target, "junction");
}

/** Unlink the dependency junction itself; never recurse through it. */
export function unlinkDependencies(workspace) {
  const target = join(workspace, "node_modules");
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existsSync(target)) throw new Error(`refusing to continue: ${target} is not a removable link`);
}

/** Every arm: drop a marked section (from the line starting `deleteFrom` up to the line equal to `deleteTo`). */
function applyBasePatch(workspace, patch) {
  const path = join(workspace, patch.file);
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(patch.deleteFrom));
  if (start < 0) return;
  const end = lines.findIndex((line, i) => i > start && line.trim() === patch.deleteTo);
  lines.splice(start, (end < 0 ? lines.length : end) - start);
  writeFileSync(path, lines.join("\n"));
  git(workspace, ["add", "--", patch.file]);
}

/**
 * Check out the task base, add the scaffold for the MEX arm, link the shared
 * dependencies, and commit, so the session diff is exactly the agent's work.
 */
export function createWorkspace({ subjectRoot, workspace, base, scaffoldCommit = null, depsDir = null, appendInstructions = false, basePatches = [], stripPrototype = false, reuse = false }) {
  const timings = {}, started = Date.now();
  if (existsSync(workspace) && !reuse) throw new Error(`workspace already exists: ${workspace}`);
  mkdirSync(dirname(workspace), { recursive: true });
  if (existsSync(workspace)) resetWorkspace(workspace, base);
  else git(subjectRoot, ["worktree", "add", "--detach", workspace, base]);
  timings.checkoutMs = Date.now() - started;
  const scaffoldStarted = Date.now();
  // `appendInstructions` keeps the base's own CLAUDE.md and appends the
  // scaffold's MEX block, as `mex setup` does for an existing file.
  const ownInstructions = join(workspace, "CLAUDE.md");
  const baseInstructions = appendInstructions && existsSync(ownInstructions) ? readFileSync(ownInstructions, "utf8") : null;
  for (const path of SCAFFOLD_PATHS) {
    if (baseInstructions !== null && path === "CLAUDE.md") continue;
    if (existsSync(join(workspace, path))) git(workspace, ["rm", "-r", "-q", "--", path]);
  }
  for (const patch of basePatches) applyBasePatch(workspace, patch);
  if (scaffoldCommit) {
    const present = git(workspace, ["ls-tree", "--name-only", scaffoldCommit, "--", ...SCAFFOLD_PATHS]).stdout.split("\n").filter(Boolean);
    if (!present.includes(".mex")) throw new Error(`scaffold commit ${scaffoldCommit} has no .mex directory`);
    git(workspace, ["checkout", scaffoldCommit, "--", ...present]);
    if (baseInstructions !== null && present.includes("CLAUDE.md")) {
      writeFileSync(ownInstructions, `${baseInstructions.trimEnd()}\n\n${readFileSync(ownInstructions, "utf8")}`);
      git(workspace, ["add", "--", "CLAUDE.md"]);
    }
  }
  if (scaffoldCommit && stripPrototype) stripPrototypeHooks(workspace);
  timings.scaffoldMs = Date.now() - scaffoldStarted;
  const commitStarted = Date.now();
  git(workspace, ["commit", "-q", "--allow-empty", "-m", scaffoldCommit ? "eval: base with MEX scaffold" : "eval: base without MEX"]);
  timings.commitMs = Date.now() - commitStarted;
  linkDependencies(workspace, depsDir);
  return { head: git(workspace, ["rev-parse", "HEAD"]).stdout.trim(), timings };
}

/** Reuse one checkout, removing ignored agent artifacts and session state too. */
export function resetWorkspace(workspace, head, depsDir = null) {
  stopStrayProcesses(workspace);
  unlinkDependencies(workspace);
  git(workspace, ["checkout", "-f", "--detach", head]);
  git(workspace, ["clean", "-ffdx"]);
  linkDependencies(workspace, depsDir);
}

export function verifyWorkspace({ workspace, head, base, cachePath = null, withHooks = false, allowedSetupPaths = [] }) {
  if (git(workspace, ["rev-parse", "HEAD"]).stdout.trim() !== head) throw new Error("workspace HEAD differs from prepared base");
  if (git(workspace, ["merge-base", "--is-ancestor", base, head], { allowFailure: true }).code !== 0) throw new Error("task base is not the prepared workspace ancestor");
  const changed = git(workspace, ["diff", "--name-only", base, head]).stdout.trim().split("\n").filter(Boolean);
  if (changed.some((p) => !/^(?:\.mex(?:\/|$)|\.claude(?:\/|$)|CLAUDE\.md$)/.test(p) && !allowedSetupPaths.includes(p))) throw new Error("prepared source differs from task base");
  if (git(workspace, ["status", "--porcelain"]).stdout.trim()) throw new Error("workspace is dirty before session");
  const local = join(workspace, ".mex", "local");
  for (const name of ["context-sessions", "context-flags.json", "context-log.jsonl", "context-settle.lock", "context-settle.again"]) {
    if (existsSync(join(local, name))) throw new Error(`session state remains: ${name}`);
  }
  const hashes = {};
  for (const name of cachePath ? [...INDEX_FILES, ...(withHooks ? [CONTEXT_INDEX, CONTEXT_ALIASES] : [])] : []) {
    const source = join(cachePath, name);
    if (name === CONTEXT_ALIASES && !existsSync(source)) continue;
    const dest = join(workspace, ".mex", name.startsWith("context-") ? "local" : "", name);
    if (name.endsWith(".db") && existsSync(`${dest}-wal`) && statSync(`${dest}-wal`).size > 0) throw new Error(`index has pending WAL writes: ${name}`);
    const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
    hashes[name] = hash(dest);
    if (hashes[name] !== hash(source)) throw new Error(`cache hash mismatch: ${name}`);
  }
  return { head, taskBase: base, clean: true, hashes };
}


const PROTOTYPE_HOOK = ".claude/hooks/mex-push.mjs";
const PROTOTYPE_MARK = "mex-push.mjs";
const SKILLS_BLOCK = /<!-- mex-agent:skills:start -->[\s\S]*?<!-- mex-agent:skills:end -->\r?\n?/;

/**
 * Scaffolds written for the earlier push prototype carry its hook script, its
 * settings and its own `CLAUDE.md` wording. The product hooks replace all of
 * that, so those three leave the checkout (the scaffold ref itself is never
 * touched). The `mex-agent:skills` block goes whoever wrote it: setup's block
 * tells agents to pull knowledge through the CLI, which the hooks arms do not
 * measure, and every repo's hooks arm must see the same instructions (only the
 * block `mex hooks install` writes).
 */
export function stripPrototypeHooks(workspace) {
  if (existsSync(join(workspace, PROTOTYPE_HOOK))) git(workspace, ["rm", "-qf", "--", PROTOTYPE_HOOK]);
  const settings = join(workspace, ".claude", "settings.json");
  if (existsSync(settings) && readFileSync(settings, "utf8").includes(PROTOTYPE_MARK)) git(workspace, ["rm", "-qf", "--", ".claude/settings.json"]);
  const instructions = join(workspace, "CLAUDE.md");
  if (existsSync(instructions)) {
    const text = readFileSync(instructions, "utf8");
    const block = text.match(SKILLS_BLOCK)?.[0] ?? "";
    if (block) {
      const rest = text.replace(block, "");
      if (rest.trim() === "") git(workspace, ["rm", "-qf", "--", "CLAUDE.md"]);
      else { writeFileSync(instructions, rest); git(workspace, ["add", "--", "CLAUDE.md"]); }
    }
  }
}

export function workspaceProcessPattern(workspace) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths = [workspace.replace(/\//g, "\\"), workspace.replace(/\\/g, "/")];
  return `(?:${paths.map(escape).join("|")})(?:[\\\\/\\s"']|$)`;
}

/** Stop processes an agent left running inside the workspace (e.g. orphaned test workers). */
function stopStrayProcesses(workspace) {
  if (process.platform !== "win32") return;
  const quote = (value) => value.replace(/'/g, "''");
  const test = `$_.CommandLine -match '${quote(workspaceProcessPattern(workspace))}'`;
  runSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($(${test})) -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
}

/** Folder layout of a session: `<root>/<runId>/<projectName>`; the run folder goes with the checkout. */
export function removeWorkspace(subjectRoot, workspace, { removeParent = false } = {}) {
  removeCheckout(subjectRoot, workspace);
  if (removeParent) { try { rmdirSync(dirname(workspace)); } catch { /* not empty or already gone */ } }
}

function removeCheckout(subjectRoot, workspace) {
  if (!existsSync(workspace)) return;
  stopStrayProcesses(workspace);
  unlinkDependencies(workspace);
  git(subjectRoot, ["worktree", "remove", "--force", workspace], { allowFailure: true });
  try {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
  } catch (error) {
    // Windows: node's rm fails with EPERM on read-only test baselines that Remove-Item -Force clears.
    if (process.platform !== "win32") throw error;
    runSync("powershell", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${workspace.replace(/'/g, "''")}' -Recurse -Force`]);
    if (existsSync(workspace)) throw error;
  }
  git(subjectRoot, ["worktree", "prune"], { allowFailure: true });
}

/**
 * Build Graph and Wiki indexes once per base and scaffold, in a template checkout.
 *
 * With `hooks`, the template matches a hooks session (prototype hooks stripped, alias
 * overlay in place) and also gets the context index, so a session's first prompt does
 * not pay for it. The folder name is part of the index (it supplies project stop
 * words), so the template and every session use the same `projectName`.
 */
export function buildIndexCache({ subjectRoot, cacheDir, key, base, scaffoldCommit, cliBin, env, depsDir = null, projectName = "project", hooks = null, seedCache = null }) {
  const target = join(cacheDir, key);
  const wanted = hooks ? [...INDEX_FILES, CONTEXT_INDEX] : INDEX_FILES;
  if (wanted.every((name) => existsSync(join(target, name)))) return target;
  mkdirSync(target, { recursive: true });
  const template = join(cacheDir, `${key}.template`, projectName);
  removeWorkspace(subjectRoot, template, { removeParent: true });
  const timings = {};
  const timed = (label, args) => {
    const started = Date.now();
    const result = runMex(cliBin, args, template, env);
    timings[label] = Date.now() - started;
    if (result.code !== 0) throw new Error(`mex ${args.join(" ")} failed for ${key}: ${result.stderr || result.stdout}`);
    return result;
  };
  try {
    // Sessions link the dependencies, so the template must too: the compiler
    // reads their declarations, and a graph built without them makes every
    // session's first refresh fall back to a full extraction.
    createWorkspace({ subjectRoot, workspace: template, base, scaffoldCommit, depsDir, stripPrototype: Boolean(hooks) });
    if (seedCache) copyFileSync(join(seedCache, "graph.db"), join(template, ".mex", "graph.db"));
    timed("graphMs", seedCache ? ["graph", "refresh"] : ["graph"]);
    timed("wikiIndexMs", ["wiki", "rebuild-index"]);
    // The clean-state check report every session's loop-close result is diffed against.
    writeFileSync(join(target, "check-baseline.json"), runMex(cliBin, ["check", "--json"], template, env).stdout);
    for (const name of INDEX_FILES) copyFileSync(join(template, ".mex", name), join(target, name));
    if (hooks) {
      const local = join(template, ".mex", "local");
      mkdirSync(local, { recursive: true });
      if (hooks.aliasesFile) copyFileSync(hooks.aliasesFile, join(local, CONTEXT_ALIASES));
      timed("contextIndexMs", ["context", "index"]);
      copyFileSync(join(local, CONTEXT_INDEX), join(target, CONTEXT_INDEX));
      if (hooks.aliasesFile) copyFileSync(join(local, CONTEXT_ALIASES), join(target, CONTEXT_ALIASES));
    }
    writeFileSync(join(target, "build-info.json"), `${JSON.stringify({ key, base, scaffoldCommit, seedCache, graphMode: seedCache ? "refresh" : "build", timings, builtAt: new Date().toISOString() }, null, 2)}
`);
  } finally {
    removeWorkspace(subjectRoot, template, { removeParent: true });
  }
  return target;
}

/**
 * Rebuild only the context index of a cached base: the cached Graph and Wiki indexes are reused
 * as they are (no graph work), the template checkout supplies the scaffold's Markdown, and the
 * current frozen CLI recomputes entities and vectors. Used after the ranking changed which
 * entries are embedded.
 */
export function refreshContextIndexCache({ subjectRoot, cachePath, base, scaffoldCommit, cliBin, env, depsDir = null, projectName = "project", aliasesFile = null }) {
  const template = join(dirname(cachePath), `${basename(cachePath)}.template`, projectName);
  removeWorkspace(subjectRoot, template, { removeParent: true });
  try {
    createWorkspace({ subjectRoot, workspace: template, base, scaffoldCommit, depsDir, stripPrototype: true });
    for (const name of INDEX_FILES) copyFileSync(join(cachePath, name), join(template, ".mex", name));
    const local = join(template, ".mex", "local");
    mkdirSync(local, { recursive: true });
    const cachedAliases = join(cachePath, CONTEXT_ALIASES);
    const aliases = existsSync(cachedAliases) ? cachedAliases : aliasesFile;
    if (aliases) copyFileSync(aliases, join(local, CONTEXT_ALIASES));
    const started = Date.now();
    const result = runMex(cliBin, ["context", "index"], template, env);
    if (result.code !== 0) throw new Error(`mex context index failed for ${cachePath}: ${result.stderr || result.stdout}`);
    const contextIndexMs = Date.now() - started;
    copyFileSync(join(local, CONTEXT_INDEX), join(cachePath, CONTEXT_INDEX));
    if (aliases) copyFileSync(join(local, CONTEXT_ALIASES), join(cachePath, CONTEXT_ALIASES));
    const infoPath = join(cachePath, "build-info.json");
    const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, "utf8")) : {};
    writeFileSync(infoPath, `${JSON.stringify({ ...info, contextIndexRefreshedAt: new Date().toISOString(), contextIndexRefreshMs: contextIndexMs }, null, 2)}
`);
    return { contextIndexMs };
  } finally {
    removeWorkspace(subjectRoot, template, { removeParent: true });
  }
}

/** Copy cached indexes into a session checkout; rebuild there if they are not fresh. */
export function installIndexes({ workspace, cachePath, cliBin, env }) {
  for (const name of INDEX_FILES) copyFileSync(join(cachePath, name), join(workspace, ".mex", name));
  // Cache is pinned to the task base/scaffold by prepare.json; byte equality is
  // checked before every session. A status scan here rereads the whole subject.
  return { copiedFresh: true, verification: "prepared-base-and-sha256" };
}

/** Copy the cached context index (and alias overlay) into a hooks session's `.mex/local/`. */
export function installContextIndex({ workspace, cachePath }) {
  const local = join(workspace, ".mex", "local");
  mkdirSync(local, { recursive: true });
  copyFileSync(join(cachePath, CONTEXT_INDEX), join(local, CONTEXT_INDEX));
  const aliases = join(cachePath, CONTEXT_ALIASES);
  if (existsSync(aliases)) copyFileSync(aliases, join(local, CONTEXT_ALIASES));
  return { aliases: existsSync(aliases) };
}
