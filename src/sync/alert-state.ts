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

export interface DriftAlertState {
  enabled: boolean;
  commitHook: boolean;
  lastDelivery: "none" | "sent" | "failed";
  /** The source state the last check saw, so an unchanged checkout is not rescanned. */
  checkedFingerprint: string | null;
  /** Findings per file at the last alert, so only new drift alerts again. */
  alerted: Record<string, number>;
}

const PATH = ".mex/local/drift-alerts.json";
const MAX_BYTES = 512 * 1024;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;
const OFF: DriftAlertState = { enabled: false, commitHook: false, lastDelivery: "none", checkedFingerprint: null, alerted: {} };

/** Checkout-local and opt-in; reading never initializes state. */
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
        const next = change(current.state);
        const document = `${JSON.stringify({ schemaVersion: 1, ...next })}\n`;
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
    return { state: { ...OFF }, revision: null };
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
  if (schemaVersion !== 1 || typeof enabled !== "boolean" || typeof commitHook !== "boolean") return null;
  if (lastDelivery !== "none" && lastDelivery !== "sent" && lastDelivery !== "failed") return null;
  if (checkedFingerprint !== null && typeof checkedFingerprint !== "string") return null;
  if (alerted === null || typeof alerted !== "object" || Array.isArray(alerted)) return null;
  if (!Object.values(alerted).every((count) => Number.isInteger(count) && (count as number) >= 0)) return null;
  return { enabled, commitHook, lastDelivery, checkedFingerprint, alerted: alerted as Record<string, number> };
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
