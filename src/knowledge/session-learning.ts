/**
 * Reserved places for learning from past sessions, which this version does not
 * ship: the setting `learning.sessions`, the job kind `session-learn` and the
 * first-screen offer. Each stays closed while no session producer is active,
 * so the feature plugs in later without touching their callers.
 */
import { producer } from "./producers.js";
import { randomUUID } from "node:crypto";
import type { RecordWriter } from "../record/index.js";

export const SESSION_PRODUCERS = ["session-import", "session-ongoing"] as const;
export const SESSION_LEARN_KIND = "session-learn";
export const SESSION_LEARNING_SETTING = "learning.sessions";
export const SESSION_RUNNER_SETTING = "learning.runner";
export const SESSION_LEARNING_UNAVAILABLE = "Learning from past sessions isn't available in this version yet; nothing changed.";
export const SESSION_RUNNER_WAIT = "Waiting: choose a session learning runner with `mex learn --runner`.";

export const SESSION_RUNNERS = ["cli", "api", "none"] as const;
export type SessionRunnerMode = typeof SESSION_RUNNERS[number];
export interface SessionRunner { mode: SessionRunnerMode; revision: string; }
type Settings = Parameters<typeof sessionLearningOn>[0];

export function sessionRunner(store: Settings): SessionRunner | undefined {
  try {
    const raw = store.setting("global", SESSION_RUNNER_SETTING);
    if (!raw || raw.length > 128) return;
    const value = JSON.parse(raw) as Partial<SessionRunner>;
    if (value && SESSION_RUNNERS.includes(value.mode!) && typeof value.revision === "string"
      && /^[0-9a-f-]{36}$/u.test(value.revision)) return { mode: value.mode!, revision: value.revision };
  } catch { /* An unreadable setting cannot grant consent. */ }
}

export function setSessionRunner(writer: RecordWriter, mode: SessionRunnerMode): SessionRunner {
  if (!sessionLearningAvailable()) throw new Error(SESSION_LEARNING_UNAVAILABLE);
  if (!SESSION_RUNNERS.includes(mode)) throw new Error("Choose cli, api or none for session learning.");
  const preference = { mode, revision: randomUUID() };
  writer.db.prepare("INSERT INTO settings VALUES('global',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
    .run(SESSION_RUNNER_SETTING, JSON.stringify(preference));
  return preference;
}

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

export function importLearningOn(store: Settings): boolean {
  // Past sessions require their own preview and approval. The global off switch can still revoke it.
  return producer("session-import").active && store.setting("global", SESSION_LEARNING_SETTING) !== "off";
}
