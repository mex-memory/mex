/**
 * The offer slot on the first screen: one paid question (learning-03 registers
 * "learn deeper" here). Empty in beta.1. A person at a terminal is asked; an
 * agent or a script gets one line with the exact command and nothing paid
 * starts, so the offer stays due and the next `mex` at a terminal asks.
 */
import { writeFileSync } from "node:fs";
import { SESSION_LEARNING_UNAVAILABLE } from "../knowledge/session-learning.js";
import { producer } from "../knowledge/producers.js";
import { sessionImportDue } from "../filter/import-offer.js";

export interface OfferContext { projectId: string; root: string; }
export interface Offer {
  id: string;
  /** The question, as one line. */
  question: string;
  /** What it costs, said plainly ("about $0.40, measured on similar repos"). */
  estimate: string;
  /** The exact command that starts it, for agents and scripts. */
  command: string;
  paid: true;
  /** Holds the slot until the real offer registers under the same id. */
  reserved?: true;
  due(context: OfferContext): boolean;
  start(context: OfferContext, write?: (line: string) => void): Promise<string>;
}

const offers: Offer[] = [];
export function registerOffer(offer: Offer): void {
  const at = offers.findIndex(item => item.id === offer.id);
  if (at < 0) offers.push(offer);
  else if (offers[at]!.reserved && !offer.reserved) offers[at] = offer;
}
export function dueOffer(context: OfferContext): Offer | undefined {
  return offers.find(offer => { try { return offer.due(context); } catch { return false; } });
}

/**
 * The reserved offer becomes a preview when the import producer is active.
 */
registerOffer({
  id: "session-learn", question: "Preview past sessions for learning?", estimate: "the preview is free and shows the expected use before approval",
  command: "mex learn --sessions", paid: true, reserved: true,
  due: context => producer("session-import").active && sessionImportDue(context),
  start: async (context, write = console.log) => {
    if (!producer("session-import").active) return SESSION_LEARNING_UNAVAILABLE;
    const { offerSessionImport } = await import("../filter/import-offer.js");
    await offerSessionImport({ ...context, write, interactive: true });
    return "";
  },
});

/** Test-only: a fake paid offer whose start writes the file MEX_TEST_FAKE_OFFER names. */
const fake = process.env.MEX_TEST_FAKE_OFFER;
if (fake) {
  registerOffer({
    id: "test-fake", question: "Learn this repo more deeply from its history?", estimate: "about $0.10 (test)",
    command: "mex test-fake-offer --start", paid: true,
    due: () => true,
    start: async () => { writeFileSync(fake, "started\n"); return "Started the test offer."; },
  });
}
