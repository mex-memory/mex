import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MachineChangeEventSchema, type MachineJobActionRequest } from "@mex/hub-contracts/machine";
import { getHome, getJobs, getReviewCounts, HubProblemError, postJobAction } from "./api";
import type { HubJob, JobAction } from "./types";

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

export function useJobs(events: HubEventState) {
  return useQuery({ queryKey: JOBS_KEY, queryFn: getJobs, ...queryOptions(events) });
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
      client.setQueryData<readonly HubJob[]>(JOBS_KEY, (jobs) => jobs?.map((job) => job.id === updated.id ? updated : job));
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
