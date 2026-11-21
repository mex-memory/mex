import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { knowledgeProject } from "../../knowledge/context.js";
import { parseEntry } from "../../knowledge/entry.js";
import { edit, forget } from "../../knowledge/mutations.js";
import { rebuildNative } from "../../knowledge/native.js";
import { runNative } from "../../knowledge/check.js";
import { previewBrief } from "../../knowledge/brief.js";
import { expand, note, recall } from "../../knowledge/store.js";
import { openRecordReadOnly } from "../../record/index.js";
import { MAX_SETUP_RECIPES, saveSetupRecipes, selectSetupRecipes, setupRecipeId } from "../recipe-entries.js";
import { scanRecipes } from "../recipes/index.js";

let binary: string;
beforeAll(() => {
  binary = join(mkdtempSync(join(tmpdir(), "mex-setup-binary-")), process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);

// Keep these isolated fixtures as deterministic journey evidence. No sweeping cleanup.
function fixture(scripts: Record<string, string> = { test: "node test.mjs", build: "node build.mjs" }) {
  const base = mkdtempSync(join(tmpdir(), "mex-setup-recipes-")), root = join(base, "repo"), home = join(base, ".mex");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
  const write = (file: string, value: unknown) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("package.json", { name: "demo", scripts });
  const env = { ...process.env, MEX_HOME: base, CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"),
    LOCALAPPDATA: join(base, "local"), MEX_HOOK_BINARY: binary, MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0", MEX_BACKGROUND: "0", MEX_OFFLINE: "1" };
  const options = { projectPath: root, home, env, isNetwork: () => false };
  const scan = () => scanRecipes({ root, binary });
  const save = () => saveSetupRecipes(scan(), options);
  const directory = () => join(home, "projects", knowledgeProject(options).projectId, "notes");
  const stored = () => Object.fromEntries(readdirSync(directory()).sort().map(name => [name, readFileSync(join(directory(), name), "utf8")]));
  return { base, root, home, options, write, scan, save, stored, directory, env };
}

describe("setup recipe entries", () => {
  it("writes checked personal recipes with exact commands and labels; reruns keep files and ids", () => {
    const f = fixture({ test: "node test.mjs", build: "node build.mjs", lint: "node lint.mjs", typecheck: "node types.mjs", format: "node fmt.mjs" });
    expect(f.save()).toEqual({ saved: 4, selected: 4, incomplete: false, capped: false });
    const first = f.stored();
    for (const role of ["test", "build", "lint", "typecheck"]) {
      const found = expand(setupRecipeId("", role), f.options);
      expect(found.level).toBe("personal");
      expect(found.label).toBe("[repo, from package.json]");
      expect(found.entry.mex).toMatchObject({ kind: "recipe", scope: ["**"], source: { type: "config", ref: "package.json", producer: "setup-recipe" }, evidence: "docs", status: "active" });
      expect(found.entry.text).toBe(found.entry.mex.one_line);
      expect(found.entry.mex.checks).toEqual([expect.objectContaining({ kind: "command", role: "complete", target: { file: "package.json", pointer: `/scripts/${role}`, run: `npm run ${role}` }, saw: { exists: true }, files: { "package.json": expect.stringMatching(/^sha256:/u) } })]);
    }
    expect(recall("Tests", f.options).entries[0]?.label).toBe("[repo, from package.json]");
    expect(f.save().saved).toBe(4);
    expect(f.stored()).toEqual(first);
  });

  it("refreshes commands under the same ids and retires removed recipes without touching a person's note", () => {
    const f = fixture();
    f.save();
    const personal = note({ text: "Keep tests small.", kind: "recipe" }, f.options).entry;
    const ownFile = `${personal.mex.id}.md`, before = f.stored()[ownFile];
    f.write("package.json", { name: "demo", packageManager: "pnpm@9.0.0", scripts: { test: "node test.mjs" } });
    const project = knowledgeProject(f.options);
    const evaluated = runNative(binary, { action: "evaluate", checkout: f.root, project_id: project.projectId, mex_home: f.home, record_directory: project.location.directory, store: false });
    expect(evaluated.items?.find(item => item.id === setupRecipeId("", "build"))?.verdict).toBe("broken");
    expect(f.save().saved).toBe(1);
    expect(expand(setupRecipeId("", "test"), f.options).entry.text).toBe("Tests: `pnpm run test`");
    const retired = parseEntry(f.stored()[`${setupRecipeId("", "build")}.md`]);
    expect(retired.mex.status).toBe("retired");
    expect(retired.mex.retired?.by).toBe("mex setup");
    expect(f.stored()[ownFile]).toBe(before);
    f.write("package.json", { name: "demo", scripts: { test: "node test.mjs", build: "node build.mjs" } });
    expect(f.save().saved).toBe(2);
    expect(Object.keys(f.stored())).toHaveLength(3);
  });

  it("keeps edited and forgotten setup entries personal, even when their recipe returns", () => {
    const f = fixture(); f.save();
    const test = setupRecipeId("", "test"), build = setupRecipeId("", "build");
    edit(test, { text: "Tests need a local fixture." }, f.options);
    forget(build, "I do not want this recipe.", f.options);
    const before = f.stored();
    expect(f.save().saved).toBe(0);
    expect(f.stored()).toEqual(before);
  });

  it("keeps every package's test and build, prefers root and build order, and scopes packages", () => {
    const f = fixture({ test: "node test.mjs", build: "node build.mjs", lint: "node lint.mjs", typecheck: "node types.mjs" });
    f.write("package.json", { name: "demo", workspaces: ["packages/*"], scripts: { test: "node test.mjs", build: "node build.mjs", lint: "node lint.mjs", typecheck: "node types.mjs" } });
    for (let i = 0; i < 15; i++) f.write(`packages/p${String(i).padStart(2, "0")}/package.json`, { name: `p${i}`, scripts: { test: "node test.mjs", build: "node build.mjs", lint: "node lint.mjs" } });
    const file = f.scan(); file.build_order = ["packages/p14", "packages/p00"];
    const selected = selectSetupRecipes(file);
    expect(selected).toHaveLength(4 + 15 * 2);
    expect(selected.slice(0, 4).map(recipe => recipe.package)).toEqual(["", "", "", ""]);
    expect(selected.slice(4, 6).map(recipe => recipe.package)).toEqual(["packages/p14", "packages/p14"]);
    expect(saveSetupRecipes(file, f.options)).toMatchObject({ saved: 34, selected: 34, incomplete: false, capped: false });
    const entry = expand(setupRecipeId("packages/p14", "test"), f.options).entry;
    expect(entry.mex.scope).toEqual(["packages/p14/**"]);
    expect(entry.mex.source.ref).toBe("packages/p14/package.json");
    expect(entry.text).toBe("Tests in packages/p14: `npm run test --workspace packages/p14`");
    expect(expand(setupRecipeId("", "build"), f.options).entry.text).toBe("Build: `npm run build` (build p14 first)");
  });

  it("bounds a very large monorepo and says so", () => {
    const f = fixture({ test: "node test.mjs", build: "node build.mjs" });
    f.write("package.json", { name: "demo", workspaces: ["packages/*"], scripts: { test: "node test.mjs", build: "node build.mjs" } });
    for (let i = 0; i < 65; i++) f.write(`packages/p${String(i).padStart(2, "0")}/package.json`, { name: `p${i}`, scripts: { test: "node test.mjs", build: "node build.mjs" } });
    const selected = selectSetupRecipes(f.scan());
    expect(selected).toHaveLength(MAX_SETUP_RECIPES);
    expect(selected.slice(0, 2).map(recipe => recipe.package)).toEqual(["", ""]);
  });

  it("keeps existing recipes when a scan is partial or the evaluator is unavailable", () => {
    const f = fixture(); f.save();
    const file = f.scan(); file.recipes = []; file.partial = true;
    saveSetupRecipes(file, f.options);
    expect(expand(setupRecipeId("", "build"), f.options).entry.mex.status).toBe("active");
    expect(saveSetupRecipes(f.scan(), { ...f.options, env: { ...f.env, MEX_HOOK_BINARY: join(f.base, "missing") } }).incomplete).toBe(true);
    expect(expand(setupRecipeId("", "build"), f.options).entry.mex.status).toBe("active");
    expect(saveSetupRecipes(f.scan(), { ...f.options, env: { ...f.env, MEX_HOOK_BINARY: process.execPath } }).incomplete).toBe(true);
    expect(expand(setupRecipeId("", "build"), f.options).entry.mex.status).toBe("active");
  });

  it("leaves the native start brief's room for a person's own recipe note", () => {
    const f = fixture(); f.save();
    const own = note({ text: "My tests.", kind: "recipe" }, f.options).entry;
    const brief = previewBrief(f.options, "codex");
    // The person's note first; with no rule file carrying them yet, root
    // commands may follow in whatever room is left.
    expect(brief.items[0]?.id).toBe(own.mex.id);
    expect(brief.items.slice(1).every(item => item.id.startsWith("mx_setup"))).toBe(true);
    expect(brief.text).toContain("[you said,");
    expect(brief.token_bound).toBeLessThanOrEqual(300);
  });

  it("builds for agents found by installation before their first session here", () => {
    const f = fixture(); f.save();
    const rebuilt = rebuildNative(f.options, { agents: ["claude-code", "codex"] });
    expect(rebuilt.agents).toEqual(["claude-code", "codex"]);
    expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toContain("npm run build");
    expect(existsSync(join(f.root, "CLAUDE.md"))).toBe(false);
  });

  it("uses config manifests for Make and Python recipes through the same store gates", () => {
    for (const [manifest, text, command] of [["Makefile", "test:\n\techo test\n", "make test"], ["pyproject.toml", "[tool.pytest.ini_options]\ntestpaths = ['tests']\n", "pytest"]]) {
      const f = fixture({}); f.write(manifest, text);
      expect(f.save().saved).toBe(1);
      const entry = expand(setupRecipeId("", "test"), f.options).entry;
      expect(entry.mex.source.ref).toBe(manifest);
      expect(entry.text).toBe(`Tests: \`${command}\``);
    }
  });
});

describe("bare mex recipe journey", () => {
  function run(f: ReturnType<typeof fixture>) {
    const result = spawnSync(process.execPath, [resolve("dist/cli.js"), "--no-wait"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("could not");
    return result.stdout;
  }

  it("puts both recipes in Claude rules and Codex AGENTS, then removes build from both", () => {
    const f = fixture(); f.write("CLAUDE.md", "# Project\n"); mkdirSync(join(f.root, ".codex"));
    const first = run(f);
    expect(first).toContain("your agents get these from now on");
    const rules = [join(f.root, ".claude/rules/mex-local.md"), join(f.root, "AGENTS.md")];
    for (const path of rules) {
      const text = readFileSync(path, "utf8");
      expect(text).toContain("Tests: `npm run test`"); expect(text).toContain("Build: `npm run build`");
    }
    const before = f.stored(); run(f); expect(f.stored()).toEqual(before);
    f.write("package.json", { name: "demo", scripts: { test: "node test.mjs" } }); run(f);
    for (const path of rules) {
      const text = readFileSync(path, "utf8");
      expect(text).toContain("Tests: `npm run test`"); expect(text).not.toContain("npm run build");
    }
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: f.root, encoding: "utf8" });
    expect(status).not.toMatch(/AGENTS\.md|mex-local/u);
    expect(readFileSync(join(f.root, "CLAUDE.md"), "utf8")).toBe("# Project\n");
    writeFileSync(join(f.base, "screen.txt"), first);
  });

  it("queues rule files while a session is live, then builds them between sessions", () => {
    const f = fixture(); f.write("CLAUDE.md", "# Project\n"); mkdirSync(join(f.root, ".codex"));
    const heartbeat = join(f.home, "heartbeats", "codex"); mkdirSync(heartbeat, { recursive: true });
    writeFileSync(join(heartbeat, "session.json"), JSON.stringify({ agent: "codex", cwd: f.root }));
    expect(run(f)).toContain("Your agents get the commands after it ends.");
    expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(f.root, ".claude/rules/mex-local.md"))).toBe(false);
    const reader = openRecordReadOnly(f.options)!;
    try { expect(reader.all("SELECT kind FROM jobs WHERE kind='native-files'")).toHaveLength(1); } finally { reader.close(); }
    const rebuilt = rebuildNative(f.options, { now: Date.now() + 11 * 60_000 });
    expect(rebuilt.deferred).toBeUndefined(); expect(rebuilt.selected).toBe(2);
    expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toContain("npm run build");
  });
});
