import { createHash } from "node:crypto";

/** Complete alert baselines fit below the 512 KiB local-state limit. */
export const MAX_ALERT_FILES = 4_096;

/** Alert baselines need stable identity, never the knowledge path itself. */
export function driftAlertKey(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}
