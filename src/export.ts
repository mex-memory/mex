import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DEFAULT_SCAFFOLD_PATTERNS, findScaffoldFiles } from "./drift/index.js";
import { toPosix } from "./paths.js";
import type { MexConfig } from "./types.js";

export interface ExportOpts {
  /** Write the bundle to this file instead of stdout. */
  out?: string;
}

/**
 * Bundle the whole scaffold into one Markdown document (#56).
 *
 * Section headers name the source file so a pasted copy stays navigable, and
 * files are emitted in a deterministic order (sorted by path). Reuses the
 * drift scanner's own file discovery, so what gets exported is exactly what
 * `mex check` scans — nothing drifts between the two.
 */
export async function runExport(config: MexConfig, opts: ExportOpts = {}): Promise<void> {
  const files = findScaffoldFiles(config.projectRoot, config.scaffoldRoot, DEFAULT_SCAFFOLD_PATTERNS)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (files.length === 0) {
    throw new Error("No scaffold files found. Run: mex setup");
  }

  const bundle: string[] = ["# mex scaffold export", ""];
  for (const file of files) {
    const relativePath = toPosix(relative(config.scaffoldRoot, file));
    bundle.push(`## ${relativePath}`, "", readFileSync(file, "utf-8").trimEnd(), "");
  }
  const document = bundle.join("\n");

  if (opts.out) {
    const target = resolve(config.projectRoot, opts.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, document, "utf-8");
    console.log(`Wrote ${files.length} scaffold file(s) to ${opts.out}`);
    return;
  }
  process.stdout.write(document);
}
