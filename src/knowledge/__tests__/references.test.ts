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
  it("checks npm workspace scripts in the named package, with the flag in either position", () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"], scripts: { lint: "eslint ." } }));
    write("packages/api/package.json", JSON.stringify({ name: "@acme/api", scripts: { generate: "node gen.mjs" } }));
    write("packages/web/package.json", JSON.stringify({ name: "web", scripts: { dev: "vite" } }));
    const source = references(root);
    for (const command of ["npm run generate --workspace packages/api", "npm run generate -w packages/api", "npm run -w packages/api generate",
      "npm run --workspace=packages/api generate", "npm run generate --workspace=@acme/api", "TZ=UTC npm run -w ./packages/api/ generate"]) {
      expect(commandExists(command, source), command).toBe(true);
    }
    for (const command of ["npm run dev --workspace packages/api", "npm run -w packages/web generate", "npm run lint -w packages/api",
      "npm run generate --workspace packages/none"]) {
      expect(commandExists(command, source), command).toBe(false);
    }
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

  it("reads anchors in a workflow and records an alias bomb as a gap", () => {
    write(".github/workflows/release.yml", [
      "jobs:",
      "  publish:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with: &checkout",
      "          fetch-depth: 0",
      "      - uses: actions/checkout@v4",
      "        with: *checkout",
      "      - run: cargo publish",
    ].join("\n"));
    write(".github/workflows/ok.yml", "jobs:\n  t:\n    steps:\n      - run: make check\n");
    const aliases = Array.from({ length: 101 }, () => "*a").join(", ");
    write(".github/workflows/bomb.yml", `a: &a 1\nbomb: [${aliases}]\n`);
    const source = references(root);
    expect(commandExists("cargo publish", source)).toBe(true);
    expect(commandExists("make check", source)).toBe(true);
    expect(source.gaps).toEqual([".github/workflows/bomb.yml could not be read."]);
    expect(source.truncated).toBe(false);
  });

  it("skips linked files and folders in docs with one gap and never reads through them", ctx => {
    const outside = realPath(mkdtempSync(join(tmpdir(), "mex-references-outside-")));
    try {
      writeFileSync(join(outside, "secret.md"), "`make outside` https://outside.example/link");
      write("docs/guide.md", "`make inside` https://inside.example/link");
      try {
        symlinkSync(outside, join(root, "docs", "linked"), "junction");
        symlinkSync(join(outside, "secret.md"), join(root, "docs", "secret.md"), "file");
      } catch (e) { ctx.skip(`symlinks need extra privilege here: ${(e as Error).message}`); }
      const source = references(root);
      expect(source.gaps).toEqual(["Some linked files in docs or CI were skipped."]);
      expect(commandExists("make inside", source)).toBe(true);
      expect(commandExists("make outside", source)).toBe(false);
      expect([...source.links]).toEqual(["https://inside.example/link"]);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("skips a docs or CI folder that is itself a link", () => {
    write("real/guide.md", "`make outside`");
    write("real/ci.yml", "jobs:\n  t:\n    steps:\n      - run: make ci\n");
    mkdirSync(join(root, ".github"));
    try {
      symlinkSync(join(root, "real"), join(root, "docs"), "junction");
      symlinkSync(join(root, "real"), join(root, ".github", "workflows"), "junction");
    } catch { return; }
    const source = references(root);
    expect(source.gaps).toEqual(["Some linked files in docs or CI were skipped."]);
    expect(commandExists("make outside", source)).toBe(false);
    expect(commandExists("make ci", source)).toBe(false);
  });

  it("still refuses other linked sources", () => {
    write("real/package.json", JSON.stringify({ scripts: { test: "x" } }));
    try { symlinkSync(join(root, "real", "package.json"), join(root, "package.json"), "file"); } catch { return; }
    expect(() => references(root)).toThrow(/redirected/u);
  });
});
