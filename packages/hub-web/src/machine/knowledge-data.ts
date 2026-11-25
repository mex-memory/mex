import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";
import { HubProblemError } from "./api";
import { queryOptions, type HubEventState } from "./data";
import { getForgotten, getKnowledgeItem, getKnowledgeLanding, getKnowledgePage, postKnowledgeEdit, postKnowledgeForget, postNote } from "./knowledge-api";
import type { KnowledgeActions, KnowledgeCreateResult, KnowledgeEditResult, KnowledgeFilters, KnowledgeForgetResult } from "./types";

const key = ["knowledge"];
const detailKey = (key: string | undefined) => ["knowledge", "item", key] as const;

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
      try { return await post(input, headers); }
      catch (error) {
        if (!(error instanceof HubProblemError) || error.status !== 503 || error.problem?.code !== "MEX_BUSY") throw error;
        onRetry?.();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
        return post(input, headers);
      }
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
