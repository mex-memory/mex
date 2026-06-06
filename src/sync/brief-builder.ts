import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { globSync } from "glob";
import { getGitDiff } from "../git.js";
import type { SyncTarget } from "../types.js";

/** Build a single combined prompt covering all targets */
export async function buildCombinedBrief(
  targets: SyncTarget[],
  projectRoot: string
): Promise<string> {
  const sections: string[] = [];

  for (const target of targets) {
    sections.push(await buildFileSection(target, projectRoot));
  }

  return `The following scaffold files have drift issues that need fixing. Fix all of them in one pass.

${sections.map((s, i) => `━━━ File ${i + 1}/${sections.length} ━━━\n\n${s}`).join("\n\n")}

Update each file to fix its issues. Only change what's necessary — do not rewrite sections that are correct.
When a referenced path no longer exists, find the correct current path from the filesystem context above and update the reference.`;
}

/** Build a targeted prompt for AI to fix a single file */
export async function buildSyncBrief(
  target: SyncTarget,
  projectRoot: string
): Promise<string> {
  const section = await buildFileSection(target, projectRoot);

  return `The following scaffold file has drift issues that need fixing:

${section}

Update the file to fix these issues. Only change what's necessary — do not rewrite sections that are correct.
When a referenced path no longer exists, find the correct current path from the filesystem context above and update the reference.`;
}

/** Build the content section for a single target (no wrapper instructions) */
async function buildFileSection(
  target: SyncTarget,
  projectRoot: string
): Promise<string> {
  const filePath = resolve(projectRoot, target.file);
  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, "utf-8");
  } catch {
    fileContent = "(file could not be read)";
  }

  const issueList = target.issues
    .map((i) => `- [${i.severity}] ${i.code}: ${i.message}`)
    .join("\n");

  // Get git diff for paths referenced by this file's claims
  const claimedPaths = target.issues
    .filter((i) => i.claim?.kind === "path")
    .map((i) => i.claim!.value);

  const diff = claimedPaths.length
    ? await getGitDiff(claimedPaths, projectRoot)
    : target.gitDiff ?? "";

  // For MISSING_PATH issues, find what actually exists nearby
  const fileContext = buildFileContext(target, projectRoot);

  let section = `**File:** ${target.file}

**Issues found:**
${issueList}

**Current file content:**
\`\`\`markdown
${fileContent}
\`\`\``;

  if (fileContext) {
    section += `

**Filesystem context (what actually exists):**
${fileContext}`;
  }

  if (diff) {
    section += `

**Recent git changes in referenced paths:**
\`\`\`diff
${diff}
\`\`\``;
  }

  return section;
}

/** For missing path issues, list actual files in the relevant directories */
function buildFileContext(
  target: SyncTarget,
  projectRoot: string
): string | null {
  const missingPaths = target.issues
    .filter((i) => i.code === "MISSING_PATH" && i.claim?.kind === "path")
    .map((i) => i.claim!.value);

  if (missingPaths.length === 0) return null;

  const sections: string[] = [];
  const listedDirs = new Set<string>();

  for (const missing of missingPaths) {
    // Get the directory the missing file was expected in
    const dir = missing.includes("/") ? dirname(missing) : ".";
    const dirKey = dir === "." ? "root" : dir;

    // List the directory contents (skip if already listed)
    if (!listedDirs.has(dirKey)) {
      listedDirs.add(dirKey);

      const absDir = resolve(projectRoot, dir);
      if (existsSync(absDir)) {
        try {
          const files = readdirSync(absDir)
            .filter((f) => !f.startsWith("."))
            .sort();
          if (files.length > 0) {
            sections.push(`\`${dir}/\` contains: ${files.join(", ")}`);
          }
        } catch {
          // skip unreadable dirs
        }
      }
    }

    // Fuzzy search: find files with similar names anywhere in the project
    const name = basename(missing);
    const ext = name.includes(".") ? name.split(".").pop() : null;
    if (ext) {
      const matches = globSync(`**/*.${ext}`, {
        cwd: projectRoot,
        ignore: ["node_modules/**", ".mex/**", "dist/**", ".git/**"],
        maxDepth: 5,
      });

      if (matches.length > 0 && matches.length <= 20) {
        sections.push(
          `All \`.${ext}\` files in project: ${matches.join(", ")}`
        );
        // Only list once per extension
        break;
      }
    }
  }

  return sections.length > 0 ? sections.join("\n") : null;
}
