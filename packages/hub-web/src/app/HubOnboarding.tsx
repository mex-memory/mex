import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { OnboardingTour } from "../pages/OnboardingTour";
import { readOnboardingState, writeOnboardingState } from "../lib/onboarding-state";
import { hubOnboardingSteps } from "./onboarding";
import type { NavigationGroupId } from "./navigation";

interface HubOnboardingContextValue {
  active: boolean;
  revealGroups: readonly NavigationGroupId[];
  replay(): void;
}

const HubOnboardingContext = createContext<HubOnboardingContextValue | null>(null);

export function useHubOnboarding(): HubOnboardingContextValue | null {
  return useContext(HubOnboardingContext);
}

export function HubOnboarding({
  children,
  projectName,
  ready,
}: {
  children: ReactNode;
  projectName?: string;
  ready: boolean;
}) {
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(() => readOnboardingState()?.completed === true);
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const step = open ? hubOnboardingSteps(projectName)[stepIndex] : undefined;

  useEffect(() => {
    if (!completed && ready) setOpen(true);
  }, [completed, ready]);

  const rememberCompleted = useCallback(() => {
    writeOnboardingState({ completed: true });
    setCompleted(true);
  }, []);

  const dismiss = useCallback(() => {
    rememberCompleted();
    setOpen(false);
  }, [rememberCompleted]);

  const finish = useCallback((path?: string) => {
    rememberCompleted();
    if (path) navigate(path);
    setOpen(false);
  }, [navigate, rememberCompleted]);

  const replay = useCallback(() => {
    setStepIndex(0);
    setOpen(true);
  }, []);

  const value = useMemo(() => ({
    active: open,
    revealGroups: step?.revealGroups ?? [],
    replay,
  }), [open, replay, step]);

  return (
    <HubOnboardingContext.Provider value={value}>
      {children}
      {open ? (
        <OnboardingTour
          projectName={projectName}
          stepIndex={stepIndex}
          onDismiss={dismiss}
          onFinish={finish}
          onStepChange={setStepIndex}
        />
      ) : null}
    </HubOnboardingContext.Provider>
  );
}
