import {
  MachineForgottenItemSchema, MachineForgottenPageSchema, MachineKnowledgeConflictSchema, MachineKnowledgeDetailSchema,
  MachineKnowledgeEditBodySchema, MachineKnowledgeForgetBodySchema, MachineKnowledgeLandingSchema, MachineKnowledgeNoteBodySchema,
  MachineKnowledgePageSchema, MachineKnowledgePreviewReplySchema,
} from "@mex/hub-contracts/machine";
import { z } from "zod";
import { HubProblemError, requestJson } from "./api";
import type { KnowledgeCreate, KnowledgeEdit, KnowledgeEditResult, KnowledgeFilters, KnowledgeForget, KnowledgeForgetResult } from "./types";

function query(path: string, fields: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) if (value) params.set(name, value);
  return params.size ? `${path}?${params}` : path;
}

export function getKnowledgePage(filters: KnowledgeFilters, cursor?: string, signal?: AbortSignal) {
  return requestJson(query("/knowledge", {
    repo: filters.scopeId ?? filters.repoId, q: filters.query, kind: filters.kind, audience: filters.audience,
    status: filters.status, area: filters.area, cursor,
  }), MachineKnowledgePageSchema, { signal });
}

export function getKnowledgeLanding(repo?: string, signal?: AbortSignal) {
  return requestJson(query("/knowledge/landing", { repo }), MachineKnowledgeLandingSchema, { signal });
}

function itemPath(key: string) { return "/knowledge/items/" + encodeURIComponent(key); }

export function getKnowledgeItem(key: string, signal?: AbortSignal) {
  return requestJson(itemPath(key), MachineKnowledgeDetailSchema, { signal });
}

export function getForgotten(repo?: string, cursor?: string, signal?: AbortSignal) {
  return requestJson(query("/knowledge/forgotten", { repo, cursor }), MachineForgottenPageSchema, { signal });
}

interface WriteHeaders { csrfToken: string; idempotencyKey: string }
function write<T>(path: string, schema: { parse(value: unknown): T }, body: unknown, { csrfToken, idempotencyKey }: WriteHeaders) {
  return requestJson(path, schema, {
    method: "POST", body: JSON.stringify(body),
    headers: { "x-mex-csrf": csrfToken, "idempotency-key": idempotencyKey, "content-type": "application/json" },
  });
}

export async function postNote({ expectedRevision: _new, ...input }: KnowledgeCreate, headers: WriteHeaders) {
  const item = await write("/knowledge/notes", MachineKnowledgeDetailSchema, MachineKnowledgeNoteBodySchema.parse(input), headers);
  return { type: "ok" as const, item };
}

function conflict(error: unknown) {
  if (!(error instanceof HubProblemError) || error.status !== 409) return;
  const parsed = MachineKnowledgeConflictSchema.safeParse(error.body);
  return parsed.success ? parsed.data.current : undefined;
}

function applyFields(revision: string | undefined) {
  return revision ? { apply: true as const, previewRevision: revision } : {};
}

const editReply = z.union([MachineKnowledgeDetailSchema, MachineKnowledgePreviewReplySchema]);
const forgetReply = z.union([MachineForgottenItemSchema, MachineKnowledgePreviewReplySchema]);

export async function postKnowledgeEdit(input: KnowledgeEdit, headers: WriteHeaders): Promise<KnowledgeEditResult> {
  const { key, confirmRevision, ...fields } = input;
  try {
    const reply = await write(itemPath(key) + "/edit", editReply, MachineKnowledgeEditBodySchema.parse({ ...fields, ...applyFields(confirmRevision) }), headers);
    return "preview" in reply ? { type: "preview", ...reply.preview } : { type: "ok", item: reply };
  } catch (error) {
    const current = conflict(error);
    if (current) return { type: "conflict", current, attempted: input };
    throw error;
  }
}

export async function postKnowledgeForget(input: KnowledgeForget, headers: WriteHeaders): Promise<KnowledgeForgetResult> {
  const { key, confirmRevision, ...fields } = input;
  try {
    const reply = await write(itemPath(key) + "/forget", forgetReply, MachineKnowledgeForgetBodySchema.parse({ ...fields, ...applyFields(confirmRevision) }), headers);
    return "preview" in reply ? { type: "preview", ...reply.preview } : { type: "ok", item: reply };
  } catch (error) {
    const current = conflict(error);
    if (current) return { type: "conflict", current, attempted: input };
    throw error;
  }
}
