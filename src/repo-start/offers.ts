/**
 * The offer slot on the first screen: one paid question (learning-03 registers
 * "learn deeper" here). Empty in beta.1. A person at a terminal is asked; an
 * agent or a script gets one line with the exact command and nothing paid
 * starts, so the offer stays due and the next `mex` at a terminal asks.
 */
import { writeFileSync } from "node:fs";
import { SESSION_LEARNING_UNAVAILABLE, sessionLearningAvailable } from "../knowledge/session-learning.js";

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
  start(context: OfferContext): Promise<string>;
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
 * Reserved: learning from past sessions. Never due while no session producer
 * is active, so it stays hidden until a later version registers one.
 */
registerOffer({
  id: "session-learn", question: "Learn from your past sessions?", estimate: "the cost is shown before anything starts",
  command: "mex config set learning.sessions on", paid: true, reserved: true,
  due: () => sessionLearningAvailable(),
  start: async () => SESSION_LEARNING_UNAVAILABLE,
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
