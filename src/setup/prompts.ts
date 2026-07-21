/**
 * Population prompt templates for mex setup.
 * Three variants based on project state:
 *   - fresh: no source files, ask user questions
 *   - existing with scanner brief: AI gets structure from pre-analysis and code facts from the graph
 *   - existing without brief: AI gets code facts from the graph, with narrow high-level discovery
 */

const GRAPH_GROUNDING_WORKFLOW = `
CODE-GRAPH WORKFLOW — use this for all implementation understanding:

The setup step has already built .mex/graph.db. Do not walk the source tree or
open representative implementation files to learn what code does. Use the
agent-facing graph commands from this project root instead:

- \`mex graph scope "<task or domain>" --fingerprint\` — primary discovery tool. It
  returns a compact JSONL manifest (meta, facts with node ids + signatures +
  serialized fingerprints, summary). \`--fingerprint\` attaches the exact serialized
  fingerprint you must copy into \`grounds_to\`.
- \`mex graph get <id> --detail source\` — read the body of a node you intend to ground.
- \`mex graph query where-defined <symbol>\` — resolve an exact symbol.
- \`mex graph query who-calls <symbol>\` / \`what-calls <symbol>\` — follow calls.
- \`mex impact <symbol|file>\` — inspect transitive blast radius when useful.

Use the pre-analyzed brief only for high-level structure: folders, tooling,
dependencies, and entry points. Use hydrated graph output for claims about
specific code behavior. If a graph command returns GRAPH_UNAVAILABLE, report
that setup cannot author trustworthy grounding; never invent ids or fingerprints.

The governing rule is: READ BROAD, GROUND TIGHT.

1. Read the relevant \`mex graph scope\` neighborhood, expanding node bodies with
   \`mex graph get <id> --detail source\` as needed to understand a task.
2. In each scaffold file that makes a specific behavioral claim, replace its
   empty \`grounds_to\` with only the functions/methods that embody that claim:

   grounds_to:
     - node: "<exact id from graph JSONL>"
       fingerprint: "<exact fingerprint from the same graph fact>"

   Never ground every node returned by scope. Callers/callees provide reading
   context; they are not automatically grounding targets. Do not ground file,
   import, parameter, or vague component nodes.
3. When prose names a load-bearing function, method, or class that you looked
   up in the graph, make the readable symbol mention a navigation anchor:
   [\`symbolName()\`](mex://<exact-node-id>). Anchor where a future agent would
   plausibly jump to code, not every incidental mention. Inline anchors contain
   the node id only; never put a fingerprint in the URI.
4. Broad architecture/stack/conventions files should ground sparsely or remain
   \`grounds_to: []\`. Pattern files and deep domain files should ground tightly
   to the few symbols that implement their documented behavior. Grounding must
   follow actual prose claims—never add grounding merely so every file has some.
`;

/** Shared pass 2+3 instructions appended to existing-project prompts */
const EXISTING_PASSES_2_3 = `
PASS 2 — Generate starter patterns:

Read .mex/patterns/README.md for the format and categories.

Generate 3-5 starter patterns for the most common and most dangerous task
types in this project. Focus on:
- The 1-2 tasks a developer does most often (e.g., add endpoint, add component)
- The 1-2 integrations with the most non-obvious gotchas
- 1 debug pattern for the most common failure boundary

Each pattern should be specific to this project — real file paths, real gotchas,
real verify steps derived from the code you read in Pass 1.
Use the format in .mex/patterns/README.md. Name descriptively (e.g., add-endpoint.md).
Before writing each pattern, run \`mex graph scope "<pattern task>"\`. Use the
broad neighborhood for understanding, then author tight \`grounds_to\` entries
and load-bearing inline \`mex://\` anchors from the exact returned facts.

Do NOT try to generate a pattern for every possible task type. The scaffold
grows incrementally — the behavioural contract (step 5: GROW) will create
new patterns from real work as the project evolves. Setup just seeds the most
critical ones.

After generating patterns, update .mex/patterns/INDEX.md with a row for each
pattern file you created. For multi-section patterns, add one row per task
section using anchor links (see INDEX.md annotation for format).

PASS 3 — Wire the web:

Re-read every file you just wrote (.mex/context/ files, pattern files, .mex/ROUTER.md).
For each file, add or update the edges array in the YAML frontmatter.
Each edge should point to another scaffold file that is meaningfully related,
with a condition explaining when an agent should follow that edge.

Rules for edges:
- Every context/ file should have at least 2 edges
- Every pattern file should have at least 1 edge (usually to the relevant context file)
- Edges should be bidirectional where it makes sense (if A links to B, consider B linking to A)
- Use relative paths (e.g., context/stack.md, patterns/add-endpoint.md)
- Pattern files can edge to other patterns (e.g., debug pattern → related task pattern)

Important: only write content derived from the codebase.
Do not include system-injected text (dates, reminders, etc.)
in any scaffold file.

When done, confirm which files were populated and flag any slots
you could not fill with confidence.`;

/** Shared pass 1 populate instructions for existing projects */
const EXISTING_PASS_1 = `
Populate each .mex/context/ file by replacing the annotation comments
with real content from this codebase. Follow the annotation instructions exactly.
For each slot:
- Use the actual names, patterns, and structures from this codebase
- Do not use generic examples
- Do not leave any slot empty — if you cannot determine the answer,
  write "[TO DETERMINE]" and explain what information is needed
- Keep length within the guidance given in each annotation
- Preserve the grounding shape and apply the code-graph workflow above: specific
  behavioral claims get tight grounds_to entries and useful symbol anchors;
  broad inventory or conceptual prose stays sparse or ungrounded

Then assess: does this project have domains complex enough that cramming
them into architecture.md would make it too long or too shallow?
If yes, create additional domain-specific context files in .mex/context/.
Examples: a project with a complex auth system gets .mex/context/auth.md.
A data pipeline gets .mex/context/ingestion.md. A project with Stripe gets
.mex/context/payments.md. Use the same YAML frontmatter format (name,
description, triggers, edges, last_updated). Only create these for
domains that have real depth — not for simple integrations that fit
in a few lines of architecture.md.

After populating .mex/context/ files, update .mex/ROUTER.md:
- Fill in the Current Project State section based on what you found
- Add rows to the routing table for any domain-specific context files you created

Update .mex/AGENTS.md:
- Fill in the project name, one-line description, non-negotiables, and commands`;

export function buildFreshPrompt(): string {
  return `You are going to populate an AI context scaffold for a project that
is just starting. Nothing is built yet.

Read the following files in order before doing anything else:
1. .mex/ROUTER.md — understand the scaffold structure
2. All files in .mex/context/ — read the annotation comments in each

Then ask me the following questions one section at a time.
Wait for my answer before moving to the next section:

1. What does this project do? (one sentence)
2. What are the hard rules — things that must never happen in this codebase?
3. What is the tech stack? (language, framework, database, key libraries)
4. Why did you choose this stack over alternatives?
5. How will the major pieces connect? Describe the flow of a typical request/action.
6. What patterns do you want to enforce from day one?
7. What are you deliberately NOT building or using?

After I answer, populate the .mex/context/ files based on my answers.
For any slot you cannot fill yet, write "[TO BE DETERMINED]" and note
what needs to be decided before it can be filled.

Then assess: based on my answers, does this project have domains complex
enough that cramming them into architecture.md would make it too long
or too shallow? If yes, create additional domain-specific context files
in .mex/context/. Examples: a project with a complex auth system gets
.mex/context/auth.md. A data pipeline gets .mex/context/ingestion.md.
A project with Stripe gets .mex/context/payments.md. Use the same YAML
frontmatter format (name, description, triggers, edges, last_updated).
Only create these for domains that have real depth — not for simple
integrations that fit in a few lines of architecture.md. For fresh
projects, mark domain-specific unknowns with "[TO BE DETERMINED —
populate after first implementation]".

Update .mex/ROUTER.md current state to reflect that this is a new project.
Add rows to the routing table for any domain-specific context files you created.
Update .mex/AGENTS.md with the project name, description, non-negotiables, and commands.

Read .mex/patterns/README.md for the format and categories.

Generate 2-3 starter patterns for the most obvious task types you can
anticipate for this stack. Focus on the tasks a developer will do first.
Mark unknowns with "[VERIFY AFTER FIRST IMPLEMENTATION]".

Do NOT try to anticipate every possible pattern. The scaffold grows
incrementally — the behavioural contract (step 5: GROW) will create
new patterns from real work as the project evolves. Setup just seeds
the most critical ones.

After generating patterns, update .mex/patterns/INDEX.md with a row for each
pattern file you created.

PASS 3 — Wire the web:

Re-read every file you just wrote (.mex/context/ files, pattern files, .mex/ROUTER.md).
For each file, add or update the edges array in the YAML frontmatter.
Each edge should point to another scaffold file that is meaningfully related,
with a condition explaining when an agent should follow that edge.

Rules for edges:
- Every context/ file should have at least 2 edges
- Every pattern file should have at least 1 edge
- Edges should be bidirectional where it makes sense
- Use relative paths (e.g., context/stack.md, patterns/add-endpoint.md)

Important: only write content derived from the codebase or from my answers.
Do not include system-injected text (dates, reminders, etc.) in any scaffold file.`;
}

export function buildExistingWithBriefPrompt(briefJson: string): string {
  return `You are going to populate an AI context scaffold for this project.
The scaffold lives in the .mex/ directory.

Read the following files in order before doing anything else:
1. .mex/ROUTER.md — understand the scaffold structure
2. .mex/context/architecture.md — read the annotation comments to understand what belongs there
3. .mex/context/stack.md — same
4. .mex/context/conventions.md — same
5. .mex/context/decisions.md — same
6. .mex/context/setup.md — same

${GRAPH_GROUNDING_WORKFLOW}

Here is a pre-analyzed brief of the codebase — do NOT explore the filesystem
yourself for basic structure. Reason from this brief for dependencies, entry
points, tooling, and folder layout. For implementation details, use the graph
workflow above rather than opening source files.

<brief>
${briefJson}
</brief>

PASS 1 — Populate knowledge files:
${EXISTING_PASS_1}
${EXISTING_PASSES_2_3}`;
}

export function buildExistingNoBriefPrompt(): string {
  return `You are going to populate an AI context scaffold for this project.
The scaffold lives in the .mex/ directory.

Read the following files in order before doing anything else:
1. .mex/ROUTER.md — understand the scaffold structure
2. .mex/context/architecture.md — read the annotation comments to understand what belongs there
3. .mex/context/stack.md — same
4. .mex/context/conventions.md — same
5. .mex/context/decisions.md — same
6. .mex/context/setup.md — same

${GRAPH_GROUNDING_WORKFLOW}

No scanner brief is available. You may inspect manifests, README documentation,
and folder names for high-level structure only. Do not sample implementation
files. Use \`mex graph scope\` and the query/impact commands for code behavior.

PASS 1 — Populate knowledge files:
${EXISTING_PASS_1}
${EXISTING_PASSES_2_3}`;
}

export function buildAgentMemoryPrompt(): string {
  return `You are going to populate a mex scaffold for a persistent AI agent workspace.
This is not primarily a code repository. The scaffold describes an operational
environment, the agent's working memory, recurring maintenance routines, and
the patterns the agent should reuse across sessions.

Read these files first:
1. .mex/AGENTS.md — compact operating contract and GROW checklist
2. .mex/ROUTER.md — session bootstrap and routing table
3. .mex/HEARTBEAT.md — lightweight periodic health checks
4. .mex/context/*.md — fill the annotated context files
5. .mex/patterns/README.md — pattern format

Populate the scaffold for the agent-memory use case:
- ROUTER.md: current operational state, active systems, known issues, routing table
- context/architecture.md: services, machines, containers, automations, data flows
- context/stack.md: models, tools, runtimes, storage, important versions
- context/conventions.md: naming, safety rules, operational habits
- context/decisions.md: key decisions and rationale that should not be re-litigated
- context/setup.md: how to inspect, run, restart, and recover the environment
- HEARTBEAT.md: concrete checks the agent should run when polled on a heartbeat
- patterns/: 3-5 operational runbooks for recurring maintenance/debug tasks

Use the GROW loop exactly:
G — Ground: identify what changed in reality.
R — Record: update ROUTER.md and relevant context files with current truth.
O — Orient: create or update a pattern when the task can recur.
W — Write: bump last_updated on changed scaffold files and run mex log for rationale.

Event guidance:
- Use state files for current truth.
- Use mex log for decisions, risks, todos, and notes about why something changed.
- Do not rewrite history out of decisions.md; supersede old decisions instead.

Do not invent cloud services, servers, models, or schedules. If something is
unknown, write [TO DETERMINE] and say what needs to be inspected.`;
}
