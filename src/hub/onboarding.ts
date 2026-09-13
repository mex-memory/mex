import { artifactError } from "../team/artifacts/errors.js";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../team/artifacts/filesystem.js";
import { RepositoryRootGuard } from "../team/workflow/repository-root.js";

export interface HubOnboardingState {
  completed: boolean;
}

const PATH = ".mex/local/hub-onboarding.json";
const MAX_BYTES = 256;
const DOCUMENT = `${JSON.stringify({ schemaVersion: 1, completed: true })}\n`;

/** Checkout-local tour completion; reading never initializes state. */
export function readHubOnboarding(projectRoot: string): HubOnboardingState {
  return readState(new RepositoryRootGuard(projectRoot));
}

/** Record completion once. Completion is one-way, so repeat calls are no-ops. */
export async function completeHubOnboarding(projectRoot: string): Promise<HubOnboardingState> {
  const root = new RepositoryRootGuard(projectRoot);
  assertScaffold(root);
  return withContainedArtifactLock(root.path, ".mex/local", ".hub-onboarding.mex-lock", () => {
    if (readState(root).completed) return { completed: true };
    assertScaffold(root);
    atomicCreateArtifact(root.path, PATH, DOCUMENT);
    root.assertCurrent();
    return { completed: true };
  });
}

function readState(root: RepositoryRootGuard): HubOnboardingState {
  assertScaffold(root);
  const stored = tryReadContainedArtifact(root.path, PATH, MAX_BYTES, "exact");
  if (stored === null) {
    root.assertCurrent();
    return { completed: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes));
  } catch { throw invalidStoredState(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "schemaVersion") || !Object.hasOwn(value, "completed")) throw invalidStoredState();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.completed !== true) throw invalidStoredState();
  root.assertCurrent();
  return { completed: true };
}

function assertScaffold(root: RepositoryRootGuard): void {
  root.assertCurrent();
  if (assertContainedArtifactDirectory(root.path, ".mex") === null) {
    throw artifactError("NOT_FOUND", "MEX scaffold unavailable", "Open the Hub from an existing MEX project.");
  }
}

function invalidStoredState() {
  return artifactError("VALIDATION_FAILED", "Invalid stored Hub tour state", "The checkout's Hub tour state is malformed or unsupported. Inspect .mex/local/hub-onboarding.json before changing it.");
}
