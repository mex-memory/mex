import { createHash, hash } from "node:crypto";
import { BANDS, K, ROWS } from "./config.js";
import { COMPACT_FINGERPRINT_PREFIX, FINGERPRINT_PREFIX, type Fingerprint } from "./reconcile.js";

const UINT32_MAX = 0xffffffff;

function hash32(value: string, seed: number): number {
  const digest = createHash("sha256")
    .update(String(seed))
    .update("\0")
    .update(value)
    .digest();
  return digest.readUInt32BE(0);
}

export interface FingerprintBuilder {
  create(
    normalizedTokens: readonly string[],
    callers?: readonly string[],
    callees?: readonly string[],
  ): Fingerprint;
}

/**
 * Create a corpus-scoped builder that memoizes the 64 seed hashes for each
 * normalized syntax trigram. Extractor tokens intentionally discard identifier
 * and literal spellings, so the same small trigram vocabulary recurs throughout
 * a repository; sharing those hashes avoids repeating identical SHA-256 work
 * without changing a single MinHash value.
 */
export function createFingerprintBuilder(): FingerprintBuilder {
  const trigramHashes = new Map<string, Uint32Array>();
  return {
    create(normalizedTokens, callers = [], callees = []) {
      return createFingerprintInternal(normalizedTokens, callers, callees, trigramHashes);
    },
  };
}

/** Build a Tier-2 fingerprint from an extractor-provided normalized AST token stream. */
export function createFingerprint(
  normalizedTokens: readonly string[],
  callers: readonly string[] = [],
  callees: readonly string[] = [],
): Fingerprint {
  return createFingerprintInternal(normalizedTokens, callers, callees);
}

function createFingerprintInternal(
  normalizedTokens: readonly string[],
  callers: readonly string[],
  callees: readonly string[],
  trigramHashes?: Map<string, Uint32Array>,
): Fingerprint {
  const trigrams = new Set<string>();
  for (let index = 0; index <= normalizedTokens.length - 3; index += 1) {
    trigrams.add(normalizedTokens.slice(index, index + 3).join("\0"));
  }

  const minima = new Uint32Array(K);
  minima.fill(UINT32_MAX);
  for (const trigram of trigrams) {
    let hashes = trigramHashes?.get(trigram);
    if (!hashes) {
      hashes = new Uint32Array(K);
      for (let seed = 0; seed < K; seed += 1) hashes[seed] = hash32(trigram, seed);
      trigramHashes?.set(trigram, hashes);
    }
    for (let seed = 0; seed < K; seed += 1) {
      if (hashes[seed]! < minima[seed]!) minima[seed] = hashes[seed]!;
    }
  }

  return {
    minhash: Array.from(minima),
    neighbors: [...new Set([...callers, ...callees])].sort(),
    tokenCount: normalizedTokens.length,
  };
}

/**
 * Serialize a fingerprint for `grounds_to` as `mh2:<K>:<base64url>` (#233).
 *
 * Fingerprints are committed to Markdown, so every agent that reads a grounded
 * file pays for them. The first encoding, `mh:<K>:<hex>`, hex-encoded the JSON
 * of 64 decimal numbers and full neighbour ids, and took a quarter to two
 * fifths of a populated scaffold. This one writes the same values as bytes:
 *
 * ```text
 * varint      tokenCount
 * K × uint32  minhash, big-endian
 * varint      kind count, then each kind as a varint byte length and UTF-8
 * varint      neighbour count, then each neighbour as either
 *               a kind index (0–254) and the 16 bytes of a `<kind>:<32 hex>` id
 *               0xff, a varint byte length and the id's UTF-8, verbatim
 * ```
 *
 * **Lossless, by construction and on purpose.** Decoding returns exactly the
 * fingerprint that was encoded — every minhash value, every neighbour id in
 * order, the token count — so reconciliation compares precisely what it did
 * before. Shortening neighbour ids or minhash values would be smaller, and
 * would change what a rename is matched against.
 *
 * The output is canonical: one fingerprint has one `mh2` string, and
 * {@link deserializeFingerprint} rejects any other spelling of it.
 */
export function serializeFingerprint(fingerprint: Fingerprint): string {
  assertFingerprint(fingerprint);
  return `${COMPACT_FINGERPRINT_PREFIX}:${K}:${encodeFingerprint(fingerprint).toString("base64url")}`;
}

/**
 * Read a serialized fingerprint in either encoding: the compact
 * `mh2:<K>:<base64url>` written now, or the `mh:<K>:<hex>` JSON every earlier
 * scaffold committed. Null for anything else, including a non-canonical `mh2`.
 */
export function deserializeFingerprint(serialized: string): Fingerprint | null {
  const [prefix, sizeText, payload, ...extra] = serialized.split(":");
  if (Number(sizeText) !== K || !payload || extra.length > 0) return null;
  try {
    if (prefix === COMPACT_FINGERPRINT_PREFIX) {
      if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
      const bytes = Buffer.from(payload, "base64url");
      const value = decodeFingerprint(bytes);
      assertFingerprint(value);
      // One fingerprint, one string: a payload that decodes but is not what
      // the encoder writes (trailing bits, a reordered kind table) is refused,
      // so equal `mh2` strings always mean equal fingerprints.
      return encodeFingerprint(value).toString("base64url") === payload ? value : null;
    }
    if (prefix !== FINGERPRINT_PREFIX) return null;
    const value = JSON.parse(Buffer.from(payload, "hex").toString("utf8")) as unknown;
    assertFingerprint(value);
    return value;
  } catch {
    return null;
  }
}

/**
 * The fingerprint as it is written today, or the string unchanged when it does
 * not decode. Two strings in different encodings describe the same fingerprint
 * exactly when their canonical forms are equal.
 */
export function canonicalFingerprint(serialized: string): string {
  const fingerprint = deserializeFingerprint(serialized);
  return fingerprint === null ? serialized : serializeFingerprint(fingerprint);
}

/**
 * Whether two serialized fingerprints describe the same fingerprint.
 *
 * **Compare fingerprints with this, never with `===`.** A scaffold committed
 * before #233 holds `mh:` strings while the graph now serializes `mh2:`, and a
 * string comparison would call every one of those groundings changed — capture
 * would refuse them and sync would ask for a review of code nobody touched.
 * Strings that do not decode are equal only when identical.
 */
export function sameFingerprint(left: string, right: string): boolean {
  return left === right || canonicalFingerprint(left) === canonicalFingerprint(right);
}

/**
 * Whether two serialized fingerprints describe the same code: the same MinHash
 * signature over the same number of tokens, in either encoding.
 *
 * The neighbour list is left out on purpose. It names the node's callers and
 * callees, so it changes when code *elsewhere* calls this node or when node
 * ids are re-minted (#240) — neither of which is this node's code changing.
 * Use it to answer "is this still the code?" without a body hash; identity
 * questions, which neighbours help settle, keep {@link sameFingerprint}.
 */
export function sameFingerprintCode(left: string, right: string): boolean {
  if (sameFingerprint(left, right)) return true;
  const a = deserializeFingerprint(left);
  const b = deserializeFingerprint(right);
  if (a === null || b === null) return false;
  return a.tokenCount === b.tokenCount
    && a.minhash.length === b.minhash.length
    && a.minhash.every((value, index) => value === b.minhash[index]);
}

/** Kind indexes 0–254 name a table entry; 0xff introduces a verbatim id. */
const VERBATIM_NEIGHBOR = 0xff;
const NEIGHBOR_ID = /^([a-z][a-z0-9_]*):([0-9a-f]{32})$/;

function encodeFingerprint(fingerprint: Fingerprint): Buffer {
  const kinds: string[] = [];
  const kindIndex = new Map<string, number>();
  const neighbors = fingerprint.neighbors.map((id): Buffer => {
    const match = NEIGHBOR_ID.exec(id);
    if (match) {
      let index = kindIndex.get(match[1]!);
      if (index === undefined && kinds.length < VERBATIM_NEIGHBOR) {
        index = kinds.push(match[1]!) - 1;
        kindIndex.set(match[1]!, index);
      }
      if (index !== undefined) return Buffer.concat([Buffer.of(index), Buffer.from(match[2]!, "hex")]);
    }
    const bytes = Buffer.from(id, "utf8");
    return Buffer.concat([Buffer.of(VERBATIM_NEIGHBOR), writeVarint(bytes.length), bytes]);
  });

  const parts: Buffer[] = [writeVarint(fingerprint.tokenCount), encodeMinhash(fingerprint.minhash)];
  parts.push(writeVarint(kinds.length));
  for (const kind of kinds) {
    const bytes = Buffer.from(kind, "utf8");
    parts.push(writeVarint(bytes.length), bytes);
  }
  parts.push(writeVarint(neighbors.length), ...neighbors);
  return Buffer.concat(parts);
}

function decodeFingerprint(bytes: Buffer): Fingerprint {
  const reader = new ByteReader(bytes);
  const tokenCount = reader.varint();
  const minhash = decodeMinhash(reader.take(K * 4));
  const kinds = Array.from({ length: reader.count() }, () => reader.utf8(reader.varint()));
  const neighbors = Array.from({ length: reader.count() }, () => {
    const tag = reader.take(1)[0]!;
    if (tag === VERBATIM_NEIGHBOR) return reader.utf8(reader.varint());
    const kind = kinds[tag];
    if (kind === undefined) throw new Error("Invalid fingerprint");
    return `${kind}:${reader.take(16).toString("hex")}`;
  });
  if (!reader.done()) throw new Error("Invalid fingerprint");
  return { minhash, neighbors, tokenCount };
}

/** Unsigned LEB128, for counts and lengths. */
function writeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid fingerprint");
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** Bounds-checked reads; any overrun is a malformed fingerprint, never a partial one. */
class ByteReader {
  private offset = 0;
  private static readonly utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly bytes: Buffer) {}

  take(length: number): Buffer {
    if (length > this.bytes.length - this.offset) throw new Error("Invalid fingerprint");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.take(1)[0]!;
      value += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(value)) throw new Error("Invalid fingerprint");
      if ((byte & 0x80) === 0) return value;
      scale *= 0x80;
    }
  }

  /** A list length. Every entry takes at least one byte, so a larger count is malformed. */
  count(): number {
    const value = this.varint();
    if (value > this.bytes.length - this.offset) throw new Error("Invalid fingerprint");
    return value;
  }

  utf8(length: number): string {
    return ByteReader.utf8Decoder.decode(this.take(length));
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

export function bandHashes(fingerprint: Fingerprint): string[] {
  assertFingerprint(fingerprint);
  if (BANDS * ROWS !== K) {
    throw new Error(`Invalid LSH configuration: ${BANDS} * ${ROWS} !== ${K}`);
  }
  return Array.from({ length: BANDS }, (_, band) => {
    const start = band * ROWS;
    return hash("sha256", JSON.stringify(fingerprint.minhash.slice(start, start + ROWS)));
  });
}

/**
 * Compact schema-v4 LSH band hashes (retained from main-v3): the first 8 bytes
 * of the same per-band sha256
 * that {@link bandHashes} hex-encodes, as a signed 64-bit integer for compact
 * INTEGER storage. Derivation input is identical, so two fingerprints share an
 * int64 band hash exactly when they share the hex band hash (modulo a ~2^-64
 * truncation collision, which merely adds one LSH candidate that full minhash
 * scoring then rejects — it can never remove or reorder a true candidate).
 */
export function bandHashInts(fingerprint: Fingerprint): bigint[] {
  assertFingerprint(fingerprint);
  if (BANDS * ROWS !== K) {
    throw new Error(`Invalid LSH configuration: ${BANDS} * ${ROWS} !== ${K}`);
  }
  return Array.from({ length: BANDS }, (_, band) => {
    const start = band * ROWS;
    // One-shot hex digest: the first 16 hex digits are the first 8 digest
    // bytes, read as a signed 64-bit integer exactly as readBigInt64BE(0) did.
    // For these tiny inputs it is ~40% faster than a Hash object per band, and
    // this runs 32 times per fingerprint in every build and fingerprint audit.
    const digest = hash("sha256", JSON.stringify(fingerprint.minhash.slice(start, start + ROWS)));
    return BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
  });
}

/** Encode a K=64 uint32 minhash as a 256-byte big-endian BLOB (schema v4). */
export function encodeMinhash(minhash: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(minhash.length * 4);
  minhash.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
  return buffer;
}

/** Decode a schema-v4 minhash BLOB back to the uint32 array it encodes. */
export function decodeMinhash(blob: Uint8Array): number[] {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) {
    values.push(buffer.readUInt32BE(offset));
  }
  return values;
}

function assertFingerprint(value: unknown): asserts value is Fingerprint {
  if (!value || typeof value !== "object") throw new Error("Invalid fingerprint");
  const candidate = value as Partial<Fingerprint>;
  if (
    !Array.isArray(candidate.minhash) ||
    candidate.minhash.length !== K ||
    candidate.minhash.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > UINT32_MAX) ||
    !Array.isArray(candidate.neighbors) ||
    candidate.neighbors.some((entry) => typeof entry !== "string") ||
    !Number.isInteger(candidate.tokenCount) ||
    (candidate.tokenCount ?? -1) < 0
  ) {
    throw new Error("Invalid fingerprint");
  }
}
