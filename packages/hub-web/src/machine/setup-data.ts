import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { MachineRepoSetup, MachineSetupQuestion, MachineSetupSnapshot, MachineSetupStep } from "@mex/hub-contracts/machine";
import { HubProblemError } from "./api";
import { queryOptions, type ControlConnection } from "./data";
import { knowledgeSaveError, retryKnowledgeBusy, useKnowledgeWrite } from "./knowledge-write-state";
import { getSetup, setupActions } from "./setup-api";
import type { SetupControls } from "./types";

export function useLiveSetup({ events, csrfToken, reportDataError }: ControlConnection, repoId?: string) {
  const client = useQueryClient();
  const key = ["setup", repoId] as const;
  const query = useQuery({
    queryKey: key, queryFn: ({ signal }) => getSetup(repoId, signal),
    ...queryOptions(events), placeholderData: undefined, refetchIntervalInBackground: false,
  });
  const raw = query.data?.repo;
  const api = setupActions(repoId ?? "", csrfToken);
  const offerRevision = raw?.offerRevision;
  const quoteKey = ["setup-quote", repoId, offerRevision] as const;
  const quote = useQuery({
    queryKey: quoteKey, enabled: !!repoId && !!offerRevision,
    queryFn: ({ signal }) => {
      const request = crypto.randomUUID();
      return retryKnowledgeBusy(() => api.quote(offerRevision!, request, signal));
    },
    staleTime: 4 * 60_000, networkMode: "always", retry: false,
  });
  useEffect(() => {
    if (query.error) reportDataError(query.error);
    if (quote.error) reportDataError(quote.error);
  }, [query.error, quote.error, reportDataError]);

  const write = useKnowledgeWrite();
  const [feedback, setFeedback] = useState<string>();
  const [answered, setAnswered] = useState<{ checkout: string; questions: MachineSetupQuestion[] }>();
  const offer = raw?.learnDeeper ?? (offerRevision
    ? quote.data ?? (quote.isError ? { state: "unavailable" as const, reason: "The learning estimate couldn’t be prepared." } : undefined)
    : undefined);
  const waiting = raw?.questions ?? [];
  const outcomes = raw && answered?.checkout === raw.checkout ? answered.questions : [];
  const repo = raw && { ...raw, learnDeeper: offer, questions: [
    ...waiting.filter(({ id }) => !outcomes.some(question => question.id === id)), ...outcomes,
  ] };

  function updateRepo(update: (value: MachineRepoSetup) => MachineRepoSetup) {
    client.setQueryData<MachineSetupSnapshot>(key, current => current?.repo && current.repo.checkout === raw?.checkout
      ? { ...current, repo: update(current.repo) } : current);
    void client.invalidateQueries({ queryKey: ["setup"], exact: false }, { cancelRefetch: false });
  }

  function apply<T>(save: (key: string) => Promise<T>, done: (result: T) => void) {
    setFeedback(undefined);
    const request = crypto.randomUUID();
    void write.run(onRetry => retryKnowledgeBusy(() => save(request), onRetry), done, error => {
      reportDataError(error);
      setFeedback(knowledgeSaveError(error, "Couldn’t save. Try again."));
      if (error instanceof HubProblemError && error.status === 409) {
        void client.invalidateQueries({ queryKey: key });
        void client.invalidateQueries({ queryKey: quoteKey });
      }
    });
  }

  function stepSaved(step: MachineSetupStep) {
    updateRepo(value => value.steps.some(({ jobId }) => jobId === step.jobId)
      ? { ...value, steps: value.steps.map(current => current.jobId === step.jobId ? step : current) }
      : { ...value, steps: [...value.steps, step], offerRevision: undefined, learnDeeper: undefined });
    void client.invalidateQueries({ queryKey: ["jobs"] });
  }

  function questionsSaved(result: { questions: MachineSetupQuestion[] }) {
    if (raw) setAnswered({ checkout: raw.checkout, questions: [...outcomes, ...result.questions] });
    updateRepo(value => ({ ...value, questions: value.questions.filter(q => !result.questions.some(({ id }) => id === q.id)) }));
  }

  const controls: SetupControls = {
    changeStep(id, action) {
      const revision = raw?.steps.find(({ jobId }) => jobId === id)?.revision;
      if (revision) apply(key => api.step(id, action, revision, key), stepSaved);
    },
    startLearning(_repo, accepted) {
      if (accepted.revision) apply(key => api.learn(accepted.revision!, key), stepSaved);
    },
    skipLearning() {
      const revision = offer?.state === "offered" ? offer.quote.revision : undefined;
      if (revision) apply(key => api.skip(revision, key), () => updateRepo(value => ({ ...value, offerRevision: undefined, learnDeeper: { state: "skipped" } })));
    },
    replyToQuestion(_repo, id, choice) {
      const revision = waiting.find(q => q.id === id)?.revision;
      if (revision) apply(key => api.answer({ action: "answer", question: { id, revision }, choice }, key), questionsSaved);
    },
    skipQuestions() {
      const questions = waiting.filter(({ id }) => !outcomes.some(q => q.id === id)).map(({ id, revision }) => ({ id, revision }));
      if (questions.length) apply(key => api.answer({ action: "skipAll", questions }, key), questionsSaved);
    },
  };
  return { query, repo, controls, pending: write.pending, feedback: write.status ?? feedback };
}
