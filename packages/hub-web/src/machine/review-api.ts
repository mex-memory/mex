import {
  MachineReviewActionRequestSchema, MachineReviewActionResponseSchema, MachineReviewCardSchema,
  MachineReviewPreviewReplySchema, MachineReviewQueueSchema, type MachineReviewActionRequest,
  type MachineReviewActionResponse,
} from "@mex/hub-contracts/machine";
import { HubProblemError, requestJson } from "./api";

const cardPath = (key: string) => "/review/cards/" + encodeURIComponent(key);
const checkStatus = { pass: "passed", warn: "warning", fail: "blocked" } as const;

export function getReviewQueue(repo?: string, cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (repo) query.set("repo", repo);
  if (cursor) query.set("cursor", cursor);
  return requestJson("/review" + (query.size ? "?" + query : ""), MachineReviewQueueSchema, { signal });
}

export function getReviewCard(key: string, signal?: AbortSignal) {
  return requestJson(cardPath(key), MachineReviewCardSchema, { signal });
}

export function reviewProblem(error: unknown, code: string): error is HubProblemError {
  return error instanceof HubProblemError && error.problem?.code === code;
}

export function currentReviewCard(error: unknown) {
  if (!reviewProblem(error, "STALE_PREVIEW")) return;
  const current = MachineReviewCardSchema.safeParse((error.body as { current?: unknown })?.current);
  if (current.success) return current.data;
}

export async function postReviewAction(
  key: string, input: MachineReviewActionRequest, headers: { csrfToken: string; idempotencyKey: string },
): Promise<MachineReviewActionResponse> {
  const body = MachineReviewActionRequestSchema.parse(input);
  try {
    const response = await requestJson(cardPath(key) + "/" + body.action, { parse: (value) => value }, {
      method: "POST", headers: {
        "content-type": "application/json", "x-mex-csrf": headers.csrfToken, "Idempotency-Key": headers.idempotencyKey,
      }, body: JSON.stringify(body),
      // A Share can wait for GitHub and the asynchronous native checker.
      timeoutMs: body.action === "share" || body.action === "use" ? 180_000 : undefined,
    });
    const result = MachineReviewPreviewReplySchema.safeParse(response);
    if (result.success) {
      const { checks, ...preview } = result.data.preview;
      return { type: "preview", ...preview, checks: checks.map(({ id, status, label }) => ({
        id: id === "secrets" ? "privacy" : id, status: checkStatus[status], message: label,
      })) };
    }
    return MachineReviewActionResponseSchema.parse(response);
  } catch (error) {
    if (!reviewProblem(error, "ALREADY_HANDLED")) throw error;
    const outcome = (error.body as { outcome?: unknown })?.outcome;
    return { type: "alreadyHandled", outcome: outcome === "Kept" || outcome === "Shared" || outcome === "Used" ? outcome : undefined };
  }
}
