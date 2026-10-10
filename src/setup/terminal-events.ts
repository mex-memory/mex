const MAX_EVENTS = 64;
const MAX_EVENT_CHARS = 1_024;
const MAX_HISTORY_CHARS = 16_384;

/** Checkout/process-local activity; old events expire at deterministic bounds. */
export function appendTerminalSetupEvent(history: readonly string[], message: string): readonly string[] {
  const entry = message.slice(0, MAX_EVENT_CHARS);
  if (!entry || entry === history.at(-1)) return history;
  const next = [...history, entry].slice(-MAX_EVENTS);
  let size = next.reduce((total, value) => total + value.length, 0);
  while (size > MAX_HISTORY_CHARS) size -= next.shift()!.length;
  return next;
}
