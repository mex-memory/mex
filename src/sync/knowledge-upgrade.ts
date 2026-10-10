import type { AiTool, MexConfig } from "../types.js";
import { AI_TOOLS } from "../types.js";
import { isCliAvailable } from "../cli-tools.js";
import { inventoryScaffold } from "../wiki/migration/inventory.js";
import { WIKI_ENTITY_TYPES } from "../wiki/model/entity.js";
import { isReadOnlyPath } from "../wiki/operations/paths.js";
import { pickSyncTool, runToolInteractive } from "./index.js";
import { rebuildWikiIndexAfterSync } from "./wiki-index.js";
import { runDriftCheck } from "../drift/index.js";
import { createRepositoryGraphPort } from "../graph/application-adapter.js";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const MAX_REVIEW_ENTITIES = 50;
const SPEC_TYPES = new Set(["spec", "requirement", "constraint", "acceptance_criterion"]);

export interface KnowledgeUpgradeCandidate { id: string; title: string; file: string }
export interface KnowledgeUpgradePlan { candidates: KnowledgeUpgradeCandidate[]; truncated: boolean }

/** Conservative review candidates, not a claim that prose can be split mechanically. */
export function planKnowledgeUpgrade(config: MexConfig, after?: string): KnowledgeUpgradePlan {
  const inventory = inventoryScaffold({ scaffoldRoot: config.scaffoldRoot, exclude: config.wiki?.exclude });
  const diagnostics = [...inventory.diagnostics, ...inventory.files.flatMap(file => file.parsed.diagnostics)];
  if (diagnostics.some(entry => entry.severity === "error")) {
    throw new Error("Resolve scaffold parse errors before upgrading knowledge.");
  }
  const ids = new Set<string>();
  for (const file of inventory.files) for (const { entity } of file.parsed.entities) {
    if (ids.has(entity.id)) throw new Error("Resolve duplicate entity identities before upgrading knowledge.");
    ids.add(entity.id);
  }
  const candidates: KnowledgeUpgradeCandidate[] = [];
  let truncated = false;
  if (after !== undefined && !ids.has(after)) throw new Error("The --after entity no longer exists in this scaffold.");
  let reached = after === undefined;
  for (const file of inventory.files) {
    if (!reached) {
      const position = file.parsed.entities.findIndex(({ entity }) => entity.id === after);
      if (position === -1) continue;
      reached = true;
    }
    if (isReadOnlyPath(file.path, config.wiki?.readOnly ?? []) || file.path.startsWith("specs/")) continue;
    if (relative(realpathSync(config.scaffoldRoot), realpathSync(file.absolutePath)).replaceAll("\\", "/").startsWith("specs/")) continue;
    if (file.parsed.entities.some(({ entity }) => SPEC_TYPES.has(entity.type))) continue;
    const markerOffset = file.parsed.entities.find(entry => entry.entity.id === after)?.entity.location?.metadataStart ?? -1;
    for (const { entity } of file.parsed.entities) {
      if (entity.location!.metadataStart <= markerOffset) continue;
      if (entity.type === "fact" || entity.status === "archived" || !entity.groundsTo.length
        || !(WIKI_ENTITY_TYPES as readonly string[]).includes(entity.type)) continue;
      if (candidates.length === MAX_REVIEW_ENTITIES) { truncated = true; continue; }
      candidates.push({ id: entity.id, title: entity.title, file: file.path });
    }
  }
  return { candidates, truncated };
}

export function buildKnowledgeUpgradeBrief(plan: KnowledgeUpgradePlan): string {
  return `Upgrade this existing MEX scaffold in place. Do not run setup or replace the scaffold.
Review only these existing code-linked entities by id, using mex wiki show <id>:
${plan.candidates.map(entry => entry.id).join("\n")}

These are review candidates, not proven multi-fact entities. A fact is one independently
checkable behavioral claim. Keep an already focused entity intact; do not split on
sentences or bullets mechanically. Keep broad non-code overview, doc and config prose grouped.

Read .mex/AGENTS.md, .mex/ROUTER.md and relevant context. Inspect the current code with
mex graph scope/query/get and verify each claim, including complete lists and defaults.
If a fact is false, uncertain, or lacks evidence, leave its original text and baselines
intact and report it. Do not silently accept drift or relabel a whole paragraph as a fact.

For verified multi-claim knowledge, use mex wiki apply operations with explicit plans:
- Preserve the existing entity id as an overview so inbound links and saved references
  still work. Preserve all existing relationships and source evidence.
- Create one section entity of type fact per independently checkable code-linked claim,
  keeping its wording and meaning. Remove duplicated claim prose from the parent only
  after its replacement entities have been created and verified. Never delete or rename
  an existing scaffold file. Do not change source code, Git state, or project configuration.
- Ground each new fact to every symbol whose change could make it false, using exact
  returned ids and fingerprints, never guessed hashes. Preserve existing baselines until
  their corresponding claims have been verified against current code. Do not use reground
  to hide a flag. Preserve unrelated grounding and every navigation anchor.
- Link each fact to the existing overview with a canonical refines relationship.
  Semantic dependencies need evidence; do not infer them from shared keywords or symbols.
- After all child facts are verified, move their corresponding code groundings off the
  broad parent so health is reported per fact. Leave a grounding in place if any claim it
  supports has not been migrated. Preserve decisions, rationale, timestamps and non-negotiables.

Preview mex wiki link-sections, then explicitly apply missing structural links.
Merge the one-code-linked-claim-per-entity rule and supported relationship guidance
into the existing GROW instructions in AGENTS.md and ROUTER.md; preserve their rules.
Run mex wiki validate and mex check. List every created fact, preserved parent id, and
unresolved candidate. Do not commit or push. Successful agent exit is not proof that
every candidate was split; report what was actually reviewed.`;
}

export interface KnowledgeUpgradeDependencies {
  write?: (message: string) => void;
  available?: typeof isCliAvailable;
  runAgent?: typeof runToolInteractive;
  ensureFreshGraph?: () => Promise<void>;
  check?: typeof runDriftCheck;
  rebuild?: typeof rebuildWikiIndexAfterSync;
  pickTool?: typeof pickSyncTool;
}

export async function runKnowledgeUpgrade(
  config: MexConfig,
  options: { apply?: boolean; dryRun?: boolean; tool?: string; after?: string },
  dependencies: KnowledgeUpgradeDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? console.log;
  const plan = planKnowledgeUpgrade(config, options.after);
  write(`${plan.candidates.length} existing code-linked entities to review${plan.truncated ? " (bounded batch)" : ""}.`);
  if (plan.truncated) write(`Next batch: mex wiki upgrade --after ${plan.candidates.at(-1)!.id}`);
  if (!plan.candidates.length) {
    write("No broad code-linked review candidates found. This does not certify that every fact is already separate.");
    return;
  }
  if (!options.apply || options.dryRun) {
    write(buildKnowledgeUpgradeBrief(plan));
    write("Preview only. Use mex wiki upgrade --apply for an interactive review with your selected agent, or copy this prompt into your agent.");
    return;
  }
  const tool = options.tool === undefined
    ? await (dependencies.pickTool ?? pickSyncTool)(config.aiTools)
    : options.tool as AiTool;
  if (tool === null) {
    write(buildKnowledgeUpgradeBrief(plan));
    write("No supported agent CLI is installed. Copy this review prompt into your coding agent; no changes were made.");
    return;
  }
  if (!Object.hasOwn(AI_TOOLS, tool) || !AI_TOOLS[tool].cli) {
    throw new Error("Choose a supported interactive agent CLI with --tool, or use the preview prompt in your coding agent.");
  }
  if (!(dependencies.available ?? isCliAvailable)(AI_TOOLS[tool].cli!)) throw new Error(`${tool} CLI is not available.`);
  await (dependencies.ensureFreshGraph ?? (async () => {
    await createRepositoryGraphPort(config.projectRoot).withFreshGroundingSnapshot(() => undefined);
  }))();
  const report = await (dependencies.check ?? runDriftCheck)(config);
  const ids = new Set(plan.candidates.map(entry => entry.id));
  const files = new Set(plan.candidates.flatMap(entry => [entry.file,
    relative(config.projectRoot, resolve(config.scaffoldRoot, entry.file)).replaceAll("\\", "/")]));
  const blocked = report.issues.filter(issue => issue.code.startsWith("GROUNDING_")
    && issue.severity !== "info" && (issue.entity ? ids.has(issue.entity.id) : files.has(issue.file.replaceAll("\\", "/"))));
  if (blocked.length) throw new Error("Review flagged or unverified candidate groundings with mex check / mex sync before upgrading. No agent was started.");
  const ok = (dependencies.runAgent ?? runToolInteractive)(tool, buildKnowledgeUpgradeBrief(plan), config.projectRoot);
  if (!ok) throw new Error("Knowledge upgrade session failed; inspect any partial working-tree changes before retrying.");
  const rebuilt = await (dependencies.rebuild ?? rebuildWikiIndexAfterSync)(config);
  const after = await (dependencies.check ?? runDriftCheck)(config);
  write(`Wiki index rebuilt: ${rebuilt.entityCount} entities. Drift score: ${report.score} → ${after.score}/100.`);
  write(`${planKnowledgeUpgrade(config, options.after).candidates.length} broad code-linked review candidates remain in this scope; unchanged candidates can already be focused. Review the working-tree diff. Nothing was committed or pushed.`);
}
