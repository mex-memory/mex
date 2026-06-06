import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ManifestInfo } from "../types.js";

const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
] as const;

/** Detect and parse the project manifest */
export function scanManifest(projectRoot: string): ManifestInfo | null {
  for (const file of MANIFEST_FILES) {
    const path = resolve(projectRoot, file);
    if (!existsSync(path)) continue;

    switch (file) {
      case "package.json":
        return parsePackageJson(path);
      case "pyproject.toml":
        return parsePyprojectStub(path);
      case "go.mod":
        return parseGoModStub(path);
      case "Cargo.toml":
        return parseCargoStub(path);
    }
  }
  return null;
}

function parsePackageJson(path: string): ManifestInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return {
      type: "package.json",
      name: raw.name ?? null,
      version: raw.version ?? null,
      dependencies: raw.dependencies ?? {},
      devDependencies: raw.devDependencies ?? {},
      scripts: raw.scripts ?? {},
    };
  } catch {
    return null;
  }
}

// Stub parsers for other manifests — extend later
function parsePyprojectStub(path: string): ManifestInfo {
  const content = readFileSync(path, "utf-8");
  const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
  const versionMatch = content.match(/^version\s*=\s*"(.+)"/m);
  return {
    type: "pyproject.toml",
    name: nameMatch?.[1] ?? null,
    version: versionMatch?.[1] ?? null,
    dependencies: {},
    devDependencies: {},
    scripts: {},
  };
}

function parseGoModStub(path: string): ManifestInfo {
  const content = readFileSync(path, "utf-8");
  const moduleMatch = content.match(/^module\s+(.+)/m);
  return {
    type: "go.mod",
    name: moduleMatch?.[1] ?? null,
    version: null,
    dependencies: {},
    devDependencies: {},
    scripts: {},
  };
}

function parseCargoStub(path: string): ManifestInfo {
  const content = readFileSync(path, "utf-8");
  const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
  const versionMatch = content.match(/^version\s*=\s*"(.+)"/m);
  return {
    type: "Cargo.toml",
    name: nameMatch?.[1] ?? null,
    version: versionMatch?.[1] ?? null,
    dependencies: {},
    devDependencies: {},
    scripts: {},
  };
}
