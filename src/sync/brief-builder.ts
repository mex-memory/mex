import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { globSync } from "glob";
import { getGitDiff } from "../git.js";
import type { SyncTarget } from "../types.js";
import type { MexConfig } from "../types.js";
import type { GroundingRuntime } from "../graph/runtime.js";
import { groundingPromptContext } from "../graph/runtime.js";

/** Build a single combined prompt covering all targets */
export async function buildCombinedBrief(
  targets: SyncTarget[],
  projectRoot: string,
  grounding?: { config: MexConfig; runtime: GroundingRuntime },
): Promise<string> {
  const sections: string[] = [];

  for (const target of targets) {
    sections.push(await buildFileSection(target, projectRoot, grounding));
  }

  const groundingInstructions = buildGroundingRepairInstructions(targets);
  const wikiInstructions = buildWikiReviewInstructions(targets);
  return `The following scaffold files have drift issues that need fixing. Fix all of them in one pass.

${sections.map((s, i) => `━━━ File ${i + 1}/${sections.length} ━━━\n\n${s}`).join("\n\n")}

${groundingInstructions}
${wikiInstructions}

Update each file to fix its issues. Only change what's necessary — do not rewrite sections that are correct.
When a referenced path no longer exists, find the correct current path from the filesystem context above and update the reference.`;
}

/** Build a targeted prompt for AI to fix a single file */
export async function buildSyncBrief(
  target: SyncTarget,
  projectRoot: string
): Promise<string> {
  const section = await buildFileSection(target, projectRoot);
  const groundingInstructions = buildGroundingRepairInstructions([target]);
  const wikiInstructions = buildWikiReviewInstructions([target]);

  return `The following scaffold file has drift issues that need fixing:

${section}

${groundingInstructions}
${wikiInstructions}

Update the file to fix these issues. Only change what's necessary — do not rewrite sections that are correct.
When a referenced path no longer exists, find the correct current path from the filesystem context above and update the reference.`;
}

function buildGroundingRepairInstructions(targets: SyncTarget[]): string {
  if (!targets.some((target) => target.issues.some((issue) => issue.code.startsWith("GROUNDING_")))) return "";
  return `GROUNDING REPAIR — repair the prose and both pointer mechanisms together:

Use the code graph for implementation context; do not sample source files. Start
with \`mex graph scope "<behavior being repaired>" --fingerprint\`, then use \`mex graph query
where-defined <symbol>\`, who-calls/what-calls, or \`mex impact <symbol|file>\`
to resolve exact behavior and candidates. READ BROAD, GROUND TIGHT: read the
whole useful neighborhood, but ground only functions/methods that embody claims
the repaired prose actually makes. Keep broad files sparse.

- GROUNDING_DRIFT/body change: decide whether the claim changed from the supplied
  old/new body. Repair only affected prose. For a link that names no Wiki
  entity, preserve the existing grounds_to fingerprint and bodyHash until the
  user explicitly accepts that entry in sync's grounding review; completing the
  agent session does not accept it. A link on a Wiki entity follows WIKI ENTITY
  REVIEW below.
- MOVED: sync may have already durably rebound a high-confidence move. Verify the
  grounds_to id and every inline mex:// anchor for that symbol use the new id,
  and retain its previous bodyHash. Identity repair does not establish that the
  documented behavior still agrees with the implementation.
- AMBIGUOUS: adjudicate the surfaced candidate with scope/query/impact. If it is
  the same behavior, update grounds_to and any matching inline anchor to that id;
  otherwise choose the correct graph node or remove the stale grounding/anchor.
- GONE: update prose that still describes the deleted symbol. Remove obsolete
  grounds_to entries and inline anchors; if replacement behavior exists, ground
  and anchor the replacement using exact graph facts.

Frontmatter entries are \`{ node, fingerprint, bodyHash? }\`. Never erase a prior
bodyHash to make drift disappear. Inline navigation is exactly
\`mex://<nodeId>\`: fingerprints belong ONLY in grounds_to and never in an URI.
Anchor only load-bearing symbol mentions, without changing their visible text.
Before finishing, re-read each changed file and verify ids/fingerprints resolve,
no grounding or anchor is duplicated, and unrelated prose remains untouched.`;
}

/** One flagged Wiki entity: its id, title, file, and each flagged link's code and verdict. */
export interface FlaggedEntity {
  id: string;
  title: string;
  file: string;
  links: string[];
}

/** Wiki entities whose links `check` flagged, in first-seen order. */
export function flaggedWikiEntities(targets: readonly SyncTarget[]): FlaggedEntity[] {
  const byId = new Map<string, FlaggedEntity>();
  for (const target of targets) {
    for (const issue of target.issues) {
      if (issue.entity === undefined || !issue.code.startsWith("GROUNDING_")) continue;
      const entry = byId.get(issue.entity.id)
        ?? { id: issue.entity.id, title: issue.entity.title, file: target.file, links: [] };
      entry.links.push(`${issue.code}${issue.verdict === undefined ? "" : ` (${issue.verdict})`}`);
      byId.set(issue.entity.id, entry);
    }
  }
  return [...byId.values()];
}

/**
 * Review of flagged Wiki entities, in the same session as scaffold drift.
 *
 * The agent compares each fact with the code as recorded and as it is now and
 * decides whether every statement still holds. It re-records only through
 * `mex wiki reground`, which derives every hash from the live graph.
 */
function buildWikiReviewInstructions(targets: SyncTarget[]): string {
  const flagged = flaggedWikiEntities(targets);
  if (flagged.length === 0) return "";
  const list = flagged
    .map((entity) => `- ${entity.id} "${entity.title}" (${entity.file}): ${entity.links.join(", ")}`)
    .join("\n");
  return `
WIKI ENTITY REVIEW — each entity below states facts about code that changed:

${list}

For each entity, compare its text with the grounded code as recorded ("Old body"
above) and as it is now ("New body", or \`mex graph get <nodeId>\`). Check every
statement, then decide exactly one:

- STILL TRUE: every statement holds for the current code. Run
  \`mex wiki reground <entity-id> --apply\`. It re-records every link of the
  entity from the live graph, following a moved symbol to its new id.
- CHANGED: a statement no longer holds. Edit only the entity's text so that it
  is true for the current code, then run \`mex wiki reground <entity-id> --apply\`.
- UNSURE: change nothing. The entity keeps its flag for a person to decide.

GROUNDING_GONE and GROUNDING_AMBIGUOUS links have no code to re-record against,
and \`mex wiki reground\` refuses them. Repair them as described above (relink to
the right node or remove the link, and fix the text), or leave them flagged.
Never write or edit node ids, fingerprints, bodyHash or codeHash by hand.`;
}

/** Build the content section for a single target (no wrapper instructions) */
async function buildFileSection(
  target: SyncTarget,
  projectRoot: string,
  grounding?: { config: MexConfig; runtime: GroundingRuntime },
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

  const groundingContext = grounding ? buildGroundingContext(target, grounding.config, grounding.runtime) : "";
  if (groundingContext) section += `\n\n**Grounded node scope (use this exact old/new body):**\n${groundingContext}`;

  return section;
}

function buildGroundingContext(target: SyncTarget, config: MexConfig, runtime: GroundingRuntime): string {
  const rows: string[] = [];
  for (const issue of target.issues) {
    if (!issue.code.startsWith("GROUNDING_")) continue;
    const nodeId = issue.message.match(/(?:changed|exists|moved): ([^;]+)/)?.[1];
    const candidateId = issue.message.match(/candidate: (\S+)/)?.[1];
    if (!nodeId) continue;
    const context = groundingPromptContext(config, target.file, nodeId, runtime, candidateId);
    if (!context) continue;
    rows.push([
      `Node: ${context.nodeId}${context.candidateId ? ` (candidate: ${context.candidateId})` : ""}`,
      "Old body:", "```", context.oldBody, "```",
      "New body:", "```", context.newBody, "```",
    ].join("\n"));
  }
  return rows.join("\n\n");
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
