import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "glob";
import type { Claim, DriftIssue } from "../../types.js";

/** Runtimes, platforms, databases, protocols, and architectural terms that appear in stack docs but aren't installable packages */
const KNOWN_RUNTIMES = new Set([
  "node.js", "node", "nodejs",
  "python", "cpython",
  "go", "golang",
  "rust",
  "ruby",
  "java", "jdk", "jre",
  "deno", "bun",
  "swift", "kotlin", "elixir", "erlang", "php",
  ".net", "dotnet", "c#", "csharp",
  "sqlite", "sqlite3",
  "postgresql", "postgres",
  "mysql", "mariadb",
  "mongodb", "mongo",
  "redis",
  "elasticsearch",
  "dynamodb", "cassandra", "neo4j", "supabase", "neon",
  "docker",
  "kubernetes", "k8s",
  "vercel", "netlify", "railway", "fly.io", "render",
  "aws", "gcp", "azure", "cloudflare",
  "s3", "ec2", "lambda", "ecs", "fargate",
  "rest", "rest api", "graphql", "grpc", "websocket", "websockets",
  "oauth", "oauth2", "jwt", "saml", "oidc",
  "http", "https", "tcp", "udp",
  "tailwind", "tailwind css", "tailwindcss",
  "bootstrap", "sass", "less", "postcss",
  "webpack", "vite", "esbuild", "turbopack", "rollup", "parcel",
  "git", "github", "gitlab", "ci/cd", "nginx", "apache", "caddy",
  "npm", "pnpm", "yarn", "npx", "corepack",
  "linux", "macos", "windows", "wasm", "webassembly",
]);

/** Check that claimed dependencies exist in manifests */
export function checkDependencies(
  claims: Claim[],
  projectRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const deps = loadAllDependencies(projectRoot);
  if (!deps) return issues;

  const depClaims = claims.filter(
    (c) => c.kind === "dependency" && !c.negated
  );
  const versionClaims = claims.filter(
    (c) => c.kind === "version" && !c.negated
  );

  for (const claim of depClaims) {
    const name = claim.value.toLowerCase();

    // Skip known runtimes/platforms — they won't be in package.json
    if (KNOWN_RUNTIMES.has(name)) continue;

    // Fuzzy match: "React" → "react", "Express" → "express"
    const found = deps.find(
      (d) => d.name.toLowerCase() === name
    );
    if (!found) {
      issues.push({
        code: "DEPENDENCY_MISSING",
        severity: "warning",
        file: claim.source,
        line: claim.line,
        message: `Claimed dependency "${claim.value}" not found in any manifest`,
        claim,
      });
    }
  }

  for (const claim of versionClaims) {
    // Parse "React 18" or "Node v20"
    const match = claim.value.match(/^(.+?)\s+v?(\d[\d.]*\S*)$/);
    if (!match) continue;

    const name = match[1].trim().toLowerCase();
    const claimedVersion = match[2];
    const found = deps.find(
      (d) => d.name.toLowerCase() === name
    );

    if (found && !found.version.includes(claimedVersion)) {
      issues.push({
        code: "VERSION_MISMATCH",
        severity: "warning",
        file: claim.source,
        line: claim.line,
        message: `Claimed "${claim.value}" but manifest has version "${found.version}"`,
        claim,
      });
    }
  }

  return issues;
}

interface DepEntry {
  name: string;
  version: string;
}

function loadAllDependencies(projectRoot: string): DepEntry[] | null {
  const entries: DepEntry[] = [];

  // package.json
  const pkgPath = resolve(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        entries.push({ name, version: String(version) });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        entries.push({ name, version: String(version) });
      }
    } catch {
      // skip
    }
  }

  // pyproject.toml (#3): [project] dependencies and optional-dependencies,
  // plus [tool.poetry.dependencies]. Python claims ("FastAPI", "Celery") were
  // reported missing whenever the project declared them here instead of a
  // package.json. Version specifiers are kept verbatim — the version-claims
  // checker treats them as substrings, and PEP 508 names are the identity.
  const pyprojectPath = resolve(projectRoot, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    entries.push(...parsePyprojectDependencies(readFileSync(pyprojectPath, "utf-8")));
  }

  // A repository often keeps a second application in a subdirectory without
  // declaring workspaces, and that application's packages are declared in its
  // own manifest. Reading only the root one reported every dependency the
  // subproject documents as missing.
  for (const nested of globSync("*/package.json", {
    cwd: projectRoot,
    ignore: ["node_modules/**"],
  })) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(projectRoot, nested), "utf-8"));
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        entries.push({ name, version: String(version) });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        entries.push({ name, version: String(version) });
      }
    } catch {
      // skip
    }
  }

  return entries.length ? entries : null;
}

/**
 * Extract dependency names from a pyproject.toml without a TOML dependency.
 *
 * Bounded line-scan over the shapes the drift checker cares about: the
 * `dependencies` array inside `[project]`, the per-extra arrays inside
 * `[project.optional-dependencies]`, and the key-value pairs inside
 * `[tool.poetry.dependencies]`. The package name is the identity; the raw
 * version specifier is kept as evidence. Dynamic declarations
 * (`dynamic = ["dependencies"]`) and everything outside these tables are out
 * of scope for a checker that only needs name identity.
 */
export function parsePyprojectDependencies(content: string): DepEntry[] {
  const entries: DepEntry[] = [];
  let table = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;

    const keyValue = /^["']?([A-Za-z0-9][\w.-]*)["']?\s*=\s*(.*)$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const value = keyValue[2]!.trim();

    if (table === "project" && key === "dependencies") {
      for (const { name, version } of parseDependencyArray(value)) entries.push({ name, version });
      continue;
    }
    if (table === "project.optional-dependencies") {
      for (const { name, version } of parseDependencyArray(value)) entries.push({ name, version });
      continue;
    }
    if (table === "tool.poetry.dependencies") {
      // `python = "^3.12"` is the interpreter constraint, not a package.
      if (key.toLowerCase() === "python") continue;
      entries.push({ name: key, version: value.replace(/^["']|["'],?\s*$/g, "") || "*" });
      continue;
    }
  }
  return entries;
}

/** Names out of `["pkg>=1", "pkg2"]`-style arrays (PEP 508 specs included). */
function parseDependencyArray(value: string): Array<{ name: string; version: string }> {
  const inner = /\[\s*(.*)\]/.exec(value)?.[1] ?? value;
  const out: Array<{ name: string; version: string }> = [];
  for (const item of inner.matchAll(/["']([^"']+)["']/g)) {
    const spec = item[1]!;
    const name = /^([A-Za-z0-9][\w.-]*)/.exec(spec)?.[1];
    if (name) out.push({ name, version: spec.slice(name.length) || "*" });
  }
  return out;
}
