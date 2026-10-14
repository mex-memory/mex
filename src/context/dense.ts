/**
 * The dense channel's document side: text, hashing and the vector cache.
 *
 * The model itself is the optional semantic extra (`semantic.ts`). Everything
 * here is model-agnostic, so the composer can be tested with a deterministic
 * fake embedder and so a missing extra is just "no embedder".
 */

import { createHash } from "node:crypto";
import { DENSE_MODEL } from "./frozen.js";
import { symbolWords } from "./tokenize.js";
import type { ContextEntity, ContextIndex } from "./types.js";

export interface Embedder {
  /** Cache key for vectors this embedder produced (model, quantisation, pooling). */
  readonly modelId: string;
  embed(text: string): Promise<Float32Array>;
  dispose?(): Promise<void> | void;
}

/** `title. aliases. symbol words. body[0:900]`, exactly as the frozen recipe embeds it. */
export function denseDocumentText(entity: ContextEntity): string {
  const symbols = [...new Set(entity.symbols.map((s) => symbolWords(s.name)))].join(", ");
  return `${entity.title}. ${entity.aliases.join(". ")}. ${symbols}. ${entity.body.slice(0, DENSE_MODEL.bodyChars)}`;
}

export const documentHash = (modelId: string, text: string): string =>
  createHash("sha256").update(`${modelId}\0${text}`).digest("hex");

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

export function decodeVector(data: string): Float32Array {
  const bytes = Buffer.from(data, "base64");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export interface FactVectors {
  vectors: Map<string, Float32Array>;
  /** How many vectors had to be (re)computed; the caller persists the index if above zero. */
  computed: number;
}

/**
 * Vectors for these facts, from the index's cache where the text hash still
 * matches and from the embedder where it does not. New vectors are written
 * into `index.vectors` (in memory); saving the index is the caller's decision.
 */
export async function ensureFactVectors(
  index: ContextIndex,
  facts: readonly ContextEntity[],
  embedder: Embedder,
): Promise<FactVectors> {
  const cache = (index.vectors[embedder.modelId] ??= {});
  const vectors = new Map<string, Float32Array>();
  let computed = 0;
  for (const fact of facts) {
    const text = denseDocumentText(fact);
    const hash = documentHash(embedder.modelId, text);
    const cached = cache[fact.id];
    if (cached !== undefined && cached.hash === hash) {
      vectors.set(fact.id, decodeVector(cached.data));
      continue;
    }
    const vector = await embedder.embed(text);
    cache[fact.id] = { hash, data: encodeVector(vector) };
    vectors.set(fact.id, vector);
    computed += 1;
  }
  return { vectors, computed };
}

/** Drop cached vectors for entities that are no longer facts, so the cache cannot grow without bound. */
export function pruneVectorCache(index: ContextIndex, factIds: ReadonlySet<string>): void {
  for (const byId of Object.values(index.vectors)) {
    for (const id of Object.keys(byId)) if (!factIds.has(id)) delete byId[id];
  }
}
