import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

// Long synchronous filesystem cases can otherwise start the next case before
// the worker receives acknowledgements for its previous runner updates.
// Native timers remain usable when a test installs fake global timers.
async function yieldToRunner(): Promise<void> {
  await setImmediate();
  await setImmediate();
}

beforeAll(yieldToRunner);
beforeEach(yieldToRunner);
afterEach(yieldToRunner);
afterAll(yieldToRunner);
