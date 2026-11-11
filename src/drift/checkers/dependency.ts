import { RepositoryInventory } from "../repository.js";
import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import { resolve } from "node:path";
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
  projectRoot: string,
  repository = new RepositoryInventory(projectRoot),
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const deps = loadAllDependencies(projectRoot, repository);
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
  /** Set for manifests whose names normalize. npm names are compared
   *  verbatim: `lodash.debounce` and `lodash-debounce` are different packages
   *  there, while `sentence_transformers` and `sentence-transformers` are one
   *  package on PyPI. Cargo folds `-` and `_` together but keeps `.` as part
   *  of the name, so the two ecosystems normalize differently. */
  normalizes?: "pep503" | "cargo";
  /** Other spellings that name the same package. A Go module is declared by
   *  its full path (`github.com/spf13/cobra`) but prose names the package
   *  (`cobra`); a Cargo dependency renamed with `package = "..."` declares
   *  the crate under that name and is reached by its own key. */
  aliases?: string[];
}

/** A claimed name against the manifest list. Prose uses the import spelling
 *  (`sentence_transformers`, `Tree.Sitter`) where the manifest carries the
 *  distribution name, so a normalizing ecosystem matches either. */
function findDependency(deps: DepEntry[], claimed: string): DepEntry | undefined {
  const exact = deps.find((d) => d.name.toLowerCase() === claimed);
  if (exact) return exact;
  const displayNames: Record<string, string[]> = {
    nestjs: ["@nestjs/core", "@nestjs/common"], clickhouse: ["@clickhouse/client"], biome: ["@biomejs/biome"],
  };
  const display = deps.find((d) => displayNames[claimed]?.includes(d.name.toLowerCase()));
  if (display) return display;
  const alias = deps.find((d) => d.aliases?.some((a) => a.toLowerCase() === claimed));
  if (alias) return alias;
  const pep503 = deps.find((d) => d.normalizes === "pep503" && normalizeName(d.name) === normalizeName(claimed));
  if (pep503) return pep503;
  return deps.find((d) => d.normalizes === "cargo" && normalizeCrateName(d.name) === normalizeCrateName(claimed));
}

// Manifest reads preserve the existing per-file and aggregate byte budgets.
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_TOTAL_MANIFEST_BYTES = 8_388_608;

/** The manifest shapes the checker reads, each recognized by its file name.
 *  The separator class covers both the repository-relative POSIX paths and the
 *  resolved absolute paths the manifests are read from. */
const PYTHON_MANIFEST = /(^|[\\/])pyproject\.toml$/;
const RUST_MANIFEST = /(^|[\\/])Cargo\.toml$/;
const GO_MANIFEST = /(^|[\\/])go\.mod$/;

function readManifest(path: string, remaining: number): string | null {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) return null;
    const limit = Math.min(MAX_MANIFEST_BYTES, remaining);
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    return count > limit ? null : bytes.subarray(0, count).toString("utf-8");
  } finally { closeSync(descriptor); }
}

function loadAllDependencies(projectRoot: string, repository: RepositoryInventory): DepEntry[] | null {
  const entries: DepEntry[] = [];

  // Repositories can contain independent applications in nested directories.
  // Discover dependency manifests recursively, while ignoring dependency
  // directories and Git metadata so we only inspect manifests belonging to
  // the repository itself.
  const manifests = repository.files && repository.manifests && [
      ...repository.manifests.map((pkg) => resolve(projectRoot, pkg.path)),
      ...repository.files.filter((file) => PYTHON_MANIFEST.test(file) && repository.safeFile(file)).map((file) => resolve(projectRoot, file)),
      ...repository.files.filter((file) => RUST_MANIFEST.test(file) && repository.safeFile(file)).map((file) => resolve(projectRoot, file)),
      ...repository.files.filter((file) => GO_MANIFEST.test(file) && repository.safeFile(file)).map((file) => resolve(projectRoot, file)),
    ].sort((a, b) => {
      const rank = (file: string) => file === resolve(projectRoot, "package.json") ? 0 : file === resolve(projectRoot, "pyproject.toml") ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  if (!manifests || manifests.length > 1024) return null;
  let remaining = MAX_TOTAL_MANIFEST_BYTES;

  for (const manifest of manifests) {
    try {
      const content = readManifest(manifest, remaining);
      if (content === null) return null;
      remaining -= Buffer.byteLength(content, "utf-8");
      if (manifest.endsWith("package.json")) {
        const pkg = JSON.parse(content);

        for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
          entries.push({ name, version: String(version) });
        }

        for (const [name, version] of Object.entries({ ...pkg.peerDependencies, ...pkg.optionalDependencies, ...pkg.devDependencies })) {
          entries.push({ name, version: String(version) });
        }
      } else if (RUST_MANIFEST.test(manifest)) {
        entries.push(
          ...parseCargoDependencies(content)
        );
      } else if (GO_MANIFEST.test(manifest)) {
        entries.push(
          ...parseGoModDependencies(content)
        );
      } else {
        entries.push(
          ...parsePyprojectDependencies(content)
        );
      }
    } catch {
      // An unreadable or malformed manifest makes the corpus incomplete.
      return null;
    }
  }

  // `null` is the only "this project's packages can't be read" signal the
  // checker has, and it suppresses every dependency issue. A manifest parser
  // that returns a few entries out of many is therefore worse than one that
  // returns none: it switches the checker on and measures claims against a
  // list it knows is incomplete. Parse a shape fully or leave it out.
  return entries.length || repository?.manifests?.length ? entries : null;
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
  return { name, version: spec.slice(name.length).trim() || "*", normalizes: "pep503" };
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
        normalizes: "pep503",
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

/**
 * Extract dependency names from a Cargo.toml without a TOML dependency.
 *
 * Cargo declares a crate in one of the `[dependencies]`, `[dev-dependencies]`
 * or `[build-dependencies]` tables, and in a target-specific table such as
 * `[target.'cfg(unix)'.dependencies]` for a platform-gated crate. The version
 * is either a bare string (`serde = "1.0"`) or the `version` key of an inline
 * table (`serde = { version = "1.0", features = ["derive"] }`), which Cargo
 * also writes across several lines.
 *
 * Crate names are matched the way Cargo matches them: `my-crate` and
 * `my_crate` are the same crate, because Cargo itself accepts either spelling
 * and normalizes it. A dot is part of a crate name, not a separator.
 */
export function parseCargoDependencies(content: string): DepEntry[] {
  const entries: DepEntry[] = [];
  let inDependencyTable = false;
  // The crate whose inline table is still open, with what has been read from
  // it so far. A crate whose table closes without a version is still declared.
  // `depth` counts the braces the table still has open.
  let openCrate: { key: string; version?: string; package?: string; depth: number } | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;

    if (openCrate) {
      const version = /\bversion\s*=\s*(["'])((?:(?!\1).)*)\1/.exec(line);
      if (version && openCrate.version === undefined) openCrate.version = version[2]!;
      const renamed = /\bpackage\s*=\s*(["'])((?:(?!\1).)*)\1/.exec(line);
      if (renamed && openCrate.package === undefined) openCrate.package = renamed[2]!;
      openCrate.depth += braceDepth(line);
      if (openCrate.depth <= 0) {
        entries.push(cargoEntry(openCrate.key, openCrate.version, openCrate.package));
        openCrate = null;
      }
      continue;
    }

    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header) {
      inDependencyTable = isCargoDependencyTable(header[1]!.trim());
      continue;
    }

    if (!inDependencyTable) continue;

    const keyValue = /^["']?([A-Za-z0-9][\w.-]*)["']?\s*=\s*(.*)$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    const value = keyValue[2]!.trim();

    // `serde = "1.0"` — the version is the string itself.
    const bare = /^(["'])((?:(?!\1).)*)\1$/.exec(value);
    if (bare) {
      entries.push(cargoEntry(key, bare[2]!));
      continue;
    }

    // `serde = { version = "1.0", features = ["derive"] }` — one line.
    const inline = /\bversion\s*=\s*(["'])((?:(?!\1).)*)\1/.exec(value);
    const renamed = /\bpackage\s*=\s*(["'])((?:(?!\1).)*)\1/.exec(value);
    if (inline || renamed) {
      entries.push(cargoEntry(key, inline?.[2], renamed?.[2]));
      continue;
    }

    if (!/^\{/.test(value)) continue;

    // `serde = { features = ["derive"] }` — a crate with no version of its
    // own, but still a declared dependency.
    if (braceDepth(value) <= 0) {
      entries.push(cargoEntry(key));
      continue;
    }

    // `serde = {` followed by the keys on later lines.
    openCrate = { key, depth: braceDepth(value) };
  }

  // An inline table left open at the end of the file still declares its crate.
  if (openCrate) {
    entries.push(cargoEntry(openCrate.key, openCrate.version, openCrate.package));
  }

  return entries;
}

/** One crate, as the manifest declares it.
 *
 *  `package = "..."` renames a dependency: the key is the name the crate is
 *  used under in the code, and the value is the crate it resolves to. The
 *  crate name is the one the registry knows, so it is the name the entry
 *  carries, and the key is kept as an alias. */
function cargoEntry(key: string, version?: string, packageName?: string): DepEntry {
  const name = packageName ?? key;
  return {
    name,
    version: version ?? "*",
    normalizes: "cargo",
    aliases: packageName && packageName !== key ? [key] : undefined,
  };
}

/** The Cargo tables that declare a crate, including the target-gated ones. */
function isCargoDependencyTable(table: string): boolean {
  if (table === "dependencies" || table === "dev-dependencies" || table === "build-dependencies") {
    return true;
  }
  // `[workspace.dependencies]` holds the dependencies the member crates inherit.
  if (table === "workspace.dependencies") {
    return true;
  }
  // `[target.'cfg(unix)'.dependencies]` and `[target.x86_64-pc-windows-msvc.dev-dependencies]`.
  return /^target\..*\.(dependencies|dev-dependencies|build-dependencies)$/.test(table);
}

/** The net number of braces a line opens and leaves open.
 *
 *  Braces inside a quoted string are not part of the table, so they are
 *  masked out before the count. */
function braceDepth(line: string): number {
  const mask = maskStrings(line);
  let depth = 0;
  for (const ch of mask) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/**
 * Cargo crate names: `my-crate` and `my_crate` are the same crate.
 *
 * A dot is part of the name rather than a separator, so it is kept — unlike
 * PEP 503, which folds `.`, `-` and `_` into one.
 */
function normalizeCrateName(name: string): string {
  return name.toLowerCase().replace(/[-_]+/g, "-");
}

/**
 * Extract dependency names from a go.mod.
 *
 * A module is required either in a `require (...)` block or on a single
 * `require <path> <version>` line. The path is the module's identity, so it
 * is what the manifest carries; prose usually names the last path segment
 * instead (`cobra` for `github.com/spf13/cobra`), which is kept as an alias so
 * a claim in either spelling resolves to the same module.
 *
 * A `// indirect` comment marks a module required by a dependency rather than
 * by this module; it is still a declared dependency, so the comment is read
 * and then dropped.
 */
export function parseGoModDependencies(content: string): DepEntry[] {
  const entries: DepEntry[] = [];
  let inRequireBlock = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripGoComment(rawLine);
    if (!line) continue;

    if (inRequireBlock) {
      const closed = line.includes(")");
      const entry = goModuleEntry(line);
      if (entry) entries.push(entry);
      if (closed) inRequireBlock = false;
      continue;
    }

    if (/^require\s*\($/.test(line)) {
      inRequireBlock = true;
      continue;
    }

    if (/^require\s+\S/.test(line)) {
      const entry = goModuleEntry(line.replace(/^require\s+/, ""));
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

/** Drop a `//` comment, which is what go.mod uses. */
function stripGoComment(line: string): string {
  const comment = line.indexOf("//");
  return (comment === -1 ? line : line.slice(0, comment)).trim();
}

/** One `require` line: a module path and its version. */
function goModuleEntry(line: string): DepEntry | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [path, version] = parts;
  if (!path || !version) return null;
  // A module path is a domain or a host-prefixed path; anything else is a
  // directive the parser misread.
  if (!/^[A-Za-z0-9][\w.-]*(\.[A-Za-z0-9][\w.-]*)*(\/[\w.-]+)*$/.test(path)) return null;
  const segments = path.split("/");
  const alias = goModuleAlias(segments);
  return {
    name: path,
    version,
    aliases: alias ? [alias] : undefined,
  };
}

/** The package name a Go module path ends with.
 *
 *  A major-version suffix belongs to the module path, not to the package:
 *  `github.com/go-chi/chi/v5` is the package `chi`, so the suffix is skipped
 *  and the segment before it is the name. */
function goModuleAlias(segments: string[]): string | undefined {
  if (segments.length < 2) return undefined;
  const last = segments[segments.length - 1]!;
  if (/^v\d+$/.test(last)) return segments[segments.length - 2];
  return last;
}
