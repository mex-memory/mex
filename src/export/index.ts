import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import type { MexConfig } from "../types.js";
import { findScaffoldFiles, DEFAULT_SCAFFOLD_PATTERNS } from "../drift/index.js";

export interface RunExportOpts {
  output?: string;
  /** Override scaffold discovery globs (relative to `config.scaffoldRoot`). */
  scaffoldPatterns?: readonly string[];
}

/** Sort scaffold files for readable export: ROUTER first, then root, context, patterns. */
export function sortScaffoldFiles(
  files: string[],
  projectRoot: string,
): string[] {
  const rank = (filePath: string): number => {
    const rel = relative(projectRoot, filePath);
    const base = rel.replace(/^\.mex\//, "");
    if (base === "ROUTER.md") return 0;
    if (base.startsWith("context/")) return 2;
    if (base.startsWith("patterns/")) return 3;
    return 1;
  };

  return [...files].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return relative(projectRoot, a).localeCompare(relative(projectRoot, b));
  });
}

/** Bundle scaffold markdown files into one document with a header per source file. */
export function bundleScaffoldMarkdown(
  config: MexConfig,
  scaffoldPatterns: readonly string[] = DEFAULT_SCAFFOLD_PATTERNS,
): string {
  const { projectRoot, scaffoldRoot } = config;
  const files = sortScaffoldFiles(
    findScaffoldFiles(projectRoot, scaffoldRoot, scaffoldPatterns),
    projectRoot,
  );

  const sections = files.map((filePath) => {
    const rel = relative(projectRoot, filePath);
    const content = readFileSync(filePath, "utf8").trimEnd();
    return `## ${rel}\n\n${content}`;
  });

  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

/** Export the scaffold as a single Markdown document (stdout or file). */
export async function runExport(
  config: MexConfig,
  opts: RunExportOpts = {},
): Promise<void> {
  const markdown = bundleScaffoldMarkdown(
    config,
    opts.scaffoldPatterns ?? DEFAULT_SCAFFOLD_PATTERNS,
  );

  if (opts.output) {
    writeFileSync(opts.output, markdown, "utf8");
    return;
  }

  process.stdout.write(markdown);
}
