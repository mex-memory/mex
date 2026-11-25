import { MachineReviewActionRequestSchema, type MachineReviewActionRequest, type MachineReviewActionResponse, type MachineReviewCard, type MachineReviewPreviewReply } from "@mex/hub-contracts/machine";
import { repositoryPolicy, type RepositoryPolicy } from "../../filter/repository.js";
import { hash } from "../../judge/evidence.js";
import { recordChecks } from "../../judge/native.js";
import { KnowledgeError } from "../../knowledge/entry.js";
import { queueNativeRebuild } from "../../knowledge/native-queue.js";
import { openRecord, openRecordReadOnly, recordLocation } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { reviewAction, type ReviewAction, type ReviewDependencies } from "../../review/actions.js";
import { groupRevision } from "../../review/queue.js";
import type { HomeData } from "./home.js";
import { knowledgeWriteProblem } from "./knowledge-writes.js";
import { readKnowledgeEntry } from "./knowledge-detail.js";
import { registeredCheckout } from "./knowledge-snapshot.js";
import { activeCheckouts, knowledgeKey, readStore } from "./read.js";
import { invalidReview, parseReviewKey, readReviewCard, reviewMissing, type ReviewDetail } from "./review.js";
import { ReviewPreviews, type Confirmation, type ReviewTarget } from "./review-previews.js";
import { reviewOutcome } from "./review-outcome.js";
import { reviewLimits } from "./review-snapshot.js";
import { HubRequestError } from "./security.js";

type Preview = MachineReviewPreviewReply["preview"];
type Check = Preview["checks"][number];
type Applied = Extract<MachineReviewActionResponse, { type: "applied" }>;
type Request = MachineReviewActionRequest;
type Action = Request["action"];
const MAX_ACTIVE = 2;
const REPOSITORY_BLOCKED = "Couldn't check the repository. Sharing needs GitHub access (gh).";

function targetFor({ card, group, checkout }: ReviewDetail): ReviewTarget {
  return { repoId: card.repoId, cardId: card.cardId, checkout, entryId: group.entry.mex.id, groupRevision: groupRevision(group) };
}

const privacyCheck: Check = { id: "secrets", status: "pass", label: "No secrets or private data found" };
function repositoryCheck(policy: RepositoryPolicy | undefined): Check {
  if (!policy?.authorized || policy.visibility === "unknown") return { id: "repository", status: "fail", label: REPOSITORY_BLOCKED };
  return policy.visibility === "public"
    ? { id: "repository", status: "warn", label: "Repository is public: session-based rules need your approval" }
    : { id: "repository", status: "pass", label: "Repository is private" };
}

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
  #previews: ReviewPreviews;
  constructor(
    private readonly data: HomeData, private readonly location: LocationOptions, private readonly now: () => number,
    private readonly env: NodeJS.ProcessEnv | undefined, private readonly dependencies: Partial<ReviewDependencies> | undefined,
    private readonly changed: (repoId: string, knowledgeChanged: boolean) => Promise<void>,
  ) { this.#previews = new ReviewPreviews(now); }

  async run(key: string, action: string, body: unknown, session: string): Promise<Applied | MachineReviewPreviewReply> {
    const { repoId, cardId } = parseReviewKey(key);
    const request = parseRequest(action, body);
    if (this.#active.has(repoId) || this.#active.size >= MAX_ACTIVE) {
      throw new HubRequestError(503, "MEX_BUSY", "MEX is busy", "MEX is busy. Try again in a moment.");
    }
    this.#active.add(repoId);
    try {
      const confirmation = this.#previews.get(session, key, request);
      let detail: ReviewDetail;
      try { detail = await readReviewCard(this.data, this.location, key, this.now(), this.env); }
      catch (error) {
        // Share can recover the exact pending publication even when its output
        // replaced the file that used to make the card eligible.
        if (error instanceof HubRequestError && error.status === 404 && request.action === "share" && confirmation
          && this.#activeCheckout(confirmation.target)) return await this.#share(request, session, key, confirmation.target, confirmation);
        throw error;
      }
      if (request.expectedRevision !== detail.card.revision) throw stale(detail.card);
      if (!detail.card.actions.includes(request.action)) throw invalidReview("This action isn’t available for the card.");
      if (request.apply && !confirmation) throw stale(detail.card);
      if (request.action === "use") return await this.#use(detail, request, session, key, confirmation);
      if (request.action === "share") return await this.#share(request, session, key, targetFor(detail), confirmation);
      if (request.action === "edit" && request.then === "share") return await this.#editedShare(detail, request);
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

  #activeCheckout({ repoId, checkout }: ReviewTarget) {
    return readStore(openRecordReadOnly, this.location, (reader) => reader && registeredCheckout(reader, repoId, checkout)
      && activeCheckouts(reader, repoId, this.now()).includes(checkout));
  }

  #call(target: ReviewTarget, action: ReviewAction, request: Request, expect?: string, overrides?: Partial<ReviewDependencies>) {
    const { checkout } = target;
    const edited = action === "edit" ? request.edited : undefined;
    const fields = edited && { oneLine: edited.claim, kind: edited.kind, scope: edited.scope };
    return reviewAction(target.cardId, action, { ...this.location, projectPath: checkout, env: this.env },
      { text: edited?.text, fields, apply: Boolean(expect), expect }, { ...this.dependencies, ...overrides, clock: this.now },
      { allCards: true, expectedGroupRevision: target.groupRevision, limits: reviewLimits });
  }

  #sharePath(target: ReviewTarget, diff: string) {
    const shown = /^diff --git a\/(\.mex\/learned\/[^\n]+) b\/\1\n/u.exec(diff)?.[1];
    const { repoId, checkout, entryId } = target;
    if (shown) return shown;
    // An unchanged team file has an empty diff. Its existing path can be nested.
    const { home } = recordLocation({ ...this.location, create: false });
    const existing = readStore(openRecordReadOnly, this.location, (reader) => {
      if (!reader) return;
      try {
        return readKnowledgeEntry(reader, { ...this.location, home, repoId, checkout }, { repoId, id: entryId, audience: "team" }, this.now()).path;
      } catch { /* A new rule uses the team store's default path. */ }
    });
    return existing ?? `.mex/learned/${entryId}.md`;
  }

  async #share(request: Request, session: string, key: string, target: ReviewTarget, confirmation?: Confirmation): Promise<Applied | MachineReviewPreviewReply> {
    let policy: RepositoryPolicy | undefined;
    const checkRepository = this.dependencies?.repository ?? repositoryPolicy;
    const checkCode = this.dependencies?.recordChecks ?? recordChecks;
    const overrides: Partial<ReviewDependencies> = {
      repository: async (checkout) => {
        try { policy = await checkRepository(checkout); } catch { policy = undefined; }
        // Unknown visibility needs a fresh successful lookup in the Hub, even
        // when the CLI could establish write authority through a merged PR.
        return policy?.authorized && policy.visibility !== "unknown" ? policy : { visibility: "unknown", authorized: false };
      },
      recordChecks: async (...args) => {
        try { return await checkCode(...args); }
        catch { throw new KnowledgeError("CHECKS_CHANGED", "The checks couldn’t run. Try again from this checkout."); }
      },
    };
    let result: Awaited<ReturnType<typeof reviewAction>>;
    try { result = await this.#call(target, "share", request, confirmation?.expect, overrides); }
    catch (error) {
      const repo = repositoryCheck(policy);
      if (error instanceof KnowledgeError && (error.code === "TEAM_AUTHORITY" || policy && repo.status === "fail")) {
        return { preview: { diff: "", path: confirmation?.path ?? this.#sharePath(target, ""), checkout: target.checkout, revision: "blocked",
          checks: [privacyCheck, repo, { id: "checks", status: "warn", label: "Checks need a verified repository." }] } };
      }
      if (error instanceof KnowledgeError && ["CHECKS_REQUIRED", "CHECKS_CHANGED"].includes(error.code)) {
        if (request.apply) throw new KnowledgeError("STALE_PREVIEW", error.message);
        return { preview: { diff: "", path: this.#sharePath(target, ""), checkout: target.checkout, revision: "blocked",
          checks: [privacyCheck, repo, { id: "checks", status: "fail", label: error.message }] } };
      }
      throw error;
    }
    const { diff, revision: expect } = result.preview;
    const path = confirmation?.path ?? this.#sharePath(target, diff);
    const { checkout, repoId, entryId } = target;
    if (result.applied) {
      // The CLI publishes only the reviewed team file on Share.
      await this.changed(repoId, true);
      return { type: "applied", outcome: "shared", toast: "Shared to " + path, knowledgeKey: knowledgeKey(repoId, "team", entryId) };
    }
    const revision = this.#previews.remember(session, key, request, { target, expect, path });
    return { preview: { diff, path, checkout, revision, checks: [privacyCheck, repositoryCheck(policy), {
      id: "checks", status: "pass", label: "Checks still hold",
    }] } };
  }

  async #editedShare(detail: ReviewDetail, request: Request): Promise<MachineReviewPreviewReply> {
    const target = targetFor(detail);
    await this.#call(target, "edit", request);
    return { preview: { diff: "", path: this.#sharePath(target, ""), checkout: target.checkout, revision: "blocked",
      checks: [privacyCheck, { id: "repository", status: "warn", label: "The repository check runs when the rule is ready to share." },
        { id: "checks", status: "fail", label: "Keep this correction for you and record its checks before sharing." }] } };
  }

  #recordConsent(target: ReviewTarget, action: "use" | "retire", revision: string) {
    const writer = openRecord(this.location);
    try {
      writer.db.prepare("INSERT OR IGNORE INTO settings(scope,key,value) VALUES(?,?,?)").run(
        target.repoId, "hub.review.consent." + hash(JSON.stringify([target.cardId, action, revision])).slice(7),
        JSON.stringify({ version: 1, source: "from the Hub", cardId: target.cardId, action, cost: 0, at: new Date(this.now()).toISOString() }),
      );
    } finally { writer.close(); }
  }

  async #use(detail: ReviewDetail, request: Request, session: string, key: string, confirmation?: Confirmation): Promise<Applied | MachineReviewPreviewReply> {
    const disabled = detail.card.disabled?.use;
    if (disabled || (confirmation && confirmation.effectsRevision !== detail.effectsRevision)) {
      if (request.apply) throw stale(detail.card);
      throw invalidReview(disabled ?? "Open the proposal again.");
    }
    const target = targetFor(detail);
    const knowledge = knowledgeKey(target.repoId, "onlyYou", target.entryId);
    if (!confirmation) {
      const { preview } = await this.#call(target, "use", request);
      const path = `personal/notes/${target.entryId}.md`;
      const revision = this.#previews.remember(session, key, request, {
        target, expect: preview.revision, path, effectsRevision: detail.effectsRevision,
      });
      return { preview: {
        diff: preview.diff, path, checkout: target.checkout, revision, checks: [],
        effects: { save: { key: knowledge, claim: detail.card.claim, audience: "onlyYou" }, retire: detail.retires, cost: 0 },
      } };
    }
    this.#recordConsent(target, "use", confirmation.expect);
    await this.#call(target, "use", request, confirmation.expect);
    queueNativeRebuild(target.checkout, {}, this.location);
    await this.changed(target.repoId, true);
    const count = detail.retires.length;
    return {
      type: "applied", outcome: "used", knowledgeKey: knowledge,
      toast: count ? `Proposal used. ${count} ${count === 1 ? "note" : "notes"} retired.` : "Proposal saved for you",
    };
  }

  async #decide(detail: ReviewDetail, request: Request): Promise<Applied> {
    const { action } = request;
    if (action !== "keep" && action !== "keepCurrent" && (action !== "edit" || request.then !== "keep")) {
      throw invalidReview("Choose an available action for this card.");
    }
    const service = action === "edit" ? "edit" : "keep";
    const target = targetFor(detail);
    const { preview } = await this.#call(target, service, request);
    await this.#call(target, service, request, preview.revision);
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
