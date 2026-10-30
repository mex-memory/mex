import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findConfig } from "../config.js";
import { SCAFFOLD_FILES } from "./phases.js";

/**
 * Templates whose entries become entities from their own prose. A file-level
 * entity placed first would make those adoptions impossible (they would shorten
 * its body), so the decision log is given its id at finish, after migration has
 * adopted the decisions written into it (#286).
 */
const STAMPED_AT_FINISH = new Set(["context/decisions.md"]);

/**
 * Give each knowledge template that is still exactly as setup placed it its
 * Wiki id, so the Wiki exists before population writes the first fact (#286).
 *
 * "Still exactly as placed" rather than "copied this run": a run interrupted
 * between placement and this step leaves pristine templates behind, and the
 * rerun must stamp them, while a template someone has since written into is
 * authored knowledge that finish hands to migration instead.
 *
 * Never fatal. A failure leaves templates unstamped, which finish handles the
 * way it handles any older scaffold; setup reports it and carries on.
 */
export async function stampPlacedTemplates(
  projectRoot: string,
  mexDir: string,
  templatesDir: string,
  warn: (message: string) => void,
): Promise<void> {
  const pristine = SCAFFOLD_FILES.filter((file) => {
    if (STAMPED_AT_FINISH.has(file)) return false;
    const path = resolve(mexDir, file);
    const template = resolve(templatesDir, file);
    if (!existsSync(path) || !existsSync(template)) return false;
    try {
      return readFileSync(path, "utf-8") === readFileSync(template, "utf-8");
    } catch {
      return false;
    }
  });
  if (pristine.length === 0) return;
  try {
    const { stampScaffoldFiles } = await import("../wiki/migration/stamp.js");
    const config = findConfig(projectRoot);
    const result = stampScaffoldFiles({
      scaffoldRoot: mexDir,
      scope: "placed",
      paths: pristine,
      ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
      ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
    });
    if (!result.applied) {
      const reason = result.diagnostics.find((entry) => entry.severity === "error")?.message ?? "the Wiki refused the change";
      warn(`Could not give the new templates their Wiki ids (${reason}). Setup will add them when it finishes.`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`Could not give the new templates their Wiki ids (${reason}). Setup will add them when it finishes.`);
  }
}
