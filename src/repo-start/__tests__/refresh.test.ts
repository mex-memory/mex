import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { knowledgeProject } from "../../knowledge/context.js";
import { expand } from "../../knowledge/store.js";
import { openRecord } from "../../record/index.js";
import { shortHash } from "../../record/project.js";
import { saveSetupRecipes, setupRecipeId } from "../recipe-entries.js";
import { scanRecipes } from "../recipes/index.js";
import { queuePendingSetupRefresh, refreshSetup, REFRESH_PENDING_DIRECTORY, REFRESH_STAMP_DIRECTORY } from "../refresh.js";

let binary: string;
beforeAll(() => {
  binary = join(mkdtempSync(join(tmpdir(), "mex-refresh-binary-")), process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
  execFileSync("go", ["build", "-o", binary, "./cmd/mex-hook"], { cwd: resolve("native"), timeout: 240_000, stdio: "pipe" });
}, 300_000);
afterEach(() => { vi.unstubAllEnvs(); });

function fixture(scripts: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), "mex-refresh-")), root = join(base, "repo"), home = join(base, ".mex");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", root], { stdio: "pipe" });
  const writePackage = (s: Record<string, string>) => writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo", scripts: s }));
  writePackage(scripts);
  // The reads use the process environment for MEX's home: pin it to this fixture.
  const env = { MEX_HOME: base, CLAUDE_CONFIG_DIR: join(base, "claude"), CODEX_HOME: join(base, "codex"), LOCALAPPDATA: join(base, "local"),
    MEX_HOOK_BINARY: binary, MEX_TELEMETRY: "0", MEX_INSTALL_AUTO: "0", MEX_BACKGROUND: "0", MEX_OFFLINE: "1" };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const options = { projectPath: root, home, env: { ...process.env, ...env }, isNetwork: () => false };
  return { base, root, home, options, writePackage, projectId: () => knowledgeProject(options).projectId };
}

describe("refreshing what setup read", () => {
  it("brings a script added after setup to the agents and retires one that was removed", async () => {
    const f = fixture({ test: "node test.mjs" });
    saveSetupRecipes(scanRecipes({ root: f.root, binary }), f.options);
    expect(() => expand(setupRecipeId("", "build"), f.options)).toThrow();
    f.writePackage({ test: "node test.mjs", build: "node build.mjs" });
    const result = await refreshSetup(f.root, f.projectId(), f.options.env);
    expect(result.commands).toBeGreaterThan(0);
    expect(expand(setupRecipeId("", "build"), f.options).entry.text).toBe("Build: `npm run build`");
    f.writePackage({ build: "node build.mjs" });
    await refreshSetup(f.root, f.projectId(), f.options.env);
    expect(() => expand(setupRecipeId("", "test"), f.options)).toThrow();
  });

  it("turns the hook's request into one job, stamps the checkout and removes the emptied folder", () => {
    const f = fixture({ test: "node test.mjs" });
    const writer = openRecord({ home: f.home, projectPath: f.root, isNetwork: () => false });
    try {
      const directory = join(writer.location.directory, REFRESH_PENDING_DIRECTORY);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${shortHash(f.root)}.json`), JSON.stringify({ version: 1, project_id: f.projectId(), checkout: f.root }));
      expect(queuePendingSetupRefresh(writer)).toBe(1);
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(join(writer.location.directory, REFRESH_STAMP_DIRECTORY, shortHash(f.root)))).toBe(true);
      expect(writer.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='setup-refresh'").get()).toEqual({ n: 1 });
    } finally { writer.close(); }
  });
});
