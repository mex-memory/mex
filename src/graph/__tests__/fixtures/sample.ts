// Fixture for the extractor test harness. It lives in an excluded `fixtures/`
// dir (see tsconfig) so it is NOT type-checked — it only needs to PARSE, which
// lets it reference symbols from "other files" the way real code does.

import { formatName } from "./helpers";

const PREFIX = "hello";

/** Greets a user by name. */
export function greet(name: string): string {
  return formatName(name);
}

export class Greeter extends Base implements Speaker {
  greeting = PREFIX;
  onReady = () => { greet("world"); };

  speak(name: string): string {
    const w = new Warmup();
    return greet(name);
  }
}

export const makeGreeter = () => new Greeter();
