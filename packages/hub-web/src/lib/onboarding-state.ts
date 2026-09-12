export const ONBOARDING_STORAGE_KEY = "mex.hub.onboarding.v1";

export interface HubOnboardingLocalState {
  completed: true;
}

export function readOnboardingState(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): HubOnboardingLocalState | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(ONBOARDING_STORAGE_KEY);
    if (raw === null || raw === "") return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "completed" in parsed
      && parsed.completed === true
    ) {
      return { completed: true };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeOnboardingState(
  state: HubOnboardingLocalState,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or quota must not block the in-memory done state.
  }
}

export function clearOnboardingState(
  storage: Pick<Storage, "removeItem"> | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // Ignore storage failures; callers still own in-memory state.
  }
}

function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
