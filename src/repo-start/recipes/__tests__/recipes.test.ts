import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ciMatch, firstPurposeLine, linePurpose } from "../ci.js";
import { conflictingTests, recipeSummary, recordChecks, scanRecipes, type RecipesFile } from "../index.js";
import { buildOrder, scriptCommand } from "../node.js";
import { gradleProjects, makeTargets, toxEnvs } from "../other.js";
import { parseIni, RepoFiles } from "../source.js";

const temps: string[] = [];
afterAll(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mex-recipes-")); temps.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** One repository with every source the readers know. */
const FIXTURE: Record<string, string> = {
  "package.json": json({ name: "demo", private: true, packageManager: "pnpm@9.0.0", scripts: { test: "vitest run", build: "turbo build", lint: "eslint .", "check-types": "tsc --noEmit" } }),
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/ignored'\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "yarn.lock": "# old\n",
  "packages/dal/package.json": json({ name: "@demo/dal", scripts: { build: "tsc -b", test: "vitest" } }),
  "packages/api/package.json": json({ name: "@demo/api", dependencies: { "@demo/dal": "workspace:*" }, scripts: { test: "jest", fmt: "prettier --write ." } }),
  "packages/ignored/package.json": json({ name: "@demo/ignored", scripts: { test: "x" } }),
  "Makefile": "test:\n\tpnpm test\n\nlint: deps\n\tpnpm lint\n",
  "tox.ini": "[tox]\nenvlist = py311, lint\n\n[testenv]\ncommands = pytest {posargs}\n\n[testenv:lint]\ncommands = ruff check .\n",
  "pyproject.toml": "[project]\nname = \"demo-py\"\n\n[tool.mypy]\nstrict = true\n",
  "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\n",
  "crates/core/Cargo.toml": "[package]\nname = \"demo-core\"\nversion = \"0.1.0\"\n",
  "crates/cli/Cargo.toml": "[package]\nname = \"demo-cli\"\nversion = \"0.1.0\"\n",
  "gradlew": "#!/bin/sh\n",
  "gradle/wrapper/gradle-wrapper.properties": "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.9-bin.zip\n",
  "settings.gradle.kts": "rootProject.name = \"demo\"\ninclude(\":app\")\n",
  ".github/workflows/ci.yml": [
    "on: [push, pull_request]",
    "env:",
    "  TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm test",
    "      - run: node scripts/report.mjs --out test-results/report.json",
    "  e2e:",
    "    runs-on: ubuntu-latest",
    "    services:",
    "      postgres:",
    "        image: postgres:16",
    "    steps:",
    "      - run: npx playwright test",
    "  publish:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |",
    "          echo building",
    "          ./scripts/release.sh build --token $TOKEN",
    "  skipped:",
    "    if: false",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: go test ./...",
    "",
  ].join("\n"),
  ".github/workflows/manual.yml": "on: workflow_dispatch\njobs:\n  bench:\n    runs-on: ubuntu-latest\n    steps:\n      - run: cargo bench --no-run && cargo build --release\n",
  ".gitlab-ci.yml": "stages: [test]\nservices: [redis:7]\nunit:\n  stage: test\n  script:\n    - pip install -e .\n    - pytest -x\n.hidden:\n  script: [make test]\n",
};

function project(file: RecipesFile) {
  return file.recipes.map(recipe => [recipe.purpose, recipe.package, recipe.command, recipe.local, recipe.origin.map(origin => origin.file).join("+")].join(" | ")).sort();
}

describe("readers", () => {
  it("parse INI like the evaluator", () => {
    expect(parseIni("top=1\r\n[a]\nk: v\n  more\n; c\nk2 = \n  first\n[a]\nk = last\n")).toEqual({ top: "1", a: { k: "last", k2: "first" } });
  });

  it("expand tox envlists, Gradle includes and Makefile targets", () => {
    expect(toxEnvs("py{310,311}, lint\n  docs")).toEqual(["py310", "py311", "lint", "docs"]);
    expect(gradleProjects("include(\":app\", \":lib:core\")\ninclude ':web'\n")).toEqual(["app", "lib:core", "web"]);
    expect([...makeTargets("all test: deps\n\techo\nVAR := 1\n.PHONY: lint\n")]).toEqual(["all", "test", ".PHONY"]);
  });

  it("classify CI lines and match them to the config they run", () => {
    expect(linePurpose("pnpm run test:unit")).toBe("test");
    expect(linePurpose("node x.mjs --report test-results/a.json")).toBeUndefined();
    expect(linePurpose("npm ci")).toBeUndefined();
    expect(linePurpose("RESULT=$(npm test)")).toBeUndefined();
    expect(linePurpose("npx tsc --noEmit")).toBe("typecheck");
    expect(linePurpose("tsc -b")).toBe("build");
    expect(firstPurposeLine("echo hi\nmake lint \\\n")).toEqual({ line: "make lint", purpose: "lint" });
    const packages = [{ path: "packages/api", name: "@demo/api", kind: "node" as const }];
    expect(ciMatch("pnpm --filter @demo/api test", packages, "")).toBe("script:packages/api:test");
    expect(ciMatch("npm run build -w packages/api", packages, "")).toBe("script:packages/api:build");
    expect(ciMatch("./gradlew :app:test", packages, "")).toBe("gradle:app:test");
    expect(ciMatch("tox -e lint", packages, "")).toBe("tox:lint");
  });

  it("orders internal dependencies first and builds manager-specific commands", () => {
    expect(buildOrder([{ path: "a", name: "a", deps: ["b"] }, { path: "b", name: "b", deps: ["c", "react"] }, { path: "c", name: "c", deps: [] }, { path: "d", name: "d", deps: [] }])).toEqual(["c", "b", "a"]);
    const pkg = { path: "packages/api", name: "@demo/api", kind: "node" as const };
    expect(["npm", "pnpm", "yarn", "bun"].map(manager => scriptCommand(manager as never, "test", pkg))).toEqual([
      "npm run test --workspace packages/api", "pnpm --filter @demo/api run test", "yarn workspace @demo/api run test", "bun run --filter @demo/api test",
    ]);
  });

  it("never follows a linked folder or reads past the depth bound", () => {
    const root = repo({ "a/b/c/d/e/f/g/package.json": "{}" });
    expect(new RepoFiles(root).glob("**")).not.toContain("a/b/c/d/e/f/g");
  });
});

describe("edge cases from real repositories", () => {
  it("filters negated workspace globs without walking the tree", () => {
    const deep = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${"d/".repeat(i + 1)}x.txt`, ""]));
    const root = repo({
      ...deep,
      "package.json": json({ name: "r", scripts: { test: "t" } }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!**/test/**'\n",
      "pnpm-lock.yaml": "",
      "packages/a/package.json": json({ name: "a", scripts: { test: "t" } }),
      "packages/test/package.json": json({ name: "t", scripts: { test: "t" } }),
    });
    const file = scanRecipes({ root, binary: null });
    expect(file.partial).toBe(false);
    expect(file.packages.map(pkg => pkg.path)).toEqual(["", "packages/a"]);
  });

  it("flags two test commands only within one tool family", () => {
    const django = scanRecipes({ root: repo({
      "package.json": json({ name: "django", scripts: { test: "grunt test" } }),
      "tox.ini": "[tox]\nenvlist = py3\n\n[testenv]\ncommands = python runtests.py\n",
    }), binary: null });
    expect(django.review).toEqual([]);
    const wrapped = scanRecipes({ root: repo({
      "package.json": json({ name: "app", scripts: { test: "vitest run" } }),
      "Makefile": "test:\n\tnpm test\n",
    }), binary: null });
    expect(wrapped.review.map(item => item.message)).toEqual(["2 different test commands for the root: `npm run test`, `make test`"]);
    expect(conflictingTests(["npm run test", "tox -e py3"])).toBe(false);
    expect(conflictingTests(["pnpm run test", "npx vitest run"])).toBe(true);
    expect(conflictingTests(["cargo test", "./gradlew test", "pytest"])).toBe(false);
  });

  it("marks steps after a background server or containers as needing services", () => {
    const root = repo({
      ".github/workflows/e2e.yml": "on: push\njobs:\n  e2e:\n    runs-on: x\n    steps:\n      - run: npm run build\n      - run: |\n          node dist/main.js &\n      - run: npm run test:e2e\n",
    });
    expect(project(scanRecipes({ root, binary: null }))).toEqual([
      "build |  | npm run build | yes | .github/workflows/e2e.yml",
      "test |  | npm run test:e2e | needs services | .github/workflows/e2e.yml",
    ]);
  });
});

describe("a repository with every source", () => {
  it("finds recipes per package, the build order, local-run labels and review items (golden)", () => {
    const root = repo(FIXTURE);
    const file = scanRecipes({ root, binary: null, now: new Date("2026-11-15T00:00:00Z") });
    expect(file.manager).toBe("pnpm");
    expect(file.checks).toBe("no evaluator");
    expect(file.build_order).toEqual(["packages/dal", "packages/api"]);
    expect(file.packages.map(pkg => `${pkg.kind}:${pkg.path || "."}:${pkg.name}`)).toEqual([
      "node:.:demo", "node:packages/api:@demo/api", "node:packages/dal:@demo/dal",
      "cargo:crates/cli:demo-cli", "cargo:crates/core:demo-core", "python:.:demo-py", "gradle:.:(root)", "gradle:app::app", "make:.:Makefile",
    ]);
    expect(project(file)).toEqual([
      "build |  | ./gradlew build | yes | gradle/wrapper/gradle-wrapper.properties",
      "build |  | ./scripts/release.sh build --token $TOKEN | needs secrets | .github/workflows/ci.yml",
      "build |  | cargo bench --no-run && cargo build --release | from CI config, not running | .github/workflows/manual.yml",
      "build |  | cargo build --workspace | yes | Cargo.toml",
      "build |  | pnpm run build | yes | package.json",
      "build | app | ./gradlew :app:build | yes | gradle/wrapper/gradle-wrapper.properties",
      "build | crates/cli | cargo build -p demo-cli | yes | crates/cli/Cargo.toml",
      "build | crates/core | cargo build -p demo-core | yes | crates/core/Cargo.toml",
      "build | packages/dal | pnpm --filter @demo/dal run build | yes | packages/dal/package.json",
      "format | packages/api | pnpm --filter @demo/api run fmt | yes | packages/api/package.json",
      "lint |  | ./gradlew check | yes | gradle/wrapper/gradle-wrapper.properties",
      "lint |  | cargo clippy --workspace | yes | Cargo.toml",
      "lint |  | make lint | yes | Makefile",
      "lint |  | pnpm run lint | yes | package.json",
      "lint |  | tox -e lint | yes | tox.ini",
      "lint | app | ./gradlew :app:check | yes | gradle/wrapper/gradle-wrapper.properties",
      "lint | crates/cli | cargo clippy -p demo-cli | yes | crates/cli/Cargo.toml",
      "lint | crates/core | cargo clippy -p demo-core | yes | crates/core/Cargo.toml",
      "test |  | ./gradlew test | yes | gradle/wrapper/gradle-wrapper.properties",
      "test |  | cargo test --workspace | yes | Cargo.toml",
      "test |  | go test ./... | from CI config, not running | .github/workflows/ci.yml",
      "test |  | make test | yes | Makefile",
      "test |  | npx playwright test | needs services | .github/workflows/ci.yml",
      "test |  | pnpm run test | yes | package.json+.github/workflows/ci.yml",
      "test |  | pytest -x | needs services | .gitlab-ci.yml",
      "test |  | tox -e py311 | yes | tox.ini",
      "test | app | ./gradlew :app:test | yes | gradle/wrapper/gradle-wrapper.properties",
      "test | crates/cli | cargo test -p demo-cli | yes | crates/cli/Cargo.toml",
      "test | crates/core | cargo test -p demo-core | yes | crates/core/Cargo.toml",
      "test | packages/api | pnpm --filter @demo/api run test | yes | packages/api/package.json",
      "test | packages/dal | pnpm --filter @demo/dal run test | yes | packages/dal/package.json",
      "typecheck |  | mypy . | yes | pyproject.toml",
      "typecheck |  | pnpm run check-types | yes | package.json",
    ]);
    expect(file.review.map(item => item.kind)).toEqual(["two-lockfiles", "two-test-commands"]);
    expect(file.review[0]!.message).toBe("Two package managers' lockfiles: pnpm-lock.yaml and yarn.lock");
    const test = file.recipes.find(recipe => recipe.command === "pnpm run test")!;
    expect(test.entry.mex).toMatchObject({ kind: "recipe", scope: ["**"], source: { type: "config", ref: "package.json#/scripts/test" }, evidence: "docs", checks: [] });
    expect(test.entry.mex.one_line).toBe("Test the repo: `pnpm run test`");
    const secret = file.recipes.find(recipe => recipe.local === "needs secrets")!;
    expect(secret.entry.mex).toMatchObject({ source: { type: "ci" }, evidence: "ci" });
    expect(secret.entry.text).toContain("It can't run on this machine as written: needs secrets.");
    expect(recipeSummary(file).line).toBe("Test and build commands for 6 packages (build @demo/dal first); 3 CI steps need secrets or services");
  });

  it("keeps entry ids stable across rescans and says when nothing was found", () => {
    const root = repo(FIXTURE);
    const ids = (file: RecipesFile) => file.recipes.map(recipe => recipe.entry.mex.id).sort();
    expect(ids(scanRecipes({ root, binary: null }))).toEqual(ids(scanRecipes({ root, binary: null })));
    const empty = scanRecipes({ root: repo({ "README.md": "# hi\n" }), binary: null });
    expect(empty.recipes).toEqual([]);
    expect(recipeSummary(empty).line).toBe("No test or build commands found in config");
  });

  it("reads a checkout with CRLF line endings (Git's autocrlf on Windows) exactly like one with LF", () => {
    const crlf = Object.fromEntries(Object.entries(FIXTURE).map(([path, text]) => [path, text.replace(/\n/gu, "\r\n")]));
    const now = new Date("2026-11-15T00:00:00Z");
    const lf = scanRecipes({ root: repo(FIXTURE), binary: null, now });
    const windows = scanRecipes({ root: repo(crlf), binary: null, now });
    expect(project(windows)).toEqual(project(lf));
    expect(windows.packages).toEqual(lf.packages);
    expect(windows.build_order).toEqual(lf.build_order);
    expect(windows.review).toEqual(lf.review);
    expect(windows.recipes.map(recipe => recipe.entry)).toEqual(lf.recipes.map(recipe => recipe.entry));
  });
});

const real = process.env.MEX_TEST_REAL_HOOK_BINARY === "1" && spawnSync("go", ["version"]).status === 0;
describe.skipIf(!real)("checks recorded through the real evaluator", () => {
  let hook: string;
  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), "mex-recipes-hook-")); temps.push(base);
    hook = join(base, process.platform === "win32" ? "mex-hook.exe" : "mex-hook");
    await promisify(execFile)("go", ["build", "-o", hook, "./cmd/mex-hook"], { cwd: resolve("native"), env: { ...process.env, CGO_ENABLED: "0" }, timeout: 240_000 });
  }, 300_000);

  it("records checks that hold on the fixture and no longer hold once a script is removed", () => {
    const root = repo(FIXTURE);
    const file = scanRecipes({ root, binary: hook });
    expect(file.checks).toBe("recorded");
    for (const recipe of file.recipes) expect(recipe.entry.mex.checks.length, recipe.command).toBeGreaterThan(0);
    const test = file.recipes.find(recipe => recipe.command === "pnpm --filter @demo/dal run test")!;
    expect(test.entry.mex.checks.map(check => `${check.kind}:${check.role}`)).toEqual(["key:complete", "command:supporting"]);
    expect(test.entry.mex.checks[0]).toMatchObject({ saw: { value: "vitest" } });
    const tox = file.recipes.find(recipe => recipe.command === "tox -e lint")!;
    expect(tox.entry.mex.checks[0]).toMatchObject({ kind: "key", saw: { value: "ruff check ." } });

    // Remove the script: the same targets can no longer be recorded, so the stored checks no longer hold.
    writeFileSync(join(root, "packages/dal/package.json"), json({ name: "@demo/dal", scripts: { build: "tsc -b" } }));
    writeFileSync(join(root, "tox.ini"), "[tox]\nenvlist = py311\n\n[testenv]\ncommands = pytest\n");
    const again = recordChecks(hook, root, [...test.entry.mex.checks, ...tox.entry.mex.checks].map(check => ({ kind: check.kind as "key", role: check.role, target: check.target as never })));
    expect(again).toEqual([undefined, undefined, undefined, undefined]);
  });
});
