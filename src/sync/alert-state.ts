import { artifactError } from "../team/artifacts/errors.js";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  atomicReplaceArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../team/artifacts/filesystem.js";
import type { Revision } from "../team/contracts/shared.js";
import { RepositoryRootGuard } from "../team/workflow/repository-root.js";
import { driftAlertKey, MAX_ALERT_FILES } from "./alert-summary.js";

export interface DriftAlertState {
  enabled: boolean;
  commitHook: boolean;
  lastDelivery: "none" | "sent" | "failed";
  /** The source state the last check saw, so an unchanged checkout is not rescanned. */
  checkedFingerprint: string | null;
  /** Findings per hashed file identity at the last alert. */
  alerted: Record<string, number>;
}

const PATH = ".mex/local/drift-alerts.json";
const MAX_BYTES = 512 * 1024;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;
const DEFAULT: DriftAlertState = { enabled: true, commitHook: false, lastDelivery: "none", checkedFingerprint: null, alerted: {} };

/** Enabled by default; reading never initializes local state or Git hooks. */
export function readDriftAlertState(projectRoot: string): DriftAlertState {
  return read(new RepositoryRootGuard(projectRoot)).state;
}

/** Apply a change under the checkout's lock, against the state as it is now. */
export async function updateDriftAlertState(
  projectRoot: string,
  change: (current: DriftAlertState) => DriftAlertState,
): Promise<DriftAlertState> {
  const root = new RepositoryRootGuard(projectRoot);
  assertScaffold(root);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withContainedArtifactLock(root.path, ".mex/local", ".drift-alerts.mex-lock", () => {
        const current = read(root);
        const next = parseState({ schemaVersion: 2, ...change(current.state) });
        if (next === null) throw invalidStoredState();
        const document = `${JSON.stringify({ schemaVersion: 2, ...next })}\n`;
        if (Buffer.byteLength(document) > MAX_BYTES) throw invalidStoredState();
        assertScaffold(root);
        if (current.revision === null) atomicCreateArtifact(root.path, PATH, document);
        else atomicReplaceArtifact(root.path, PATH, current.revision, document, MAX_BYTES, "exact");
        root.assertCurrent();
        return next;
      });
    } catch (error) {
      // The shared lock refuses instead of waiting, and every holder here is brief.
      if (attempt >= LOCK_ATTEMPTS || (error as { problem?: { code?: string } }).problem?.code !== "REVISION_CONFLICT") throw error;
      await new Promise((resume) => setTimeout(resume, LOCK_RETRY_MS));
    }
  }
}

function read(root: RepositoryRootGuard): { state: DriftAlertState; revision: Revision | null } {
  assertScaffold(root);
  const stored = tryReadContainedArtifact(root.path, PATH, MAX_BYTES, "exact");
  if (stored === null) {
    root.assertCurrent();
    return { state: { ...DEFAULT, alerted: {} }, revision: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes));
  } catch { throw invalidStoredState(); }
  const state = parseState(value);
  if (state === null) throw invalidStoredState();
  root.assertCurrent();
  return { state, revision: stored.revision };
}

function parseState(value: unknown): DriftAlertState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { schemaVersion, enabled, commitHook, lastDelivery, checkedFingerprint, alerted } = value as Record<string, unknown>;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || typeof enabled !== "boolean" || typeof commitHook !== "boolean") return null;
  if (lastDelivery !== "none" && lastDelivery !== "sent" && lastDelivery !== "failed") return null;
  if (checkedFingerprint !== null && (typeof checkedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(checkedFingerprint))) return null;
  if (alerted === null || typeof alerted !== "object" || Array.isArray(alerted)) return null;
  const entries = Object.entries(alerted);
  if (entries.length > MAX_ALERT_FILES || !entries.every(([key, count]) =>
    (schemaVersion === 1 || /^[a-f0-9]{64}$/.test(key)) && Number.isSafeInteger(count) && (count as number) >= 0)) return null;
  return {
    enabled, commitHook, lastDelivery,
    // Legacy checks omitted graph identity, so do not reuse their skip marker.
    checkedFingerprint: schemaVersion === 1 ? null : checkedFingerprint,
    alerted: Object.fromEntries(entries.map(([key, count]) => [schemaVersion === 1 ? driftAlertKey(key) : key, count as number])),
  };
}

function assertScaffold(root: RepositoryRootGuard): void {
  root.assertCurrent();
  if (assertContainedArtifactDirectory(root.path, ".mex") === null) {
    throw artifactError("NOT_FOUND", "MEX scaffold unavailable", "Open the Hub from an existing MEX project.");
  }
}

function invalidStoredState() {
  return artifactError("VALIDATION_FAILED", "Invalid stored drift alert state", "The checkout's drift alert state is malformed or unsupported. Inspect .mex/local/drift-alerts.json before changing it.");
}
