import { shellQuote } from "./policy.mjs";
import { MIN_SUBSTANTIVE_ANSWER_LENGTH } from "./answer.mjs";

export function buildPrompt(task, armId, arm, command, subjectRoot, policy = "forced-first") {
  const common = [
    "Investigate the repository and answer the question using only the permitted tools.",
    `The repository root is ${subjectRoot}. Treat all answer evidence paths as relative to that root.`,
    `Question: ${task.question}`,
    "Return exactly one JSON object with all four required root keys: answer, symbols, evidence, and complete. Do not omit any key or embed keys inside answer.",
    `The answer field must be a substantive, source-grounded explanation of at least ${MIN_SUBSTANTIVE_ANSWER_LENGTH} characters. Never return a placeholder such as test, TODO, N/A, or unknown.`,
    "The symbols and evidence fields must each be non-empty arrays. In symbols, return exact source declaration names as written in the repository, never graph node IDs.",
    "Keep all four fields as sibling root keys; never use XML or pseudo-field markup such as <parameter> inside answer.",
    "Cite repository-relative paths and exact 1-based line numbers. Set complete to true only when the substantive answer covers the question.",
  ];
  if (arm.kind === "grep") {
    return [...common, "Use repository file search and reads only. Do not inspect .mex or any graph database."].join("\n\n");
  }
  const cli = command.map(shellQuote).join(" ");
  const candidate = arm.role === "patched";
  const graphFlow = policy === "optional"
    ? `The graph CLI is available as \`${cli}\`, but you may choose repository files instead. If you use the graph, start with \`${cli} graph scope "<question>"\`${candidate ? " and use only one distinct Scope request" : ""}.`
    : `Start with \`${cli} graph scope "<question>"\`${candidate ? " and use only one distinct Scope request" : ""}.`;
  const followupContract = candidate
    ? [
      "Read the Scope summary status. When it is ok, do not run graph query/get or another Scope. A targeted graph query is allowed only after partial, degraded, or no-match. A targeted graph get is allowed only after partial or degraded.",
      "Do not retry Scope with different wording. Treat an insufficient graph response as a reason to use the permitted repository file tools.",
    ]
    : ["Use graph query/get only when the released Scope response is insufficient."];
  return [
    ...common,
    graphFlow,
    ...followupContract,
    "You may fall back to Read, Grep, or Glob only when graph retrieval is insufficient. Never inspect .mex/graph.db or use SQLite directly. Bash may only invoke the exact graph CLI shown above.",
  ].join("\n\n");
}
