import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname, resolve } from "node:path";
import { eventAttributes } from "../src/telemetry/schema.js";

/**
 * Architectural lint for the wiki engine.
 *
 * These three rules exist in phase one rather than in the phases that need
 * them, because each protects a guarantee that dies quietly. A single careless
 * line breaks it, the code still compiles and every test still passes, and the
 * damage only surfaces much later as an acceptance criterion about unrelated
 * bytes. The bans have to precede the code that could violate them.
 *
 * Each rule is a pure function over (path, source) so it can be tested against
 * a planted violation without writing files. A lint test that has never failed
 * is not a test, so every rule below has a negative case.
 */

const REPO_ROOT = resolve(__dirname, "..");
const SRC = join(REPO_ROOT, "src");

/** Repo-relative POSIX paths of every TypeScript file under src/, tests excluded. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "fixtures" || entry.name === "wasm") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      found.push(relative(REPO_ROOT, full).replace(/\\/g, "/"));
    }
  };
  walk(SRC);
  return found.sort();
}

const FILES = sourceFiles();

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

// -- Rule (a): dependency direction ------------------------------------------

/**
 * Layering rules, as a table so a later phase extends it by adding a row.
 *
 * The model layer is pure data and validation. Keeping the filesystem, SQLite
 * and the code graph out of it is what lets the same definitions serve the
 * index, operations, migration, synthesis and the Hub — and what lets wiki
 * reads work in a checkout with no graph at all.
 */
interface LayerRule {
  /** Repo-relative directory the rule applies to. */
  layer: string;
  /** Import prefixes this layer may not reach for. */
  forbids: string[];
  reason: string;
}

const LAYER_RULES: LayerRule[] = [
  {
    layer: "src/wiki/model/",
    forbids: [
      "src/wiki/markdown/",
      "src/wiki/index/",
      "src/wiki/grounding/",
      "src/wiki/operations/",
      "src/wiki/query/",
      "src/wiki/synthesis/",
      "src/wiki/migration/",
      "src/wiki/validation/",
      "src/wiki/cli/",
      "src/graph/",
      "node:fs",
      "node:sqlite",
      "node:child_process",
    ],
    reason: "the model layer is pure data and validation; it must not reach for I/O, the code graph, or any layer above it",
  },
  {
    layer: "src/wiki/synthesis/",
    forbids: [
      "src/wiki/operations/apply",
      "src/wiki/operations/plan",
      "src/wiki/operations/audit",
      "src/wiki/index/",
      "node:sqlite",
      "node:child_process",
    ],
    reason:
      "synthesis proposes and never applies: its output is operation envelopes, and a module that could call the pipeline itself would be a second writer wearing the proposer's name. It may read `operations/paths` for the one containment rule the whole engine shares",
  },
  {
    layer: "src/wiki/query/",
    forbids: [
      "src/wiki/operations/",
      "src/wiki/index/rebuild",
      "src/wiki/index/refresh",
      "src/wiki/index/publish",
      "src/wiki/index/dbfile",
    ],
    reason:
      "reads must not depend on writes; a query that can mutate is a query nobody can cache or parallelize, and a read path that can rebuild turns a 10 ms query into a 5 s one at random while hiding that the index was broken",
  },
];

/** Import specifiers in a source file: static, type-only, re-export and dynamic. */
export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.push(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found;
}

/** Resolve an import specifier to a repo-relative path, or return it unchanged. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = join(dirname(fromFile), specifier).replace(/\\/g, "/");
  // `.js` in ESM source refers to the `.ts` beside it; the prefix match below
  // only cares about the directory, so the extension is left as-is.
  return resolved;
}

export function findLayeringViolations(
  path: string,
  source: string,
  rules: readonly LayerRule[] = LAYER_RULES,
): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    if (!path.startsWith(rule.layer)) continue;
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(path, specifier);
      for (const forbidden of rule.forbids) {
        if (resolved === forbidden || resolved.startsWith(forbidden)) {
          violations.push(`${path} imports "${specifier}" — ${rule.reason}`);
        }
      }
    }
  }
  return violations;
}

// -- Rule (b): no re-serialization -------------------------------------------

/**
 * The two primitives permitted to write Markdown text.
 *
 * Forward-looking: neither file exists yet. They are named now so that when the
 * codec is built, the only place a serializer could legally live is already
 * fixed, rather than being argued about under deadline pressure.
 */
const SERIALIZATION_ALLOWLIST = ["src/wiki/markdown/patch.ts", "src/wiki/markdown/frontmatter.ts"];

/**
 * Files exempt from the no-re-serialization rule.
 *
 * **Empty, and it stays empty.** `writeGroundings` in `src/markdown.ts` was the
 * one recorded exception: it rewrote the whole frontmatter block through
 * `YAML.stringify`, losing comment placement, quoting style and key order on
 * every grounding write. P2b refactored it onto the scoped
 * `spliceTopLevelKey` primitive, so the exception is gone.
 *
 * A new entry here is not a fix. It is a second writer with different fidelity,
 * which is how byte preservation dies.
 */
const KNOWN_SERIALIZATION_EXCEPTIONS: string[] = [];

export function findSerializationViolations(path: string, source: string): string[] {
  if (SERIALIZATION_ALLOWLIST.includes(path) || KNOWN_SERIALIZATION_EXCEPTIONS.includes(path)) return [];

  const violations: string[] = [];
  if (importSpecifiers(source).some((specifier) => specifier === "remark-stringify")) {
    violations.push(
      `${path} imports remark-stringify — re-serializing an AST reformats unrelated content; splice ranges in the original text instead`,
    );
  }
  // Matches `YAML.stringify(`, `yaml.stringify(` and `stringifyDocument(` style
  // aliases of the same operation over a whole map.
  for (const match of source.matchAll(/\b(?:YAML|yaml)\s*\.\s*stringify\s*\(/g)) {
    violations.push(
      `${path} calls ${match[0].trim()} — rewriting a whole YAML map loses comments, quoting and key order; splice the one key's range instead`,
    );
  }
  return violations;
}

// -- Rule (c): no unscoped scaffold writes -----------------------------------

/**
 * Nothing under `src/wiki/` writes a file directly.
 *
 * Every path that modifies a `.mex` file — operations, migration apply,
 * generated-view regeneration, anchor reconciliation — goes through the one
 * plan/preview/apply pipeline, so that write-scope enforcement and the audit
 * log cannot be bypassed. A second writer is exactly how byte preservation
 * dies.
 */
const WRITE_ALLOWLIST = ["src/wiki/operations/apply.ts", "src/wiki/operations/audit.ts", "src/wiki/index/dbfile.ts"];

const WRITE_CALLS =
  /\b(writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|rmSync|unlinkSync|renameSync|truncateSync)\s*\(/g;

/** Source with comments removed, so a rule reads code and not prose about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every allowlisted writer's exemption, narrowed to what it is actually for.
 *
 * `src/wiki/index/dbfile.ts` renames a rebuilt index into place and deletes the
 * temp file a crashed build left behind. `src/wiki/operations/apply.ts` writes
 * Markdown through a temp file and a rename. `src/wiki/operations/audit.ts`
 * appends one line to the operation log. None can be judged safe by reading a
 * call site — but "it is not really an unscoped write" is what every second
 * writer has claimed, so each exemption carries its own runtime guard and this
 * rule asserts the guard is in front of **every** mutation.
 *
 * Until P5 this rule began `if (!WRITE_ALLOWLIST.includes(path) ||
 * !path.startsWith("src/wiki/index/")) return []`, so `apply.ts` and `audit.ts`
 * sat on the allowlist with nothing behind it: either could have called
 * `writeFileSync` on any path in the world with every lint test green. The
 * guard name is now a per-file fact, which is also what stops one module
 * satisfying the count with another module's guard.
 *
 * A lint rule cannot tell that `rmSync(path)` is safe. The guard can, and it
 * fails closed.
 */
const WRITE_GUARDS: Readonly<Record<string, string>> = {
  "src/wiki/index/dbfile.ts": "assertIndexPath",
  "src/wiki/operations/apply.ts": "assertWritablePath",
  "src/wiki/operations/audit.ts": "assertOperationLogPath",
};

/** A string literal naming a Markdown file. */
const MARKDOWN_LITERAL = /["'`][^"'`]*\.mdx?["'`]/;

export function findGuardedWriteViolations(path: string, source: string): string[] {
  const guardName = WRITE_GUARDS[path];
  if (guardName === undefined) return [];

  const violations: string[] = [];
  const code = withoutComments(source);
  const mutations = [...code.matchAll(WRITE_CALLS)].length;
  const guards = [...code.matchAll(new RegExp(String.raw`\b` + guardName + String.raw`\s*\(`, "gu"))].length;
  if (mutations > 0 && guards < mutations) {
    violations.push(
      `${path} performs ${mutations} filesystem mutations but calls ${guardName} ${guards} times — every mutation must be guarded`,
    );
  }
  // The index module may not name Markdown; the Markdown writers, obviously,
  // may. That half of the rule belongs to one exemption, not to all of them.
  if (path.startsWith("src/wiki/index/") && MARKDOWN_LITERAL.test(code)) {
    violations.push(`${path} names a Markdown path — the database module may only touch database files`);
  }
  return violations;
}

/**
 * Every file the allowlist exempts must be a file the guard rule can see.
 *
 * The two lists drifting apart is exactly how `apply.ts` came to be exempt with
 * nothing behind it, so they are asserted equal rather than maintained in
 * parallel and hoped about.
 */
export function findUnguardedAllowlistEntries(): string[] {
  return WRITE_ALLOWLIST.filter((path) => WRITE_GUARDS[path] === undefined).map(
    (path) => `${path} is write-allowlisted but has no runtime guard registered`,
  );
}

/**
 * The ban itself, read against code rather than prose about code.
 *
 * `withoutComments` was added in P3 for the guarded rule and not for this one,
 * so a module *documenting* why it does not call `writeFileSync` was a
 * violation — a false positive that pushes the next author to reword a comment
 * rather than to think about the rule. Stripping comments cannot hide a real
 * write, because a write inside a comment is not a write.
 */
export function findScaffoldWriteViolations(path: string, source: string): string[] {
  if (!path.startsWith("src/wiki/") || WRITE_ALLOWLIST.includes(path)) return [];
  return [...withoutComments(source).matchAll(WRITE_CALLS)].map(
    (match) =>
      `${path} calls ${match[1]} — all writes go through the operation pipeline so write-scope enforcement and the audit log cannot be bypassed`,
  );
}

// -- Rule (d): one door onto the code graph ----------------------------------

/**
 * The wiki reaches the code graph through exactly one module.
 *
 * `src/wiki/grounding/adapter.ts` binds `GraphEngine`, the `Reconciler` and
 * `FingerprintStore` into an interface, and everything else works against that
 * interface. The reason is the rule the adapter's callers have to obey and
 * cannot be reminded of at every call site: the drift oracle is the reference
 * committed in Markdown, and `graph.db`'s cached `body_hash` is never the
 * primary signal, because a graph rebuild re-captures it and the comparison
 * silently becomes current-against-current.
 *
 * That rule is enforceable while there is one door and unenforceable once there
 * are several. This is the same discipline P2b's `createPositionMap` has for
 * AST offsets, and for the same reason: the second implementation is where the
 * correction gets forgotten.
 *
 * `src/graph/db/sqlite.ts` is exempt because it is not the graph — it is the
 * SQLite adapter D8 says the wiki index shares, and `wiki.db` is opened with
 * it. Importing a database driver tells you nothing about code.
 */
const GRAPH_DOOR = "src/wiki/grounding/adapter.ts";

/**
 * What each file under `src/wiki/` may reach for, beyond the door.
 *
 * Stated per file rather than per directory on purpose. A rule that exempted
 * `src/wiki/grounding/` wholesale would let the next module in that directory
 * bind the engine directly, which is the thing being prevented.
 *
 * - Every wiki file may import the shared SQLite adapter (D8) and the
 *   baseline's value types. Neither carries any knowledge of code: one is a
 *   database driver, the other is two interfaces and a string union.
 * - `query/budget.ts` composes with the graph's own token estimator and budget
 *   ledger, which D10 requires rather than permits — a second budget system is
 *   the failure it avoids.
 * - `grounding/baseline.ts` wraps `FingerprintStore`, the code that has always
 *   owned the one baseline table. D1's whole point is that it stays the only
 *   one, so wrapping it is the compliance, not the violation. It may reach for
 *   that and nothing else.
 */
const GRAPH_IMPORT_ALLOWANCES: ReadonlyArray<{ file: string | null; allows: string }> = [
  { file: null, allows: "src/graph/db/sqlite" },
  { file: null, allows: "src/graph/grounding" },
  { file: "src/wiki/query/budget.ts", allows: "src/graph/agent-protocol" },
  { file: "src/wiki/grounding/baseline.ts", allows: "src/graph/fingerprint-store" },
];

export function findGraphSeamViolations(path: string, source: string): string[] {
  if (!path.startsWith("src/wiki/")) return [];
  if (path === GRAPH_DOOR) return [];
  const allowed = (resolved: string): boolean =>
    GRAPH_IMPORT_ALLOWANCES.some(
      (allowance) => (allowance.file === null || allowance.file === path) && resolved.startsWith(allowance.allows),
    );
  return importSpecifiers(source)
    .map((specifier) => resolveSpecifier(path, specifier))
    .filter((resolved) => resolved.startsWith("src/graph/"))
    .filter((resolved) => !allowed(resolved))
    .map((resolved) => `${path} imports ${resolved}; the code graph is reached through ${GRAPH_DOOR}`);
}

// -- The rules, applied to the tree ------------------------------------------

/**
 * Bytes that make a source file binary to Git.
 *
 * Finding 45 caught two P5 modules embedding a raw U+0000 as a hash-field
 * delimiter: Git calls a file binary the moment it sees one, so `git diff`
 * renders "Bin 0 -> N bytes", `--numstat` reports nothing, review sees nothing,
 * `core.autocrlf` skips the file and a later merge is binary rather than
 * three-way. Finding 46 then concluded that "nothing in the tooling catches
 * this and no test can."
 *
 * The second half of that is wrong, and P6 proved it the expensive way:
 * `src/wiki/migration/ids.ts` shipped with three literal NULs in `6cc4647`,
 * for the same reason and in the same shape, one phase after the fix. A byte
 * scan is a test, and this is it. It reads the file as bytes rather than as
 * text, because a decoded string is exactly where the distinction disappears.
 *
 * The escape byte is included for a different reason: §15.2 forbids ANSI in
 * JSON output, and a colour sequence written literally into a source string is
 * how one gets there without any call to a colour library.
 */
const FORBIDDEN_SOURCE_BYTES: ReadonlyArray<{ byte: number; name: string; why: string }> = [
  { byte: 0x00, name: "U+0000", why: "makes the file binary to Git; write the escape instead" },
  { byte: 0x1b, name: "U+001B", why: "a live terminal escape; build it with String.fromCharCode in a test" },
];

function filesWithForbiddenBytes(paths: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const path of paths) {
    const bytes = readFileSync(join(REPO_ROOT, path));
    for (const { byte, name, why } of FORBIDDEN_SOURCE_BYTES) {
      if (bytes.includes(byte)) offenders.push(`${path}: ${name} — ${why}`);
    }
  }
  return offenders.sort();
}

/** Every tracked TypeScript file, tests included — the defect landed in both kinds. */
function allTypeScriptFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "wasm" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      found.push(relative(REPO_ROOT, full).replace(/\\/g, "/"));
    }
  };
  walk(SRC);
  walk(join(REPO_ROOT, "test"));
  return found.sort();
}

/**
 * Product modules cannot bypass the CLI/Hub projection with direct captures.
 * Only their composition roots import the capture entry point. Runtime schema
 * checks complement this dependency guard: command names are a closed catalog,
 * and no event accepts query text, paths, artifact IDs, or arbitrary properties.
 */
const TELEMETRY_COMPOSITION_ROOTS = ["src/cli.ts", "src/hub/command.ts"];

function findTelemetryLeaks(path: string, source: string): string[] {
  if (path.startsWith("src/telemetry/")) return [];
  const code = withoutComments(source);
  const violations: string[] = [];
  for (const specifier of importSpecifiers(code)) {
    const resolved = resolveSpecifier(path, specifier);
    if (!resolved.startsWith("src/telemetry/") || resolved === "src/telemetry/schema.js") continue;
    if (resolved !== "src/telemetry/index.js" || !TELEMETRY_COMPOSITION_ROOTS.includes(path)) {
      violations.push(`${path} imports ${resolved}; telemetry must use the CLI/Hub projection`);
    }
  }
  // Composition roots pass the capture function to the projection; they never
  // call it with command arguments themselves. Legacy hooks stay inside core.
  if (/\b(?:captureEvent|captureCommand)\s*\(/.test(code)) {
    violations.push(`${path} captures directly instead of using the CLI/Hub projection`);
  }
  return violations;
}

describe("telemetry keeps Wiki arguments behind the shared projection", () => {
  it("holds across every shipped module", () => {
    expect(FILES.flatMap((path) => findTelemetryLeaks(path, read(path)))).toEqual([]);
  });

  it("checks the real production capture entry points", () => {
    const callers = FILES.filter((path) => importSpecifiers(withoutComments(read(path)))
      .some((specifier) => resolveSpecifier(path, specifier) === "src/telemetry/index.js"));
    expect(callers.sort()).toEqual([...TELEMETRY_COMPOSITION_ROOTS].sort());
    expect(read("src/cli.ts")).toContain("createCliTelemetry(captureEvent, flush,");
  });

  it("rejects bypasses, including aliased imports and direct transport access", () => {
    expect(findTelemetryLeaks("src/cli.ts", 'captureCommand("wiki query", queryText, scaffoldId);')).toHaveLength(1);
    expect(findTelemetryLeaks("src/cli.ts", 'captureEvent("cli.command_started", { command: userQuery });')).toHaveLength(1);
    expect(findTelemetryLeaks("src/wiki/cli/query.ts",
      'import { captureEvent as send } from "../../telemetry/index.js";')).toHaveLength(1);
    expect(findTelemetryLeaks("src/cli.ts",
      'import { sendBatch } from "./telemetry/transport.js";')).toHaveLength(1);
    expect(findTelemetryLeaks("src/wiki/query/query.ts",
      'export { captureEvent } from "../../telemetry/index.js";')).toHaveLength(1);
    expect(findTelemetryLeaks("src/cli.ts",
      'import { captureEvent, flush } from "./telemetry/index.js"; createCliTelemetry(captureEvent, flush);')).toEqual([]);
  });

  it("rejects Wiki input values and extra properties at the final schema boundary", () => {
    const event = "cli.command_started";
    expect(eventAttributes(event, { command: "wiki.query" })).toEqual({ command: "wiki.query" });
    for (const value of ["private query text", "component:private-id", "/private/project/file.ts"]) {
      expect(eventAttributes(event, { command: value })).toBeUndefined();
      expect(eventAttributes(event, { command: "wiki.query", argument: value })).toBeUndefined();
    }
  });
});

describe("no literal control bytes in source", () => {
  it("holds across src/ and test/", () => {
    expect(filesWithForbiddenBytes(allTypeScriptFiles())).toEqual([]);
  });

  it("scans a file list that actually contains the modules the rule was written for", () => {
    const files = allTypeScriptFiles();
    // Named because a rule that silently stopped walking would pass vacuously,
    // and these three are the ones that have carried the defect.
    expect(files).toContain("src/wiki/operations/plan.ts");
    expect(files).toContain("src/wiki/operations/preview.ts");
    expect(files).toContain("src/wiki/migration/ids.ts");
    expect(files.length).toBeGreaterThan(100);
  });

  it("catches a planted byte of each kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "mex-lint-"));
    try {
      const nul = join(dir, "nul.ts");
      const esc = join(dir, "esc.ts");
      const clean = join(dir, "clean.ts");
      writeFileSync(nul, `const delimiter = "${String.fromCharCode(0)}";`);
      writeFileSync(esc, `const red = "${String.fromCharCode(0x1b)}[31m";`);
      // The same intent, spelled the way the rule asks for: an escape, not a byte.
      writeFileSync(clean, `const delimiter = "${String.fromCharCode(92)}u0000";`);
      const relativeTo = (file: string) => relative(REPO_ROOT, file).replace(/\\/g, "/");
      const offenders = filesWithForbiddenBytes([nul, esc, clean].map(relativeTo));
      expect(offenders).toHaveLength(2);
      expect(offenders.some((entry) => entry.includes("U+0000"))).toBe(true);
      expect(offenders.some((entry) => entry.includes("U+001B"))).toBe(true);
      expect(offenders.some((entry) => entry.includes("clean.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wiki layering", () => {
  it("finds source files to check", () => {
    // Guards against the walk silently matching nothing, which would make every
    // assertion below vacuously true.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.filter((path) => path.startsWith("src/wiki/")).length).toBeGreaterThan(5);
  });

  it("keeps the model layer free of I/O, the code graph and higher layers", () => {
    const violations = FILES.flatMap((path) => findLayeringViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("catches a synthesis module reaching for the pipeline it feeds", () => {
    // The rule provoked rather than merely present: synthesis emits envelopes,
    // and a module here that could call `applyOperation` would be a second
    // writer with the proposer's name on it.
    expect(
      findLayeringViolations("src/wiki/synthesis/propose.ts", 'import { applyOperation } from "../operations/apply.js";'),
    ).toHaveLength(1);
    // …and the one import it legitimately needs still passes: containment is
    // shared with the write side on purpose, so both answer alike for a path.
    expect(
      findLayeringViolations("src/wiki/synthesis/propose.ts", 'import { isReadOnlyPath } from "../operations/paths.js";'),
    ).toEqual([]);
  });

  it("catches a planted layering violation", () => {
    expect(
      findLayeringViolations("src/wiki/model/entity.ts", 'import { openGraphDatabase } from "../../graph/db/database.js";'),
    ).toHaveLength(1);
    expect(findLayeringViolations("src/wiki/model/entity.ts", 'import { readFileSync } from "node:fs";')).toHaveLength(1);
    expect(
      findLayeringViolations("src/wiki/model/entity.ts", 'const mod = await import("../index/rebuild.js");'),
    ).toHaveLength(1);
    expect(findLayeringViolations("src/wiki/query/list.ts", 'import { plan } from "../operations/plan.js";')).toHaveLength(1);
  });

  it("allows what the model layer legitimately needs", () => {
    expect(findLayeringViolations("src/wiki/model/ulid.ts", 'import { randomFillSync } from "node:crypto";')).toEqual([]);
    expect(findLayeringViolations("src/wiki/model/entity.ts", 'import { type EntityId } from "./ids.js";')).toEqual([]);
    // Layers above the model may reach for I/O and the graph.
    expect(findLayeringViolations("src/wiki/index/open.ts", 'import { readFileSync } from "node:fs";')).toEqual([]);
  });
});

describe("one door onto the code graph", () => {
  it("holds across src/wiki/", () => {
    expect(FILES.flatMap((path) => findGraphSeamViolations(path, read(path)))).toEqual([]);
  });

  it("checks a file list that actually contains the door", () => {
    // Vacuity guard with teeth: renaming the adapter away must fail this rule
    // rather than satisfy it by leaving nothing to check.
    expect(FILES).toContain(GRAPH_DOOR);
    expect(read(GRAPH_DOOR)).toContain("from \"../../graph/engine.js\"");
  });

  it("catches a second seam, and permits the shared SQLite adapter", () => {
    expect(
      findGraphSeamViolations("src/wiki/query/for-code.ts", 'import { createGraphEngine } from "../../graph/engine-impl.js";'),
    ).toHaveLength(1);
    expect(
      findGraphSeamViolations("src/wiki/index/write.ts", 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toHaveLength(1);
    // The type-only import of the row shapes is still a graph import and still
    // banned; only the database driver and the baseline's own value types pass.
    expect(
      findGraphSeamViolations("src/wiki/index/write.ts", 'import type { SqliteDatabase } from "../../graph/db/sqlite.js";'),
    ).toEqual([]);
    expect(
      findGraphSeamViolations("src/wiki/grounding/baseline.ts", 'import type { GroundingSubject } from "../../graph/grounding.js";'),
    ).toEqual([]);
    // The door itself may import whatever it needs.
    expect(
      findGraphSeamViolations(GRAPH_DOOR, 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toEqual([]);
    // A per-file allowance is exactly that: baseline.ts may wrap the store and
    // may not bind the engine, and no other file inherits its allowance.
    expect(
      findGraphSeamViolations("src/wiki/grounding/baseline.ts", 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toEqual([]);
    expect(
      findGraphSeamViolations("src/wiki/grounding/baseline.ts", 'import type { GraphEngine } from "../../graph/engine.js";'),
    ).toHaveLength(1);
    expect(
      findGraphSeamViolations("src/wiki/grounding/resolve.ts", 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toHaveLength(1);
  });

  it("does not constrain code outside the wiki engine", () => {
    expect(
      findGraphSeamViolations("src/drift/checkers/grounding.ts", 'import type { GraphEngine } from "../../graph/engine.js";'),
    ).toEqual([]);
  });
});

describe("no Markdown re-serialization", () => {
  it("holds across the tree apart from the one recorded exception", () => {
    const violations = FILES.flatMap((path) => findSerializationViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("has no recorded exceptions left, and may not grow new ones", () => {
    // The count reached zero when P2b moved `writeGroundings` onto the scoped
    // splice. It may only stay there: a new entry means a second writer that
    // reformats, which is the failure this whole rule exists to prevent.
    expect(KNOWN_SERIALIZATION_EXCEPTIONS).toEqual([]);
    expect(read("src/markdown.ts")).not.toContain("YAML.stringify(");
  });

  it("keeps remark-stringify out of the dependency list entirely", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("remark-stringify");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("remark-stringify");
  });

  it("catches a planted re-serialization", () => {
    expect(findSerializationViolations("src/wiki/index/rebuild.ts", 'import remarkStringify from "remark-stringify";')).toHaveLength(1);
    expect(findSerializationViolations("src/wiki/operations/apply.ts", "const text = YAML.stringify(frontmatter);")).toHaveLength(1);
    expect(findSerializationViolations("src/wiki/operations/apply.ts", "const text = yaml.stringify(doc);")).toHaveLength(1);
  });

  it("permits the two primitives that legitimately write Markdown text", () => {
    for (const path of SERIALIZATION_ALLOWLIST) {
      expect(findSerializationViolations(path, "const text = YAML.stringify(value);")).toEqual([]);
    }
  });

  it("does not flag ordinary JSON serialization", () => {
    expect(findSerializationViolations("src/wiki/cli/json.ts", "return JSON.stringify(envelope);")).toEqual([]);
  });
});

describe("no unscoped scaffold writes", () => {
  it("holds across src/wiki/", () => {
    const violations = FILES.flatMap((path) => findScaffoldWriteViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("keeps every write exemption guarded", () => {
    expect(FILES.flatMap((path) => findGuardedWriteViolations(path, read(path)))).toEqual([]);
    // The allowlist and the guard table must name the same files.
    expect(findUnguardedAllowlistEntries()).toEqual([]);
    // Each rule needs a subject: renaming a guarded file away must fail this
    // rather than satisfy it by leaving nothing to check.
    for (const [path, guard] of Object.entries(WRITE_GUARDS)) {
      expect(FILES, `${path} is registered as a guarded writer`).toContain(path);
      expect(read(path), `${path} must call ${guard}`).toContain(guard);
    }
  });

  it("catches an unguarded database write, and a Markdown path in the database module", () => {
    expect(findGuardedWriteViolations("src/wiki/index/dbfile.ts", "export function f() { rmSync(path); }")).toHaveLength(1);
    expect(
      findGuardedWriteViolations(
        "src/wiki/index/dbfile.ts",
        'export function f() { assertIndexPath(p); rmSync(p); const doc = "ROUTER.md"; }',
      ),
    ).toHaveLength(1);
    expect(
      findGuardedWriteViolations("src/wiki/index/dbfile.ts", "export function f() { assertIndexPath(p); rmSync(p); }"),
    ).toEqual([]);
    // A word boundary, not an identity escape (§33.4).
    expect(
      findGuardedWriteViolations("src/wiki/index/dbfile.ts", "export function f() { xassertIndexPath(p); rmSync(p); }"),
    ).toHaveLength(1);
  });

  it("fires on a planted violation in each of the two operation writers", () => {
    // The rule this replaces returned `[]` for both of these files, so an
    // `apply.ts` that wrote anywhere in the world passed every lint test. A
    // planted violation is the only way to know the extension actually fires.
    expect(
      findGuardedWriteViolations("src/wiki/operations/apply.ts", "export function f() { writeFileSync(p, t); }"),
    ).toHaveLength(1);
    expect(
      findGuardedWriteViolations("src/wiki/operations/audit.ts", "export function f() { appendFileSync(p, line); }"),
    ).toHaveLength(1);
    // Satisfied by the *right* guard, not by any guard: apply.ts cannot borrow
    // the audit log's, which is what a per-file table buys over a shared name.
    expect(
      findGuardedWriteViolations(
        "src/wiki/operations/apply.ts",
        "export function f() { assertOperationLogPath(root, p); writeFileSync(p, t); }",
      ),
    ).toHaveLength(1);
    expect(
      findGuardedWriteViolations(
        "src/wiki/operations/apply.ts",
        "export function f() { assertWritablePath(root, p); writeFileSync(p, t); }",
      ),
    ).toEqual([]);
    // A Markdown path in a Markdown writer is the point of it, not a violation.
    expect(
      findGuardedWriteViolations(
        "src/wiki/operations/apply.ts",
        'export function f() { assertWritablePath(root, p); writeFileSync(p, "x.md"); }',
      ),
    ).toEqual([]);
  });

  it("catches a planted write, and reads code rather than prose about it", () => {
    expect(findScaffoldWriteViolations("src/wiki/migration/apply.ts", "writeFileSync(path, text);")).toHaveLength(1);
    expect(findScaffoldWriteViolations("src/wiki/migration/generated.ts", "await writeFile(path, text);")).toHaveLength(1);
    expect(findScaffoldWriteViolations("src/wiki/operations/audit.ts", "appendFileSync(log, line);")).toEqual([]);
    const commented = ["// never calls writeFileSync(path, text)", "const x = 1;"].join(String.fromCharCode(10));
    const real = ["// a comment", "writeFileSync(path, text);"].join(String.fromCharCode(10));
    expect(findScaffoldWriteViolations("src/wiki/index/open.ts", commented)).toEqual([]);
    expect(findScaffoldWriteViolations("src/wiki/index/open.ts", real)).toHaveLength(1);
  });

  it("pins every filesystem writer outside the wiki engine", () => {
    // D9 says there is no second writer anywhere in the tree. **That is not
    // true today**, and the honest response is to pin the exceptions rather
    // than restate the claim.
    //
    // `src/graph/runtime.ts` is the one that matters, and it is the reason this
    // rule exists: it writes into `.mex` Markdown files a human already wrote,
    // during anchor reconciliation and grounding-baseline capture. Both use
    // one staged publication helper and scoped splices, but both bypass
    // write-scope enforcement, the audit log and `wiki.readOnly`: a `mex ground`
    // run will happily write into `team/**`. Pinned rather than folded, because
    // routing `mex ground` through this pipeline changes shipped behaviour on a
    // path with real users, for legacy root-level keys P6 migrates away from
    // anyway — a bad trade to make in the phase that introduces the pipeline.
    //
    // The rest write JSON, hooks, or brand-new files, so there are no bytes of
    // anybody's to preserve. **Pinned by write call, not by a Markdown
    // heuristic**: the first draft of this rule looked for a `.md` literal near
    // a write, and `runtime.ts` — the only entry that matters — does not
    // contain one, because its paths arrive in variables. A detector that
    // cannot see its own motivating case is worse than a longer list.
    //
    // Every other rule in this file is scoped to `src/wiki/`, so before this
    // one nothing in `src/` was watching at all.
    const KNOWN: Readonly<Record<string, string>> = {
      "src/agent-skills/installer.ts": "atomically installs fixed packaged skill trees and marker-scoped root instructions",
      "src/graph/candidate-process.ts": "removes only the identity-bound parent-owned temporary workspace after the candidate child closes",
      "src/graph/engine-impl.ts": "writes only a private, bounded temporary source spool that is removed before graph publication",
      "src/graph/maintenance.ts": "publishes and recovers the disposable graph index under its maintenance lease",
      "src/graph/runtime.ts": "edits existing .mex Markdown; bypasses the pipeline (recorded D9 exception)",
      "src/hub/setup/commit.ts": "manages temporary and preserved Git indexes for explicit revision-reviewed setup commits; never edits Wiki content",
      "src/config.ts": "writes config.json",
      "src/global-config.ts": "writes the global config and telemetry id",
      "src/events.ts": "appends to events/decisions.jsonl",
      "src/export.ts": "writes one export bundle to a user-specified path — a brand-new file, never scaffold bytes",
      "src/pattern/index.ts": "creates a new pattern file from a template",
      "src/setup/anchor.ts": "edits root tool configs only, never .mex/, and only inside its own markers",
      "src/setup/ignore.ts": "creates or appends only the setup-managed .mex/.gitignore rules",
      "src/setup/population.ts": "writes and removes one ignored private prompt file for the interactive setup session",
      "src/team/artifacts/filesystem.ts": "atomically publishes bounded team-owned canonical artifacts",
      "src/team/local-state/receipt-signer.ts": "atomically provisions the bounded local-only C preview signing credential",
      "src/team/relay/cli/local-preview.ts": "removes only the exact contained checkout-local Relay receipt after successful apply",
      "src/watch.ts": "installs and removes git hooks",
    };

    const outside = FILES.filter((path) => !path.startsWith("src/wiki/"));
    const writers = outside.filter((path) => [...withoutComments(read(path)).matchAll(WRITE_CALLS)].length > 0);
    expect(writers.sort()).toEqual(Object.keys(KNOWN).sort());
    // Vacuity guard: there were files outside the wiki engine to check.
    expect(outside.length).toBeGreaterThan(20);

    // Pin the shared exclusive staging write and rename publication, so a new
    // direct writer in this existing exception is caught as well.
    const runtime = withoutComments(read("src/graph/runtime.ts"));
    expect([...runtime.matchAll(/writeFileSync\s*\(/g)]).toHaveLength(1);
    expect([...runtime.matchAll(/renameSync\s*\(/g)]).toHaveLength(1);
  });

  it("does not constrain code outside the wiki engine", () => {
    // The rest of mex has its own writers and is not in scope for this rule.
    expect(findScaffoldWriteViolations("src/setup/scaffold.ts", "writeFileSync(path, text);")).toEqual([]);
  });
});
