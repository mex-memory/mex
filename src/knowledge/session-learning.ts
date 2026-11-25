/**
 * Reserved places for learning from past sessions, which this version does not
 * ship: the setting `learning.sessions`, the job kind `session-learn` and the
 * first-screen offer. Each stays closed while no session producer is active,
 * so the feature plugs in later without touching their callers.
 */
import { producer } from "./producers.js";

export const SESSION_PRODUCERS = ["session-import", "session-ongoing"] as const;
export const SESSION_LEARN_KIND = "session-learn";
export const SESSION_LEARNING_SETTING = "learning.sessions";
export const SESSION_LEARNING_UNAVAILABLE = "Learning from past sessions isn't available in this version yet; nothing changed.";

/** True once a session producer is registered as active. */
export function sessionLearningAvailable(): boolean {
  return SESSION_PRODUCERS.some(id => producer(id).active);
}

/** Why a value can't be set, checked before the record is opened so a refusal changes nothing. */
export function sessionLearningRefusal(value: string): string | undefined {
  if (value !== "on" && value !== "off") return `Use on or off for ${SESSION_LEARNING_SETTING}.`;
  if (value === "on" && !sessionLearningAvailable()) return SESSION_LEARNING_UNAVAILABLE;
  return undefined;
}

/** Default off: only an explicit on counts. */
export function sessionLearningOn(store: { setting(scope: string, key: string): string | undefined }): boolean {
  return sessionLearningAvailable() && store.setting("global", SESSION_LEARNING_SETTING) === "on";
}

export function ongoingLearningOn(store: Parameters<typeof sessionLearningOn>[0]): boolean {
  return producer("session-ongoing").active && sessionLearningOn(store) && store.setting("global", "learning.statements") === "on";
}
