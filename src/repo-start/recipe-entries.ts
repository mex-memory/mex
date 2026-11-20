import type { KnowledgeEntry } from "../knowledge/entry.js";
import { producerEntryId } from "../knowledge/producers.js";
import { nativeBinary } from "../knowledge/check.js";
import { MAX_SETUP_RECIPES, refreshSetupRecipes, type KnowledgeOptions } from "../knowledge/store.js";
import type { Recipe, RecipesFile } from "./recipes/index.js";

const ROLES = ["test", "build", "lint", "typecheck"];
export { MAX_SETUP_RECIPES };
const VERBS: Record<string, string> = { test: "Tests", build: "Build", lint: "Lint", typecheck: "Typecheck" };

export function setupRecipeId(packagePath: string, role: string): string {
  return producerEntryId("setup-recipe", `mex setup\n${packagePath}\n${role}`);
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
    if (out.length === MAX_SETUP_RECIPES) return out;
  }
  return out;
}

export function saveSetupRecipes(file: RecipesFile, options: KnowledgeOptions): { saved: number; selected: number; incomplete: boolean; capped: boolean } {
  const selected = selectSetupRecipes(file), binary = nativeBinary(options.env);
  const capped = selected.length === MAX_SETUP_RECIPES;
  if (!binary) return { saved: 0, selected: selected.length, incomplete: selected.length > 0, capped };
  const entries: KnowledgeEntry[] = [];
  for (const recipe of selected) {
    const origin = recipe.origin[0];
    if (!origin) continue;
    const check = { kind: "command" as const, role: "complete" as const, target: {
      run: recipe.command, file: origin.file, pointer: origin.pointer,
    }, saw: { exists: true }, files: {} };
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
  }
  const incomplete = entries.length !== selected.length;
  // Missing results in a partial scan or failed evaluator are not proof of removal.
  const results = refreshSetupRecipes(entries, options, !file.partial && !incomplete, new Date(file.scanned_at));
  return { saved: results.filter(result => result.status === "accepted").length, selected: selected.length, capped,
    incomplete: incomplete || results.some(result => result.status === "review" || (result.status === "dropped"
      && !["forgotten", "duplicate-entry", "duplicate-rule-line"].includes(result.reason))) };
}
