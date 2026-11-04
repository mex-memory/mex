import type { DriftStatus } from "@mex/hub-contracts";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { findConfig } from "../config.js";
import { RepositoryInventory } from "../drift/repository.js";
import { readDriftAlertState, updateDriftAlertState } from "./alert-state.js";
import { detectDriftForAlerts } from "./detect.js";
import { driftAlertKey, MAX_ALERT_FILES } from "./alert-summary.js";
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
export function sourceSnapshot(projectRoot: string, now = Date.now()): { fingerprint: string; newestMs: number } | null {
  const files = new RepositoryInventory(projectRoot).files;
  if (files === null) return null;
  const hash = createHash("sha256");
  let newestMs = 0;
  for (const file of files) {
    // Without Git the walk also finds the disposable indexes, which change on their own.
    if (/^\.mex\/(graph|wiki)\.db/.test(file)) continue;
    try {
      const stat = lstatSync(resolve(projectRoot, file));
      newestMs = Math.max(newestMs, stat.mtimeMs);
      hash.update(`${file}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.size}\n`);
    } catch { hash.update(`${file}\0missing\n`); }
  }
  // Graph maintenance changes which links can be checked, without editing source.
  // Its timestamps invalidate the check but must not restart the source quiet period.
  for (const file of [".mex/graph.db", ".mex/graph.db-wal"]) {
    try {
      const stat = lstatSync(resolve(projectRoot, file));
      hash.update(`${file}\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\n`);
    } catch { hash.update(`${file}\0missing\n`); }
  }
  try {
    hash.update(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, maxBuffer: 4_096,
    }));
  } catch { hash.update("no-head"); }
  // Age-based drift and commit history can change while worktree bytes stay put.
  hash.update(new Date(now).toISOString().slice(0, 10));
  return { fingerprint: hash.digest("hex"), newestMs };
}

function hasNewDrift(alerted: Record<string, number>, status: DriftStatus): boolean {
  const previous = new Map(Object.entries(alerted));
  return status.fileCount > previous.size
    || status.files.some((file) => (previous.get(driftAlertKey(file.path)) ?? -1) < file.errors + file.warnings);
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
  const now = options.now?.() ?? Date.now();
  const snapshot = sourceSnapshot(projectRoot, now);
  if (snapshot === null) return "incomplete";
  if (snapshot.fingerprint === before.checkedFingerprint) return "unchanged";
  if (!options.afterCommit && now - snapshot.newestMs < QUIET_MS) return "waiting";

  const status = await (options.detect ?? ((root) => detectDriftForAlerts(findConfig(root))))(projectRoot);
  // Never deduplicate a full report against the Hub's truncated first page.
  if (status.fileCount > MAX_ALERT_FILES || status.files.length !== status.fileCount) return "incomplete";
  const files = Object.fromEntries(status.files.map((file) => [driftAlertKey(file.path), file.errors + file.warnings]));
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
    ? { ...current, lastDelivery: sent ? "sent" : "failed", checkedFingerprint: sent ? current.checkedFingerprint : null, alerted: sent ? current.alerted : previousAlerted }
    : current));
  return sent ? "sent" : "failed";
}
