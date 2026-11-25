// The snapshot and Standard text rates are from the provider's model page.
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
export const SESSION_API_AGENT = "openai-api";
export const SESSION_API_MODEL = "gpt-5.4-mini-2026-03-17";
export const SESSION_API_KEY = "MEX_SESSION_API_KEY";
export const SESSION_API_RATES = { input: 750, cache_write: 750, cache_read: 75, output: 4500 };
export const SESSION_API_DAILY_UNITS = 250_000_000;
export const SESSION_API_KEY_WAIT = `Waiting: make ${SESSION_API_KEY} available to the MEX worker.`;
export const SESSION_API_AUTH_WAIT = "Waiting: replace the session learning API key and resume the job.";
export const SESSION_API_LIMIT_WAIT = "Waiting: the API provider reached its limit. Resume the job when it resets.";
export const SESSION_API_CAP_WAIT = "Waiting: the daily session learning API allowance is used up.";

export function sessionApiKey(): string | undefined {
  const key = process.env[SESSION_API_KEY];
  return key && /^[A-Za-z0-9_-]{20,512}$/u.test(key) ? key : undefined;
}
