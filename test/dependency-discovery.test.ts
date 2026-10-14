import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkDependencies } from "../src/drift/checkers/dependency.js";
import type { Claim } from "../src/types.js";

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-dependency-discovery-"));
  outside = mkdtempSync(join(tmpdir(), "mex-dependency-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const claim = (value: string, kind: Claim["kind"] = "dependency"): Claim =>
  ({ kind, value, source: "test.md", line: 1, section: null, negated: false });
function manifest(path: string, name = "real-package", version = "1.0.0") {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, "package.json"), JSON.stringify({ dependencies: { [name]: version } }));
}

it("preserves root Python precedence over nested JavaScript", () => {
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["httpx==1.0.0"]\n');
  manifest("backend", "httpx", "2.0.0");
  expect(checkDependencies([claim("httpx 1.0.0", "version")], root)).toEqual([]);
});

it("preserves root JavaScript precedence over root Python", () => {
  manifest("", "httpx", "2.0.0");
  writeFileSync(join(root, "pyproject.toml"), '[project]\ndependencies = ["httpx==1.0.0"]\n');
  expect(checkDependencies([claim("httpx 2.0.0", "version")], root)).toEqual([]);
});

it("orders nested manifests deterministically rather than by traversal order", () => {
  manifest("z/backend", "shared-package", "2.0.0");
  manifest("a/backend", "shared-package", "1.0.0");
  expect(checkDependencies([claim("shared-package 1.0.0", "version")], root)).toEqual([]);
});

it("finds the issue's FastAPI/Celery example and nested normalized optional dependencies", () => {
  mkdirSync(join(root, "services/backend/api"), { recursive: true });
  writeFileSync(join(root, "services/backend/api/pyproject.toml"), [
    "[project]",
    'dependencies = ["fastapi>=0.115", "celery[redis]==5.4.0"]',
    "[project.optional-dependencies]",
    'ml = ["sentence-transformers>=3.0"]',
  ].join("\n"));
  expect(checkDependencies([
    claim("FastAPI"), claim("Celery"), claim("sentence_transformers"), claim("celery 5.4.0", "version"),
  ], root)).toEqual([]);
});

it("excludes dependency directories and Git metadata at every depth", () => {
  manifest("");
  for (const path of ["node_modules/dependency", "apps/node_modules/dependency", "apps/.git/fixtures"]) {
    manifest(path, "ignored-package");
    writeFileSync(join(root, path, "pyproject.toml"), '[project]\ndependencies=["ignored-python==1"]\n');
  }
  expect(checkDependencies([claim("ignored-package"), claim("ignored-python")], root)).toHaveLength(2);
});

it.each(["package.json", "pyproject.toml"])("ignores an external nested %s symlink", (filename) => {
  manifest("");
  mkdirSync(join(root, "apps/backend"), { recursive: true });
  writeFileSync(join(outside, filename), filename === "package.json"
    ? JSON.stringify({ dependencies: { "external-only-package": "1" } })
    : '[project]\ndependencies=["external-only-package==1"]\n');
  symlinkSync(join(outside, filename), join(root, "apps/backend", filename), "file");
  expect(checkDependencies([claim("external-only-package")], root)).toHaveLength(1);
});

it("does not traverse directory symlinks or junctions", () => {
  manifest("");
  writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { "external-only-package": "1" } }));
  symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  expect(checkDependencies([claim("external-only-package")], root)).toHaveLength(1);
});

it("does not read directories named like manifests", () => {
  manifest("");
  mkdirSync(join(root, "apps/package.json"), { recursive: true });
  expect(checkDependencies([claim("missing-package")], root)).toHaveLength(1);
});

it("abstains if a discovered JSON manifest is malformed", () => {
  manifest("");
  mkdirSync(join(root, "apps/backend"), { recursive: true });
  writeFileSync(join(root, "apps/backend/package.json"), "{");
  expect(checkDependencies([claim("missing-package")], root)).toEqual([]);
});

it("abstains instead of using a partial corpus when a manifest exceeds the byte limit", () => {
  manifest("");
  writeFileSync(join(root, "pyproject.toml"), "#".repeat(1_048_577));
  expect(checkDependencies([claim("missing-package")], root)).toEqual([]);
});

it("abstains when the total manifest byte budget is exceeded", () => {
  manifest("");
  for (let i = 0; i < 8; i++) {
    mkdirSync(join(root, `service-${i}`));
    writeFileSync(join(root, `service-${i}/pyproject.toml`), "#".repeat(1_048_576));
  }
  expect(checkDependencies([claim("missing-package")], root)).toEqual([]);
});

it("abstains when too many manifests are discovered", () => {
  for (let i = 0; i < 1_025; i++) manifest(`service-${i}`);
  expect(checkDependencies([claim("missing-package")], root)).toEqual([]);
});
