import { createHash } from "node:crypto";
import {
  MachineKnowledgeEditBodySchema, MachineKnowledgeForgetBodySchema, MachineKnowledgeNoteBodySchema,
} from "@mex/hub-contracts/machine";
import type { z } from "zod";
import { KNOWLEDGE_LIMITS, KnowledgeError } from "../../knowledge/entry.js";
import { confirmHint, forgetHint } from "../../knowledge/hints.js";
import { edit, editedEntry, forget } from "../../knowledge/mutations.js";
import { rebuildNative } from "../../knowledge/native.js";
import { queueNativeRebuild } from "../../knowledge/native-queue.js";
import { note, type KnowledgeOptions } from "../../knowledge/store.js";
import { applyTeamWrite, prepareTeamWrite, type TeamPreview } from "../../knowledge/team.js";
import { openRecordReadOnly, projectIdentity } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { revisionOf } from "../../team/artifacts/revision.js";
import { knowledgeTarget, readKnowledgeEntry, readKnowledgeItem, type ItemIdentity, type KnowledgeDetail } from "./knowledge-detail.js";
import { badKnowledgeRequest, knowledgeMissing, parseKnowledgeKey } from "./knowledge-list.js";
import { knowledgeKey, midnight, PROJECT_ID } from "./knowledge-snapshot.js";
import { readStore } from "./read.js";
import { HubRequestError } from "./security.js";

type EditBody = z.infer<typeof MachineKnowledgeEditBodySchema>;
type ForgetBody = z.infer<typeof MachineKnowledgeForgetBodySchema>;
const KEYS = 200;
const TTL = 10 * 60_000;
const MAX_REPLY_BYTES = 8 << 20;
const DEFAULT_REASON = "Removed with mex forget";

export class KnowledgeConflict extends HubRequestError {
  constructor(code: "REVISION_CONFLICT" | "STALE_PREVIEW", readonly current: KnowledgeDetail | undefined, readonly attempted: EditBody | ForgetBody) {
    super(409, code, "This item changed", "Open the current item and review your change again.");
  }
}

export function knowledgeWriteProblem(error: unknown): unknown {
  const sqlite = error as { errcode?: number; code?: string } | undefined;
  if (sqlite?.errcode !== undefined && [5, 6].includes(sqlite.errcode & 0xff)
      || sqlite?.code === "SQLITE_BUSY" || sqlite?.code === "STORE_BUSY") {
    return new HubRequestError(503, "MEX_BUSY", "MEX is busy", "MEX is busy. Try again in a moment.");
  }
  if (error instanceof KnowledgeError) {
    if (error.code === "NOT_FOUND") return knowledgeMissing();
    if (error.code === "RETIRED_ENTRY") {
      return new HubRequestError(409, "REVISION_CONFLICT", "This item can’t be changed", "It has already been forgotten or is a proposed decision.");
    }
    if (error.code === "CONTRADICTION" || error.code === "DUPLICATE_ENTRY" || error.code === "DUPLICATE_RULE_LINE" || error.code === "SECRET_FOUND") {
      return new HubRequestError(400, "INVALID_REQUEST", "The note couldn’t be saved", error.message);
    }
    return badKnowledgeRequest("Check the note text, scope, and the repo’s files.");
  }
  return error;
}

export function knowledgeReadProblem(error: unknown): unknown {
  return error instanceof KnowledgeError ? knowledgeMissing("This file couldn’t be read safely.") : error;
}

type SavedReply = { body: string; type: string | null; status: number };
interface Replay {
  signature: string;
  result: Promise<SavedReply>;
  expires: number;
  bytes: number;
}

export class KnowledgeReplays {
  #replies = new Map<string, Replay>();
  #bytes = 0;
  constructor(private readonly now: () => number) {}

  async run(session: string, key: string | undefined, path: string, payload: unknown, action: () => Promise<Response>) {
    if (key === undefined) return action();
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(key)) throw badKnowledgeRequest("The request key is invalid.");
    const id = session + ":" + key;
    const signature = createHash("sha256").update(JSON.stringify([path, payload])).digest("hex");
    for (const [id, saved] of this.#replies) if (saved.expires <= this.now()) this.#remove(id, saved);
    let replay = this.#replies.get(id);
    if (replay) {
      if (replay.signature !== signature) throw new HubRequestError(409, "REQUEST_KEY_USED", "Request already used", "Try the action again as a new request.");
      this.#replies.delete(id);
      this.#replies.set(id, replay);
    } else {
      this.#trim(KEYS - 1);
      if (this.#replies.size >= KEYS) throw new HubRequestError(503, "MEX_BUSY", "MEX is busy", "MEX is busy. Try again in a moment.");
      replay = { signature, expires: Infinity, bytes: 0, result: Promise.resolve().then(async () => {
        const response = await action();
        return { status: response.status, body: await response.text(), type: response.headers.get("content-type") };
      }) };
      this.#replies.set(id, replay);
      const pending = replay;
      void pending.result.then((reply) => {
        // A busy writer has made no change. Let the same action try again.
        if (reply.status === 503) { this.#remove(id, pending); return; }
        pending.expires = this.now() + TTL;
        pending.bytes = Buffer.byteLength(reply.body);
        this.#bytes += pending.bytes;
        this.#trim(KEYS);
      }, () => this.#remove(id, pending));
    }
    const reply = await replay.result;
    return new Response(reply.body, { status: reply.status, headers: reply.type ? { "content-type": reply.type } : undefined });
  }

  #remove(id: string, saved: Replay) {
    if (this.#replies.get(id) !== saved) return;
    this.#replies.delete(id);
    this.#bytes -= saved.bytes;
  }

  #trim(limit: number) {
    for (const [id, saved] of this.#replies) {
      if (this.#replies.size <= limit && this.#bytes <= MAX_REPLY_BYTES) break;
      if (Number.isFinite(saved.expires)) this.#remove(id, saved);
    }
  }
}

function input<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw badKnowledgeRequest("Provide valid note fields and the revision you opened.");
  return result.data;
}

function writePreview({ diff, path, revision }: TeamPreview, checkout: string) {
  return { preview: { diff, path, checkout, revision } };
}

export class KnowledgeWrites {
  constructor(
    private readonly location: LocationOptions, private readonly now: () => number, private readonly env: NodeJS.ProcessEnv | undefined,
    private readonly changed: (repoId: string) => Promise<void>,
  ) {}

  #options(repoId: string, checkout?: string): KnowledgeOptions {
    return readStore(openRecordReadOnly, this.location, (reader) => {
      const target = knowledgeTarget(reader, this.location, repoId, this.now(), this.env, checkout);
      if (!target.checkout) throw knowledgeMissing("This repo needs an existing checkout with MEX on.");
      if (projectIdentity(target.checkout).rootPath !== target.checkout) throw knowledgeMissing("Register the repo’s current root before making changes.");
      return { ...target, projectPath: target.checkout };
    });
  }

  #publishedRepo(options: KnowledgeOptions, original: string): string {
    // The Node writer may promote a registered provisional project.
    try {
      return readStore(openRecordReadOnly, this.location, (reader) => reader?.get<{ project_id: string }>(
        "SELECT project_id FROM checkouts WHERE path=?", options.projectPath,
      )?.project_id ?? original);
    } catch { return original; }
  }

  async #finish(repoId: string, options: KnowledgeOptions, shared: boolean) {
    const published = shared ? repoId : this.#publishedRepo(options, repoId);
    try {
      if (shared) rebuildNative(options, { sharedOnly: true, force: true });
      else queueNativeRebuild(options.projectPath, { local: true }, options);
    } catch {
      // The service committed the entry. Report the follow-up failure without retrying the mutation.
      throw new HubRequestError(500, "RULE_FILES_UNAVAILABLE", "The item was saved", "The rule files couldn’t be updated. Run mex rules --write to try again.");
    } finally {
      if (published !== repoId) await this.changed(repoId);
      await this.changed(published);
    }
    return published;
  }

  async create(body: unknown) {
    const { repoId, ...fields } = input(MachineKnowledgeNoteBodySchema, body);
    if (!PROJECT_ID.test(repoId)) throw badKnowledgeRequest("Choose a registered repo.");
    const options = this.#options(repoId);
    const oneLine = fields.oneLine ?? fields.text.split(/\r?\n/u, 1)[0].slice(0, KNOWLEDGE_LIMITS.oneLineCharacters).trim();
    const saved = note({ ...fields, oneLine }, options, new Date(this.now()));
    const published = await this.#finish(repoId, options, false);
    return this.#detail(knowledgeKey(published, "onlyYou", saved.entry.mex.id));
  }

  async edit(key: string, body: unknown) {
    const identity = parseKnowledgeKey(key);
    const { repoId, audience, id } = identity;
    const request = input(MachineKnowledgeEditBodySchema, body);
    const options = this.#actionOptions(identity, request);
    const { expectedRevision, apply, previewRevision, checkout: _checkout, ...fields } = request;
    const at = new Date(this.now());
    return this.#resolveConflict(key, request, async () => {
      if (audience === "team") {
        const current = this.#teamEntry(identity, options, Boolean(apply));
        const preview = prepareTeamWrite(editedEntry(current, fields, at), options, fields.text);
        this.#expect(preview, expectedRevision, Boolean(apply));
        if (!apply) return writePreview(preview, options.projectPath);
        applyTeamWrite(preview, previewRevision!, options, fields.text);
      } else if (audience === "hint") {
        confirmHint(id, fields, options, at, expectedRevision);
      } else {
        edit(id, fields, options, at, expectedRevision);
      }
      const published = await this.#finish(repoId, options, audience === "team");
      return this.#detail(knowledgeKey(published, audience === "hint" ? "onlyYou" : audience, id), audience === "team" ? options.projectPath : undefined);
    });
  }

  async forget(key: string, body: unknown) {
    const identity = parseKnowledgeKey(key);
    const { repoId, audience, id } = identity;
    const request = input(MachineKnowledgeForgetBodySchema, body);
    const options = this.#actionOptions(identity, request);
    const { expectedRevision, apply, previewRevision, reason = DEFAULT_REASON } = request;
    const now = new Date(this.now());
    return this.#resolveConflict(key, request, async () => {
      const at = now.toISOString().slice(0, 10);
      if (audience === "team") {
        const current = this.#teamEntry(identity, options, Boolean(apply));
        const retired = { reason, by: "mex forget", at };
        const preview = prepareTeamWrite({ ...current, mex: { ...current.mex, status: "retired", retired } }, options);
        this.#expect(preview, expectedRevision, Boolean(apply));
        if (!apply) return writePreview(preview, options.projectPath);
        applyTeamWrite(preview, previewRevision!, options);
      } else if (audience === "hint") {
        forgetHint(id, reason, options, now, "forget", expectedRevision);
      } else {
        forget(id, reason, options, now, "forget", expectedRevision);
      }
      const published = await this.#finish(repoId, options, audience === "team");
      return { id, repoId: published, audience, at: midnight(at) };
    });
  }

  #actionOptions(identity: ItemIdentity, request: EditBody | ForgetBody) {
    if (identity.audience !== "team" && (request.checkout || request.apply)) {
      throw badKnowledgeRequest("Choose a team item to apply a preview in a checkout.");
    }
    return this.#options(identity.repoId, request.checkout);
  }

  #teamEntry(identity: ItemIdentity, options: KnowledgeOptions, apply: boolean) {
    try {
      return readStore(openRecordReadOnly, this.location, (reader) => {
        if (!reader) throw knowledgeMissing();
        const target = knowledgeTarget(reader, this.location, identity.repoId, this.now(), this.env, options.projectPath);
        return readKnowledgeEntry(reader, target, identity, this.now()).entry;
      });
    } catch (error) {
      if (apply && error instanceof HubRequestError && error.status === 404) {
        throw new KnowledgeError("STALE_PREVIEW", "The team file moved or was deleted.");
      }
      throw error;
    }
  }

  #expect(preview: TeamPreview, expectedRevision: string | undefined, apply: boolean) {
    if (preview.before === null || (expectedRevision !== undefined && revisionOf(preview.before) !== expectedRevision)) {
      throw new KnowledgeError(apply ? "STALE_PREVIEW" : "REVISION_CONFLICT", "The team file changed since it was opened.");
    }
  }

  #detail(key: string, checkout?: string) {
    return readKnowledgeItem(this.location, key, this.now(), this.env, checkout);
  }

  async #resolveConflict<T>(key: string, attempted: EditBody | ForgetBody, action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof KnowledgeError && ["REVISION_CONFLICT", "STALE_ENTRY", "STALE_PREVIEW"].includes(error.code)) {
        let current: KnowledgeDetail | undefined;
        try { current = await this.#detail(key, attempted.checkout); } catch { /* The newer item may be gone or unreadable. */ }
        throw new KnowledgeConflict(error.code === "STALE_PREVIEW" ? "STALE_PREVIEW" : "REVISION_CONFLICT", current, attempted);
      }
      throw error;
    }
  }
}
