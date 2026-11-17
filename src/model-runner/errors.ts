export type ModelFailure = "launch" | "arguments" | "authentication" | "usage_limit" | "failed" | "protocol" | "cancelled" | "timeout" | "prompt" | "output";

/** No raw child text, private prompt, account detail or local path in failures. */
export class ModelRunError extends Error {
  constructor(readonly category: ModelFailure, readonly tool?: string, readonly resetTime?: string) {
    super({ launch: "The model command could not start.", arguments: "The model command rejected its arguments.",
      authentication: "Sign in to the selected agent CLI before retrying.", usage_limit: "The selected agent reached its usage limit.",
      failed: "The model command failed.", protocol: "The model command did not return a complete result.",
      cancelled: "The model command was cancelled.", timeout: "The model command reached its time limit.",
      prompt: "The model prompt exceeds its limit.", output: "The model result exceeds its limit." }[category]);
    this.name = "ModelRunError";
  }
}
