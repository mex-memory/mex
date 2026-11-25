import { MachineReviewActionRequestSchema, type MachineReviewActionRequest, type MachineReviewActionResponse, type MachineReviewCard } from "@mex/hub-contracts/machine";
import { KnowledgeError } from "../../knowledge/entry.js";
import { queueNativeRebuild } from "../../knowledge/native-queue.js";
import type { LocationOptions } from "../../record/location.js";
import { reviewAction, type ReviewAction, type ReviewDependencies } from "../../review/actions.js";
import { groupRevision } from "../../review/queue.js";
import type { HomeData } from "./home.js";
import { knowledgeWriteProblem } from "./knowledge-writes.js";
import { knowledgeKey } from "./read.js";
import { invalidReview, parseReviewKey, readReviewCard, reviewMissing, type ReviewDetail } from "./review.js";
import { reviewOutcome } from "./review-outcome.js";
import { reviewLimits } from "./review-snapshot.js";
import { HubRequestError } from "./security.js";

type Applied = Extract<MachineReviewActionResponse, { type: "applied" }>;
type Request = MachineReviewActionRequest;
type Action = Request["action"];
const MAX_ACTIVE = 2;

export class ReviewProblem extends HubRequestError {
  constructor(code: "STALE_PREVIEW" | "ALREADY_HANDLED", readonly extensions: Record<string, unknown> = {}) {
    const handled = code === "ALREADY_HANDLED";
    super(409, code, handled ? "Already handled elsewhere" : "This card changed",
      handled ? "This card was already handled elsewhere." : "Review the current card and open the preview again.");
  }
}

export function reviewWriteProblem(error: unknown): unknown {
  const mapped = knowledgeWriteProblem(error);
  if (mapped instanceof HubRequestError && mapped.code === "MEX_BUSY") return mapped;
  if (error instanceof KnowledgeError) {
    switch (error.code) {
      case "STORE_LIMIT": return invalidReview("Review reached its reading limit. Run mex review in this checkout.");
      case "INVALID_ENTRY": return invalidReview("Check the note text, claim, kind, and scope.");
      case "SECRET_FOUND": return invalidReview("The note contains a possible secret. Remove it and try again.");
      case "PROPOSAL_WITHHELD": return invalidReview("The proposal couldn’t be saved. Check its evidence in the terminal.");
      default: return invalidReview("The card’s inputs couldn’t be verified. Open Review again.");
    }
  }
  return error;
}

function parseRequest(action: string, body: unknown): Request {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalidReview("Provide a Review action and the revision you opened.");
  const parsed = MachineReviewActionRequestSchema.safeParse({ action, ...body });
  if (!parsed.success || parsed.data.action !== action || !/^sha256:[a-f0-9]{64}$/u.test(parsed.data.expectedRevision)) {
    throw invalidReview("Provide a valid Review action and the revision you opened.");
  }
  const { edited, then, apply, previewRevision, reason } = parsed.data;
  if ((action === "edit" ? !edited || !then : edited || then) || (action !== "retire" && reason)
      || (previewRevision && !apply) || ((action === "keep" || action === "keepCurrent" || then === "keep") && apply)) {
    throw invalidReview("Provide only the fields for this action.");
  }
  return parsed.data;
}

function stale(current?: MachineReviewCard) {
  return new ReviewProblem("STALE_PREVIEW", current ? { current } : undefined);
}

export class ReviewWrites {
  #active = new Set<string>();
  constructor(
    private readonly data: HomeData, private readonly location: LocationOptions, private readonly now: () => number,
    private readonly env: NodeJS.ProcessEnv | undefined, private readonly dependencies: Partial<ReviewDependencies> | undefined,
    private readonly changed: (repoId: string, knowledgeChanged: boolean) => Promise<void>,
  ) {}

  async run(key: string, action: string, body: unknown): Promise<Applied> {
    const { repoId, cardId } = parseReviewKey(key);
    const request = parseRequest(action, body);
    if (this.#active.has(repoId) || this.#active.size >= MAX_ACTIVE) {
      throw new HubRequestError(503, "MEX_BUSY", "MEX is busy", "MEX is busy. Try again in a moment.");
    }
    this.#active.add(repoId);
    try {
      const detail = await readReviewCard(this.data, this.location, key, this.now(), this.env);
      if (request.expectedRevision !== detail.card.revision) throw stale(detail.card);
      if (!detail.card.actions.includes(request.action)) throw invalidReview("This action isn’t available for the card.");
      return await this.#decide(detail, request);
    } catch (error) {
      const unavailable = error instanceof HubRequestError && error.status === 404;
      if (unavailable || error instanceof KnowledgeError && ["NOT_FOUND", "STALE_ENTRY", "STALE_PREVIEW"].includes(error.code)) {
        const outcome = reviewOutcome(this.location, repoId, cardId);
        if (outcome !== undefined) {
          await this.changed(repoId, true);
          throw new ReviewProblem("ALREADY_HANDLED", { outcome });
        }
        const current = await readReviewCard(this.data, this.location, key, this.now(), this.env).catch(() => undefined);
        if (unavailable && !current && !request.apply) throw reviewMissing();
        throw stale(current?.card);
      }
      throw error;
    } finally { this.#active.delete(repoId); }
  }

  #call(detail: ReviewDetail, action: ReviewAction, request: Request, expect?: string) {
    const { group, checkout } = detail;
    const edited = action === "edit" ? request.edited : undefined;
    const fields = edited && { oneLine: edited.claim, kind: edited.kind, scope: edited.scope };
    return reviewAction(group.id, action, { ...this.location, projectPath: checkout, env: this.env },
      { text: edited?.text, fields, apply: Boolean(expect), expect }, { ...this.dependencies, clock: this.now },
      { allCards: true, expectedGroupRevision: groupRevision(group), limits: reviewLimits });
  }

  async #decide(detail: ReviewDetail, request: Request): Promise<Applied> {
    const { action } = request;
    if (action !== "keep" && action !== "keepCurrent" && (action !== "edit" || request.then !== "keep")) {
      throw invalidReview("Choose an available action for this card.");
    }
    const service = action === "edit" ? "edit" : "keep";
    const { preview } = await this.#call(detail, service, request);
    await this.#call(detail, service, request, preview.revision);
    const { repoId, contradiction } = detail.card;
    queueNativeRebuild(detail.checkout, {}, this.location);
    await this.changed(repoId, action !== "keepCurrent");
    return {
      type: "applied", outcome: action === "keepCurrent" ? "keptCurrent" : "kept",
      toast: action === "keepCurrent" ? "Kept your current notes. The proposal was dismissed." : "Kept for you",
      knowledgeKey: contradiction?.current[0]?.key ?? knowledgeKey(repoId, "onlyYou", detail.group.entry.mex.id),
    };
  }
}
