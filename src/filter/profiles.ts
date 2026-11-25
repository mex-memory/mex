import manifest from "../../native/internal/captureprofile/profiles.json";

export type CaptureAgent = keyof typeof manifest;
export type TranscriptAgent = "claude" | "codex" | "copilot" | "cursor" | "gemini" | "devin";
interface CaptureProfile {
  typed: "hook" | "plugin" | "none";
  transcript: TranscriptAgent | null;
  cache: boolean;
  outside: "none" | "transcript" | "hook" | "transcript-and-hook";
  choices: boolean;
  memory: boolean;
  finish: "session-end" | "idle" | "none";
}

export const captureProfiles: Readonly<Record<CaptureAgent, CaptureProfile>> = manifest as Record<CaptureAgent, CaptureProfile>;

export function captureAgent(value: string): value is CaptureAgent {
  return Object.hasOwn(captureProfiles, value);
}

export function typedCapture(value: string): value is CaptureAgent {
  return captureAgent(value) && captureProfiles[value].typed !== "none";
}
