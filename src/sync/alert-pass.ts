import type { DriftStatus } from "@mex/hub-contracts";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { findConfig } from "../config.js";
import { RepositoryInventory } from "../drift/repository.js";
import { readDriftAlertState, updateDriftAlertState } from "./alert-state.js";
import { detectDrift } from "./detect.js";
import { sendDesktopNotification } from "./notify.js";

/** Half-finished edits look like drift, so wait until the source has settled. */
const QUIET_MS = 10 * 60_000;

export type DriftAlertOutcome = "off" | "incomplete" | "unchanged" | "waiting" | "checked" | "sent" | "failed";

export interface DriftAlertPassOptions {
  /** A commit is a natural checkpoint, so it skips the wait for quiet. */
  afterCommit?: boolean;
  now?: () => number;
  detect?: (projectRoot: string) => Promise<DriftStatus>;
  notify?: (title: string, body: string) => Promise<boolean>;
}

/** Null when the bounded inventory could not list the repository. */
export function sourceSnapshot(projectRoot: string): { fingerprint: string; newestMs: number } | null {
  const files = new RepositoryInventory(projectRoot).files;
  if (files === null) return null;
  const hash = createHash("sha256");
  let newestMs = 0;
  for (const file of files) {
    // Without Git the walk also finds the disposable indexes, which change on their own.
    if (/^\.mex\/(graph|wiki)\.db/.test(file)) continue;
    let mtimeMs = -1;
    try { mtimeMs = statSync(resolve(projectRoot, file)).mtimeMs; } catch { /* Deleted: still a change. */ }
    newestMs = Math.max(newestMs, mtimeMs);
    hash.update(`${file}\0${mtimeMs}\n`);
  }
  return { fingerprint: hash.digest("hex"), newestMs };
}

function hasNewDrift(alerted: Record<string, number>, status: DriftStatus): boolean {
  const previous = new Map(Object.entries(alerted));
  return status.fileCount > previous.size
    || status.files.some((file) => (previous.get(file.path) ?? -1) < file.errors + file.warnings);
}

function driftMessage(fileCount: number): string {
  return `${fileCount} knowledge file${fileCount === 1 ? "" : "s"} may be out of date. Run mex sync.`;
}

/** One check. It writes only its own checkout-local state and never starts an agent. */
export async function runDriftAlertPass(
  projectRoot: string,
  options: DriftAlertPassOptions = {},
): Promise<DriftAlertOutcome> {
  const before = readDriftAlertState(projectRoot);
  if (!before.enabled) return "off";
  const snapshot = sourceSnapshot(projectRoot);
  if (snapshot === null) return "incomplete";
  if (snapshot.fingerprint === before.checkedFingerprint) return "unchanged";
  const now = options.now?.() ?? Date.now();
  if (!options.afterCommit && now - snapshot.newestMs < QUIET_MS) return "waiting";

  const status = await (options.detect ?? ((root) => detectDrift(findConfig(root))))(projectRoot);
  const files = Object.fromEntries(status.files.map((file) => [file.path, file.errors + file.warnings]));
  // Claim the alert before sending, so a pass running beside this one stays quiet.
  let shouldNotify = false;
  let previousAlerted: Record<string, number> = {};
  await updateDriftAlertState(projectRoot, (current) => {
    if (!current.enabled) return current;
    previousAlerted = current.alerted;
    const needsSync = status.state === "needs_sync";
    shouldNotify = needsSync && hasNewDrift(current.alerted, status);
    return {
      ...current,
      checkedFingerprint: snapshot.fingerprint,
      alerted: needsSync ? (shouldNotify ? files : current.alerted) : {},
    };
  });
  if (!shouldNotify) return "checked";

  const notify = options.notify ?? sendDesktopNotification;
  const sent = await notify(`MEX: ${basename(projectRoot)}`, driftMessage(status.fileCount));
  await updateDriftAlertState(projectRoot, (current) => (current.enabled
    ? { ...current, lastDelivery: sent ? "sent" : "failed", alerted: sent ? current.alerted : previousAlerted }
    : current));
  return sent ? "sent" : "failed";
}
