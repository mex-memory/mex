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

/**
 * Architectural and descriptive labels that name a part of a system rather
 * than something installable (#4). The complement to the acronym pattern
 * below: a single word like "Frontend" has the shape of a package name, so
 * only a list can catch it.
 *
 * Several of these — `server`, `client`, `queue`, `middleware`, `platform` —
 * are also real npm packages. That is safe here and would not be safe in the
 * claim extractor: a project that genuinely depends on one declares it in a
 * manifest, the lookup below finds it, and nothing is reported either way.
 * The list only suppresses a warning about a package nothing declares.
 */
const NON_PACKAGE_LABELS = new Set([
  "frontend", "backend", "fullstack", "full-stack",
  "database", "storage", "persistence",
  "middleware", "infrastructure", "infra", "platform",
  "authentication", "authorization",
  "caching", "queue", "queues", "scheduler", "workers",
  "server", "client", "monorepo", "tooling", "observability",
  "testing", "deployment", "orchestration", "gateway", "firewall",
]);

/**
 * An acronym names an architectural concept — `SPA`, `CRUD`, `MVC`, `SSR`,
 * `DDD` — not a package, so a claim written this way can never be satisfied
 * by a manifest.
 *
 * Deliberately narrow: one unseparated word. A capitalized package spelling
 * keeps its separators (`PINO-HTTP`, `GRAPHQL-WS`, `YOUTUBE.JS`, `@SCOPE/PKG`)
 * and is still checked.
 *
 * The residual cost, accepted: a package with a name short enough to be
 * written in capitals (`cors`, `ajv`, `d3`) stops being reported once it is
 * dropped from the manifest, because nothing in the name separates that from
 * an acronym. Version claims are unaffected — `**D3 7.0**` is still compared
 * against the manifest below.
 */
function isConceptAcronym(value: string): boolean {
  return /^[A-Z][A-Z0-9]*$/.test(value);
}

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

    // Skip what a stack section calls a part of the system rather than a
    // package: "Frontend", "Observability", "SPA" (#4).
    if (NON_PACKAGE_LABELS.has(name) || isConceptAcronym(claim.value)) continue;

    // Fuzzy match: "React" → "react", "Express" → "express"
    const found = findDependency(deps, name);
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
    const found = findDependency(deps, name);

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
  /** Set for manifests whose names normalize (PEP 503). npm names are compared
   *  verbatim: `lodash.debounce` and `lodash-debounce` are different packages
   *  there, while `sentence_transformers` and `sentence-transformers` are one
   *  package on PyPI. */
  normalizes?: boolean;
}

/** A claimed name against the manifest list. Prose uses the import spelling
 *  (`sentence_transformers`, `Tree.Sitter`) where the manifest carries the
 *  distribution name, so a normalizing ecosystem matches either. */
function findDependency(deps: DepEntry[], claimed: string): DepEntry | undefined {
  const exact = deps.find((d) => d.name.toLowerCase() === claimed);
  if (exact) return exact;
  const normalized = normalizeName(claimed);
  return deps.find((d) => d.normalizes && normalizeName(d.name) === normalized);
}

/**
 * Same walk for every manifest this checker understands. A one-directory
 * package.json glob found `backend/package.json` and missed
 * `api/backend/package.json`; `pyproject.toml` was never walked at all,
 * so `backend/pyproject.toml` produced false `DEPENDENCY_MISSING` while
 * the identical file at the root — or a JS manifest at the same depth —
 * passed (#206).
 *
 * Depth 5 matches the other bounded project walks (`path` checker,
 * brief-builder). Ignore the obvious generated trees so an installed
 * package's own manifest cannot satisfy a claim.
 */
const MANIFEST_MAX_DEPTH = 5;

const MANIFEST_IGNORE = [
  "**/node_modules/**",
  "node_modules/**",
  "**/.git/**",
  ".git/**",
  "**/dist/**",
  "dist/**",
  "**/build/**",
  "build/**",
  "**/.mex/**",
  ".mex/**",
  "**/.venv/**",
  ".venv/**",
  "**/venv/**",
  "venv/**",
  "**/__pycache__/**",
  "**/vendor/**",
  "vendor/**",
  "**/coverage/**",
] as const;

function discoverManifests(
  projectRoot: string,
  filename: "package.json" | "pyproject.toml"
): string[] {
  return globSync(`**/${filename}`, {
    cwd: projectRoot,
    nodir: true,
    ignore: [...MANIFEST_IGNORE],
    maxDepth: MANIFEST_MAX_DEPTH,
  });
}

function isRootManifest(rel: string, filename: string): boolean {
  const normalized = rel.replace(/\\/g, "/");
  return normalized === filename || normalized === `./${filename}`;
}

function collectPackageJsonEntries(absPath: string): DepEntry[] {
  try {
    const pkg = JSON.parse(readFileSync(absPath, "utf-8"));
    const entries: DepEntry[] = [];
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      entries.push({ name, version: String(version) });
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      entries.push({ name, version: String(version) });
    }
    return entries;
  } catch {
    return [];
  }
}

function loadAllDependencies(projectRoot: string): DepEntry[] | null {
  const entries: DepEntry[] = [];

  // package.json
  const pkgPath = resolve(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    entries.push(...collectPackageJsonEntries(pkgPath));
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

  // Nested manifests share one depth and ignore list. A repository often
  // keeps a second application in a subdirectory without declaring
  // workspaces; reading only the root file — or only one-level JS
  // manifests — reported every package that subproject documents as missing.
  for (const nested of discoverManifests(projectRoot, "package.json")) {
    if (isRootManifest(nested, "package.json")) continue;
    entries.push(...collectPackageJsonEntries(resolve(projectRoot, nested)));
  }
  for (const nested of discoverManifests(projectRoot, "pyproject.toml")) {
    if (isRootManifest(nested, "pyproject.toml")) continue;
    try {
      entries.push(
        ...parsePyprojectDependencies(readFileSync(resolve(projectRoot, nested), "utf-8"))
      );
    } catch {
      // skip
    }
  }

  // `null` is the only "this project's packages can't be read" signal the
  // checker has, and it suppresses every dependency issue. A manifest parser
  // that returns a few entries out of many is therefore worse than one that
  // returns none: it switches the checker on and measures claims against a
  // list it knows is incomplete. Parse a shape fully or leave it out.
  return entries.length ? entries : null;
}

/** A dependency table whose keys are package names, not extra/group names. */
const POETRY_DEPENDENCY_TABLE = /^tool\.poetry(?:\.group\.[\w.-]+)?\.dependencies$/;

/** Blank every quoted run so brackets, commas and `#` inside a string
 *  (`"celery[redis]"`, `"x; python_version < '3.11'"`) can't be read as
 *  structure. Returns a same-length mask, so indexes still line up. */
function maskStrings(line: string): string {
  return line.replace(/(["'])(?:(?!\1).)*\1/g, (run) => run[0] + " ".repeat(run.length - 2) + run[0]);
}

function stripComment(line: string): string {
  const hash = maskStrings(line).indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/** Split an array body on the commas that separate items, not the ones inside
 *  a version specifier (`"mcp>=1.0.0,<3"`). */
function splitItems(body: string): string[] {
  const mask = maskStrings(body);
  const items: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items;
}

/** The package name and its raw specifier out of one PEP 508 array item. */
function specEntry(item: string): DepEntry | null {
  const text = item.trim();
  // `{ include-group = "dev" }` (PEP 735) points at another group, and a
  // poetry multi-constraint table names no package of its own.
  if (!text || text.startsWith("{")) return null;
  const quoted = /(["'])((?:(?!\1).)*)\1/.exec(text);
  if (!quoted) return null;
  const spec = quoted[2]!;
  const name = /^([A-Za-z0-9][\w.-]*)/.exec(spec)?.[1];
  if (!name) return null;
  return { name, version: spec.slice(name.length).trim() || "*", normalizes: true };
}

/** PEP 503 names: `Tree_Sitter` and `tree-sitter` are the same package. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Extract dependency names from a pyproject.toml without a TOML dependency.
 *
 * Bounded line-scan over the shapes the drift checker cares about: the
 * `dependencies` array inside `[project]`, the per-extra arrays inside
 * `[project.optional-dependencies]`, the PEP 735 arrays inside
 * `[dependency-groups]`, and the key-value pairs inside
 * `[tool.poetry.dependencies]` and its named groups. The package name is the
 * identity; the raw version specifier is kept as evidence.
 *
 * An array is buffered across lines, because one item per line is what every
 * Python packaging tool writes and reading only the single-line form found
 * nothing in real projects. Dynamic declarations (`dynamic = ["dependencies"]`)
 * are out of scope: the packages aren't in the file to be read.
 */
export function parsePyprojectDependencies(content: string): DepEntry[] {
  const entries: DepEntry[] = [];
  let table = "";
  let projectName = "";
  // Set while a multi-line value is open: "collect" for a dependency array,
  // "skip" for a value whose packages are named by the key we already read.
  let open: "collect" | "skip" | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;

    if (open) {
      const closed = /[\]}]/.test(maskStrings(line));
      if (open === "collect") {
        for (const item of splitItems(line.replace(/[\]}][\s,]*$/, ""))) {
          const entry = specEntry(item);
          if (entry) entries.push(entry);
        }
      }
      if (closed) open = null;
      continue;
    }

    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      continue;
    }

    const keyValue = /^["']?([A-Za-z0-9][\w.-]*)["']?\s*=\s*(.*)$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const value = keyValue[2]!.trim();

    if (table === "project" && key === "name") {
      projectName = value.replace(/^["']|["']$/g, "");
      continue;
    }

    if (POETRY_DEPENDENCY_TABLE.test(table)) {
      // `python = "^3.12"` is the interpreter constraint, not a package.
      if (key.toLowerCase() === "python") continue;
      // `fastapi = { version = "^0.115", optional = true }` — the constraint is
      // the evidence the version checker compares against, not the whole table.
      const inline = /\bversion\s*=\s*(["'])((?:(?!\1).)*)\1/.exec(value);
      entries.push({
        name: key,
        version: inline?.[2] ?? (value.replace(/^["']|["'],?\s*$/g, "") || "*"),
        normalizes: true,
      });
      if (!/[\]}]/.test(maskStrings(value)) && /^[[{]/.test(value)) open = "skip";
      continue;
    }

    const isDependencyArray =
      (table === "project" && key === "dependencies") ||
      table === "project.optional-dependencies" ||
      table === "dependency-groups";
    if (!isDependencyArray) continue;

    const bracket = value.indexOf("[");
    if (bracket === -1) continue;
    const body = value.slice(bracket + 1);
    for (const item of splitItems(body.replace(/\][\s,]*$/, ""))) {
      const entry = specEntry(item);
      if (entry) entries.push(entry);
    }
    if (!maskStrings(body).includes("]")) open = "collect";
  }

  // An `all = ["mypkg[extra]", ...]` convenience extra declares the project as
  // its own dependency; that is not a package a scaffold can claim.
  const self = projectName ? normalizeName(projectName) : "";
  return self ? entries.filter((entry) => normalizeName(entry.name) !== self) : entries;
}
