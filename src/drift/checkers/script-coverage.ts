import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DriftIssue } from "../../types.js";

/** npm lifecycle hooks and internal scripts that don't need documentation */
const IGNORED_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
  "prepack",
  "pack",
  "postpack",
  "prepare",
  "preshrinkwrap",
  "shrinkwrap",
  "postshrinkwrap",
]);

/** Check that package.json scripts are mentioned somewhere in the scaffold */
export function checkScriptCoverage(
  scaffoldFiles: string[],
  projectRoot: string
): DriftIssue[] {
  const scripts = loadPackageScripts(projectRoot);
  if (!scripts) return [];

  // Collect all scaffold text to search against
  const scaffoldText = scaffoldFiles
    .map((f) => {
      try {
        return readFileSync(f, "utf-8");
      } catch {
        return "";
      }
    })
    .join("\n");

  const issues: DriftIssue[] = [];

  for (const script of scripts) {
    // Skip lifecycle hooks
    if (IGNORED_SCRIPTS.has(script)) continue;

    // Skip pre/post variants of other scripts (e.g. pretest, postbuild)
    if (
      (script.startsWith("pre") && scripts.has(script.slice(3))) ||
      (script.startsWith("post") && scripts.has(script.slice(4)))
    ) {
      continue;
    }

    // Skip colon variants if the base script is documented (e.g. dev:debug when dev exists)
    if (script.includes(":")) {
      const base = script.split(":")[0];
      if (scaffoldText.includes(base)) continue;
    }

    // Check if the script name appears anywhere in scaffold files
    if (!scaffoldText.includes(script)) {
      issues.push({
        code: "UNDOCUMENTED_SCRIPT",
        severity: "warning",
        file: "package.json",
        line: null,
        message: `Script "${script}" exists in package.json but is not mentioned in any scaffold file`,
      });
    }
  }

  return issues;
}

function loadPackageScripts(projectRoot: string): Set<string> | null {
  const pkgPath = resolve(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const scripts = pkg.scripts ?? {};
    return Object.keys(scripts).length ? new Set(Object.keys(scripts)) : null;
  } catch {
    return null;
  }
}
