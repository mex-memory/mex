import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    source(root, "main.go", "package main\n");
    source(root, "internal/server/server.go", "package server\n");
    source(root, "src/App.svelte", "<script>let x = 1;</script>\n");
    source(root, "src/api.ts", "export const api = true;\n");

    const coverage = unindexedExtensionHistogram(root);

    expect(coverage.total).toBe(3);
    expect(coverage.entries).toEqual([
      { extension: ".go", files: 2 },
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
      source(root, `generated/file-${i}.go`, "package main\n");
    }

    const coverage = unindexedExtensionHistogram(root, limits);

    expect(coverage.truncated).toBe(true);
    expect(coverage.total).toBe(limits.maxUnindexedFiles);
    expect(coverage.entries[0]).toEqual({ extension: ".go", files: limits.maxUnindexedFiles });
  });

  it("caps the reported entries at maxUnindexedEntries, most common first", () => {
    const root = temporaryRoot();
    const limits = { maxUnindexedFiles: 1000, maxUnindexedEntries: 3 };
    for (const extension of [".go", ".rb", ".java", ".kt", ".scala"]) {
      source(root, `src/main${extension}`, "x\n");
    }
    source(root, "src/extra.go", "package extra\n");

    const coverage = unindexedExtensionHistogram(root, limits);

    expect(coverage.total).toBe(6);
    expect(coverage.entries).toEqual([
      { extension: ".go", files: 2 },
      { extension: ".java", files: 1 },
      { extension: ".kt", files: 1 },
    ]);
    expect(coverage.truncated).toBe(false);
  });
});
