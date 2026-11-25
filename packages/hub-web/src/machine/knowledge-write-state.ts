import { useRef, useState } from "react";
import { HubProblemError } from "./api";

export async function retryKnowledgeBusy<T>(save: () => T | Promise<T>, onRetry?: () => void): Promise<T> {
  try { return await save(); }
  catch (error) {
    if (!(error instanceof HubProblemError) || error.status !== 503 || error.problem?.code !== "MEX_BUSY") throw error;
    onRetry?.();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
    return save();
  }
}

export function knowledgeSaveError(error: unknown, fallback: string): string {
  if (error instanceof HubProblemError && error.problem) {
    if (error.problem.code === "MEX_BUSY") return "Couldn't save. Try again.";
    return error.problem.detail;
  }
  return fallback;
}

export function useKnowledgeWrite() {
  const inFlight = useRef(false);
  const [state, setState] = useState<"idle" | "saving" | "retrying">("idle");

  async function run<T>(save: (retry: () => void) => T | Promise<T>, success: (value: T) => void, failure: (error: unknown) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("saving");
    try { success(await save(() => setState("retrying"))); }
    catch (error) { failure(error); }
    finally {
      inFlight.current = false;
      setState("idle");
    }
  }

  return { run, pending: state !== "idle", status: state === "retrying" ? "MEX is busy, retrying…" : undefined };
}
