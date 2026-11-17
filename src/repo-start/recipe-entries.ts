import { createHash } from "node:crypto";
import { CheckSchema, type KnowledgeEntry } from "../knowledge/entry.js";
import { nativeBinary, recordCheck } from "../knowledge/check.js";
import { refreshSetupRecipes, type KnowledgeOptions } from "../knowledge/store.js";
import { knowledgeProject } from "../knowledge/context.js";
import type { Recipe, RecipesFile } from "./recipes/index.js";

const ROLES = ["test", "build", "lint", "typecheck"];
const VERBS: Record<string, string> = { test: "Tests", build: "Build", lint: "Lint", typecheck: "Typecheck" };

export function setupRecipeId(packagePath: string, role: string): string {
  return `mx_setup${createHash("sha256").update(`mex setup\n${packagePath}\n${role}`).digest("hex").slice(0, 24)}`;
}

/** Root first, then dependency order, then remaining packages. One entry per package and role. */
export function selectSetupRecipes(file: RecipesFile): Recipe[] {
  const paths = [...new Set(["", ...file.build_order, ...file.packages.map(pkg => pkg.path)])];
  const out: Recipe[] = [];
  for (const path of paths) for (const role of ROLES) {
    if (path !== "" && role !== "test" && role !== "build") continue;
    const recipe = file.recipes.find(recipe => recipe.package === path && recipe.purpose === role
      && recipe.local === "yes" && recipe.entry.mex.source.type === "config");
    if (recipe) out.push(recipe);
    if (out.length === 20) return out;
  }
  return out;
}

export function saveSetupRecipes(file: RecipesFile, options: KnowledgeOptions): { saved: number; selected: number; incomplete: boolean } {
  const selected = selectSetupRecipes(file), binary = nativeBinary(options.env);
  if (!binary) return { saved: 0, selected: selected.length, incomplete: selected.length > 0 };
  const project = knowledgeProject(options), entries: KnowledgeEntry[] = [];
  for (const recipe of selected) {
    const origin = recipe.origin[0];
    if (!origin) continue;
    try {
      const check = CheckSchema.parse(recordCheck(binary, {
        checkout: project.root, project_id: project.projectId, record_directory: project.location.directory,
        kind: "command", role: "complete", target: { run: recipe.command, file: origin.file, pointer: origin.pointer },
      }));
      if (check.kind !== "command" || check.role !== "complete" || !check.saw.exists) continue;
      const first = file.build_order[0];
      const firstName = file.packages.find(pkg => pkg.path === first)?.name ?? first;
      const order = recipe.package === "" && recipe.purpose === "build" && first !== undefined && file.build_order.length > 1
        ? ` (build ${firstName} first)` : "";
      const text = `${VERBS[recipe.purpose]}${recipe.package ? ` in ${recipe.package}` : ""}: \`${recipe.command}\`${order}`;
      entries.push({ mex: {
        id: setupRecipeId(recipe.package, recipe.purpose), kind: "recipe", scope: [recipe.package ? `${recipe.package}/**` : "**"],
        source: { type: "config", ref: origin.file }, evidence: "docs", one_line: text, checks: [check], status: "active",
        created: file.scanned_at.slice(0, 10),
      }, text });
    } catch { /* An unrecordable command never becomes an unchecked recipe. */ }
  }
  const incomplete = entries.length !== selected.length;
  // Missing results in a partial scan or failed evaluator are not proof of removal.
  const saved = refreshSetupRecipes(entries, options, !file.partial && !incomplete);
  return { saved, selected: selected.length, incomplete };
}
