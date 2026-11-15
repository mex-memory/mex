/** Initialize only a fresh owned worktree, before its write checkpoint. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeError } from "../knowledge/contract.js";
import { git } from "../knowledge/share-plan.js";
import type { UpgradeFileChange } from "./cleanup-plan.js";
import { applyChange, readText } from "./safe-files.js";

/** Git may materialize CRLF even though the invoking checkout has reviewed LF
 * bytes. Prove the fresh target is still the base, then seed the exact approved
 * before image. Ordinary writes and recovery after initialization compare exact bytes. */
export function seedOwnedCheckout(root: string, base: string, changes: readonly UpgradeFileChange[]): void {
  if (!lstatSync(join(root, ".git")).isFile() || git(root, "rev-parse", "HEAD") !== base) {
    throw new KnowledgeError("UPGRADE_CHANGED", "The upgrade checkout is no longer the approved base.");
  }
  for (const change of changes) {
    const current = readText(root, change.path);
    if (current === change.before) continue;
    if (current === null || change.before === null || current.replace(/\r\n/gu, "\n") !== change.before.replace(/\r\n/gu, "\n")) {
      throw new KnowledgeError("UPGRADE_CHANGED", `Upgrade base bytes changed: ${change.path}`);
    }
    try {
      git(root, "diff", "--quiet", "--no-ext-diff", "--no-textconv", base, "--", change.path);
      git(root, "diff", "--quiet", "--no-ext-diff", "--no-textconv", "--cached", base, "--", change.path);
    } catch { throw new KnowledgeError("UPGRADE_CHANGED", `Upgrade base is not clean: ${change.path}`); }
    applyChange(root, { path: change.path, before: current, after: change.before });
  }
}
