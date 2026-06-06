import type { MexConfig, ScannerBrief } from "../types.js";
import { scanManifest } from "./manifest.js";
import { scanEntryPoints } from "./entry-points.js";
import { scanFolderTree } from "./folder-tree.js";
import { scanTooling } from "./tooling.js";
import { scanReadme } from "./readme.js";

/** Run pre-analysis scan and return brief or prompt */
export async function runScan(
  config: MexConfig,
  opts: { jsonOnly?: boolean }
): Promise<ScannerBrief | string> {
  const brief = buildBrief(config.projectRoot);

  if (opts.jsonOnly) return brief;

  return buildPrompt(brief);
}

/** Build the scanner brief from codebase analysis */
function buildBrief(projectRoot: string): ScannerBrief {
  return {
    manifest: scanManifest(projectRoot),
    entryPoints: scanEntryPoints(projectRoot),
    folderTree: scanFolderTree(projectRoot),
    tooling: scanTooling(projectRoot),
    readme: scanReadme(projectRoot),
    timestamp: new Date().toISOString(),
  };
}

/** Build AI prompt with embedded brief */
function buildPrompt(brief: ScannerBrief): string {
  const briefJson = JSON.stringify(brief, null, 2);

  return `Here is a pre-analyzed brief of the codebase — do NOT explore the filesystem yourself, reason from this brief:

<brief>
${briefJson}
</brief>

Using this brief, populate the mex scaffold files. Focus on:
1. context/architecture.md — system components, data flow, integrations
2. context/stack.md — technologies, versions, key libraries
3. context/conventions.md — code patterns, naming, file organization
4. context/decisions.md — architectural choices and their rationale
5. context/setup.md — how to set up and run the project
6. ROUTER.md — update the "Current Project State" section

For each file, use the information from the brief rather than exploring the filesystem.
Be precise about versions, paths, and dependencies — they come directly from the manifest.`;
}
