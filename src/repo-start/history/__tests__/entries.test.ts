import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildIndex } from "../../../file-index/build.js";
import { indexDirectory, readPatterns } from "../../../file-index/store.js";
import { runNative } from "../../../knowledge/check.js";
import { parseEntry, type EntryCheck, type KnowledgeEntry } from "../../../knowledge/entry.js";
import type { ObserveChecks } from "../../../knowledge/gate.js";
import { readNotes } from "../../../knowledge/personal-store.js";
import { openRecord } from "../../../record/index.js";
import { ownerId, runOneBatch } from "../../../record/jobs.js";
import { queueJob } from "../../../record/background.js";
import type { RecordLocation } from "../../../record/location.js";
import { realPath } from "../../../record/project.js";
import { writeFactFile } from "../../facts.js";
import { scanRecipes } from "../../recipes/index.js";
import { actionsPathGlob, ignoreStyleGlob, proposeCodeFacts } from "../entries.js";
import { buildCodeFacts } from "../job.js";
import { generatedMarker, hasGeneratedMarker } from "../mine.js";

const temps: string[] = [];
afterAll(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
}
function commit(root: string, files: Record<string, string>, message: string): void {
  write(root, files);
  git(root, "add", "-A"); git(root, "commit", "-qm", message);
}

interface Fixture { root: string; projectId: string; location: RecordLocation; }
/** A repository in a temp folder, registered with a MEX home beside it. `history` pads it past the small-repo bar. */
function fixture(files: Record<string, string>, options: { history?: boolean; commits?: Array<Record<string, string>> } = {}): Fixture {
  const base = realPath(mkdtempSync(join(tmpdir(), "mex-fact-entries-"))); temps.push(base);
  const root = join(base, "repo"); mkdirSync(root);
  git(root, "init", "-q"); git(root, "config", "core.autocrlf", "false");
  const pad: Record<string, string> = {};
  if (options.history) for (let i = 0; i < 30; i++) pad[`misc/pad${i}.ts`] = `export const pad${i} = ${i};\n`;
  commit(root, { ...files, ...pad }, "init");
  for (const [i, change] of (options.commits ?? []).entries()) commit(root, change, `change ${i}`);
  if (options.history) for (let i = 0; i < 50; i++) git(root, "commit", "-q", "--allow-empty", "-m", `pad ${i}`);
  const writer = openRecord({ home: join(base, "home"), projectPath: root, isNetwork: () => false });
  try { return { root, projectId: writer.checkout(root)!.project_id, location: writer.location }; } finally { writer.close(); }
}

/** What `mex` does before the code-facts job: the file index and recipes.json. */
async function prepare(f: Fixture, binary: string | null = null): Promise<void> {
  await buildIndex({ root: f.root, projectId: f.projectId, recordDirectory: f.location.directory, workers: 0 });
  writeFactFile(f.location, f.projectId, "recipes.json", scanRecipes({ root: f.root, binary, projectId: f.projectId, recordDirectory: f.location.directory }));
}
async function mine(f: Fixture) {
  let commits: Array<{ files: string[] }> | undefined;
  const facts = await buildCodeFacts(f.root, f.projectId, f.location, undefined, read => { commits = read; });
  return { facts, commits };
}

const FAKE_HASH = `sha256:${"1".repeat(64)}`;
/** The evaluator's stand-in: echoes stated observations and makes up the rest. */
const observeChecks: ObserveChecks = checks => checks.map(check => {
  const saw = check.saw ?? ({ key: { value: "observed" }, command: { exists: true }, source: { hash: FAKE_HASH }, pattern: { count: 0 } } as Record<string, unknown>)[check.kind];
  return { check: { ...check, saw, files: {} } as EntryCheck };
});

async function run(f: Fixture, now = new Date("2026-11-20T12:00:00Z")) {
  const { facts, commits } = await mine(f);
  return proposeCodeFacts({ checkout: f.root, projectId: f.projectId, location: f.location, facts, commits }, { observeChecks, now });
}
function stored(f: Fixture): KnowledgeEntry[] {
  return [...readNotes(f.location.home, f.projectId).files.values()].map(parseEntry).filter(entry => entry.mex.source.producer === "code-facts");
}
const active = (f: Fixture) => stored(f).filter(entry => entry.mex.status === "active");
const byScope = (entries: KnowledgeEntry[], scope: string) => entries.find(entry => entry.mex.scope.includes(scope));
const accepted = (results: unknown[] | undefined) => (results ?? []).filter(result => (result as { status: string }).status === "accepted").length;

describe("glob dialects", () => {
  it("turns .gitattributes and CODEOWNERS patterns into scope globs only when they mean the same files", () => {
    expect(ignoreStyleGlob("*.snap", false)).toBe("**/*.snap");
    expect(ignoreStyleGlob("/gen/**", false)).toBe("gen/**");
    expect(ignoreStyleGlob("docs/api/*.md", false)).toBe("docs/api/*.md");
    expect(ignoreStyleGlob("/apps/api/", true)).toBe("apps/api/**");
    expect(ignoreStyleGlob("/docs", true)).toBe("docs/**");
    expect(ignoreStyleGlob("apps/", true)).toBe("**/apps/**");
    expect(ignoreStyleGlob("[ab].ts", true)).toBeUndefined();
    expect(ignoreStyleGlob("a**b/c", true)).toBeUndefined();
    expect(actionsPathGlob("src/**")).toBe("src/**");
    expect(actionsPathGlob("**.go")).toBe("**/*.go");
    expect(actionsPathGlob("docs/")).toBe("docs/**");
    expect(actionsPathGlob("!src/legacy/**")).toBeUndefined();
    expect(actionsPathGlob("src/v?.ts")).toBeUndefined();
    expect(actionsPathGlob("**")).toBeUndefined();
  });

  it("reads explicit auto-generated headers, never the bare word", () => {
    expect(generatedMarker("/* This file is auto-generated from schema.json */\n")).toBe("This file is auto-generated");
    expect(generatedMarker("// Code generated by protoc-gen-go. DO NOT EDIT.\n")).toBe("DO NOT EDIT");
    expect(hasGeneratedMarker("// ids are auto-generated by the database\n")).toBe(true);
    expect(hasGeneratedMarker("// the id is auto-generated\nexport const x = 1;\n")).toBe(false);
  });
});

describe("generated files and headers", () => {
  let f: Fixture;
  const marker = (tool: string, body: string) => `// Code generated by ${tool}. DO NOT EDIT.\n${body}\n`;
  beforeAll(async () => {
    f = fixture({
      "gen/a.ts": marker("protoc-gen-ts", "export const a = 1;"), "gen/b.ts": marker("protoc-gen-ts", "export const b = 1;"),
      "gen/nested/c.ts": marker("protoc-gen-ts", "export const c = 1;"),
      "src/api.pb.go": marker("protoc-gen-go", "package src"), "lib/x.pb.go": marker("protoc-gen-go", "package lib"),
      "lib/keep.go": "package lib\n", "pkg/y.pb.go": marker("protoc-gen-go", "package pkg"),
      "src/one.ts": "/* This file is auto-generated from schema.json */\nexport const one = 1;\n", "src/main.ts": "export const main = 1;\n",
      ".gitattributes": "*.snap linguist-generated\n/docs/** -diff\n", "ui/a.snap": "x\n", "ui/b/c.snap": "y\n",
      "proto/api.proto": "syntax = \"proto3\";\n", "out/api.ts": "export {};\n",
    }, {
      history: true,
      commits: [0, 1].map(i => ({ "proto/api.proto": `syntax = "proto3"; // ${i}\n`, "out/api.ts": `export {}; // ${i}\n` })),
    });
    await prepare(f);
  }, 120_000);

  it("groups by folder and suffix, reads .gitattributes, and names the generator from history", { timeout: 60_000 }, async () => {
    const result = await run(f);
    expect(result.complete).toBe(true);
    expect(result.summary).toMatch(/^entries: generated 5 saved, 0 to Review, 0 dropped; layer 0 saved/u);
    const entries = active(f);
    expect(entries.map(entry => entry.mex.scope[0]).sort()).toEqual(["**/*.pb.go", "**/*.snap", "gen/**", "out/api.ts", "src/one.ts"]);
    for (const entry of entries) {
      expect(entry.mex).toMatchObject({ kind: "pitfall", evidence: "mined", source: { producer: "code-facts" } });
      expect(entry.mex.source.label).toMatch(/^mined from code, \d+ of \d+ /u);
      expect(`${entry.mex.one_line} ${entry.text}`).toMatch(/generated/u);
      expect(entry.mex.checks.map(check => check.role)).toEqual(["complete"]);
    }
    expect(byScope(entries, "gen/**")).toMatchObject({
      text: "Files under `gen/` are generated (each carries a `DO NOT EDIT` header, written by `protoc-gen-ts`). Don't edit them by hand; change what generates them and regenerate.",
      mex: { source: { label: "mined from code, 3 of 3 files carry a generated header" },
        checks: [{ kind: "pattern", target: { scope: "gen/**", pattern: "DO NOT EDIT" }, saw: { count: 3 } }] },
    });
    expect(byScope(entries, "**/*.pb.go")!.mex.checks[0]).toMatchObject({ target: { scope: "**/*.pb.go", pattern: "DO NOT EDIT" }, saw: { count: 3 } });
    expect(byScope(entries, "src/one.ts")!.mex.checks[0]).toMatchObject({ target: { scope: "src/one.ts", pattern: "This file is auto-generated" }, saw: { count: 1 } });
    expect(byScope(entries, "**/*.snap")).toMatchObject({
      mex: { source: { ref: ".gitattributes", label: "mined from code, 2 of 2 matching files marked generated" },
        checks: [{ kind: "pattern", target: { scope: ".gitattributes", pattern: "*.snap linguist-generated" }, saw: { count: 1 } }] },
    });
    expect(byScope(entries, "out/api.ts")).toMatchObject({
      text: expect.stringContaining("`out/api.ts` is generated from `proto/api.proto`"),
      mex: { source: { label: "mined from code, 3 of 3 changes came with api.proto" }, checks: [{ kind: "source", target: { file: "out/api.ts" } }] },
    });
    // The literals are counted by the file index the evaluator reads.
    expect(readPatterns(indexDirectory(f.location.directory, f.projectId)).map(item => item.pattern)).toEqual(
      expect.arrayContaining(["DO NOT EDIT", "This file is auto-generated", "*.snap linguist-generated"]));
  });

  it("changes nothing on a re-run and retires an entry whose fact is gone", { timeout: 60_000 }, async () => {
    const again = await run(f);
    expect(again.results.generated!.every(result => result.status === "accepted" && result.change === "unchanged")).toBe(true);
    commit(f.root, { ".gitattributes": "/docs/** -diff\n" }, "no generated snapshots");
    await buildIndex({ root: f.root, projectId: f.projectId, recordDirectory: f.location.directory, workers: 0 });
    const after = await run(f);
    expect(accepted(after.results.generated)).toBe(4);
    const gone = stored(f).find(entry => entry.mex.scope.includes("**/*.snap"))!;
    expect(gone.mex).toMatchObject({ status: "retired", retired: { by: "mex code-facts refresh" } });
    expect(active(f)).toHaveLength(4);
  });
});

describe("layer rules", () => {
  it("bans the precise import literals of the upper layer, and skips a folder reached only by relative paths", { timeout: 120_000 }, async () => {
    const importDb = (name: string) => `import { db } from "@acme/db";\nexport const ${name} = db;\n`;
    const f = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/db/package.json": JSON.stringify({ name: "@acme/db" }), "packages/db/index.ts": "export const db = 1;\n",
      "packages/api/package.json": JSON.stringify({ name: "@acme/api" }),
      "packages/api/a.ts": importDb("a"), "packages/api/b.ts": importDb("b"), "packages/api/c.ts": importDb("c"),
      "core/model.ts": "export const model = 1;\n",
      ...Object.fromEntries([1, 2, 3].map(i => [`app/m${i}.ts`, `import { model } from "../core/model";\nexport const m${i} = model;\n`])),
    }, { history: true });
    await prepare(f);
    const result = await run(f);
    expect(result.summary).toContain("layer 1 saved, 0 to Review, 0 dropped (1 skipped: no precise import literal)");
    const [rule] = active(f).filter(entry => entry.mex.kind === "rule");
    const literals = ["'@acme/api'", "\"@acme/api\"", "'@acme/api/", "\"@acme/api/"];
    expect(rule!.mex).toMatchObject({
      scope: ["packages/db/**"], evidence: "mined",
      source: { type: "mined", producer: "code-facts", label: "mined from code: 3 imports go api→db, none db→api" },
      when: literals.map(pattern => ({ type: "anti", match: "literal", pattern })),
      checks: literals.map(pattern => ({ kind: "pattern", role: "complete", target: { scope: "packages/db/**", pattern }, saw: { count: 0 } })),
    });
    expect(rule!.text).toBe("`packages/db` never imports `@acme/api` (`packages/api`): 3 imports go from `packages/api` into `packages/db` and none go back. Keep the dependency one-way.");
  });
});

describe("CI path obligations", () => {
  it("turns a workflow path filter and its local commands into one procedure", { timeout: 60_000 }, async () => {
    const workflow = (on: string, run = "npm test") => `on:\n${on}\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: ${run}\n`;
    const f = fixture({
      "package.json": JSON.stringify({ name: "app", scripts: { test: "vitest run", lint: "eslint .", generate: "node scripts/gen.js", build: "tsc -p ." } }),
      "src/index.ts": "export const x = 1;\n",
      ".github/workflows/ci.yml": `on:\n  pull_request:\n    paths: ["src/**", "package.json"]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n      - run: npm run lint\n      - run: npm run generate\n      - if: false\n        run: npm run build\n`,
      ".github/workflows/ignore.yml": workflow("  push:\n    paths-ignore: [\"docs/**\"]"),
      ".github/workflows/negated.yml": workflow("  pull_request:\n    paths: [\"src/**\", \"!src/legacy/**\"]"),
      ".github/workflows/remote.yml": workflow("  push:\n    paths: [\"deploy/**\"]", "./deploy.sh test"),
    });
    await prepare(f);
    const result = await run(f);
    expect(result.summary).toContain("CI 1 saved, 0 to Review, 0 dropped (1 skipped: paths filter without an exact scope; 1 skipped: no local command for its CI steps)");
    expect(result.summary).toContain("small repo: 1 commit, 1 source file; mined facts skipped");
    const [procedure] = active(f).filter(entry => entry.mex.kind === "procedure");
    const text = "After changes in `src/**` and `package.json`, run `npm run test`, `npm run lint` and `npm run generate` (CI runs them in `.github/workflows/ci.yml`).";
    expect(procedure).toMatchObject({ text, mex: {
      scope: ["src/**", "package.json"], one_line: text, evidence: "mined",
      source: { type: "ci", ref: ".github/workflows/ci.yml", label: "mined from code, 3 of 3 CI steps in ci.yml run locally" },
      checks: [
        { kind: "key", role: "complete", target: { file: ".github/workflows/ci.yml", pointer: "/on/pull_request/paths" } },
        { kind: "command", role: "supporting", target: { run: "npm run test", file: "package.json", pointer: "/scripts/test" } },
        { kind: "command", role: "supporting", target: { run: "npm run lint", file: "package.json", pointer: "/scripts/lint" } },
        { kind: "command", role: "supporting", target: { run: "npm run generate", file: "package.json", pointer: "/scripts/generate" } },
      ],
    } });
  });
});

describe("environment, Docker, dev container and owners", () => {
  it("reads declared prerequisites into precise entries, without values or personal handles", { timeout: 60_000 }, async () => {
    const f = fixture({
      "package.json": JSON.stringify({ name: "app", scripts: { build: "tsc -p ." } }),
      ".env.example": "# local settings\nPORT=3000\nDATABASE_URL=postgres://localhost/app\nexport API_TOKEN=changeme\n",
      "Dockerfile": "FROM node:20-alpine AS build\nRUN npm ci\nFROM build AS test\nFROM node:20-alpine\nCOPY . .\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:15\n  cache:\n    image: redis:7-alpine\n  app:\n    build: .\n",
      ".devcontainer/devcontainer.json": "{\n  // set up the checkout\n  \"postCreateCommand\": \"npm run build\"\n}\n",
      ".github/CODEOWNERS": "* @acme/everyone\n/apps/api/ @acme/api-team\n/docs/ @alice\n*.md @acme/docs @bob # docs\n",
      "apps/api/x.ts": "export const x = 1;\n", "docs/a.md": "# A\n", "README.md": "# App\n",
    });
    await prepare(f);
    const result = await run(f);
    expect(result.summary).toContain("env/owners 7 saved, 0 to Review, 0 dropped");
    const entries = active(f);
    expect(entries.every(entry => entry.mex.evidence === "mined" && /^mined from code, /u.test(entry.mex.source.label!))).toBe(true);
    expect(byScope(entries, ".env.example")).toMatchObject({
      text: "Local runs read these variables: PORT, DATABASE_URL, API_TOKEN. Copy `.env.example` to `.env` and fill in the values.",
      mex: { kind: "recipe", scope: [".env.example", ".env"], checks: [{ kind: "source", role: "complete", target: { file: ".env.example" } }] },
    });
    expect(byScope(entries, "Dockerfile")).toMatchObject({
      text: "`Dockerfile` builds on Node.js 20 (image `node:20-alpine`). Use the same version locally.",
      mex: { kind: "fact", source: { label: "mined from code, 1 of 2 base images in Dockerfile" },
        checks: [{ kind: "pattern", target: { scope: "Dockerfile", pattern: "FROM node:20-alpine AS build" }, saw: { count: 1 } }] },
    });
    expect(byScope(entries, "docker-compose.yml")).toMatchObject({
      text: "`docker-compose.yml` starts postgres (image `postgres:15`) and redis (image `redis:7-alpine`) for local runs.",
      mex: { kind: "fact", checks: [
        { kind: "key", target: { file: "docker-compose.yml", pointer: "/services/db/image" } },
        { kind: "key", target: { file: "docker-compose.yml", pointer: "/services/cache/image" } },
      ] },
    });
    expect(entries.find(entry => entry.mex.source.ref === ".devcontainer/devcontainer.json")).toMatchObject({
      text: "On a fresh checkout, run `npm run build`: the dev container runs it after it is created (`.devcontainer/devcontainer.json`).",
      mex: { kind: "recipe", scope: ["**"], checks: [
        { kind: "key", role: "complete", target: { file: ".devcontainer/devcontainer.json", pointer: "/postCreateCommand" } },
        { kind: "command", role: "supporting", target: { run: "npm run build", file: "package.json", pointer: "/scripts/build" } },
      ] },
    });
    const owners = entries.filter(entry => entry.mex.source.ref === ".github/CODEOWNERS").sort((a, b) => a.mex.scope[0]!.localeCompare(b.mex.scope[0]!));
    expect(owners.map(entry => entry.text)).toEqual([
      "Changes under `**/*.md` are reviewed by @acme/docs and other listed owners in `.github/CODEOWNERS`.",
      "Changes under `apps/api/**` are reviewed by @acme/api-team in `.github/CODEOWNERS`.",
      "Changes under `docs/**` are reviewed by its listed owners in `.github/CODEOWNERS`.",
    ]);
    expect(owners.map(entry => entry.mex.checks[0])).toMatchObject([
      { kind: "pattern", target: { scope: ".github/CODEOWNERS", pattern: "*.md" }, saw: { count: 1 } },
      { kind: "pattern", target: { scope: ".github/CODEOWNERS", pattern: "/apps/api/" }, saw: { count: 1 } },
      { kind: "pattern", target: { scope: ".github/CODEOWNERS", pattern: "/docs/" }, saw: { count: 1 } },
    ]);
    // Variable values and personal handles never reach an entry file.
    for (const raw of readNotes(f.location.home, f.projectId).files.values()) expect(raw).not.toMatch(/alice|bob|changeme|localhost/u);
  });
});

describe("a small repository", () => {
  it("mines no statistical facts and says so, but still reads declared ones", { timeout: 60_000 }, async () => {
    const f = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/db/package.json": JSON.stringify({ name: "@acme/db" }), "packages/db/index.ts": "export const db = 1;\n",
      "packages/api/package.json": JSON.stringify({ name: "@acme/api" }),
      ...Object.fromEntries(["a", "b", "c"].map(name => [`packages/api/${name}.ts`, `import { db } from "@acme/db";\nexport const ${name} = db;\n`])),
      "gen/a.ts": "// @generated\nexport {};\n",
      "proto/api.proto": "syntax = \"proto3\";\n", "out/api.ts": "export {};\n",
    }, { commits: [0, 1].map(i => ({ "proto/api.proto": `syntax = "proto3"; // ${i}\n`, "out/api.ts": `export {}; // ${i}\n` })) });
    await prepare(f);
    const { facts } = await mine(f);
    expect(facts.layer_rules).toHaveLength(1);
    expect(facts.generated.map(item => item.signal).sort()).toEqual(["history", "marker"]);
    const result = await run(f);
    expect(result.summary).toContain("small repo: 3 commits, 4 source files; mined facts skipped");
    expect(active(f).map(entry => [entry.mex.kind, entry.mex.scope[0]])).toEqual([["pitfall", "gen/a.ts"]]);
  });

  it("saves nothing without a check evaluator, and the job tries again on the next run", { timeout: 60_000 }, async () => {
    const f = fixture({ "gen/a.ts": "// @generated\nexport {};\n" });
    await prepare(f);
    const { facts } = await mine(f);
    const result = await proposeCodeFacts({ checkout: f.root, projectId: f.projectId, location: f.location, facts }, { env: { MEX_HOOK_BINARY: join(f.root, "missing") } });
    expect(result).toEqual({ summary: "entries: none saved (no check evaluator)", complete: false, results: {} });
    expect(stored(f)).toEqual([]);
  });
});

const real = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"]).status === 0;

describe.skipIf(!real)("the code-facts job with the real file index and native evaluator", () => {
  let binary: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "mex-fact-entries-bin-")); temps.push(base);
    binary = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve(__dirname, "../../../../native"), timeout: 240_000, stdio: "pipe" });
  }, 300_000);

  it("saves held entries of every type in one run of a fresh setup, and does nothing on the next", { timeout: 240_000 }, async () => {
    const importDb = (name: string) => `import { db } from "@acme/db";\nexport const ${name} = db;\n`;
    const f = fixture({
      "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"], scripts: { test: "vitest run" } }),
      "packages/db/package.json": JSON.stringify({ name: "@acme/db" }), "packages/db/index.ts": "export const db = 1;\n",
      "packages/api/package.json": JSON.stringify({ name: "@acme/api" }),
      "packages/api/a.ts": importDb("a"), "packages/api/b.ts": importDb("b"), "packages/api/c.ts": importDb("c"),
      "gen/a.ts": "// @generated\nexport const a = 1;\n", "gen/b.ts": "// @generated\nexport const b = 1;\n",
      ".github/workflows/ci.yml": "on:\n  push:\n    paths:\n      - \"packages/**\"\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
      ".env.example": "PORT=3000\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n",
      ".github/CODEOWNERS": "/packages/db/ @acme/data\n",
    }, { history: true });
    const previous = process.env.MEX_HOOK_BINARY;
    process.env.MEX_HOOK_BINARY = binary;
    const writer = openRecord({ home: f.location.home, projectPath: f.root, isNetwork: () => false });
    try {
      // A fresh `mex`: the file index is built before any code-fact literal is listed.
      await prepare(f, binary);
      const queued = queueJob(writer, { kind: "code-facts", projectId: f.projectId, params: { checkout: f.root } }).job;
      const self = ownerId("foreground");
      expect(await runOneBatch(writer, self, { only: new Set([queued.id]) })).toBe("ran");
      const summary = (writer.db.prepare("SELECT summary FROM job_results WHERE job_id=? ORDER BY batch DESC").get(queued.id) as { summary: string }).summary;
      expect(summary).toContain("entries: generated 1 saved, 0 to Review, 0 dropped; layer 1 saved, 0 to Review, 0 dropped; CI 1 saved, 0 to Review, 0 dropped; env/owners 3 saved");
      const entries = active(f);
      expect(entries.map(entry => entry.mex.kind).sort()).toEqual(["fact", "fact", "pitfall", "procedure", "recipe", "rule"]);
      expect(entries.find(entry => entry.mex.kind === "pitfall")!.mex.checks[0]).toMatchObject({ target: { scope: "gen/**", pattern: "@generated" }, saw: { count: 2 } });
      expect(entries.find(entry => entry.mex.kind === "procedure")!.mex.checks[0]).toMatchObject({ kind: "key", saw: { value: ["packages/**"] } });
      // The native evaluator holds every one of them against today's code.
      const report = runNative(binary, { action: "evaluate", checkout: f.root, project_id: f.projectId, mex_home: f.location.home, record_directory: f.location.directory, store: false });
      const verdicts = new Map((report.items ?? []).map(item => [item.id, item.verdict]));
      for (const entry of entries) expect([entry.mex.kind, verdicts.get(entry.mex.id)]).toEqual([entry.mex.kind, "held"]);

      const again = queueJob(writer, { kind: "code-facts", projectId: f.projectId, params: { checkout: f.root } }).job;
      expect(await runOneBatch(writer, self, { only: new Set([again.id]) })).toBe("ran");
      const second = (writer.db.prepare("SELECT summary FROM job_results WHERE job_id=?").get(again.id) as { summary: string }).summary;
      expect(second).toMatch(/^unchanged since [0-9a-f]{7}$/u);
      expect(readFileSync(join(f.location.home, "projects", f.projectId, "code-facts.json"), "utf8")).toContain("\"generated\"");
    } finally {
      writer.close();
      if (previous === undefined) delete process.env.MEX_HOOK_BINARY; else process.env.MEX_HOOK_BINARY = previous;
    }
  });
});
