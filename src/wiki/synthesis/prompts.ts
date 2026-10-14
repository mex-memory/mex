/**
 * §12.3 step 2 — MEX provides prompts and schemas to the user's connected agent.
 *
 * Three focused prompts per cluster rather than one broad one. That is the
 * pipeline's own finding and it is worth restating: a single "create knowledge
 * units" prompt produces a mixture of architecture claims, half-conventions and
 * restated function signatures, because the model has no reason to keep them
 * apart. Three passes with three vocabularies produce atomic units, and each
 * one can be improved without disturbing the other two.
 *
 * **mex renders these. mex never sends them anywhere.** There is no HTTP client
 * in this module, no API key path and no model name, and there must not be one:
 * the agent runs its own model against its own credentials and hands the result
 * back through `wiki propose`.
 *
 * The vocabulary is mex's, not the reference's. The prompts name mex lifecycle
 * states and mex entity types, because a prompt that teaches an agent a
 * vocabulary the validator will reject is a prompt that manufactures rejections.
 */

import { WIKI_ENTITY_TYPES } from "../model/entity.js";
import type { ClusterCodeBlock, ClusterContext, ClusterContextNode } from "./types.js";

/**
 * The stages, and the types each may emit.
 *
 * Four of mex's fourteen entity types. The other ten are left out for reasons
 * rather than by omission: `decision`, `risk` and `task` record a judgement a
 * team made and cannot be read off code; `topic` is an organizing entity a
 * human curates; `guide` describes a procedure rather than the system; and
 * `spec`, `requirement`, `constraint` and `acceptance_criterion` belong to the
 * SDD traceability chain, whose source is a specification document, not a
 * repository. `fact` is omitted deliberately as well — it is the type an agent
 * reaches for when it has nothing to say, and every unit it would carry is
 * better expressed as one of the four below.
 */
export const SYNTHESIS_STAGES = ["architecture_component", "pattern", "convention"] as const;

export type SynthesisStage = (typeof SYNTHESIS_STAGES)[number];

export const STAGE_TYPES: Record<SynthesisStage, readonly string[]> = {
  architecture_component: ["architecture", "component"],
  pattern: ["pattern"],
  convention: ["convention"],
};

/** Asserted rather than assumed: every type a stage may emit is a real one. */
export function stageTypesAreRegistered(): boolean {
  const registered = new Set<string>(WIKI_ENTITY_TYPES);
  return Object.values(STAGE_TYPES).every((types) => types.every((type) => registered.has(type)));
}

const SHARED_RULES = `
You are an expert software architect and code analyst helping build a high-quality knowledge wiki for this repository.

Your job is to extract ONLY clear, reusable, high-signal knowledge from the ClusterContext you are given.

The ClusterContext is code-first. It contains primary symbols, supporting symbols, primary code evidence, supporting code evidence, and per-file summaries.

HARD RULES (non-negotiable):
1. ONLY use information present in the ClusterContext. Never invent or assume missing code, intent, or architecture.
2. Prefer PRIMARY evidence. Supporting evidence may refine a unit; it should not be the sole basis for one unless there is no primary evidence at all.
3. Every unit MUST be grounded in one or more real nodeIds copied exactly from the context. If you cannot ground it, do not emit it.
4. Prefer grounding to nodeIds of primary symbols, and include EVERY symbol whose change could make the claim false. A claim about a helper's caller or a shared constant needs that dependency as well; do not substitute one broad container for its supporting symbols.
5. Units must be ATOMIC — one clear concept each. Split independent behavioral claims into separate units with their own groundings so a change to one does not flag the others. Keep the concrete identifiers and literals the claim depends on in its prose.
6. Units must be SEMANTIC and reusable. Do not restate a function signature or narrate one code block.
7. Every unit must be supported by concrete implementation evidence from the provided code.
8. Prefer a few excellent units over many mediocre ones. An empty result is a valid and often correct answer.
9. Titles are concise and descriptive, at most about 80 characters.
10. Summaries are one to three sentences. Bodies may be longer and may use Markdown.
11. Always assign a confidence between 0 and 1, and be conservative:
    - 0.85-1.0 = strong, repeated, or very clear evidence
    - 0.65-0.84 = plausible and grounded, but thinner evidence
    - below 0.65 = usually do not emit at all
12. mex applies its own confidence gates after you: at least 0.7 is proposed as "promoted", at least 0.4 as "in_flight", and anything lower is rejected. A proposal is never applied without human review, whatever its confidence.
13. Output ONLY valid JSON matching the requested schema. No prose around it, no Markdown fences.
`.trim();

const OUTPUT_SCHEMA = (types: readonly string[]): string =>
  `
Output schema:
{
  "units": [
    {
      "type": ${types.map((type) => `"${type}"`).join(" | ")},
      "title": string,
      "summary": string,
      "body": string,
      "confidence": number,
      "grounding": {
        "nodeIds": string[],
        "evidence": optional array of { "nodeId": string, "quote"?: string, "reason"?: string }
      },
      "reasoning": optional string
    }
  ]
}
`.trim();

const ARCHITECTURE_COMPONENT_SYSTEM = `
${SHARED_RULES}

You are performing stage 1 of synthesis: architecture and component extraction.

Focus exclusively on:
- the architectural boundaries and responsibilities of this cluster
- the major components or modules and what each owns
- what this cluster is responsible for, versus what it depends on

Read primary code blocks first; use supporting code only to clarify boundaries or dependencies. Prefer conclusions a strong engineer would draw from the actual implementations.

Do NOT extract patterns or coding conventions in this stage.

Bad units: restating a single function; vague claims with no concrete code support; speculative system-wide architecture not evidenced in this cluster.

${OUTPUT_SCHEMA(STAGE_TYPES.architecture_component)}
`.trim();

const PATTERN_SYSTEM = `
${SHARED_RULES}

You are performing stage 2 of synthesis: pattern extraction.

Focus exclusively on recurring or clearly intentional implementation approaches in this cluster.

A good pattern unit names a reusable approach, explains how it works in this codebase, points at concrete evidence, and is more specific than a textbook label — prefer "repository with an explicit transaction boundary" over "repository pattern".

Look for repeated structure, repeated control flow, repeated layering, or deliberate implementation choices in the primary code blocks. Supporting code may confirm a pattern; primary evidence should carry it.

Do NOT extract architecture boundaries or coding style conventions in this stage.

Bad units: one-off code with no reusable approach; generic pattern names with weak evidence; a restatement of one function body.

${OUTPUT_SCHEMA(STAGE_TYPES.pattern)}
`.trim();

const CONVENTION_SYSTEM = `
${SHARED_RULES}

You are performing stage 3 of synthesis: convention extraction.

Focus exclusively on coding conventions and local rules visible in this cluster: naming, error handling, return shapes, validation style, layering rules, logging and testing habits, and other "how we do things here" practices.

A good convention unit states a clear, actionable rule, is specific enough to guide an agent, and is grounded in actual code.

Prefer conventions demonstrated by primary implementations. Supporting evidence may show consistency, but do not invent team-wide rules from thin examples.

Do NOT re-extract architecture or patterns in this stage.

Bad units: one accidental style choice; overly broad rules not evidenced in the code; a library default restated as a team convention.

${OUTPUT_SCHEMA(STAGE_TYPES.convention)}
`.trim();

const STAGE_SYSTEM: Record<SynthesisStage, string> = {
  architecture_component: ARCHITECTURE_COMPONENT_SYSTEM,
  pattern: PATTERN_SYSTEM,
  convention: CONVENTION_SYSTEM,
};

const STAGE_INSTRUCTION: Record<SynthesisStage, string> = {
  architecture_component:
    "Extract high-quality architecture and component units. Base every claim on concrete implementation evidence rather than on naming. If the cluster is too small or too unclear to support one, return an empty units array.",
  pattern:
    "Extract high-quality pattern units. Only emit a pattern where you can point at clear, repeated, or clearly intentional implementation evidence in the context above. If no strong patterns are visible, return an empty units array.",
  convention:
    "Extract high-quality convention units. Be strict: only emit conventions clearly demonstrated by the implementations above. If the cluster does not show strong conventions, return an empty units array.",
};

/** One rendered prompt pair, exactly as the agent should send it to its model. */
export interface RenderedPrompt {
  stage: SynthesisStage;
  system: string;
  user: string;
  /** The entity types this stage's response may carry. */
  expectedTypes: readonly string[];
}

function renderNode(node: ClusterContextNode): string[] {
  const lines = [
    `- nodeId: ${node.id}`,
    `  kind: ${node.kind}`,
    `  name: ${node.name}`,
    `  file: ${node.filePath}`,
    `  importance: ${node.importance}`,
  ];
  if (node.reason !== undefined) lines.push(`  why: ${node.reason}`);
  if (node.qualifiedName !== undefined) lines.push(`  qualifiedName: ${node.qualifiedName}`);
  if (node.signature !== undefined) lines.push(`  signature: ${node.signature}`);
  if (node.docstring !== undefined) lines.push(`  doc: ${node.docstring}`);
  if (node.callers !== undefined && node.callers.length > 0) lines.push(`  callers: ${node.callers.join(", ")}`);
  if (node.callees !== undefined && node.callees.length > 0) lines.push(`  callees: ${node.callees.join(", ")}`);
  return lines;
}

/**
 * Fence a code block without letting its own content close the fence.
 *
 * A cluster in this very repository contains files full of triple backticks,
 * and a three-backtick fence around one of them ends early — after which the
 * rest of the source reads to the model as instructions rather than as
 * evidence. The fence is therefore longer than the longest run inside it.
 */
function fenceFor(content: string): string {
  const longest = [...content.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderCodeBlock(block: ClusterCodeBlock): string[] {
  const location =
    block.startLine !== undefined && block.endLine !== undefined
      ? ` (lines ${block.startLine}-${block.endLine})`
      : "";
  const grounding = block.nodeId === undefined ? "" : ` nodeId=${block.nodeId}`;
  const fence = fenceFor(block.content);
  return ["", `#### ${block.filePath}${location}${grounding} [${block.kind}]`, fence, block.content, fence];
}

/**
 * Serialize a cluster context into the deterministic text a prompt carries.
 *
 * Every nodeId appears explicitly, because grounding is checked against exactly
 * these strings and an agent that cannot see one cannot copy it.
 */
export function renderClusterContext(context: ClusterContext): string {
  const { cluster, nodes, codeBlocks, fileSummaries } = context;
  const lines: string[] = [`# Cluster: ${cluster.name}`];

  if (cluster.description !== undefined) lines.push("", cluster.description);
  if (context.truncated === true) {
    const dropped = context.dropped;
    const parts: string[] = [];
    if (dropped !== undefined) {
      if (dropped.nodes > 0) parts.push(`${dropped.nodes} symbol(s)`);
      if (dropped.primaryBlocks > 0) parts.push(`${dropped.primaryBlocks} primary code block(s)`);
      if (dropped.supportingBlocks > 0) parts.push(`${dropped.supportingBlocks} supporting code block(s)`);
    }
    lines.push(
      "",
      `NOTE: this cluster is larger than the budget for one context, so it was trimmed${
        parts.length === 0 ? "" : ` — ${parts.join(", ")} are not shown`
      }.`,
      "What remains is the highest-ranked evidence, primary first. Treat anything absent as UNKNOWN, never as a",
      "fact about the code: do not write a unit claiming this cluster does not do something you cannot see here.",
    );
  }

  lines.push("", `## Files (${cluster.files.length})`);
  for (const file of cluster.files) {
    const summary = fileSummaries?.find((entry) => entry.filePath === file);
    lines.push(`- ${file}${summary?.notes === undefined ? "" : ` — ${summary.notes}`}`);
    if (summary?.exports !== undefined && summary.exports.length > 0) {
      lines.push(`  exports: ${summary.exports.join(", ")}`);
    }
  }

  const primaryNodes = nodes.filter((node) => node.importance === "primary");
  const supportingNodes = nodes.filter((node) => node.importance === "supporting");

  lines.push(
    "",
    "## Nodes",
    "",
    "Ground every unit in one or more of these exact nodeIds. Prefer the PRIMARY symbols;",
    "SUPPORTING symbols are context only.",
  );
  if (nodes.length === 0) lines.push("- (no structural nodes were resolved for this cluster)");

  lines.push("", `### Primary symbols (${primaryNodes.length})`);
  if (primaryNodes.length === 0) lines.push("- (none)");
  for (const node of primaryNodes) lines.push(...renderNode(node));

  lines.push("", `### Supporting symbols (${supportingNodes.length})`);
  if (supportingNodes.length === 0) lines.push("- (none)");
  for (const node of supportingNodes) lines.push(...renderNode(node));

  const primaryBlocks = codeBlocks.filter((block) => block.importance === "primary");
  const supportingBlocks = codeBlocks.filter((block) => block.importance === "supporting");

  lines.push("", "## Source");
  if (codeBlocks.length === 0) lines.push("", "(no source blocks available)");

  lines.push("", `### Primary evidence (${primaryBlocks.length})`);
  for (const block of primaryBlocks) lines.push(...renderCodeBlock(block));

  lines.push("", `### Supporting evidence (${supportingBlocks.length})`);
  for (const block of supportingBlocks) lines.push(...renderCodeBlock(block));

  return lines.join("\n");
}

/** Render one stage's prompt for one cluster. */
export function renderPrompt(context: ClusterContext, stage: SynthesisStage): RenderedPrompt {
  const rendered = renderClusterContext(context);
  return {
    stage,
    system: STAGE_SYSTEM[stage],
    user: [
      "Here is the ClusterContext for this synthesis stage:",
      "",
      rendered,
      "",
      "---",
      "",
      STAGE_INSTRUCTION[stage],
      "",
      "Return only the JSON object.",
    ].join("\n"),
    expectedTypes: STAGE_TYPES[stage],
  };
}

/** All three stages for one cluster, in the order they must be run. */
export function renderPrompts(context: ClusterContext): RenderedPrompt[] {
  return SYNTHESIS_STAGES.map((stage) => renderPrompt(context, stage));
}
