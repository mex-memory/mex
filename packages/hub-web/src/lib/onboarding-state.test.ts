import { afterEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_STORAGE_KEY,
  clearOnboardingState,
  readOnboardingState,
  writeOnboardingState,
} from "./onboarding-state";

afterEach(() => {
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

describe("hub onboarding local state", () => {
  it("treats missing, empty, and malformed values as not completed", () => {
    clearOnboardingState();
    expect(readOnboardingState()).toBeNull();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "");
    expect(readOnboardingState()).toBeNull();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "{");
    expect(readOnboardingState()).toBeNull();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ completed: false }));
    expect(readOnboardingState()).toBeNull();
  });

  it("round-trips a completed tour and ignores storage write failures", () => {
    writeOnboardingState({ completed: true });
    expect(readOnboardingState()).toEqual({ completed: true });
    clearOnboardingState();
    expect(readOnboardingState()).toBeNull();

    const failing = {
      setItem() {
        throw new Error("quota");
      },
      removeItem() {
        throw new Error("quota");
      },
    };
    expect(() => writeOnboardingState({ completed: true }, failing)).not.toThrow();
    expect(() => clearOnboardingState(failing)).not.toThrow();
  });
});
