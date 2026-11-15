/**
 * The `code-facts` job: one `git log` pass over the newest 2,000 commits,
 * then code-facts.json under the machine record. One batch, idempotent: a run
 * killed at any point leaves the previous file (written atomically) and the
 * runner redoes the batch.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { registerJobKind } from "../../record/jobs.js";
import type { RecordLocation } from "../../record/location.js";

export interface CodeFactsParams { checkout: string; }
export interface CodeFactsFile {
  version: 1;
  built_at: string;
  /** The checkout the history was read from; the background process re-reads it when its HEAD moves. */
  checkout?: string;
  head: string | null;
  commits_read: number;
  skipped: null | "shallow clone" | "no git" | "no commits";
  change_together: Array<{ a: string; b: string; confidence: number; support: number; kind: "test" | "mirror" | "related" }>;
  layer_rules: Array<{ from: string; to: string; imports: number }>;
  generated: Array<{ path: string; signal: "marker" | "gitattributes" | "history" }>;
  /** Why layer rules are empty when they couldn't be computed. */
  layers_skipped?: "no file index";
}

const MAX_FILES = 50_000;
const HEAD_BYTES = 1024;
const GIT_TIMEOUT_MS = 120_000;

/**
 * The long git reads run without blocking, so a waiting `mex` keeps drawing its progress and
 * answers Ctrl+C at once.
 */
function gitAsync(root: string, args: string[], maxBuffer = 64 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, "-c", "core.quotePath=off", ...args],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
const breathe = () => new Promise<void>(resolve => setImmediate(resolve));

function git(root: string, args: string[], maxBuffer = 64 << 20): string {
  return execFileSync("git", ["-C", root, "-c", "core.quotePath=off", ...args], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
}

function readHead(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function skippedFacts(skipped: NonNullable<CodeFactsFile["skipped"]>, head: string | null = null): CodeFactsFile {
  return { version: 1, built_at: new Date().toISOString(), head, commits_read: 0, skipped, change_together: [], layer_rules: [], generated: [] };
}


/** Build code facts for one checkout. Read-only git commands only. `progress` hears each step in plain words. */
export async function buildCodeFacts(root: string, projectId: string, location: RecordLocation, progress?: (text: string) => void): Promise<CodeFactsFile> {
  const mine = await import("./mine.js");
  let head: string;
  try {
    if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") return skippedFacts("shallow clone");
    head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
  } catch {
    try { git(root, ["rev-parse", "--git-dir"]); return skippedFacts("no commits"); } catch { return skippedFacts("no git"); }
  }
  // Separate commits, not merged pull requests as one change: on flask, where pull requests land
  // as merges, pairs learned from the merges' whole diffs held 0.82 against 0.93 from the commits.
  progress?.("reading the last 2,000 commits");
  const commits = mine.parseLog(await gitAsync(root, ["log", "--no-renames", "--no-merges", "--name-only", "--format=%x1e%H", "-n", String(mine.HISTORY_LIMITS.commits), head]));
  if (!commits.length) return skippedFacts("no commits", head);
  const tracked = (await gitAsync(root, ["ls-files", "-z"])).split("\0").filter(Boolean).slice(0, MAX_FILES);
  const current = new Set(tracked);
  const keep = (path: string) => current.has(path);

  const generated = new Map<string, CodeFactsFile["generated"][number]["signal"]>();
  for (let i = 0; i < tracked.length; i++) {
    if (i % 250 === 0) {
      progress?.(`${i.toLocaleString("en-US")} of ${tracked.length.toLocaleString("en-US")} files checked for generated code`);
      await breathe();
    }
    const path = tracked[i]!;
    if (mine.hasGeneratedMarker(readHead(join(root, ...path.split("/"))))) generated.set(path, "marker");
  }
  if (current.has(".gitattributes")) {
    let text = "";
    try { text = git(root, ["show", `${head}:.gitattributes`], 1 << 20); } catch { text = ""; }
    for (const path of mine.attributeGenerated(text, tracked)) if (!generated.has(path)) generated.set(path, "gitattributes");
  }
  for (const path of mine.historyGenerated(commits, keep)) if (!generated.has(path)) generated.set(path, "history");

  progress?.("finding files that change together, and layer rules");
  // Layer rules from the file index's import lists, at the package or top-level-folder grain.
  const { readFactFile } = await import("../facts.js");
  const recipes = readFactFile<{ version: number; packages?: Array<{ path: string; name: string }> }>(location, projectId, "recipes.json");
  const packages = (recipes?.packages ?? []).filter(pkg => pkg.path !== "");
  let layerRules: CodeFactsFile["layer_rules"] = [];
  let layersSkipped: CodeFactsFile["layers_skipped"];
  const { openIndex } = await import("../../file-index/read.js");
  const index = openIndex({ recordDirectory: location.directory, projectId, checkout: root });
  if (!index) layersSkipped = "no file index";
  else {
    try {
      const edges = new Map<string, Map<string, number>>();
      for (const file of index.importsByFile(MAX_FILES)) {
        const from = mine.unitOf(file.path, packages.map(pkg => pkg.path));
        if (!from) continue;
        for (const source of file.from) {
          const to = mine.importTarget(file.path, source, packages);
          if (!to || to === from) continue;
          let row = edges.get(from);
          if (!row) edges.set(from, row = new Map());
          row.set(to, (row.get(to) ?? 0) + 1);
        }
      }
      layerRules = mine.layerRules(edges);
    } finally { index.close(); }
  }

  return {
    version: 1, built_at: new Date().toISOString(), checkout: root, head, commits_read: commits.length, skipped: null,
    change_together: mine.changeTogether(commits, keep, mine.PAIR_PARAMS, path => generated.has(path)),
    layer_rules: layerRules,
    generated: [...generated].map(([path, signal]) => ({ path, signal })).sort((a, b) => a.path.localeCompare(b.path)).slice(0, mine.HISTORY_LIMITS.generated),
    ...(layersSkipped ? { layers_skipped: layersSkipped } : {}),
  };
}

registerJobKind<CodeFactsParams, { builds: number }>({
  name: "code-facts",
  label: "Code facts from git history",
  scope: "project",
  // One atomic file write; running the batch twice gives the same file.
  sideEffects: "idempotent",
  async runBatch({ job, params, checkpoint, writer, progress }) {
    const { readFactFile, writeFactFile } = await import("../facts.js");
    // HEAD hasn't moved since these facts were read from this checkout: nothing to re-read.
    const previous = readFactFile<CodeFactsFile>(writer.location, job.project_id!, "code-facts.json");
    if (previous && !previous.skipped && previous.head && previous.checkout === params.checkout) {
      let head: string | undefined;
      try { head = git(params.checkout, ["rev-parse", "--verify", "-q", "HEAD"]).trim(); } catch { head = undefined; }
      if (head === previous.head) {
        return { checkpoint: { builds: checkpoint?.builds ?? 0 }, done: true, results: 0, summary: `unchanged since ${head.slice(0, 7)}` };
      }
    }
    const facts = await buildCodeFacts(params.checkout, job.project_id!, writer.location, progress);
    // Test-only: prove a run killed mid-batch is redone and leaves no half-written file.
    if (process.env.MEX_REPO_START_KILL_AT === "code-facts") process.kill(process.pid, "SIGKILL");
    writeFactFile(writer.location, job.project_id!, "code-facts.json", facts);
    return {
      checkpoint: { builds: (checkpoint?.builds ?? 0) + 1 },
      done: true,
      results: facts.change_together.length + facts.layer_rules.length + facts.generated.length,
      summary: facts.skipped
        ? `skipped: ${facts.skipped}`
        : `${facts.commits_read} commits read: ${facts.change_together.length} change-together pairs, ${facts.layer_rules.length} layer rules, ${facts.generated.length} generated files`,
    };
  },
});
