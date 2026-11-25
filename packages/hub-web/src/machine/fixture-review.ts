import { useRef, useState } from "react";
import {
  MachineReviewActionRequestSchema,
  type MachineReviewActionRequest, type MachineReviewActionResponse, type MachineReviewCard, type MachineReviewQueue,
} from "@mex/hub-contracts/machine";
import { HubProblemError } from "./api";
import { reviewSnapshot } from "./fixture-review-data";
import { teamFile, unifiedDiff, type FixtureKnowledge } from "./fixture-knowledge";
import type { FixtureVariant } from "./fixtures";
import { retryKnowledgeBusy } from "./knowledge-write-state";
import type { KnowledgeDetail, ReviewDraft, ReviewHandled, ReviewPreview, ReviewWritePreview } from "./types";

const repositoryChecks = {
  storefront: { status: "passed", message: "Repository is private" },
  "design-kit": { status: "warning", message: "Repository is public: sessions-based rules need your approval" },
} as const;
const unknownRepository = { status: "blocked", message: "Couldn't check the repository. Sharing needs GitHub access (gh)" } as const;
const busy = new HubProblemError(503, {
  title: "MEX is busy.", code: "MEX_BUSY", status: 503, detail: "MEX is busy. Try again in a moment.", requestId: "review-fixture",
});
const stale = new HubProblemError(409, {
  title: "Review inputs changed.", code: "STALE_PREVIEW", status: 409,
  detail: "Review inputs changed. Open the preview again.", requestId: "review-fixture",
});

function sharingChecks(repoId: string): ReviewWritePreview["checks"] {
  const repository = repositoryChecks[repoId as keyof typeof repositoryChecks] ?? unknownRepository;
  return [
    { id: "privacy", status: "passed", message: "No secrets or private data found" },
    { id: "repository", ...repository },
    { id: "checks", status: "passed", message: "Checks still hold" },
  ];
}

function reviewNote(card: MachineReviewCard, fields: ReviewDraft, at: string, audience: "team" | "onlyYou"): KnowledgeDetail {
  const id = "mx_" + card.cardId.replaceAll("-", "");
  const checkout = card.sources.checkouts[0];
  const path = ".mex/learned/" + id + ".md";
  return {
    id, repoId: card.repoId, audience, key: [card.repoId, audience, id].join(":"),
    oneLine: fields.claim, kind: fields.kind, scope: fields.scope, text: fields.text,
    revision: "r1", status: audience === "team" ? "upToDate" : "notChecked",
    source: audience === "team" ? { type: "team", path, checkout } : { type: "note", at, via: "hub", edited: fields !== card },
    checkout, lastUsedAt: null, checks: [], useCount30Days: 0, history: [{ type: "added", at }],
  };
}

export function useFixtureReview(
  initial: MachineReviewQueue | undefined, knowledge: FixtureKnowledge, variant: FixtureVariant,
): ReviewPreview {
  const [queue, setQueue] = useState(initial);
  const current = useRef(initial);
  const completed = useRef(new Map<string, ReviewHandled>());
  const sequence = useRef(0);
  const previews = useRef(new Map<string, { signature: string; preview: ReviewWritePreview; at: string }>());
  const busyAttempts = useRef(variant === "review-busy" ? 2 : 0);

  function remove(key: string) {
    if (!current.current) return;
    const next = reviewSnapshot(current.current.cards.filter((card) => card.key !== key), current.current.updatingSince);
    previews.current.delete(key);
    current.current = next;
    setQueue(next);
  }

  function perform(key: string, draft: MachineReviewActionRequest): MachineReviewActionResponse {
    const card = current.current?.cards.find((card) => card.key === key);
    const previous = completed.current.get(key);
    if (!card || previous) return previous ?? { type: "alreadyHandled" };

    const { action, expectedRevision, previewRevision, reason, edited } = MachineReviewActionRequestSchema.parse(draft);
    if (expectedRevision !== card.revision) throw stale;
    if (action === "edit" || !card.actions.includes(action) || card.disabled?.[action]) {
      throw new Error(card.disabled?.[action] ?? "This action isn't available for this card.");
    }
    if (variant === "review-handled" || variant === "review-handled-unknown") {
      const handled: ReviewHandled = { type: "alreadyHandled", outcome: variant === "review-handled" ? "Kept" : undefined };
      completed.current.set(key, handled);
      return handled;
    }
    if (busyAttempts.current > 0) {
      busyAttempts.current--;
      throw busy;
    }

    const retired = action === "retire" && card.retireTarget ? knowledge.getDetail(card.retireTarget.key) : undefined;
    if (action === "retire" && !retired) throw stale;

    const pending = previews.current.get(key);
    const at = previewRevision && pending ? pending.at : new Date().toISOString();
    const note = reviewNote(card, edited ?? card, at, action === "share" ? "team" : "onlyYou");
    if (action === "share" || (retired?.source.type === "team")) {
      const writing = retired ?? note;
      if (writing.source.type !== "team") throw stale;
      const { path, checkout } = writing.source;
      const before = retired ? teamFile(retired) : [];
      const after = retired ? teamFile(retired, at, reason) : teamFile(note);
      const checks = retired ? [] : sharingChecks(card.repoId);
      const signature = JSON.stringify([action, expectedRevision, retired?.revision, path, checkout, after]);
      if (!previewRevision) {
        const preview: ReviewWritePreview = {
          type: "preview", path, checkout, checks, diff: unifiedDiff(path, before, after), revision: "preview-" + ++sequence.current,
        };
        previews.current.set(key, { signature, preview, at });
        return preview;
      }
      if (pending?.preview.revision !== previewRevision || pending.signature !== signature) throw stale;
      const blocked = checks.find((check) => check.status === "blocked");
      if (blocked) throw new Error(blocked.message);
    }

    const currentNotes = card.contradiction?.current ?? [];
    const finish = (outcome: "kept" | "shared" | "used" | "keptCurrent" | "retired", toast: string, knowledgeKey = note.key) => {
      const word = outcome === "shared" ? "Shared" : outcome === "used" ? "Used" : outcome === "kept" ? "Kept" : undefined;
      completed.current.set(key, { type: "alreadyHandled", outcome: word });
      remove(key);
      return { type: "applied" as const, outcome, toast, knowledgeKey };
    };

    switch (action) {
      case "share":
        if (note.source.type !== "team") throw stale;
        knowledge.applyReview(at, note);
        return finish("shared", "Shared to " + note.source.path);
      case "keep":
        knowledge.applyReview(at, note);
        return finish("kept", "Kept for you");
      case "keepCurrent":
        return finish("keptCurrent", "Kept your current notes. The proposal was dismissed.", currentNotes[0].key);
      case "use": {
        const keys = currentNotes.map(({ key }) => key);
        knowledge.applyReview(at, note, keys);
        return finish("used", "Proposal used; " + keys.length + (keys.length === 1 ? " note retired" : " notes retired"));
      }
      case "retire":
        if (!retired) throw stale;
        knowledge.applyReview(at, undefined, [retired.key]);
        return finish("retired", "Moved to Forgotten", retired.key);
    }
  }

  return {
    queue,
    act: (key, request, onRetry) => retryKnowledgeBusy(() => perform(key, request), onRetry),
    dismissHandled: remove,
  };
}
