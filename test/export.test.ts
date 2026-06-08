import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bundleScaffoldMarkdown,
  runExport,
  sortScaffoldFiles,
} from "../src/export/index.js";
import type { MexConfig } from "../src/types.js";

let tmpDir: string;
let config: MexConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-export-"));
  const scaffoldRoot = join(tmpDir, ".mex");
  mkdirSync(join(scaffoldRoot, "context"), { recursive: true });
  mkdirSync(join(scaffoldRoot, "patterns"), { recursive: true });

  writeFileSync(join(scaffoldRoot, "ROUTER.md"), "# Router\n");
  writeFileSync(join(scaffoldRoot, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(scaffoldRoot, "context", "architecture.md"), "# Architecture\n");
  writeFileSync(join(scaffoldRoot, "patterns", "alpha.md"), "# Alpha pattern\n");

  config = {
    projectRoot: tmpDir,
    scaffoldRoot,
    aiTools: [],
  };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bundleScaffoldMarkdown", () => {
  it("includes every scaffold file under a section header", () => {
    const bundled = bundleScaffoldMarkdown(config);

    expect(bundled).toContain("## .mex/ROUTER.md\n\n# Router");
    expect(bundled).toContain("## .mex/AGENTS.md\n\n# Agents");
    expect(bundled).toContain("## .mex/context/architecture.md\n\n# Architecture");
    expect(bundled).toContain("## .mex/patterns/alpha.md\n\n# Alpha pattern");
  });

  it("orders ROUTER.md before context and patterns", () => {
    const bundled = bundleScaffoldMarkdown(config);
    const routerIdx = bundled.indexOf("## .mex/ROUTER.md");
    const contextIdx = bundled.indexOf("## .mex/context/architecture.md");
    const patternsIdx = bundled.indexOf("## .mex/patterns/alpha.md");

    expect(routerIdx).toBeGreaterThanOrEqual(0);
    expect(contextIdx).toBeGreaterThan(routerIdx);
    expect(patternsIdx).toBeGreaterThan(contextIdx);
  });

  it("returns empty string when no scaffold files match", () => {
    const emptyConfig: MexConfig = {
      projectRoot: tmpDir,
      scaffoldRoot: join(tmpDir, "empty-scaffold"),
      aiTools: [],
    };
    mkdirSync(emptyConfig.scaffoldRoot);

    expect(bundleScaffoldMarkdown(emptyConfig, [])).toBe("");
  });
});

describe("sortScaffoldFiles", () => {
  it("ranks ROUTER.md ahead of other files", () => {
    const files = [
      join(config.scaffoldRoot, "patterns", "alpha.md"),
      join(config.scaffoldRoot, "ROUTER.md"),
      join(config.scaffoldRoot, "context", "architecture.md"),
    ];

    const sorted = sortScaffoldFiles(files, config.projectRoot);
    expect(sorted[0]).toBe(join(config.scaffoldRoot, "ROUTER.md"));
  });
});

describe("runExport", () => {
  it("writes bundled markdown to a file when --output is set", async () => {
    const outPath = join(tmpDir, "bundle.md");
    await runExport(config, { output: outPath });

    expect(existsSync(outPath)).toBe(true);
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("## .mex/ROUTER.md");
    expect(written).toContain("# Alpha pattern");
  });
});
