import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import type { MachineKnowledgeCheckout } from "@mex/hub-contracts/machine";
import { HubProblemError } from "./api";
import { queryOptions, type ControlConnection, type HubEventState } from "./data";
import { getForgotten, getKnowledgeItem, getKnowledgeLanding, getKnowledgePage, getRuleFiles, postBriefPreview, postKnowledgeEdit, postKnowledgeForget, postNote, postRuleRefresh } from "./knowledge-api";
import { retryKnowledgeBusy } from "./knowledge-write-state";
import type { KnowledgeActions, KnowledgeCreateResult, KnowledgeEditResult, KnowledgeFilters, KnowledgeForgetResult, KnowledgeToolsPreview } from "./types";

const key = ["knowledge"];
const detailKey = (key: string | undefined) => ["knowledge", "item", key] as const;
const rulesKey = ({ repoId, checkout }: MachineKnowledgeCheckout) => ["knowledge", "rules", repoId, checkout] as const;

export function useRuleFiles(scope: MachineKnowledgeCheckout, { events, csrfToken, reportDataError }: ControlConnection) {
  const client = useQueryClient();
  const options = queryOptions(events);
  const query = useQuery({
    ...options, placeholderData: undefined, queryKey: rulesKey(scope),
    queryFn: ({ signal }) => getRuleFiles(scope, signal),
    refetchInterval: ({ state }) => state.data?.updatingSince ? 500 : options.refetchInterval,
  });
  useEffect(() => {
    if (query.error) reportDataError(query.error);
  }, [query.error, reportDataError]);
  const refresh = useMutation({
    networkMode: "always", retry: false,
    mutationFn: (input: MachineKnowledgeCheckout) => postRuleRefresh(input, { csrfToken, idempotencyKey: crypto.randomUUID() }),
    onSuccess: async (rules, input) => {
      const queryKey = rulesKey(input);
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, rules);
    },
    onError: reportDataError,
  });
  return { query, refresh: refresh.mutateAsync };
}

export function liveBriefPreview({ csrfToken, reportDataError }: ControlConnection): KnowledgeToolsPreview["previewBrief"] {
  return async (input, signal) => {
    try { return await postBriefPreview(input, { csrfToken, idempotencyKey: crypto.randomUUID() }, signal); }
    catch (error) {
      if (!signal.aborted) reportDataError(error);
      throw new Error(error instanceof HubProblemError && error.problem?.detail || "Couldn’t preview the brief. Try again.");
    }
  };
}

function useResetChangedCursor<T>(queryKey: QueryKey, error: unknown) {
  const client = useQueryClient();
  useEffect(() => {
    if (!(error instanceof HubProblemError) || error.problem?.code !== "KNOWLEDGE_CHANGED") return;
    // Keep the first screenful in place while reading a new first page.
    client.setQueryData<InfiniteData<T>>(queryKey, (previous) => previous && {
      pages: previous.pages.slice(0, 1), pageParams: [undefined],
    });
    void client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
  }, [client, error, queryKey]);
}

export function useKnowledgePage(params: KnowledgeFilters, events: HubEventState, enabled = true) {
  const queryKey = [...key, "list", params];
  const query = useInfiniteQuery({
    ...queryOptions(events), placeholderData: undefined, enabled, queryKey,
    queryFn: ({ pageParam, signal }) => getKnowledgePage(params, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  useResetChangedCursor(queryKey, query.error);
  return query;
}

export function useKnowledgeLanding(repo: string | undefined, events: HubEventState, enabled = true) {
  return useQuery({
    ...queryOptions(events), placeholderData: undefined, enabled, queryKey: [...key, "landing", repo],
    queryFn: ({ signal }) => getKnowledgeLanding(repo, signal),
  });
}

export function useKnowledgeItem(key: string | undefined, events: HubEventState) {
  return useQuery({
    ...queryOptions(events), placeholderData: undefined, enabled: key !== undefined, queryKey: detailKey(key),
    queryFn: ({ signal }) => getKnowledgeItem(key!, signal),
  });
}

export function useForgotten(repo: string | undefined, events: HubEventState, enabled = true) {
  const queryKey = [...key, "forgotten", repo];
  const query = useInfiniteQuery({
    ...queryOptions(events), placeholderData: undefined, enabled, queryKey,
    queryFn: ({ pageParam, signal }) => getForgotten(repo, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  useResetChangedCursor(queryKey, query.error);
  return query;
}

type WriteResult = KnowledgeCreateResult | KnowledgeEditResult | KnowledgeForgetResult;
type WriteRequest<T, R> = (input: T, headers: { csrfToken: string; idempotencyKey: string }) => Promise<R>;

function useKnowledgeMutation<T, R extends WriteResult>(
  post: WriteRequest<T, R>, csrfToken: string, reportDataError: (error: unknown) => void,
) {
  const client = useQueryClient();
  const { mutateAsync } = useMutation({
    mutationFn: async ({ input, onRetry }: { input: T; onRetry?: () => void }) => {
      const headers = { csrfToken, idempotencyKey: crypto.randomUUID() };
      return retryKnowledgeBusy(() => post(input, headers), onRetry);
    },
    networkMode: "always",
    retry: false,
    onSuccess: (reply) => {
      if (reply.type === "preview") return;
      const current = reply.type === "conflict" ? reply.current : "text" in reply.item ? reply.item : undefined;
      if (current) client.setQueryData(detailKey(current.key), current);
      void client.invalidateQueries({ queryKey: key });
    },
    onError: reportDataError,
  });
  return (input: T, onRetry?: () => void) => mutateAsync({ input, onRetry });
}

export function useKnowledgeActions(csrfToken: string, reportDataError: (error: unknown) => void): KnowledgeActions {
  return {
    createNote: useKnowledgeMutation(postNote, csrfToken, reportDataError),
    editNote: useKnowledgeMutation(postKnowledgeEdit, csrfToken, reportDataError),
    forgetItem: useKnowledgeMutation(postKnowledgeForget, csrfToken, reportDataError),
  };
}
