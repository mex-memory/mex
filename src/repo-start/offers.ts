/**
 * The offer slot on the first screen: one paid question (learning-03 registers
 * "learn deeper" here). Empty in beta.1. A person at a terminal is asked; an
 * agent or a script gets one line with the exact command and nothing paid
 * starts, so the offer stays due and the next `mex` at a terminal asks.
 */
import { writeFileSync } from "node:fs";

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
  due(context: OfferContext): boolean;
  start(context: OfferContext): Promise<string>;
}

const offers: Offer[] = [];
export function registerOffer(offer: Offer): void {
  if (offers.some(item => item.id === offer.id)) return;
  offers.push(offer);
}
export function dueOffer(context: OfferContext): Offer | undefined {
  return offers.find(offer => { try { return offer.due(context); } catch { return false; } });
}

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
