import { useRef, useState } from "react";
import { HubProblemError } from "./api";

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
