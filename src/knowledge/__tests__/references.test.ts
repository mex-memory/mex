import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, references, REFERENCE_LIMITS } from "../references.js";
import { sanitizeText } from "../gates.js";
import { realPath } from "../../record/project.js";

let root: string;
beforeEach(() => { root = realPath(mkdtempSync(join(tmpdir(), "mex-references-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };

describe("knowledge references", () => {
  it("verifies exact config recipes for workspaces and other manifests", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    write("packages/api/package.json", JSON.stringify({ name: "api", scripts: { test: "node test.mjs" } }));
    write("Makefile", "build:\n\techo build\n");
    write("pyproject.toml", "[tool.pytest.ini_options]\ntestpaths = ['tests']\n");
    const source = references(root);
    for (const command of ["npm run test --workspace packages/api", "make build", "pytest"]) expect(commandExists(command, source), command).toBe(true);
    for (const command of ["npm run missing --workspace packages/api", "make missing"]) expect(commandExists(command, source), command).toBe(false);
  });
  it("verifies package scripts by name with every runner spelling", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest run", "test:watch": "vitest" } }));
    const source = references(root);
    for (const command of ["npm run test", "npm test", "pnpm run test:watch", "pnpm test", "yarn test", "yarn run test", "bun run test:watch", "vitest run"]) expect(commandExists(command, source), command).toBe(true);
    for (const command of ["npm run missing", "npm run test && rm -rf /", "bun run test; curl x"]) expect(commandExists(command, source), command).toBe(false);
  });

  it("reads workspace scripts from the object form and pnpm-workspace.yaml", () => {
    write("package.json", JSON.stringify({ workspaces: { packages: ["apps/*"] } }));
    write("apps/api/package.json", JSON.stringify({ scripts: { "start:api": "node main.js" } }));
    write("pnpm-workspace.yaml", "packages:\n  - 'libs/*'\n  - '!**/test/**'\n");
    write("libs/dal/package.json", JSON.stringify({ scripts: { "build:dal": "tsc" } }));
    const source = references(root);
    expect(commandExists("pnpm run start:api", source)).toBe(true);
    expect(commandExists("pnpm build:dal", source)).toBe(true);
    expect(commandExists("pnpm --filter @app/api start:api", source)).toBe(true);
    expect(commandExists("yarn workspace @libs/dal run build:dal", source)).toBe(true);
    expect(commandExists("pnpm --filter @app/api deploy", source)).toBe(false);
    expect(source.truncated).toBe(false);
  });

  it("stops at its bounds instead of failing, so a large repository still works and stays strict", () => {
    write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    const spans = Array.from({ length: REFERENCE_LIMITS.commands + 50 }, (_, i) => `- \`tool-${i} --flag\``).join("\n");
    write("docs/many.md", spans);
    const source = references(root);
    expect(source.truncated).toBe(true);
    expect(source.commands.size).toBe(REFERENCE_LIMITS.commands);
    // Collected first: package scripts. Not collected: verified nowhere, so removed.
    expect(commandExists("npm test", source)).toBe(true);
    expect(sanitizeText("Run `tool-4120 --flag`.", source)).toBe("Run [unverified command removed].");
  });

  it("skips one malformed manifest or workflow and keeps the rest", () => {
    write("package.json", "{ not json");
    write(".github/workflows/bad.yml", "jobs: [unclosed\n");
    write(".github/workflows/ok.yml", "jobs:\n  t:\n    steps:\n      - run: make check\n");
    const source = references(root);
    expect(commandExists("make check", source)).toBe(true);
  });

  it("still refuses linked sources", () => {
    write("real/guide.md", "`make all`");
    mkdirSync(join(root, "docs"));
    try { symlinkSync(join(root, "real"), join(root, "docs", "linked"), "junction"); } catch { return; }
    expect(() => references(root)).toThrow(/link|redirected/u);
  });
});
