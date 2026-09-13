import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useHubApi } from "../api/context";
import { hubOnboardingSteps } from "./onboarding";
import type { NavigationGroupId } from "./navigation";

// The shell mounts on every route; load the tour only when it opens.
const OnboardingTour = lazy(async () => ({ default: (await import("../pages/OnboardingTour")).OnboardingTour }));

const ONBOARDING_QUERY_KEY = ["settings", "onboarding"] as const;

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
  const api = useHubApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Completion lives in this checkout's .mex/local, not the browser, so it
  // survives the Hub's per-launch loopback port.
  const state = useQuery({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => api.getOnboardingState(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const complete = useMutation({
    mutationFn: () => api.completeOnboarding(),
    onSuccess: (next) => queryClient.setQueryData(ONBOARDING_QUERY_KEY, next),
  });
  const [open, setOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const step = open ? hubOnboardingSteps(projectName)[stepIndex] : undefined;

  // Open at most once per mount, so a failed completion write never reopens it.
  useEffect(() => {
    if (ready && !autoOpened && state.data?.completed === false) {
      setAutoOpened(true);
      setOpen(true);
    }
  }, [autoOpened, ready, state.data?.completed]);

  const { mutate: recordCompleted } = complete;
  const rememberCompleted = useCallback(() => {
    if (state.data?.completed !== true) recordCompleted();
  }, [recordCompleted, state.data?.completed]);

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
        <Suspense fallback={null}>
          <OnboardingTour
            projectName={projectName}
            stepIndex={stepIndex}
            onDismiss={dismiss}
            onFinish={finish}
            onStepChange={setStepIndex}
          />
        </Suspense>
      ) : null}
    </HubOnboardingContext.Provider>
  );
}
