/**
 * Scope guard for per-subsystem setup runs.
 *
 * Every agent session of the per-subsystem path may write only its batch file
 * (the shared and final sessions also their own scaffold files). MEX notices
 * any other change in `.mex/` and, cheaply, in tracked source files, and
 * reports it by name. It never reverts anything: the change may be the user's.
 *
 * The guard keeps one baseline. MEX takes the changes before and after each of
 * its own applies, so what an apply writes is never blamed on an agent.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MAX_WATCHED_FILES = 5_000;
const MAX_HASHED_BYTES = 4 * 1024 * 1024;
const GIT_STATUS_TIMEOUT_MS = 10_000;
const GIT_STATUS_BYTES = 8 * 1024 * 1024;

type Snapshot = Map<string, string>;

/** Canonical `.mex/` files, keyed `.mex/<path>`: everything but `local/` and the derived databases and their sidecars (`graph.db-audit.json`). */
function snapshotScaffold(projectRoot: string): Snapshot {
  const snapshot: Snapshot = new Map();
  const mexDir = resolve(projectRoot, ".mex");
  const visit = (relative: string): void => {
    if (snapshot.size >= MAX_WATCHED_FILES) return;
    let entries;
    try { entries = readdirSync(resolve(mexDir, relative), { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (relative === "" && entry.name === "local") continue;
        visit(path);
      } else if (entry.isFile() && !/\.db(?:$|[-.])/iu.test(entry.name) && !/\.tmp$/iu.test(entry.name)) {
        snapshot.set(`.mex/${path}`, fileStamp(resolve(mexDir, path)));
      }
      if (snapshot.size >= MAX_WATCHED_FILES) return;
    }
  };
  visit("");
  return snapshot;
}

function fileStamp(path: string): string {
  try {
    const stats = statSync(path);
    if (stats.size > MAX_HASHED_BYTES) return `${stats.size}:${stats.mtimeMs}`;
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

/** Tracked source files Git reports as changed, with a size and time stamp so a second edit shows too. */
function snapshotTrackedSource(projectRoot: string): Snapshot | null {
  let output: string;
  try {
    output = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no", "--", ".", ":(exclude).mex"], {
      cwd: projectRoot, encoding: "utf8", timeout: GIT_STATUS_TIMEOUT_MS, maxBuffer: GIT_STATUS_BYTES,
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
  } catch {
    return null;
  }
  const snapshot: Snapshot = new Map();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // A rename or copy carries its origin as the next record.
    if (status.includes("R") || status.includes("C")) index += 1;
    let stamp = status;
    try {
      const stats = statSync(resolve(projectRoot, path));
      stamp = `${status}:${stats.size}:${stats.mtimeMs}`;
    } catch { /* deleted: the status says so */ }
    snapshot.set(path, stamp);
    if (snapshot.size >= MAX_WATCHED_FILES) break;
  }
  return snapshot;
}

function changedPaths(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  for (const [path, stamp] of after) if (before.get(path) !== stamp) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

export interface ScopeGuardOptions {
  /** Also watch tracked source files through `git status` (default true). */
  readonly trackSource?: boolean;
}

export class ScopeGuard {
  readonly #projectRoot: string;
  readonly #trackSource: boolean;
  #scaffold: Snapshot;
  #source: Snapshot | null;

  constructor(projectRoot: string, options: ScopeGuardOptions = {}) {
    this.#projectRoot = resolve(projectRoot);
    this.#trackSource = options.trackSource !== false;
    this.#scaffold = snapshotScaffold(this.#projectRoot);
    this.#source = this.#trackSource ? snapshotTrackedSource(this.#projectRoot) : null;
  }

  /**
   * Files that changed since the last call (or since the guard was made), as
   * `.mex/...` or repository-relative source paths. They become the new baseline,
   * so each change is reported once.
   */
  take(): string[] {
    const scaffold = snapshotScaffold(this.#projectRoot);
    const changed = changedPaths(this.#scaffold, scaffold);
    this.#scaffold = scaffold;
    if (this.#trackSource) {
      const source = snapshotTrackedSource(this.#projectRoot);
      // Without Git status now or before, source changes are not judged.
      if (source !== null && this.#source !== null) changed.push(...changedPaths(this.#source, source));
      this.#source = source;
    }
    return changed;
  }
}

/** The paths of `changed` a unit was not allowed to write. */
export function outOfScope(changed: readonly string[], allowed: (path: string) => boolean): string[] {
  return changed.filter((path) => !allowed(path));
}
