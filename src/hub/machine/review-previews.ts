import { randomUUID } from "node:crypto";
import type { MachineReviewActionRequest } from "@mex/hub-contracts/machine";
import { hash } from "../../judge/evidence.js";

const TTL = 10 * 60_000;
const LIMIT = 128;

export interface ReviewTarget {
  repoId: string;
  cardId: string;
  checkout: string;
  entryId: string;
  groupRevision: string;
}

export interface Confirmation {
  target: ReviewTarget;
  expect: string;
  path: string;
  effectsRevision?: string;
}

function signature(session: string, key: string, { action, edited, then, expectedRevision, reason }: MachineReviewActionRequest) {
  return hash(JSON.stringify([session, key, action, edited, then, expectedRevision, reason]));
}

/** Only the exact action the browser previewed can spend its confirmation. */
export class ReviewPreviews {
  #pending = new Map<string, Confirmation & { signature: string; expires: number }>();
  constructor(private readonly now: () => number) {}

  remember(session: string, key: string, request: MachineReviewActionRequest, confirmation: Confirmation) {
    const token = randomUUID();
    for (const [id, { expires }] of this.#pending) if (expires <= this.now()) this.#pending.delete(id);
    if (this.#pending.size >= LIMIT) this.#pending.delete(this.#pending.keys().next().value!);
    this.#pending.set(token, { ...confirmation, signature: signature(session, key, request), expires: this.now() + TTL });
    return token;
  }

  get(session: string, key: string, request: MachineReviewActionRequest): Confirmation | undefined {
    const saved = request.previewRevision && this.#pending.get(request.previewRevision);
    return saved && saved.expires > this.now() && saved.signature === signature(session, key, request) ? saved : undefined;
  }
}
