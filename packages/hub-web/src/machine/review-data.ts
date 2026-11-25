import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { MachineReviewActionRequest, MachineReviewQueue } from "@mex/hub-contracts/machine";
import { HubProblemError } from "./api";
import { queryOptions, type HubEventState } from "./data";
import { retryKnowledgeBusy } from "./knowledge-write-state";
import { currentReviewCard, getReviewCard, getReviewQueue, postReviewAction, reviewProblem } from "./review-api";

const topic = ["review"];
const itemKey = (key: string | undefined) => [...topic, "card", key];

export function useReviewQueue(repo: string | undefined, events: HubEventState) {
  const client = useQueryClient();
  const queryKey = useMemo(() => [...topic, "queue", repo], [repo]);
  const query = useInfiniteQuery({
    ...queryOptions(events), placeholderData: undefined, queryKey,
    queryFn: ({ pageParam, signal }) => getReviewQueue(repo, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  useEffect(() => {
    if (!reviewProblem(query.error, "REVIEW_CHANGED")) return;
    client.setQueryData<InfiniteData<MachineReviewQueue>>(queryKey, (previous) => previous && {
      pages: previous.pages.slice(0, 1), pageParams: [undefined],
    });
    void client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
  }, [client, query.error, queryKey]);
  return query;
}

export function useReviewCard(key: string | undefined, events: HubEventState) {
  return useQuery({
    ...queryOptions(events), placeholderData: undefined, enabled: key !== undefined, queryKey: itemKey(key),
    queryFn: ({ signal }) => getReviewCard(key!, signal),
  });
}

export function useReviewActions(csrfToken: string, reportDataError: (error: unknown) => void) {
  const client = useQueryClient();
  const retries = useRef(new Map<string, string>());
  const { mutateAsync } = useMutation({
    mutationFn: ({ key, request, idempotencyKey, onRetry }: {
      key: string; request: MachineReviewActionRequest; idempotencyKey: string; onRetry?: () => void;
    }) => retryKnowledgeBusy(() => postReviewAction(key, request, { csrfToken, idempotencyKey }), onRetry),
    networkMode: "always",
    retry: false,
    onError: (error, { key }) => {
      const current = currentReviewCard(error);
      if (current?.key === key) client.setQueryData(itemKey(key), current);
      if (reviewProblem(error, "STALE_PREVIEW")) {
        void client.invalidateQueries({ queryKey: [...topic, "queue"] }, { cancelRefetch: false });
      }
      reportDataError(error);
    },
  });

  return async (key: string, request: MachineReviewActionRequest, onRetry?: () => void) => {
    const signature = JSON.stringify([key, request]);
    const prior = retries.current.get(signature);
    const idempotencyKey = prior ?? crypto.randomUUID();
    if (!prior) {
      if (retries.current.size >= 20) retries.current.delete(retries.current.keys().next().value!);
      retries.current.set(signature, idempotencyKey);
    }
    try {
      const result = await mutateAsync({ key, request, idempotencyKey, onRetry });
      retries.current.delete(signature);
      return result;
    } catch (error) {
      // A transport failure may have lost a successful reply. Keep its key.
      if (error instanceof HubProblemError && error.status < 500) retries.current.delete(signature);
      throw error;
    }
  };
}

export function useReviewRefresh() {
  const client = useQueryClient();
  return () => {
    for (const name of ["review", "home", "knowledge"]) {
      void client.invalidateQueries({ queryKey: [name] }, { cancelRefetch: false });
    }
  };
}
