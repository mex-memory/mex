import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildGraph, refreshGraph } from "../maintenance.js";
import { currentGraphPath, graphLocation, readGraphPointer } from "../storage.js";
import { openGraphRead } from "../overlay-open.js";

/**
 * Acceptance: an overlay equals a fresh build on a 30-commit replay.
 *
 * Two worktrees of one repository share a base. One follows a branch through
 * 30 scripted commits (edits, new and deleted files, renamed functions, a file
 * that stops parsing and recovers); the other diverges on its own branch. At
 * every commit each worktree's graph, read through its base and overlay, must
 * equal a fresh full build of the same tree in a separate MEX home, row for row.
 */

const roots: string[] = [];
// Compare the v4 row digests and import bindings throughout the replay.
beforeEach(() => vi.stubEnv("MEX_GRAPH_STORAGE", "v4"));
afterEach(() => vi.unstubAllEnvs());

afterAll(() => {
  for (const root of roots.splice(0)) {
    try { git(root, "worktree", "prune"); } catch { /* not a repository */ }
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=replay", "-c", "user.email=replay@example.com", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
}
function put(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** Row images for every table a file owns, plus the whole-copy tables, without ids and times. */
const IMAGES: Record<string, string> = {
  nodes: "SELECT id, kind, name, qualified_name, container_id, identity_key, file_path, language, start_line, end_line, start_column, end_column, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract, decorators, type_parameters, return_type, body_hash FROM nodes",
  edges: "SELECT source, target, kind, metadata, line, col, provenance, confidence, resolution_method, evidence FROM edges",
  files: "SELECT path, content_hash, language, size, parse_status, diagnostic_count, missing_count, error_coverage, errors, node_count, extractor_version FROM files",
  unresolved_refs: "SELECT ref_key, from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language, receiver, qualifier, import_source, metadata, status, target_id, resolver FROM unresolved_refs",
  import_bindings: "SELECT * FROM import_bindings",
  coverage: "SELECT * FROM coverage",
  node_fingerprints: "SELECT node_id, hex(minhash), neighbors, token_count FROM node_fingerprints",
  lsh_buckets: "SELECT l.band, l.band_hash, f.node_id FROM lsh_buckets l JOIN node_fingerprints f ON f.ref = l.ref",
  source_chunks: "SELECT file_path, start_line, end_line, content_hash, path_terms, identifier_terms, comment_terms FROM source_chunks",
  file_row_digests: "SELECT * FROM file_row_digests",
  file_extraction_cache: "SELECT path, content_hash, hex(payload) FROM file_extraction_cache",
};

function images(root: string): Record<string, string[]> {
  const db = openGraphRead(root)!;
  try {
    const out: Record<string, string[]> = {};
    for (const [table, sql] of Object.entries(IMAGES)) {
      out[table] = (db.prepare(sql).all() as unknown[]).map(row => JSON.stringify(Object.values(row as object))).sort();
    }
    return out;
  } finally { db.close(); }
}

async function freshImages(root: string, home: string): Promise<Record<string, string[]>> {
  const previous = process.env.MEX_HOME;
  vi.stubEnv("MEX_HOME", home);
  try { await rebuildGraph(root); return images(root); }
  finally { if (previous === undefined) vi.unstubAllEnvs(); else vi.stubEnv("MEX_HOME", previous); }
}

function pyModule(name: string, calls: string[], body = "1"): string {
  return [
    ...calls.map(call => `from ${call} import ${call}_value`),
    "",
    `def ${name}_value():`,
    `    return ${[body, ...calls.map(call => `${call}_value()`)].join(" + ")}`,
    "",
  ].join("\n");
}

/** One scripted commit: deterministic, and every kind of edit appears. */
function edit(root: string, step: number): void {
  const modules = ["alpha", "beta", "gamma", "delta"];
  switch (step % 10) {
    case 0: put(root, `pkg/${modules[step % 4]}.py`, pyModule(modules[step % 4]!, [], String(step))); break;
    case 1: put(root, `pkg/extra_${step}.py`, pyModule(`extra_${step}`, ["alpha"])); break;
    case 2: { const old = `pkg/extra_${step - 1}.py`; if (existsSync(join(root, old))) unlinkSync(join(root, old)); break; }
    case 3: put(root, "web/util.ts", `export function scale${step}(value: number): number {\n  return value * ${step};\n}\n`);
      put(root, "web/app.ts", `import { scale${step} } from "./util";\n\nexport function app(): number {\n  return scale${step}(2);\n}\n`); break;
    case 4: put(root, "pkg/beta.py", "def beta_value(:\n  ((( ]] }} ::\n"); break;
    case 5: put(root, "pkg/beta.py", pyModule("beta", ["alpha"])); break;
    case 6: put(root, "web/app.ts", `${readFileSync(join(root, "web/app.ts"), "utf8")}\nexport const added${step} = app();\n`); break;
    case 7: put(root, "pkg/gamma.py", pyModule("gamma", ["alpha", "beta"], String(step))); break;
    case 8: put(root, `docs/note-${step}.md`, `note ${step}\n`); break;
    default: put(root, "pkg/delta.py", pyModule("delta", ["gamma"])); break;
  }
}

describe("overlays", () => {
  it("equal a fresh build at every commit of a 30-commit replay in two worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-overlay-replay-"));
    roots.push(root);
    const main = join(root, "main"), side = join(root, "side");
    const home = join(root, "home"), freshHome = join(root, "fresh-home");
    mkdirSync(main);
    vi.stubEnv("MEX_HOME", home);
    put(main, "pkg/alpha.py", pyModule("alpha", []));
    put(main, "pkg/beta.py", pyModule("beta", ["alpha"]));
    put(main, "pkg/gamma.py", pyModule("gamma", ["alpha"]));
    put(main, "pkg/delta.py", pyModule("delta", ["gamma"]));
    put(main, "web/util.ts", "export function scale(value: number): number {\n  return value * 2;\n}\n");
    put(main, "web/app.ts", "import { scale } from \"./util\";\n\nexport function app(): number {\n  return scale(2);\n}\n");
    put(main, "tsconfig.json", "{\"compilerOptions\":{\"strict\":true,\"module\":\"esnext\",\"moduleResolution\":\"bundler\"}}\n");
    put(main, ".gitignore", "ignored/\n");
    git(main, "init", "-q", "-b", "main");
    git(main, "add", ".");
    git(main, "commit", "-qm", "start");
    git(main, "worktree", "add", "-q", "-b", "side", side);

    await rebuildGraph(main);
    await refreshGraph(side);
    const sharedBase = readGraphPointer(graphLocation(main))!.base;
    expect(readGraphPointer(graphLocation(side))!.base).toBe(sharedBase);
    let overlays = 0;

    for (let step = 0; step < 30; step++) {
      edit(main, step);
      git(main, "add", "-A");
      git(main, "commit", "-q", "--allow-empty", "-m", `step ${step}`);
      await refreshGraph(main);
      if (step % 3 === 0) {
        edit(side, step + 5);
        git(side, "add", "-A");
        git(side, "commit", "-q", "--allow-empty", "-m", `side ${step}`);
        await refreshGraph(side);
      }
      for (const checkout of step % 3 === 0 ? [main, side] : [main]) {
        if (readGraphPointer(graphLocation(checkout))?.overlay) overlays++;
        const actual = images(checkout);
        const expected = await freshImages(checkout, freshHome);
        for (const table of Object.keys(IMAGES)) {
          expect(actual[table], `${checkout === main ? "main" : "side"} step ${step} ${table}`).toEqual(expected[table]);
        }
      }
    }
    // The replay must exercise overlays, not just new bases.
    expect(overlays).toBeGreaterThan(20);
    // Both worktrees still share one base unless a large change made a new one.
    expect(currentGraphPath(main)).not.toBe(currentGraphPath(side));
  }, 600_000);
});
