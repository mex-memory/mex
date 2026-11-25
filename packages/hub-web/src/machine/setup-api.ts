import {
  MachineSetupAnswerResultSchema, MachineSetupLearningSchema, MachineSetupSavedSchema, MachineSetupSnapshotSchema, MachineSetupStepSchema,
} from "@mex/hub-contracts/machine";
import { requestJson } from "./api";

export function getSetup(repo: string | undefined, signal: AbortSignal) {
  return requestJson(repo ? `/setup?${new URLSearchParams({ repo })}` : "/setup", MachineSetupSnapshotSchema, { signal });
}

export function setupActions(repo: string, csrfToken: string) {
  const path = "/setup/" + encodeURIComponent(repo) + "/";
  const post = <T,>(action: string, schema: { parse(value: unknown): T }, body: unknown, key: string, signal?: AbortSignal) =>
    requestJson(path + action, schema, {
      method: "POST", headers: { "content-type": "application/json", "x-mex-csrf": csrfToken, "Idempotency-Key": key },
      body: JSON.stringify(body), timeoutMs: action === "quote" || action === "learn" ? 45_000 : 14_000, signal,
    });
  return {
    quote: (expectedRevision: string, key: string, signal: AbortSignal) => post("quote", MachineSetupLearningSchema, { expectedRevision }, key, signal),
    learn: (quoteRevision: string, key: string) => post("learn", MachineSetupStepSchema, { quoteRevision }, key),
    skip: (quoteRevision: string, key: string) => post("skip-learning", MachineSetupSavedSchema, { quoteRevision }, key),
    step: (id: string, action: string, expectedRevision: string, key: string) =>
      post("steps/" + encodeURIComponent(id), MachineSetupStepSchema, { action, expectedRevision }, key),
    answer: (request: unknown, key: string) => post("questions", MachineSetupAnswerResultSchema, request, key),
  };
}
