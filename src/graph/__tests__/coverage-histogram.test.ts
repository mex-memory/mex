import fs from "node:fs";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureGraphCoverage, COVERAGE_CACHE_LIMITS, readGraphCoverage, readGraphCoverageObservation,
} from "../coverage.js";
import type { SqliteDatabase } from "../db/sqlite.js";
import {
  GRAPH_COVERAGE_LIMITS,
  unindexedExtensionHistogram,
} from "../corpus-policy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "mex-graph-coverage-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function source(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

describe("unindexedExtensionHistogram", () => {
  it("reports recognized source extensions no extractor handles", () => {
    const root = temporaryRoot();
    source(root, "main.java", "class Main {}\n");
    source(root, "internal/server/server.java", "package server;\n");
    source(root, "src/App.svelte", "<script>let x = 1;</script>\n");
    source(root, "src/api.ts", "export const api = true;\n");

    const coverage = unindexedExtensionHistogram(root);

    expect(coverage.total).toBe(3);
    expect(coverage.entries).toEqual([
      { extension: ".java", files: 2 },
      { extension: ".svelte", files: 1 },
    ]);
    expect(coverage.truncated).toBe(false);
  });

  it("ignores unsupported-but-uninteresting extensions, dotfiles and dot-directories", () => {
    const root = temporaryRoot();
    source(root, "README.md", "# readme\n");
    source(root, "package.json", "{}\n");
    source(root, "assets/logo.png", "png");
    source(root, ".github/workflows/deploy.yml", "on: push\n");
    source(root, ".gitignore", "node_modules\n");
    source(root, "Dockerfile", "FROM node\n");
    source(root, "src/api.ts", "export const api = true;\n");

    const coverage = unindexedExtensionHistogram(root);

    expect(coverage.total).toBe(0);
    expect(coverage.entries).toEqual([]);
  });

  it("honors the repository's configured graph.ignore globs", () => {
    const root = temporaryRoot();
    source(root, "vendor/legacy.go", "package legacy\n");
    source(root, "main.rb", "puts 1\n");
    source(root, ".mex/config.json", JSON.stringify({
      graph: { ignore: ["vendor/**"] },
    }));

    const coverage = unindexedExtensionHistogram(root);

    expect(coverage.total).toBe(1);
    expect(coverage.entries).toEqual([{ extension: ".rb", files: 1 }]);
  });

  it("is empty on a repository with nothing recognized at all", () => {
    const root = temporaryRoot();
    source(root, "notes.txt", "hello\n");

    const coverage = unindexedExtensionHistogram(root);

    expect(coverage.total).toBe(0);
  });

  it("stops the walk when the scan cap is crossed and reports truncation", () => {
    const root = temporaryRoot();
    const limits = { maxUnindexedFiles: 50, maxUnindexedEntries: 24 };
    // Only counted files, so the processed-file cap maps exactly onto the total.
    for (let i = 0; i < limits.maxUnindexedFiles + 10; i++) {
      source(root, `generated/file-${i}.java`, "class File {}\n");
    }

    const coverage = unindexedExtensionHistogram(root, limits);

    expect(coverage.truncated).toBe(true);
    expect(coverage.total).toBe(limits.maxUnindexedFiles);
    expect(coverage.entries[0]).toEqual({ extension: ".java", files: limits.maxUnindexedFiles });
  });

  it("caps the reported entries at maxUnindexedEntries, most common first", () => {
    const root = temporaryRoot();
    const limits = { maxUnindexedFiles: 1000, maxUnindexedEntries: 3 };
    for (const extension of [".cpp", ".rb", ".java", ".kt", ".scala"]) {
      source(root, `src/main${extension}`, "x\n");
    }
    source(root, "src/extra.cpp", "int extra;\n");

    const coverage = unindexedExtensionHistogram(root, limits);

    expect(coverage.total).toBe(6);
    expect(coverage.entries).toEqual([
      { extension: ".cpp", files: 2 },
      { extension: ".java", files: 1 },
      { extension: ".kt", files: 1 },
    ]);
    expect(coverage.truncated).toBe(false);
  });
});

function cachedDb(raw: string): SqliteDatabase {
  return { prepare: () => ({ get: () => ({ value: raw }) }) } as unknown as SqliteDatabase;
}

describe("build-time coverage cache", () => {
  it("counts 600 candidates exactly in a 30k-file tree", () => {
    const root = temporaryRoot();
    for (let i = 0; i < 30_000; i++) source(root, `data/${i}.txt`, "");
    for (let i = 0; i < 600; i++) source(root, `src/${i}.java`, "class File {}");
    const raw = captureGraphCoverage(root);
    expect(readGraphCoverage(cachedDb(raw), root, true)).toMatchObject({ total: 600, truncated: false });
    // Large fixture cleanup belongs to this test's explicit runtime budget.
    roots.splice(roots.indexOf(root), 1);
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it("reuses metadata without any directory discovery on reads", () => {
    const root = temporaryRoot();
    source(root, "src/main.java", "class Main {}");
    const raw = captureGraphCoverage(root);
    const spy = vi.spyOn(fs, "opendirSync").mockImplementation(() => { throw new Error("read-time walk"); });
    try {
      for (let i = 0; i < 3; i++) expect(readGraphCoverage(cachedDb(raw), root, true)?.total).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it("invalidates nested additions, new directories and deletions even without supported-source drift", () => {
    const root = temporaryRoot();
    source(root, "src/main.go", "package main");
    let raw = captureGraphCoverage(root);
    source(root, "src/added.vue", "<template />");
    expect(readGraphCoverage(cachedDb(raw), root, true)).toBeNull();
    raw = captureGraphCoverage(root);
    source(root, "new/deep/added.go", "package main");
    expect(readGraphCoverage(cachedDb(raw), root, true)).toBeNull();
    raw = captureGraphCoverage(root);
    rmSync(join(root, "src/main.go"));
    expect(readGraphCoverage(cachedDb(raw), root, true)).toBeNull();
  });

  it("does not claim exact counts for stale/degraded, malformed or over-bound metadata", () => {
    const root = temporaryRoot();
    source(root, "main.go", "package main");
    const raw = captureGraphCoverage(root);
    expect(readGraphCoverage(cachedDb(raw), root, false)).toBeNull();
    for (const malformed of ["{", "null", "{}", JSON.stringify({ ...JSON.parse(raw), directories: Array(COVERAGE_CACHE_LIMITS.directories + 1).fill({}) })]) {
      expect(readGraphCoverage(cachedDb(malformed), root, true)).toBeNull();
    }
  });

  it("returns unknown when a directory cannot be observed", () => {
    const root = temporaryRoot();
    const denied = vi.spyOn(fs, "opendirSync").mockImplementation(() => { throw new Error("denied"); });
    try { expect(captureGraphCoverage(root)).toBe("null"); } finally { denied.mockRestore(); }
  });

  it("keeps build-time counts, unstamped, once the entry or directory budget is crossed", () => {
    const root = temporaryRoot();
    source(root, "a/one.java", "class One {}");
    source(root, "b/two.vue", "<template />");
    source(root, "c/three.java", "class Three {}");
    const huge = vi.spyOn(fs, "opendirSync").mockImplementation(() => ({
      readSync: () => ({ name: "entry" }), closeSync: () => {},
    }) as unknown as fs.Dir);
    let raw: string;
    try { raw = captureGraphCoverage(root); } finally { huge.mockRestore(); }
    expect(JSON.parse(raw)).toMatchObject({ directories: [], histogram: { total: 3, truncated: false } });

    raw = captureGraphCoverage(root, { ...COVERAGE_CACHE_LIMITS, directories: 2 });
    expect(JSON.parse(raw)).toMatchObject({ directories: [], histogram: { total: 3, truncated: false } });
    const observation = readGraphCoverageObservation(cachedDb(raw), root, { graphCurrent: true, verify: "always" });
    // Counts past the budget can never verify, but they are not discarded.
    expect(observation).toMatchObject({ verified: false, histogram: { total: 3 } });
    expect(readGraphCoverage(cachedDb(raw), root, true)).toBeNull();
  });

  it("keeps counts as a last-build observation when an unrelated directory entry changes", () => {
    const root = temporaryRoot();
    source(root, "src/App.vue", "<template />");
    source(root, "README.md", "# readme");
    const raw = captureGraphCoverage(root);
    expect(readGraphCoverageObservation(cachedDb(raw), root, { graphCurrent: true, verify: "always" }))
      .toMatchObject({ verified: true, histogram: { total: 1 } });
    // An editor's atomic save: write a temporary file, then rename it over the original.
    writeFileSync(join(root, "README.md.tmp"), "# readme v2");
    renameSync(join(root, "README.md.tmp"), join(root, "README.md"));
    expect(readGraphCoverageObservation(cachedDb(raw), root, { graphCurrent: true, verify: "always" }))
      .toMatchObject({ verified: false, histogram: { total: 1, entries: [{ extension: ".vue", files: 1 }] } });
    expect(readGraphCoverageObservation(cachedDb(raw), root, { graphCurrent: false, verify: "always" }))
      .toMatchObject({ verified: false, histogram: { total: 1 } });
  });

  it("verifies stamps with lstat alone, never realpath, on reads", () => {
    const root = temporaryRoot();
    source(root, "src/deep/main.java", "class Main {}");
    const raw = captureGraphCoverage(root);
    const realpath = vi.spyOn(fs, "realpathSync").mockImplementation(() => { throw new Error("read-time realpath"); });
    try {
      expect(readGraphCoverage(cachedDb(raw), root, true)?.total).toBe(1);
    } finally { realpath.mockRestore(); }
  });

  it("skips directory stamps entirely when nothing would be reported", () => {
    const root = temporaryRoot();
    source(root, "src/api.ts", "export const api = 1;");
    const raw = captureGraphCoverage(root);
    const lstat = vi.spyOn(fs, "lstatSync");
    try {
      expect(readGraphCoverageObservation(cachedDb(raw), root, { graphCurrent: true, verify: "when-reported" }))
        .toMatchObject({ histogram: { total: 0, truncated: false } });
      expect(lstat).not.toHaveBeenCalled();
      readGraphCoverageObservation(cachedDb(raw), root, { graphCurrent: true, verify: "always" });
      expect(lstat).toHaveBeenCalled();
    } finally { lstat.mockRestore(); }
  });

  it("drops schema and shell extension noise", () => {
    const root = temporaryRoot();
    for (const ext of ["sql", "proto", "gradle", "ps1", "bash", "zsh", "vim"]) source(root, `file.${ext}`, "text");
    expect(unindexedExtensionHistogram(root)).toEqual({ total: 0, entries: [], truncated: false });
  });
});
