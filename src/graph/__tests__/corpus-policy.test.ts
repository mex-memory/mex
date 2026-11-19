import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  GRAPH_CORPUS_IGNORE_GLOBS,
  GRAPH_CORPUS_LIMITS,
  GRAPH_CORPUS_POLICY_HASH,
  GRAPH_IGNORE_CONFIG_LIMITS,
  GraphCorpusLimitError,
  graphCorpusIgnoreGlobs,
  graphCorpusPolicyHash,
  isPerFileCorpusLimitError,
  readConfiguredGraphIgnoreGlobs,
  addGraphCompilerSourceBytes,
  addGraphCorpusBytes,
  addGraphSemanticInput,
  createGraphSemanticInputLedger,
  discoverBoundedGraphPaths,
} from "../corpus-policy.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-corpus-policy-"));
  roots.push(root);
  for (const path of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "export const value = true;\n", "utf8");
  }
  return root;
}

describe("graph corpus policy", () => {
  it("discovers deterministically without materializing beyond the file ceiling", () => {
    const root = fixture(["src/z.ts", "src/a.ts"]);
    const options = { ...GRAPH_CORPUS_GLOB_OPTIONS, cwd: root };

    expect(discoverBoundedGraphPaths("src/**/*.ts", options, 2)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(() => discoverBoundedGraphPaths("src/**/*.ts", options, 1))
      .toThrow(GraphCorpusLimitError);
  });

  it("rejects per-file and aggregate byte overflows", () => {
    expect(() => addGraphCorpusBytes(
      0,
      GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1,
      "source",
    )).toThrow(GraphCorpusLimitError);
    expect(() => addGraphCorpusBytes(
      GRAPH_CORPUS_LIMITS.maxSourceBytes,
      1,
      "source",
    )).toThrow(GraphCorpusLimitError);
    expect(() => addGraphCompilerSourceBytes(
      GRAPH_CORPUS_LIMITS.maxCompilerSourceBytes,
      1,
    )).toThrow("maxCompilerSourceBytes");
  });

  it("shares hard path and byte ceilings for indirect compiler inputs", () => {
    const byteLedger = createGraphSemanticInputLedger();
    const fullFiles = GRAPH_CORPUS_LIMITS.maxSemanticInputBytes
      / GRAPH_CORPUS_LIMITS.maxSourceFileBytes;
    for (let index = 0; index < fullFiles; index += 1) {
      addGraphSemanticInput(
        byteLedger,
        `config/${index}.json`,
        GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
      );
    }
    expect(() => addGraphSemanticInput(byteLedger, "config/next.json", 1))
      .toThrow("maxSemanticInputBytes");

    const pathLedger = createGraphSemanticInputLedger();
    for (let index = 0; index < GRAPH_CORPUS_LIMITS.maxSemanticInputFiles; index += 1) {
      addGraphSemanticInput(pathLedger, `missing/${index}.json`, null);
    }
    expect(() => addGraphSemanticInput(pathLedger, "missing/overflow.json", null))
      .toThrow("maxSemanticInputFiles");

    const coveredProbeLedger = createGraphSemanticInputLedger();
    for (let index = 0; index <= GRAPH_CORPUS_LIMITS.maxSemanticInputFiles; index += 1) {
      addGraphSemanticInput(coveredProbeLedger, `missing/${index}.ts`, null, false);
    }
    expect(coveredProbeLedger.semanticPaths.size).toBe(0);
  });
});

describe("per-file corpus limits", () => {
  it("separates a single-file ceiling from a corpus-wide one", () => {
    const perFile = new GraphCorpusLimitError("maxSourceFileBytes", 34_380_944);
    const corpusWide = new GraphCorpusLimitError("maxSourceBytes");

    expect(perFile.perFile).toBe(true);
    expect(isPerFileCorpusLimitError(perFile)).toBe(true);
    expect(corpusWide.perFile).toBe(false);
    expect(isPerFileCorpusLimitError(corpusWide)).toBe(false);
    expect(isPerFileCorpusLimitError(new Error("unrelated"))).toBe(false);
  });

  it("names the observed size and the limit on the first line", () => {
    // The limit is named, not recovered from byte values: per-file ceilings
    // can be numerically identical.
    expect(new GraphCorpusLimitError("maxSourceFileBytes", 34_380_944).message)
      .toBe("The graph corpus exceeded the configured maxSourceFileBytes safety bound: "
        + "34380944 bytes against a 4194304-byte limit.");
    expect(() => addGraphCorpusBytes(0, GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1, "source"))
      .toThrow(/maxSourceFileBytes safety bound: 4194305 bytes/u);
  });
});

describe("configured graph ignore globs", () => {
  function withConfig(body: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "mex-graph-ignore-config-"));
    roots.push(root);
    mkdirSync(join(root, ".mex"), { recursive: true });
    writeFileSync(
      join(root, ".mex", "config.json"),
      typeof body === "string" ? body : JSON.stringify(body),
      "utf8",
    );
    return root;
  }

  it("appends configured globs to the frozen defaults, never replacing them", () => {
    const root = withConfig({ graph: { ignore: ["generated/**", "**/*.gen.ts"] } });

    expect(readConfiguredGraphIgnoreGlobs(root)).toEqual(["**/*.gen.ts", "generated/**"]);
    expect(graphCorpusIgnoreGlobs(root)).toEqual([
      ...GRAPH_CORPUS_IGNORE_GLOBS,
      "**/*.gen.ts",
      "generated/**",
    ]);
  });

  it("cannot un-ignore a default, whatever the configuration says", () => {
    const root = withConfig({ graph: { ignore: ["!**/node_modules/**", "!**/.mex/**"] } });

    // Negations are appended like any other glob and cancel *earlier* patterns
    // only in glob semantics we never rely on; the defaults still stand.
    for (const glob of GRAPH_CORPUS_IGNORE_GLOBS) {
      expect(graphCorpusIgnoreGlobs(root)).toContain(glob);
    }
  });

  it("yields no extra globs rather than failing on a malformed or hostile config", () => {
    expect(readConfiguredGraphIgnoreGlobs(withConfig("{ not json"))).toEqual([]);
    expect(readConfiguredGraphIgnoreGlobs(withConfig([1, 2, 3]))).toEqual([]);
    expect(readConfiguredGraphIgnoreGlobs(withConfig({ graph: "nope" }))).toEqual([]);
    expect(readConfiguredGraphIgnoreGlobs(withConfig({ graph: { ignore: "nope" } }))).toEqual([]);
    expect(readConfiguredGraphIgnoreGlobs(withConfig({
      graph: { ignore: [42, "", "   "] },
    }))).toEqual([]);
    expect(readConfiguredGraphIgnoreGlobs(
      mkdtempSync(join(tmpdir(), "mex-graph-ignore-missing-")),
    )).toEqual([]);
  });

  it("rejects every escaping glob identically on every platform", () => {
    // `.mex/config.json` is tracked and travels with the repository, and these
    // globs feed the corpus policy hash. A platform-dependent verdict — which
    // `path.isAbsolute` gives, since `C:/x` is absolute only on Windows — would
    // give one repository two manifest hashes and make its index read as stale
    // purely from being opened on another machine.
    const escaping = [
      "/absolute/**",
      "//server/share/**",
      "\\\\server\\share\\**",
      "C:/absolute/**",
      "c:/absolute/**",
      "C:\\absolute\\**",
      "C:relative/**",
      "../escape/**",
      "..\\escape\\**",
      "vendor/../../escape/**",
      "..",
    ];
    const root = withConfig({ graph: { ignore: escaping } });

    expect(readConfiguredGraphIgnoreGlobs(root)).toEqual([]);
    expect(graphCorpusPolicyHash(root)).toBe(GRAPH_CORPUS_POLICY_HASH);
  });

  it("keeps ordinary globs that merely contain dots", () => {
    const root = withConfig({ graph: { ignore: ["a..b/**", "**/*.min.js", "./local/**"] } });

    expect(readConfiguredGraphIgnoreGlobs(root))
      .toEqual(["**/*.min.js", "./local/**", "a..b/**"]);
  });

  it("bounds the configured list", () => {
    const tooMany = Array.from({ length: 500 }, (_, index) => `dir${index}/**`);
    const tooLong = "x".repeat(GRAPH_IGNORE_CONFIG_LIMITS.maxGlobLength + 1);
    const root = withConfig({ graph: { ignore: [...tooMany, tooLong] } });

    const globs = readConfiguredGraphIgnoreGlobs(root);
    expect(globs.length).toBe(GRAPH_IGNORE_CONFIG_LIMITS.maxGlobs);
    expect(globs).not.toContain(tooLong);
  });

  it("keeps the discovery identity of a repository that configures nothing", () => {
    const unconfigured = mkdtempSync(join(tmpdir(), "mex-graph-ignore-none-"));
    roots.push(unconfigured);
    const configured = withConfig({ graph: { ignore: ["generated/**"] } });

    expect(graphCorpusPolicyHash(unconfigured)).toBe(GRAPH_CORPUS_POLICY_HASH);
    expect(graphCorpusPolicyHash(configured)).not.toBe(GRAPH_CORPUS_POLICY_HASH);
  });
});
