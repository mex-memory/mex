import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../src/graph/engine-impl.js";

let root: string;
let id: string;
let loader: string;
let preload: string;
const cli = resolve("dist/cli.js");
function invoke(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--require", preload, "--loader", pathToFileURL(loader).href, cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, MEX_TELEMETRY: "0", DO_NOT_TRACK: "1", ...extraEnv },
  });
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-reader-loading-"));
  mkdirSync(join(root, ".mex/context"), { recursive: true });
  writeFileSync(join(root, ".mex/config.json"), '{"setupMode":"code-repo","aiTools":[]}');
  writeFileSync(join(root, ".mex/ROUTER.md"), "# Router\n");
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(root, "tsconfig.json"), '{/* project */"include":["src",],}');
  writeFileSync(join(root, "source.py"), "def value():\n    return 1\n");
  loader = join(root, "deny-compiler.mjs");
  writeFileSync(loader, `import { writeSync } from "node:fs";
export function resolve(specifier, context, next) {
    if (specifier === "typescript" || specifier.endsWith("/typescript.js")) { writeSync(2, "COMPILER_LOADED_ON_READ"); throw new Error("COMPILER_LOADED_ON_READ"); }
    return next(specifier, context);
  }`);
  preload = join(root, "deny-compiler.cjs");
  writeFileSync(preload, `const Module = require("node:module");
const { writeSync } = require("node:fs");
const load = Module._load;
Module._load = function(request, ...args) {
  const normalized = String(request).replaceAll(String.fromCharCode(92), "/");
  if (normalized === "typescript" || normalized.endsWith("/typescript.js")) {
    writeSync(2, "COMPILER_LOADED_ON_READ"); throw new Error("COMPILER_LOADED_ON_READ");
  }
  return Reflect.apply(load, this, [request, ...args]);
};`);
  const engine = createGraphEngine({ rootDir: root });
  try { await engine.build(); id = engine.searchNodes("value").find(node => node.name === "value")!.id; }
  finally { engine.close(); }
  writeFileSync(join(root, "operation.json"), JSON.stringify({
    opId: "reader-loading-fact", type: "create-entry", actor: { kind: "human", id: "fixture" }, timestamp: "2026-10-23T00:00:00.000Z",
    payload: { file: "context/read.md", insertAt: { at: "end-of-file" }, type: "fact", title: "Read", body: "One fact." },
  }));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
describe("shipped read module loading", () => {
  for (const command of ["status", "scope", "get", "where-defined", "who-calls", "impact", "wiki-apply", "wiki-apply-write", "wiki-validate", "wiki-query", "check", "sync", "help", "version"]) {
    it(`${command} keeps extraction off a valid JSONC read`, () => {
      const args = command === "status" ? ["graph", "status", "--json"]
        : command === "scope" ? ["graph", "scope", "value"]
        : command === "get" ? ["graph", "get", id]
        : command === "impact" ? ["impact", id]
        : command === "wiki-apply" ? ["wiki", "apply", join(root, "operation.json"), "--json"]
        : command === "wiki-apply-write" ? ["wiki", "apply", join(root, "operation.json"), "--apply", "--json"]
        : command === "wiki-validate" ? ["wiki", "validate", "--json"]
        : command === "wiki-query" ? ["wiki", "query", "value", "--json"]
        : command === "check" ? ["check", "--json"]
        : command === "sync" ? ["sync", "--dry-run"]
        : command === "help" ? ["--help"]
        : command === "version" ? ["--version"]
        : ["graph", "query", command, id];
      const result = invoke(args);
      expect(result.error).toBeUndefined();
      expect(result.stderr).not.toContain("COMPILER_LOADED_ON_READ");
      // Querying a missing Wiki index may refuse, but must never initialize extraction.
      if (command !== "wiki-query") expect(result.status, result.stdout + result.stderr).toBe(0);
    });
  }
  it("keeps CLI dispatch working when compilation caching is disabled", () => {
    const result = invoke(["graph", "status", "--json"], { NODE_DISABLE_COMPILE_CACHE: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("fresh");
  });
  it("runs the original glob fallback from the packaged CLI", () => {
    const path = join(root, ".mex/config.json"); const before = readFileSync(path, "utf8");
    try {
      writeFileSync(path, '{"setupMode":"code-repo","aiTools":[],"graph":{"ignore":["missing/**"]}}');
      const result = invoke(["graph", "status", "--json"]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).status).not.toBe("fresh");
    } finally { writeFileSync(path, before); }
  });

});
