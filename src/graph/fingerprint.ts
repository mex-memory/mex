import { createHash } from "node:crypto";
import { BANDS, K, ROWS } from "./config.js";
import { FINGERPRINT_PREFIX, type Fingerprint } from "./reconcile.js";

const UINT32_MAX = 0xffffffff;

function hash32(value: string, seed: number): number {
  const digest = createHash("sha256")
    .update(String(seed))
    .update("\0")
    .update(value)
    .digest();
  return digest.readUInt32BE(0);
}

/** Build a Tier-2 fingerprint from an extractor-provided normalized AST token stream. */
export function createFingerprint(
  normalizedTokens: readonly string[],
  callers: readonly string[] = [],
  callees: readonly string[] = [],
): Fingerprint {
  const trigrams = new Set<string>();
  for (let index = 0; index <= normalizedTokens.length - 3; index += 1) {
    trigrams.add(normalizedTokens.slice(index, index + 3).join("\0"));
  }

  const minhash = Array.from({ length: K }, (_, seed) => {
    let minimum = UINT32_MAX;
    for (const trigram of trigrams) {
      minimum = Math.min(minimum, hash32(trigram, seed));
    }
    return minimum;
  });

  return {
    minhash,
    neighbors: [...new Set([...callers, ...callees])].sort(),
    tokenCount: normalizedTokens.length,
  };
}

export function serializeFingerprint(fingerprint: Fingerprint): string {
  assertFingerprint(fingerprint);
  const payload = Buffer.from(JSON.stringify(fingerprint), "utf8").toString("hex");
  return `${FINGERPRINT_PREFIX}:${K}:${payload}`;
}

export function deserializeFingerprint(serialized: string): Fingerprint | null {
  const [prefix, sizeText, payload, ...extra] = serialized.split(":");
  if (prefix !== FINGERPRINT_PREFIX || Number(sizeText) !== K || !payload || extra.length > 0) {
    return null;
  }
  try {
    const value = JSON.parse(Buffer.from(payload, "hex").toString("utf8")) as unknown;
    assertFingerprint(value);
    return value;
  } catch {
    return null;
  }
}

export function bandHashes(fingerprint: Fingerprint): string[] {
  assertFingerprint(fingerprint);
  if (BANDS * ROWS !== K) {
    throw new Error(`Invalid LSH configuration: ${BANDS} * ${ROWS} !== ${K}`);
  }
  return Array.from({ length: BANDS }, (_, band) => {
    const start = band * ROWS;
    return createHash("sha256")
      .update(JSON.stringify(fingerprint.minhash.slice(start, start + ROWS)))
      .digest("hex");
  });
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
