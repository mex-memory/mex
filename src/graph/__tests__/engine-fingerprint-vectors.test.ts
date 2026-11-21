import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bodyHash } from "../engine-impl.js";
import { createFingerprint } from "../fingerprint.js";

/**
 * Shared body-hash, fingerprint and text vectors for the Rust graph engine
 * (OSS-73), computed by today's TypeScript functions. The Rust port runs the
 * same file (`native/graph/core/tests/fingerprint_vectors.rs`). Run with
 * `MEX_WRITE_ENGINE_VECTORS=1` to regenerate after an intended change.
 */
const VECTORS = join(import.meta.dirname, "../../../native/graph/core/tests/fingerprint-vectors.json");

const BODIES: Array<{ source: string; start: number; end: number }> = [
  { source: "def f():\n    return 1\n", start: 1, end: 2 },
  { source: "class A:\r\n    x  =\t2\r\n", start: 1, end: 2 },
  { source: "a\n\n\nb", start: 2, end: 3 },
  { source: "x = '😀\u00a0é'\n", start: 1, end: 1 },
  { source: "only\n", start: 1, end: 99 },
  { source: "\u2028sep\u3000\ufeff\n", start: 1, end: 1 },
];

const TOKENS: string[][] = [
  [],
  ["def", "identifier"],
  ["def", "identifier", "(", ")", ":", "return", "integer"],
  ["class", "identifier", ":", "identifier", "=", "integer", "identifier", "=", "integer"],
  Array.from({ length: 60 }, (_, i) => ["identifier", "(", ")", ".", "string_start", "string_content"][i % 6]!),
];

// `text.slice(0, n)` cuts UTF-16 units; a split pair leaves a lone surrogate,
// which UTF-8 encoding turns into U+FFFD.
const SLICES: Array<{ text: string; units: number }> = [
  { text: "hello world", units: 5 },
  { text: "a😀b", units: 2 },
  { text: "a😀b", units: 3 },
  { text: "é".repeat(250), units: 200 },
];

function vectors() {
  return {
    bodies: BODIES.map((b) => ({ ...b, hash: bodyHash(b.source.split("\n"), b.start, b.end) })),
    sketches: TOKENS.map((tokens) => {
      const f = createFingerprint(tokens);
      return { tokens, minhash: f.minhash, tokenCount: f.tokenCount };
    }),
    slices: SLICES.map((s) => ({ ...s, utf8Hex: Buffer.from(s.text.slice(0, s.units), "utf8").toString("hex") })),
  };
}

describe("shared fingerprint vectors for the Rust engine", () => {
  it("matches the committed vectors", () => {
    const computed = vectors();
    if (process.env.MEX_WRITE_ENGINE_VECTORS === "1") writeFileSync(VECTORS, `${JSON.stringify(computed, null, 2)}\n`);
    expect(JSON.parse(readFileSync(VECTORS, "utf8"))).toEqual(computed);
  });
});
