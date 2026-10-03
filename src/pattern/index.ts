import { join } from "node:path";
import { existsSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import chalk from "chalk";
import type { MexConfig } from "../types.js";
import { loadConfiguredWikiConfig } from "../config.js";
import { wikiInUse } from "../wiki/migration/adoption-gaps.js";
import { inventoryScaffold } from "../wiki/migration/inventory.js";
import { migrateScaffold } from "../wiki/migration/migrate.js";

export async function runPatternAdd(config: MexConfig, name: string) {
  if (!/^[a-z0-9-]+$/i.test(name)) {
    throw new Error(`Invalid pattern name '${name}'. Use only letters, numbers, and hyphens.`);
  }

  const patternsDir = join(config.scaffoldRoot, "patterns");
  const patternPath = join(patternsDir, `${name}.md`);
  const indexPath = join(patternsDir, "INDEX.md");

  if (existsSync(patternPath)) {
    throw new Error(`Pattern '${name}' already exists at ${patternPath}`);
  }

  const today = new Date().toISOString().split("T")[0];

  const template = `---
name: ${name}
description: [one line — what this pattern covers and when to use it]
triggers:
  - "[keyword that should trigger loading this file]"
edges:
  - target: "context/conventions.md"
    condition: "when verifying this task"
last_updated: ${today}
---

# ${name}

## Context
[What to load or know before starting this task type]

## Steps
[The workflow — what to do, in what order]

## Gotchas
[The things that go wrong. What to watch out for.]

## Verify
[Checklist to run after completing this task type]

## Debug
[What to check when this task type breaks]

## Update Scaffold
- [ ] Update \`ROUTER.md\` "Current Project State" if what's working/not built has changed
- [ ] Update any \`context/\` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in \`patterns/\` and add to \`INDEX.md\`
`;

  mkdirSync(patternsDir, { recursive: true });
  writeFileSync(patternPath, template, "utf8");

  if (existsSync(indexPath)) {
    const currentIndex = readFileSync(indexPath, "utf8");
    const newlinePrefix = currentIndex.length === 0 || currentIndex.endsWith("\n") ? "" : "\n";
    const entry = `${newlinePrefix}| [${name}.md](${name}.md) | [description] |\n`;
    appendFileSync(indexPath, entry, "utf8");
  }

  console.log(chalk.green(`✓ Created pattern ${name}.md`));
  console.log(chalk.dim(`  Added entry to patterns/INDEX.md`));
  const adoption = adoptPattern(config.scaffoldRoot, `patterns/${name}.md`);
  if (adoption.kind === "adopted") {
    console.log(chalk.dim(`  Added it to the Wiki as ${adoption.id}`));
  } else if (adoption.kind === "failed") {
    console.log(chalk.yellow(`! Not added to the Wiki: ${adoption.reason} Run \`mex wiki migrate\` to add it.`));
  }
  console.log(chalk.yellow(`! Remember to edit patterns/INDEX.md and replace [description] with a real use case.`));
}

type PatternAdoption =
  | { kind: "adopted"; id: string }
  | { kind: "skipped" }
  | { kind: "failed"; reason: string };

/**
 * Adopt the new pattern as a Wiki entity, as setup's migration would have (#227).
 *
 * Migration runs once, during setup, so a pattern created afterwards stayed
 * outside the Wiki until someone thought to re-run it. The file is migrated
 * on its own, through the same locked, audited path `mex wiki migrate` takes,
 * and only when the scaffold already uses the Wiki: a scaffold with no entity
 * (agent memory, or one never migrated) is left exactly as before, as is a
 * file `wiki.exclude` hides. A failure never undoes the pattern file; it is
 * reported with the command that finishes the job.
 */
function adoptPattern(scaffoldRoot: string, path: string): PatternAdoption {
  try {
    const wiki = loadConfiguredWikiConfig(scaffoldRoot);
    const inventory = inventoryScaffold({ scaffoldRoot, exclude: wiki.exclude });
    if (!wikiInUse(inventory) || !inventory.files.some((file) => file.path === path)) return { kind: "skipped" };
    const report = migrateScaffold({ scaffoldRoot, paths: [path], exclude: wiki.exclude, readOnly: wiki.readOnly });
    const id = report.idsGenerated[0];
    if (id !== undefined) return { kind: "adopted", id };
    const reason = report.diagnostics.find((entry) => entry.severity === "error")?.message
      ?? report.abstentions.find((entry) => entry.file === path)?.reason
      ?? "migration created no entity.";
    return { kind: "failed", reason };
  } catch (error) {
    return { kind: "failed", reason: `${error instanceof Error ? error.message : String(error)}.` };
  }
}
