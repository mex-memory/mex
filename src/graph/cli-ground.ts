import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { MexConfig } from "../types.js";
import { AI_TOOLS } from "../types.js";
import { isCliAvailable } from "../cli-tools.js";
import { runToolInteractive } from "../sync/index.js";

export interface GroundMigrationOptions {
  dryRun?: boolean;
}

export interface GroundMigrationDeps {
  runAgent?: (prompt: string, cwd: string) => boolean;
  write?: (line: string) => void;
}

/** Prompt for agent-authored, prose-preserving migration of pre-0.7 scaffolds. */
export function buildGroundMigrationPrompt(): string {
  return `You are retro-grounding an existing populated mex scaffold after an upgrade.
The prose in .mex/ is already the user's accumulated project knowledge. Preserve it.
This is a pointer migration, not a scaffold rewrite or regeneration.

Read every existing scaffold markdown file under .mex/, including context/,
patterns/, AGENTS.md, ROUTER.md, SETUP.md, and SYNC.md. For each file, treat its
existing prose as the ground truth. Do not rephrase, reorder, expand, shorten, or replace that prose.
Do not create or delete scaffold files. The only permitted content edits are:

1. Add or update the YAML frontmatter grounds_to array.
2. Wrap an existing load-bearing symbol mention in a mex:// Markdown link.

Use the graph for all code lookup:
- mex graph scope "<behavior described by this file>" for broad hydrated context
- mex graph query where-defined <symbol> to resolve an exact mention
- mex graph query who-calls <symbol> / what-calls <symbol> when call context matters
- mex impact <symbol|file> when blast radius helps disambiguate

READ BROAD, GROUND TIGHT. Read the whole relevant scope neighborhood, but ground
only the specific functions or methods that embody behavioral claims already in
the prose. Callers and callees are reading context, not automatic targets. Broad
architecture/stack/conventions files should remain sparse or ungrounded; pattern
and deep-domain files should ground tightly. Never add grounding just so every
file has an entry, and never ground file/import/parameter or vague component nodes.

For a justified behavioral target, copy the exact id and serialized fingerprint
from the same graph JSONL fact into frontmatter:

grounds_to:
  - node: "<exact graph node id>"
    fingerprint: "<exact mh:64:... fingerprint>"

When existing prose already names a load-bearing function, method, or class,
wrap only that existing visible mention, preserving its text:
[\`symbolName()\`](mex://<exact-node-id>)

The asymmetry is mandatory: fingerprints belong ONLY in grounds_to frontmatter.
A mex:// URI is exactly mex://<nodeId> and never contains a fingerprint.

Make the migration idempotent. Before adding anything, inspect existing
grounds_to entries and mex:// anchors. Merge by node id, update stale fingerprints,
and do not duplicate an entry or wrap a mention that is already anchored. A second
run must leave the file byte-identical when the existing pointers are current.

Before finishing, re-read every changed file and verify:
- all original prose and visible symbol text is preserved;
- every grounds_to node and every mex:// id came from graph output;
- each grounds_to fingerprint came from the same node fact;
- no node id is duplicated and no anchor is nested or duplicated.

If .mex/graph.db or trustworthy graph facts are unavailable, stop and report it.
Never invent node ids or fingerprints. Report which files gained grounding and
which broad files were intentionally left sparse or ungrounded.`;
}

/** Run or print the migration prompt. All grounding judgments remain agent-authored. */
export function runGraphGround(
  config: MexConfig,
  options: GroundMigrationOptions = {},
  deps: GroundMigrationDeps = {},
): "ran" | "prompted" {
  if (!existsSync(resolve(config.projectRoot, ".mex", "graph.db"))) {
    throw new Error("Code graph unavailable. Run `mex graph` before `mex graph ground`.");
  }
  const prompt = buildGroundMigrationPrompt();
  const write = deps.write ?? console.log;
  if (options.dryRun) {
    write(prompt);
    return "prompted";
  }

  const runAgent = deps.runAgent ?? configuredAgent(config);
  if (runAgent && runAgent(prompt, config.projectRoot)) return "ran";

  write("No configured AI CLI is available. Paste this prompt into your agent:\n");
  write(prompt);
  return "prompted";
}

function configuredAgent(config: MexConfig): GroundMigrationDeps["runAgent"] {
  const tool = config.aiTools.find((candidate) => {
    const cli = AI_TOOLS[candidate].cli;
    return cli !== null && isCliAvailable(cli);
  });
  return tool ? (prompt, cwd) => runToolInteractive(tool, prompt, cwd) : undefined;
}
