// Replay schema v5 overlays against independent cold rebuilds of the same checkout.
// Bundle with the esbuild command in storage-parity.ts, replacing the entry and output names.
// MEX_GRAPH_ENGINE=<absolute mex-graph> node dist/graph-refresh-replay.mjs <repos-dir> [hono flask ripgrep novu random-ts random-python] [--arm=both|warm|refresh]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openGraphDatabase } from "../../src/graph/db/database.js";
import { GraphStore } from "../../src/graph/db/store.js";
import { v5Rows } from "../../src/graph/db/v5.js";
import { FingerprintStore } from "../../src/graph/fingerprint-store.js";
import { collectGraphGarbage, currentGraphPath, graphLocation, readGraphPointer } from "../../src/graph/storage.js";
import { openWarmCheckout } from "../../src/graph/warm.js";
import { benchmarkFiles, commentFor, insertCall } from "./edit-cases.js";

const cli = resolve(process.env.MEX_BENCH_CLI ?? "dist/cli.js");
const [, , reposDirectory, ...args] = process.argv;
if (!reposDirectory || !process.env.MEX_GRAPH_ENGINE) throw new Error("Pass the benchmark repos directory and set MEX_GRAPH_ENGINE.");
const arm = args.find(arg => arg.startsWith("--arm="))?.slice("--arm=".length) ?? "both";
if (!["both", "warm", "refresh"].includes(arm)) throw new Error(`Unknown replay arm ${arm}.`);
const requested = args.filter(arg => !arg.startsWith("--"));
const syntheticOnly = args.includes("--synthetic-only");
const steps = Number(args.find(arg => arg.startsWith("--steps="))?.slice(8) ?? "160");
if (!Number.isSafeInteger(steps) || steps < 1) throw new Error("Invalid randomized step count.");

const env = {
  ...process.env, MEX_GRAPH_ENGINE_LANGUAGES: "python,typescript,javascript,rust,csharp",
  MEX_GRAPH_STORAGE: "v5", MEX_TELEMETRY: "0", MEX_OFFLINE: "1", DO_NOT_TRACK: "1",
};
Object.assign(process.env, env);
const MiB = 1024 ** 2;
const free = () => {
  const stat = statfsSync(tmpdir(), { bigint: true });
  return Number(stat.bavail * stat.bsize);
};
const startingFree = free();
let minimumFree = startingFree;
function checkDisk() {
  minimumFree = Math.min(minimumFree, free());
  if (minimumFree < 2300 * MiB) throw new Error(`Disk guard: ${Math.floor(minimumFree / MiB)} MiB free.`);
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], {
  cwd, encoding: "utf8", maxBuffer: 4 * MiB,
}).trim();

function graphCommand(root: string, home: string, action: "rebuild" | "refresh") {
  checkDisk();
  const result = JSON.parse(execFileSync(process.execPath, [cli, "graph", action, "--json"], {
    cwd: root, env: { ...env, MEX_HOME: home }, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * MiB,
  }));
  checkDisk();
  if (result.status?.schemaVersion !== 5 || !["fresh", "degraded"].includes(result.status.status)) {
    throw new Error(`${action} failed to publish v5: ${JSON.stringify(result).slice(0, 2000)}`);
  }
  return result.refresh as { filesChanged: number; filesReextracted: number } | undefined;
}

function atHome<T>(home: string, read: () => T): T {
  const previous = process.env.MEX_HOME;
  process.env.MEX_HOME = home;
  try { return read(); }
  finally {
    if (previous === undefined) delete process.env.MEX_HOME;
    else process.env.MEX_HOME = previous;
  }
}

async function atHomeAsync<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MEX_HOME;
  process.env.MEX_HOME = home;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.MEX_HOME;
    else process.env.MEX_HOME = previous;
  }
}

function digest(rows: Iterable<unknown>) {
  const hash = createHash("sha256");
  let count = 0;
  for (const row of rows) { hash.update(JSON.stringify(row)).update("\n"); count++; }
  return { count, sha256: hash.digest("hex") };
}

/** Read the native rows directly. Surrogate keys and write clocks have no semantic identity. */
function rawRows(db: ReturnType<typeof openGraphDatabase>) {
  const t = (table: string) => v5Rows(db, table);
  const nodes = t("nodes");
  const files = t("files");
  const kinds = t("edge_kinds");
  const names = t("unresolved_names");
  const reasons = t("unresolved_reasons");
  const tables = {
    files: `SELECT f.path, hex(f.content_hash), l.name, f.size, f.parse_status, f.error_count, f.missing_count,
      f.error_coverage, f.extractor_version FROM ${files} f JOIN ${t("languages")} l ON l.id = f.language ORDER BY f.path`,
    resolution: `SELECT f.path, hex(r.digest) FROM ${t("file_resolution")} r
      JOIN ${files} f ON f.id = r.file ORDER BY f.path`,
    diagnostics: `SELECT f.path, d.position, d.code, d.start_line, d.end_line FROM ${t("file_diagnostics")} d
      JOIN ${files} f ON f.id = d.file ORDER BY f.path, d.position`,
    nodes: `SELECT hex(n.public_id) AS id, k.name AS kind, f.path, hex(p.public_id) AS parent, n.name,
      n.qualified_name, n.start_line, n.start_col, n.end_line, n.end_col, n.signature, n.flags,
      hex(n.body_hash) AS body_hash, n.docstring, n.visibility, n.return_type FROM ${nodes} n
      JOIN ${t("node_kinds")} k ON k.id = n.kind JOIN ${files} f ON f.id = n.file
      LEFT JOIN ${nodes} p ON p.id = n.parent ORDER BY id`,
    attributes: `SELECT hex(n.public_id) AS id, a.kind, a.position, a.value FROM ${t("node_attributes")} a
      JOIN ${nodes} n ON n.id = a.node ORDER BY id, a.kind, a.position`,
    edges: `SELECT hex(s.public_id) AS src, hex(d.public_id) AS dst, k.name AS kind, e.line, e.col,
      f.path, p.name AS provenance, e.confidence, m.name AS method, e.target_name, e.detail_kind, e.detail, e.argument
      FROM ${t("edges")} e JOIN ${nodes} s ON s.id = e.source JOIN ${nodes} d ON d.id = e.target
      JOIN ${kinds} k ON k.id = e.kind JOIN ${t("provenances")} p ON p.id = e.provenance
      JOIN ${t("resolution_methods")} m ON m.id = e.method LEFT JOIN ${files} f ON f.id = e.site_file
      ORDER BY src, dst, kind, e.line, e.col`,
    calls: `SELECT hex(s.public_id) AS src, n.name, w.name AS written, r.name AS reason, k.name AS kind,
      u.line, u.col, hex(c.public_id) AS candidate, v.name AS receiver FROM ${t("unresolved_calls")} u
      JOIN ${nodes} s ON s.id = u.source JOIN ${names} n ON n.id = u.name JOIN ${reasons} r ON r.id = u.reason
      JOIN ${kinds} k ON k.id = u.kind LEFT JOIN ${nodes} c ON c.id = u.candidate
      LEFT JOIN ${names} v ON v.id = u.receiver LEFT JOIN ${names} w ON w.id = u.written_name
      ORDER BY src, u.line, u.col, n.name, written, reason, kind, candidate, receiver`,
    unresolved: `SELECT hex(s.public_id) AS src, n.name, r.name AS reason, k.name AS kind, u.line, u.col
      FROM ${t("unresolved_other")} u JOIN ${nodes} s ON s.id = u.source JOIN ${names} n ON n.id = u.name
      JOIN ${reasons} r ON r.id = u.reason JOIN ${kinds} k ON k.id = u.kind ORDER BY src, u.line, u.col, n.name, reason, kind`,
    fingerprints: `SELECT hex(n.public_id) AS id, hex(f.minhash), f.token_count FROM ${t("fingerprints")} f
      JOIN ${nodes} n ON n.id = f.node ORDER BY id`,
    neighbours: `SELECT hex(n.public_id) AS id, hex(r.public_id) AS neighbour FROM ${t("fingerprint_neighbours")} f
      JOIN ${nodes} n ON n.id = f.node JOIN ${nodes} r ON r.id = f.neighbour ORDER BY id, neighbour`,
    chunks: `SELECT f.path, c.start_line, c.end_line FROM ${t("source_chunks")} c
      JOIN ${files} f ON f.id = c.file ORDER BY f.path, c.start_line`,
  };
  // A contentless FTS table still exposes the token counts of each indexed chunk.
  const overlay = t("files") !== "main.files";
  const fts = (schema: string) => `SELECT f.path, c.start_line, hex(x.sz)
    FROM ${schema}.source_chunks c JOIN ${schema}.files f ON f.id = c.file
    JOIN ${schema}.source_chunks_fts_docsize x ON x.id = c.id${schema === "base"
      ? " WHERE f.path NOT IN (SELECT path FROM main.shadow_files)" : ""}`;
  const chunks = `${fts("main")}${overlay ? " UNION ALL " + fts("base") : ""} ORDER BY 1, 2`;
  const result = Object.fromEntries(Object.entries(tables).map(([table, sql]) => [table, digest(db.prepare(sql).iterate())]));
  return { ...result, sourceTokens: digest(db.prepare(chunks).iterate()) };

}

function answers(root: string, home: string, queries: readonly string[], selected?: readonly string[]) {
  return atHome(home, () => {
    const db = openGraphDatabase(currentGraphPath(root), { readOnly: true, immutable: true });
    try {
      const store = new GraphStore(db);
      const sortedDigest = (rows: unknown[]) => digest(rows.map(row => JSON.stringify(row)).sort());
      const nodes = store.getAllNodes().map(({ updatedAt: _clock, ...node }) => node);
      const stable = nodes.filter(node => node.bodyHash).map(node => node.id).sort();
      // Point readers exercise integer references separately from raw full scans.
      const ids = selected ?? stable.filter((_, index) => index % Math.max(1, Math.floor(stable.length / 24)) === 0).slice(0, 24);
      const fingerprints = new FingerprintStore(db);
      return {
        ids,
        raw: rawRows(db),
        read: {
          nodes: sortedDigest(nodes), edges: sortedDigest(store.getAllEdges()), unresolved: sortedDigest(store.getAllUnresolvedRefs()),
          points: ids.map(id => ({ id, fingerprint: fingerprints.get(id), incoming: sortedDigest(store.getIncomingEdges(id)),
            outgoing: sortedDigest(store.getOutgoingEdges(id)) })),
          search: queries.map(query => ({ query, symbols: store.search(query, { limit: 30 }).map(node => node.id),
            source: store.searchSourceChunks(query, 20).map(({ id: _key, ...hit }) => hit) })),
        },
      };
    } finally { db.close(); }
  });
}

function firstDifference(left: unknown, right: unknown, path = "") : string | undefined {
  if (isDeepStrictEqual(left, right)) return undefined;
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const difference = firstDifference(a[key], b[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return `${path}: ${JSON.stringify(left)?.slice(0, 200)} != ${JSON.stringify(right)?.slice(0, 200)}`;
}

function history(root: string, input: string, name: string): string[] {
  const tip = git(root, "rev-parse", "HEAD");
  const revisions = () => git(root, "rev-list", "--first-parent", "--max-count=31", "--reverse", tip).split("\n");
  let commits = revisions();
  if (name === "hono" && commits.length < 31) {
    const upstream = git(input, "remote", "get-url", "origin");
    git(root, "fetch", "--quiet", "--no-tags", "--depth=31", upstream, tip);
    commits = revisions();
  }
  if (name === "hono" && commits.length !== 31) throw new Error("Hono requires 31 first-parent commits including the initial base.");
  return commits;
}

interface ReplayEdit {
  label: string;
  paths: string[];
  apply(): void;
}

function flaskEdits(root: string): ReplayEdit[] {
  const folder = join(root, "mex_replay");
  const write = (path: string, source: string) => writeFileSync(join(folder, path), source);
  const leaf = (func: string, method: string) => `class Parent:\n    def ${method}(self):\n        return 13\n\ndef ${func}(value):\n    return value * 29 + value ** 2 - 11\n`;
  const route = (path: string) => `from flask import Flask\nfrom . import Parent, handler\napp = Flask(__name__)\n\nclass Child(Parent):\n    def run(self):\n        return self.work() + handler(7)\n\n@app.get('${path}')\ndef mexReplayHandler():\n    return str(Child().run())\n`;
  const edits = [
    { label: "add package and Flask route", paths: ["leaf.py", "__init__.py", "routes.py"], apply() {
      mkdirSync(folder);
      write("leaf.py", leaf("handler", "work"));
      write("__init__.py", "from .leaf import Parent, handler\n");
      write("routes.py", route("/replay-before"));
    } },
    { label: "rename and re-export a symbol", paths: ["leaf.py", "__init__.py"], apply() {
      write("leaf.py", leaf("renamed", "work"));
      write("__init__.py", "from .leaf import Parent, renamed as handler\n");
    } },
    { label: "move the defining module", paths: ["leaf.py", "moved.py", "__init__.py"], apply() {
      renameSync(join(folder, "leaf.py"), join(folder, "moved.py"));
      write("__init__.py", "from .moved import Parent, renamed as handler\n");
    } },
    { label: "change inherited method and route", paths: ["moved.py", "routes.py"], apply() {
      write("moved.py", leaf("renamed", "stop"));
      write("routes.py", route("/replay-after"));
    } },
    { label: "delete the defining module", paths: ["moved.py"], apply() { rmSync(join(folder, "moved.py")); } },
    { label: "remove the added package", paths: ["__init__.py", "routes.py"], apply() { rmSync(folder, { recursive: true }); } },
  ];
  return edits.map(edit => ({ ...edit, paths: edit.paths.map(path => `mex_replay/${path}`) }));
}

function ripgrepEdits(root: string): ReplayEdit[] {
  const file = "crates/grep/src/lib.rs";
  return [{ label: "add a public Rust function and its caller", paths: [file], apply() {
    appendFileSync(join(root, file), "\npub fn mex_replay_export() -> u32 { 73 }\npub fn mex_replay_call() -> u32 { mex_replay_export() }\n");
  } }];
}

type BenchmarkRepo = keyof typeof benchmarkFiles;
type Language = "ts" | "py" | "rs";

function fixture(language: Language, state: {
  prepend: number; calls: number; renamed: boolean; exported: boolean; extra: boolean; forwarded: boolean;
  secondImport: boolean; wiringOffset: number;
}): Record<string, string | undefined> {
  const name = state.renamed ? "renamed" : "handler";
  const other = state.forwarded ? "another" : name;
  const call = language === "py" ? "    " : "  ";
  const positions = (language === "py" ? "# shift\n" : "// shift\n").repeat(state.prepend);
  const calls = Array.from({ length: state.calls }, () => `${call}${name}()`).join("\n");
  if (language === "ts") return {
    "leaf.ts": `${positions}${state.exported ? "export " : ""}function ${name}() { return 73; }\nexport function another() { return 12; }\nexport function local() {\n${calls}\n  return ${name}();\n}\n`,
    "barrel.ts": state.forwarded
      ? `export { another as run } from './leaf';\n`
      : `export { ${name} as run } from './leaf';\nexport * from './leaf';\n`,
    "caller.ts": `${"// moved callback\n".repeat(state.wiringOffset)}import { run } from '${state.secondImport ? "./second" : "./barrel"}';\nimport { relay, callback } from './wiring';\nexport function use() {\n  return run();\n}\nrelay(callback);\n`,
    "wiring.ts": "export function relay(fn: () => void) { fn(); }\nexport function callback() { return 31; }\n",
    "second.ts": "export * from './barrel';\n",
    "extra.ts": state.extra ? "export { run } from './barrel';\n" : undefined,
    "missing.ts": "import { run } from './extra';\nexport function test() { run(); }\n",
    "wiring-again.ts": "import { relay, callback } from './wiring';\n\n\n\n\nrelay(callback);\n",
  };
  if (language === "py") return {
    "leaf.py": `${positions}def ${name}():\n    return 73\n\ndef another():\n    return 12\n\ndef local():\n${calls}\n    return ${name}()\n`,
    "__init__.py": `${state.exported ? `from .leaf import ${other} as run\n` : ""}`,
    "caller.py": `from ${state.secondImport ? ".second" : "."} import run\ndef use():\n    return run()\n`,
    "second.py": "from . import run\n",
    "extra.py": state.extra ? "from . import run\n" : undefined,
    "missing.py": "from .extra import run\ndef test():\n    run()\n",
  };
  return {
    "leaf.rs": `${positions}${state.exported ? "pub " : ""}fn ${name}() -> u32 { 73 }\npub fn another() -> u32 { 12 }\npub fn local() -> u32 {\n${calls.replaceAll("()", "();")}\n  ${name}()\n}\n`,
    "lib.rs": `mod leaf;\npub use crate::leaf::${other} as run;\nmod caller;\nmod extra;\nmod missing;\n`,
    "caller.rs": "use crate::run;\npub fn call() -> u32 { run() }\n",
    "extra.rs": state.extra ? "pub use crate::leaf::another as run;\n" : undefined,
    "missing.rs": "pub fn test() -> u32 { crate::extra::run() }\n",
  };
}

function mixedEdits(root: string, language: Language, random?: number): ReplayEdit[] {
  const folder = "mex_edit_fixture";
  const state = {
    prepend: 0, calls: 0, renamed: false, exported: true, extra: false, forwarded: false,
    secondImport: false, wiringOffset: 0,
  };
  const render = () => {
    mkdirSync(join(root, folder), { recursive: true });
    for (const [file, contents] of Object.entries(fixture(language, state))) {
      const target = join(root, folder, file);
      if (contents === undefined) rmSync(target, { force: true });
      else if (!existsSync(target) || readFileSync(target, "utf8") !== contents) writeFileSync(target, contents);
    }
  };
  const paths = Object.keys(fixture(language, state)).map(file => `${folder}/${file}`);
  const edit = (label: string, change: () => void) => ({ label, paths, apply() { change(); render(); } });
  const toggles = [
    edit("prepend a line", () => { state.prepend = (state.prepend + 1) % 9; }),
    edit("insert a call", () => { state.calls++; }),
    edit("remove a call", () => { if (state.calls) state.calls--; else state.calls++; }),
    edit("rename function and calls", () => { state.renamed = !state.renamed; }),
    edit("change export", () => { state.exported = !state.exported; }),
    edit("toggle extra file", () => { state.extra = !state.extra; }),
    edit("change re-export", () => { state.forwarded = !state.forwarded; state.exported = true; }),
  ];
  if (random !== undefined) {
    // A renderer leaves untouched files byte- and stat-identical.
    render();
    let seed = random;
    const next = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return seed >>> 0;
    };
    toggles.push(edit("redirect importer", () => { state.secondImport = !state.secondImport; }));
    return Array.from({ length: steps }, () => toggles[next() % toggles.length]!);
  }
  return [
    { label: "install edit fixture", paths, apply: render },
    ...toggles.slice(0, 5),
    { ...toggles[5]!, label: "add extra file" },
    { ...toggles[5]!, label: "delete extra file" },
    toggles[6]!,
    ...(language === "ts" ? [edit("move a colliding callback site", () => { state.wiringOffset++; })] : []),
  ];
}

function syntheticEdits(root: string, name: BenchmarkRepo): ReplayEdit[] {
  const path = benchmarkFiles[name];
  const file = join(root, path);
  let before: string;
  return [
    { label: "prepend on the benchmark file", paths: [path], apply() {
      writeFileSync(file, commentFor(path) + readFileSync(file, "utf8"));
    } },
    { label: "insert a call in the benchmark file", paths: [path], apply() {
      before = readFileSync(file, "utf8");
      writeFileSync(file, insertCall(path, before));
    } },
    { label: "remove the inserted call", paths: [path], apply() { writeFileSync(file, before); } },
    ...mixedEdits(root, name === "flask" ? "py" : name === "ripgrep" ? "rs" : "ts"),
  ];
}

const probeQueries: Record<string, string[]> = {
  hono: ["hono compose middleware", "router", "getCookie", "html", "body stream", "context req"],
  flask: ["flask route view", "dispatch_request", "blueprint", "render_template", "mexReplayHandler", "renamed", "url_for"],
  ripgrep: ["mex_replay_export", "mex_replay_call", "grep", "searcher", "matcher", "printer"],
  novu: ["consumer", "AppModule", "run", "handler", "wiring"],
  nest: ["NestFactory", "createProxy", "handler", "wiring"],
  "random-ts": ["handler", "renamed", "callback", "use", "extra", "run"],
  "random-python": ["handler", "renamed", "use", "extra", "run"],
};

for (const name of requested.length ? requested : ["hono", "flask", "ripgrep"]) {
  const queries = probeQueries[name];
  if (!queries) throw new Error(`Unknown replay repository ${name}.`);
  checkDisk();
  if (name === "novu" && free() < 4 * 1024 ** 3) throw new Error("Novu replay requires at least 4 GiB free.");
  const scratch = mkdtempSync(join(tmpdir(), `mex-${name}-refresh-replay-`));
  try {
    const root = join(scratch, "repo");
    const random = name === "random-ts" || name === "random-python";
    let commits: string[];
    let edits: ReplayEdit[];
    if (random) {
      mkdirSync(root);
      git(root, "init", "--quiet");
      edits = mixedEdits(root, name === "random-ts" ? "ts" : "py",
        name === "random-ts" ? 0x7352a31 : 0x7352b74);
      git(root, "add", ".");
      git(root, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@localhost",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "seed benchmark fixture");
      commits = [git(root, "rev-parse", "HEAD")];
    } else {
      const input = resolve(name === "hono" && process.env.MEX_BENCH_HONO_HISTORY || join(reposDirectory, name));
      git(scratch, "-c", "advice.detachedHead=false", "-c", "core.autocrlf=false", "clone", "--quiet", "--shared", input, root);
      commits = syntheticOnly ? [git(root, "rev-parse", "HEAD")] : history(root, input, name);
      git(root, "checkout", "--quiet", "--detach", commits[0]!);
      edits = syntheticOnly ? [] : name === "hono" ? commits.slice(1).map((label, index) => ({
        label,
        paths: git(root, "diff", "--name-only", "-z", "--no-renames", commits[index]!, label).split("\0").filter(Boolean),
        apply: () => { git(root, "checkout", "--quiet", "--detach", label); },
      })) : name === "flask" ? flaskEdits(root) : name === "ripgrep" ? ripgrepEdits(root) : [];
      edits.push(...syntheticEdits(root, name as BenchmarkRepo));
    }
    const refreshHome = join(scratch, "refresh");
    const warmHome = join(scratch, "warm");
    const freshHome = join(scratch, "fresh");
    if (arm !== "warm") graphCommand(root, refreshHome, "rebuild");
    const warm = arm === "refresh" ? undefined : await atHomeAsync(warmHome, async () => {
      graphCommand(root, warmHome, "rebuild");
      return openWarmCheckout(root);
    });
    const overlays = { refresh: 0, warm: 0 };
    let compared = 0;
    let pointReads = 0;
    const locations = [
      ...(arm === "warm" ? [] : [["refresh", refreshHome] as const]),
      ...(warm ? [["warm", warmHome] as const] : []),
    ].map(([kind, home]) => ({ kind, home, location: atHome(home, () => graphLocation(root)) }));
    try {
      for (const edit of edits) {
        edit.apply();
        const refresh = arm === "warm" ? undefined : graphCommand(root, refreshHome, "refresh");
        const result = warm ? await atHomeAsync(warmHome, () => warm.edit(edit.paths)) : undefined;
        if (result && result.status !== "published") throw new Error(`${name} ${edit.label} warm: ${result.status} (${result.reason ?? ""})`);
        try {
          graphCommand(root, freshHome, "rebuild");
          const fresh = answers(root, freshHome, queries);
          for (const { kind, home, location } of locations) {
            if (readGraphPointer(location)?.overlay) overlays[kind]++;
            const difference = firstDifference(answers(root, home, queries, fresh.ids), fresh);
            if (difference) throw new Error(`${name} ${edit.label} ${kind}${difference}`);
            collectGraphGarbage(location, Date.now() + 120_000);
          }
          compared++;
          pointReads += fresh.ids.length;
          console.log(JSON.stringify({ repo: name, step: compared, revision: edit.label, refresh, warm: result?.ms, raw: fresh.raw }));
        } finally { rmSync(freshHome, { recursive: true, force: true }); }
        checkDisk();
      }
      console.log(JSON.stringify({ repo: name, base: commits[0], tip: commits.at(-1), compared, overlays, pointReads,
        searches: 2 * compared * queries.length, differences: 0 }));
    } finally { warm?.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ freeAtStartMiB: Math.floor(startingFree / MiB), minimumFreeMiB: Math.floor(minimumFree / MiB) }));
