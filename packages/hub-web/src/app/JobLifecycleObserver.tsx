import { HUB_LIMITS, HubJobSnapshotSchema } from "@mex/hub-contracts";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useHubApi } from "../api/context";
import type { JobKind, JobSummary, JobsResponse } from "../api/types";
import { rememberBoundedId } from "../lib/bounds";

const JOB_LIFECYCLE_CHANNEL_PREFIX = "mex-hub-job-lifecycle-v1";

interface JobLifecycleMessage {
  schemaVersion: 1;
  type: "job_snapshot";
  job: JobSummary;
}

export function isActiveJob(job: JobSummary): boolean {
  return job.state === "queued" || job.state === "running";
}

export function isGraphJob(kind: JobKind): kind is "graph_refresh" | "graph_rebuild" {
  return kind === "graph_refresh" || kind === "graph_rebuild";
}

export function isWikiJob(kind: JobKind): kind is "wiki_refresh" | "wiki_rebuild" {
  return kind === "wiki_refresh" || kind === "wiki_rebuild";
}

export async function invalidateGraphReads(queryClient: QueryClient): Promise<void> {
  // Not awaited: a drift check can far outlast the other reads.
  void queryClient.invalidateQueries({ queryKey: ["drift"] });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["search"] }),
    queryClient.invalidateQueries({ queryKey: ["code-symbol"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-graph"] }),
    queryClient.invalidateQueries({ queryKey: ["context-detail"] }),
    queryClient.invalidateQueries({ queryKey: ["context-code"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
    queryClient.invalidateQueries({ queryKey: ["home"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
  ]);
}

export async function invalidateWikiReads(queryClient: QueryClient): Promise<void> {
  // Not awaited: a drift check can far outlast the other reads.
  void queryClient.invalidateQueries({ queryKey: ["drift"] });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["search"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-entities"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-entity"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-relations"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-backlinks"] }),
    queryClient.invalidateQueries({ queryKey: ["code-knowledge"] }),
    queryClient.invalidateQueries({ queryKey: ["wiki-graph"] }),
    queryClient.invalidateQueries({ queryKey: ["context-detail"] }),
    queryClient.invalidateQueries({ queryKey: ["context-code"] }),
    queryClient.invalidateQueries({ queryKey: ["health"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
    queryClient.invalidateQueries({ queryKey: ["home"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
  ]);
}

export async function invalidateIndexOperationState(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["health"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["capabilities"] }),
    queryClient.invalidateQueries({ queryKey: ["home"] }),
    queryClient.invalidateQueries({ queryKey: ["overview"] }),
  ]);
}

async function invalidateTerminalJob(queryClient: QueryClient, job: JobSummary): Promise<void> {
  if (job.state === "succeeded" && isGraphJob(job.kind)) return invalidateGraphReads(queryClient);
  if (job.state === "succeeded" && isWikiJob(job.kind)) return invalidateWikiReads(queryClient);
  return invalidateIndexOperationState(queryClient);
}

function mergeJobSnapshot(current: JobSummary | undefined, incoming: JobSummary): JobSummary {
  if (current && !isActiveJob(current) && isActiveJob(incoming)) return current;
  return incoming;
}

function mergeLifecyclePage(current: JobsResponse | undefined, incoming: JobSummary): JobsResponse {
  if (!current) return { items: [incoming], nextCursor: null };
  const existing = current.items.find((job) => job.id === incoming.id);
  const merged = mergeJobSnapshot(existing, incoming);
  const items = existing
    ? current.items.map((job) => job.id === incoming.id ? merged : job)
    : [merged, ...current.items];
  return { ...current, items: items.slice(0, HUB_LIMITS.defaultPageSize) };
}

function parseLifecycleMessage(value: unknown): JobLifecycleMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<JobLifecycleMessage>;
  if (candidate.schemaVersion !== 1 || candidate.type !== "job_snapshot") return null;
  const job = HubJobSnapshotSchema.safeParse(candidate.job);
  return job.success ? { schemaVersion: 1, type: "job_snapshot", job: job.data } : null;
}

function publishLifecycleSnapshot(channel: BroadcastChannel | null, job: JobSummary): void {
  if (!channel) return;
  try {
    channel.postMessage({ schemaVersion: 1, type: "job_snapshot", job } satisfies JobLifecycleMessage);
  } catch {
    // Cross-tab discovery is an optimization; the durable SSE remains authoritative.
  }
}

/**
 * Own durable index-job observation for the lifetime of the authenticated app.
 * This keeps terminal cache invalidation alive when users leave the Jobs route.
 */
export function JobLifecycleObserver({ channelScope }: { channelScope?: string }) {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const initialTerminalIds = useRef<Set<string> | null>(null);
  const observedTerminal = useRef(new Set<string>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lifecycle = useQuery({
    queryKey: ["job-lifecycle"],
    queryFn: async () => {
      const page = await api.getJobs();
      if (initialTerminalIds.current === null) {
        initialTerminalIds.current = new Set(page.items.filter((job) => !isActiveJob(job)).map((job) => job.id));
      }
      return page;
    },
    retry: false,
  });
  const activeIds = useMemo(
    () => lifecycle.data?.items.filter(isActiveJob).map((job) => job.id).sort().join(",") ?? "",
    [lifecycle.data],
  );

  const observeTerminal = useCallback((job: JobSummary) => {
    if (
      isActiveJob(job)
      || observedTerminal.current.has(job.id)
      || initialTerminalIds.current?.has(job.id)
    ) return;
    rememberBoundedId(observedTerminal.current, job.id);
    void invalidateTerminalJob(queryClient, job);
  }, [queryClient]);

  useEffect(() => {
    if (!lifecycle.data) return;
    const terminal = lifecycle.data.items.filter((job) => !isActiveJob(job));
    for (const job of terminal) {
      const unseen = !observedTerminal.current.has(job.id)
        && !initialTerminalIds.current?.has(job.id);
      rememberBoundedId(observedTerminal.current, job.id);
      if (unseen) void invalidateTerminalJob(queryClient, job);
    }
  }, [lifecycle.data, queryClient]);

  useEffect(() => {
    if (!channelScope || typeof BroadcastChannel !== "function") return;
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(`${JOB_LIFECYCLE_CHANNEL_PREFIX}:${channelScope.slice(0, 64)}`);
    } catch {
      return;
    }
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseLifecycleMessage(event.data);
      if (!message) return;
      const currentLifecycle = queryClient.getQueryData<JobsResponse>(["job-lifecycle"]);
      const existingLifecycleJob = currentLifecycle?.items.find((job) => job.id === message.job.id);
      const mergedLifecycleJob = mergeJobSnapshot(existingLifecycleJob, message.job);
      const becameActive = isActiveJob(mergedLifecycleJob)
        && (!existingLifecycleJob || !isActiveJob(existingLifecycleJob));
      queryClient.setQueryData<JobSummary>(["job", message.job.id], (current) => (
        mergeJobSnapshot(current, message.job)
      ));
      queryClient.setQueryData<JobsResponse>(["job-lifecycle"], (current) => (
        mergeLifecyclePage(current, message.job)
      ));
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (becameActive) {
        void queryClient.invalidateQueries({ queryKey: ["home"] });
        void queryClient.invalidateQueries({ queryKey: ["overview"] });
      }
      observeTerminal(message.job);
    };
    return () => {
      if (channelRef.current === channel) channelRef.current = null;
      channel.onmessage = null;
      channel.close();
    };
  }, [channelScope, observeTerminal, queryClient]);

  useEffect(() => {
    if (!activeIds) return;
    const subscriptions = activeIds.split(",").map((id) => api.subscribeToJob(id, (snapshot) => {
      queryClient.setQueryData<JobSummary>(["job", id], (current) => mergeJobSnapshot(current, snapshot));
      queryClient.setQueryData<JobsResponse>(["job-lifecycle"], (current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === snapshot.id ? mergeJobSnapshot(item, snapshot) : item),
      } : current);
      publishLifecycleSnapshot(channelRef.current, snapshot);

      if (isActiveJob(snapshot)) {
        void queryClient.invalidateQueries({ queryKey: ["jobs"] });
        return;
      }
      const unseen = !observedTerminal.current.has(snapshot.id)
        && !initialTerminalIds.current?.has(snapshot.id);
      rememberBoundedId(observedTerminal.current, snapshot.id);
      if (!unseen) return;
      void invalidateTerminalJob(queryClient, snapshot).then(() => queryClient.invalidateQueries({ queryKey: ["job-lifecycle"] }));
    }));
    return () => subscriptions.forEach((subscription) => subscription.close());
  }, [activeIds, api, queryClient]);

  return null;
}
