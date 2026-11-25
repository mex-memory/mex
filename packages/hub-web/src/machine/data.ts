import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MachineChangeEventSchema, type MachineJobActionRequest } from "@mex/hub-contracts/machine";
import { getHome, getJobs, getReviewCounts, HubProblemError, postJobAction, signOut } from "./api";
import { changeSetting, getAgent, getAgents, getSettings, getUninstallPreview, previewAgentRepair, repairAgent, type SettingsChange } from "./control-api";
import { retryKnowledgeBusy } from "./knowledge-write-state";
import type { BrowserAgentRepair, HubJob, JobAction, MachineAgent } from "./types";

const JOBS_KEY = ["jobs"];
const POLL_MS = 10_000;
export type HubEventState = "connecting" | "open" | "reconnecting" | "polling";

export function queryOptions(events: HubEventState) {
  return {
    placeholderData: keepPreviousData,
    refetchInterval: events === "open" ? false as const : POLL_MS,
    refetchIntervalInBackground: true,
    retry: false as const,
    networkMode: "always" as const,
  };
}

export function useHome(events: HubEventState) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return useQuery({ queryKey: ["home", tz], queryFn: () => getHome(tz), ...queryOptions(events) });
}

export function useReviewCount(events: HubEventState) {
  return useQuery({ queryKey: ["review", "counts"], queryFn: getReviewCounts, ...queryOptions(events) });
}

export function useJobs(events: HubEventState, job?: string) {
  return useQuery({ queryKey: job ? [...JOBS_KEY, job] : JOBS_KEY, queryFn: () => getJobs(job), ...queryOptions(events) });
}

const agentsKey = ["agents"] as const;
const agentKey = (agent: string | undefined) => ["agents", agent] as const;
const settingsKey = ["settings"] as const;

export interface ControlConnection {
  events: HubEventState;
  csrfToken: string;
  reportDataError: (error: unknown) => void;
}

export function useAgents(events: HubEventState, enabled = true) {
  return useQuery({ queryKey: agentsKey, queryFn: ({ signal }) => getAgents(signal),
    ...queryOptions(events), placeholderData: undefined, enabled });
}

export function useAgent(events: HubEventState, agent: string | undefined) {
  return useQuery({ queryKey: agentKey(agent), queryFn: ({ signal }) => getAgent(agent!, signal),
    ...queryOptions(events), placeholderData: undefined, enabled: agent !== undefined });
}

export function useSettings(events: HubEventState) {
  return useQuery({
    queryKey: settingsKey, queryFn: ({ signal }) => getSettings(signal),
    ...queryOptions(events), placeholderData: undefined,
  });
}

export function useUninstallPreview(events: HubEventState) {
  return useQuery({
    queryKey: ["settings", "uninstall"], queryFn: ({ signal }) => getUninstallPreview(signal),
    ...queryOptions(events), placeholderData: undefined,
  });
}

export function useAgentRepair({ csrfToken, reportDataError }: ControlConnection) {
  const client = useQueryClient();
  const prepare = useMutation({
    networkMode: "always", retry: false,
    mutationFn: ({ id, onRetry }: { id: MachineAgent["id"]; onRetry: () => void }) => {
      const credentials = { csrfToken, idempotencyKey: crypto.randomUUID() };
      return retryKnowledgeBusy(() => previewAgentRepair(id, credentials), onRetry);
    },
    onError: (error) => {
      reportDataError(error);
      void client.invalidateQueries({ queryKey: agentsKey });
    },
  });
  const repair = useMutation({
    networkMode: "always", retry: false,
    mutationFn: ({ preview, onRetry }: { preview: BrowserAgentRepair; onRetry: () => void }) => {
      const credentials = { csrfToken, idempotencyKey: crypto.randomUUID() };
      return retryKnowledgeBusy(() => repairAgent(preview, credentials), onRetry);
    },
    onSuccess: ({ agent }) => {
      client.setQueryData<Awaited<ReturnType<typeof getAgents>>>(agentsKey, current => current
        ? { ...current, agents: current.agents?.map(item => item.id === agent.id ? agent : item) } : undefined);
      client.setQueryData(agentKey(agent.id), { agent });
      void client.invalidateQueries({ queryKey: agentsKey });
      void client.invalidateQueries({ queryKey: ["settings", "uninstall"] });
    },
    onError: (error) => {
      reportDataError(error);
      if (error instanceof HubProblemError && error.status === 409) void client.invalidateQueries({ queryKey: agentsKey });
    },
  });
  return { prepare: prepare.mutateAsync, repair: repair.mutateAsync };
}

export function useSettingChange({ csrfToken, reportDataError }: ControlConnection) {
  const client = useQueryClient();
  return useMutation({
    networkMode: "always", retry: false,
    mutationFn: ({ change, revision, onRetry }: { change: SettingsChange; revision: string; onRetry: () => void }) => {
      const credentials = { csrfToken, idempotencyKey: crypto.randomUUID() };
      return retryKnowledgeBusy(() => changeSetting(change, revision, credentials), onRetry);
    },
    onSuccess: () => {
      for (const queryKey of [settingsKey, ["home"], ["machine", "projects"]]) void client.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      reportDataError(error);
      if (error instanceof HubProblemError && error.status === 409) void client.invalidateQueries({ queryKey: settingsKey });
    },
  }).mutateAsync;
}

/** After signing out, the session check finds no cookie and shows the sign-in screen. */
export function useSignOut({ csrfToken, reportDataError }: ControlConnection) {
  return useMutation({
    networkMode: "always", retry: false,
    mutationFn: (scope: "thisBrowser" | "everywhere") => signOut(scope, csrfToken),
    onSuccess: () => reportDataError(new HubProblemError(401)),
    onError: reportDataError,
  }).mutateAsync;
}

export function useHubEvents(checkSession: () => void): HubEventState {
  const client = useQueryClient();
  const [state, setState] = useState<HubEventState>("connecting");

  useEffect(() => {
    if (typeof EventSource === "undefined") { setState("polling"); return; }
    const source = new EventSource("/api/v1/events");
    const usePolling = () => window.setTimeout(() => setState("polling"), POLL_MS);
    let fallback: number | undefined = usePolling();
    const refresh = (topic: string) => void client.invalidateQueries({ queryKey: [topic] }, { cancelRefetch: false });
    source.onopen = () => {
      window.clearTimeout(fallback);
      fallback = undefined;
      setState("open");
      // Re-read after a disconnect, since the stream carries only change signals.
      refresh("home");
      refresh("jobs");
      refresh("knowledge");
      refresh("review");
      refresh("agents");
      refresh("settings");
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        window.clearTimeout(fallback);
        setState("polling");
      } else {
        setState((current) => {
          if (current === "open" || current === "connecting") return "reconnecting";
          return current;
        });
        // The initial timer keeps running while the browser attempts to connect.
        if (fallback === undefined) fallback = usePolling();
      }
      // EventSource doesn't expose a rejected HTTP status. The session endpoint
      // detects a 401 and the re-link flow unmounts this stream.
      checkSession();
    };
    const onChange = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
      let data: unknown;
      try { data = JSON.parse(event.data); } catch { return; }
      const parsed = MachineChangeEventSchema.safeParse(data);
      if (parsed.success) {
        const topics = new Set(parsed.data.topics);
        if (topics.has("home") || topics.has("knowledge")) topics.add("review");
        for (const topic of topics) refresh(topic);
      }
    };
    source.addEventListener("change", onChange);
    return () => {
      window.clearTimeout(fallback);
      source.removeEventListener("change", onChange);
      source.close();
    };
  }, [checkSession, client]);

  return state;
}

function expectedState({ state }: HubJob): MachineJobActionRequest["expectedState"] {
  switch (state.phase) {
    case "doneWithGaps": return "done with gaps";
    case "stopped": return "cancelled";
    default: return state.phase;
  }
}

export function useJobActions(csrfToken: string, reportDataError: (error: unknown) => void) {
  const client = useQueryClient();
  const { mutateAsync } = useMutation({
    mutationFn: ({ job, action }: { job: HubJob; action: JobAction }) => postJobAction(job.id, action, expectedState(job), csrfToken),
    onSuccess: (updated) => {
      client.setQueriesData<readonly HubJob[]>({ queryKey: JOBS_KEY }, (jobs) => jobs?.map((job) => job.id === updated.id ? updated : job));
      void client.invalidateQueries({ queryKey: JOBS_KEY });
    },
    networkMode: "always",
  });

  return async (job: HubJob, action: JobAction) => {
    try { await mutateAsync({ job, action }); }
    catch (error) {
      if (error instanceof HubProblemError && error.status === 409) {
        await client.invalidateQueries({ queryKey: JOBS_KEY });
        return;
      }
      reportDataError(error);
      throw error;
    }
  };
}
