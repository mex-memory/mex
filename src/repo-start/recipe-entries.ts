import { createHash } from "node:crypto";
import { CheckSchema, type KnowledgeEntry } from "../knowledge/entry.js";
import { spawnSync } from "node:child_process";
import { nativeBinary } from "../knowledge/check.js";
import { MAX_SETUP_RECIPES, refreshSetupRecipes, type KnowledgeOptions } from "../knowledge/store.js";
import { knowledgeProject } from "../knowledge/context.js";
import type { Recipe, RecipesFile } from "./recipes/index.js";

const ROLES = ["test", "build", "lint", "typecheck"];
export { MAX_SETUP_RECIPES };
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
    if (out.length === MAX_SETUP_RECIPES) return out;
  }
  return out;
}

export function saveSetupRecipes(file: RecipesFile, options: KnowledgeOptions): { saved: number; selected: number; incomplete: boolean; capped: boolean } {
  const selected = selectSetupRecipes(file), binary = nativeBinary(options.env);
  const capped = selected.length === MAX_SETUP_RECIPES;
  if (!binary) return { saved: 0, selected: selected.length, incomplete: selected.length > 0, capped };
  const project = knowledgeProject(options), entries: KnowledgeEntry[] = [];
  const recipes = selected.filter(recipe => recipe.origin[0]);
  // One evaluator run records every command's check; one spawn per command
  // cost about 80 ms each on Windows.
  const run = spawnSync(binary, ["--check-run"], {
    input: JSON.stringify({ action: "record-batch", checkout: project.root, project_id: project.projectId, record_directory: project.location.directory,
      items: recipes.map(recipe => ({ kind: "command", role: "complete", target: { run: recipe.command, file: recipe.origin[0]!.file, pointer: recipe.origin[0]!.pointer } })) }),
    encoding: "utf8", timeout: 30_000, windowsHide: true, env: { ...(options.env ?? process.env), MEX_BACKGROUND: "1" },
  });
  let results: Array<{ ok?: boolean; check?: unknown }> = [];
  try {
    const parsed = JSON.parse(run.stdout || "{}") as { ok?: boolean; results?: Array<{ ok?: boolean; check?: unknown }> };
    if (parsed.ok && Array.isArray(parsed.results)) results = parsed.results;
  } catch { /* no results: every recipe stays unsaved and setup says so */ }
  recipes.forEach((recipe, i) => {
    const origin = recipe.origin[0]!, result = results[i];
    if (!result?.ok) return;
    const parsed = CheckSchema.safeParse(result.check);
    if (!parsed.success) return; // An unrecordable command never becomes an unchecked recipe.
    const check = parsed.data;
    if (check.kind !== "command" || check.role !== "complete" || !check.saw.exists) return;
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
  });
  const incomplete = entries.length !== selected.length;
  // Missing results in a partial scan or failed evaluator are not proof of removal.
  const saved = refreshSetupRecipes(entries, options, !file.partial && !incomplete);
  return { saved, selected: selected.length, incomplete, capped };
}
