import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalFingerprint,
  createFingerprint,
  deserializeFingerprint,
  sameFingerprint,
  serializeFingerprint,
} from "../fingerprint.js";
import type { Fingerprint } from "../reconcile.js";

/** A real node id: `<kind>:` and 32 lowercase hex digits. */
function nodeId(kind: string, seed: string): string {
  return `${kind}:${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

/** The encoding every scaffold committed before #233. */
function legacy(fingerprint: Fingerprint): string {
  return `mh:64:${Buffer.from(JSON.stringify(fingerprint), "utf8").toString("hex")}`;
}

function payload(serialized: string): Buffer {
  return Buffer.from(serialized.split(":")[2]!, "base64url");
}

function withPayload(bytes: Buffer): string {
  return `mh2:64:${bytes.toString("base64url")}`;
}

const TOKENS = [
  "FunctionKeyword", "Identifier", "OpenParenToken", "Identifier", "CloseParenToken",
  "OpenBraceToken", "ReturnKeyword", "Identifier", "PlusToken", "NumericLiteral",
  "SemicolonToken", "CloseBraceToken",
];

const realistic = createFingerprint(
  TOKENS,
  [nodeId("function", "a"), nodeId("method", "b"), nodeId("function", "c")],
  [nodeId("class", "d"), nodeId("method", "e"), nodeId("function", "f")],
);

describe("compact fingerprint encoding (#233)", () => {
  it("round-trips every value exactly, in order", () => {
    const cases: Fingerprint[] = [
      realistic,
      { ...realistic, neighbors: [] },
      { ...realistic, tokenCount: 0 },
      { ...realistic, tokenCount: 2 ** 40 },
      { ...realistic, minhash: realistic.minhash.map((_, index) => (index % 2 === 0 ? 0 : 0xffffffff)) },
      // Order is data: an unsorted list comes back unsorted.
      { ...realistic, neighbors: [nodeId("method", "z"), nodeId("function", "y"), nodeId("method", "x")] },
      // Ids outside the `<kind>:<32 hex>` shape are kept verbatim.
      {
        ...realistic,
        neighbors: [
          "caller-a",
          `function:${"A".repeat(32)}`,
          "function:abc",
          "kind:with:colons",
          "naïve:ü",
          nodeId("function", "g"),
        ],
      },
    ];
    for (const fingerprint of cases) {
      const serialized = serializeFingerprint(fingerprint);
      expect(serialized).toMatch(/^mh2:64:[A-Za-z0-9_-]+$/);
      expect(deserializeFingerprint(serialized)).toEqual(fingerprint);
      expect(serializeFingerprint(deserializeFingerprint(serialized)!)).toBe(serialized);
    }
  });

  it("keeps more neighbour kinds than the table holds, verbatim", () => {
    const neighbors = Array.from({ length: 300 }, (_, index) => nodeId(`kind_${index}`, String(index)));
    const fingerprint = { ...realistic, neighbors };
    expect(deserializeFingerprint(serializeFingerprint(fingerprint))).toEqual(fingerprint);
  });

  it("still reads the original hex encoding, as the same fingerprint", () => {
    const old = legacy(realistic);
    expect(deserializeFingerprint(old)).toEqual(realistic);
    expect(canonicalFingerprint(old)).toBe(serializeFingerprint(realistic));
    expect(sameFingerprint(old, serializeFingerprint(realistic))).toBe(true);
    expect(sameFingerprint(serializeFingerprint(realistic), old)).toBe(true);
  });

  it("tells different fingerprints apart in either encoding", () => {
    const minhash = [...realistic.minhash];
    minhash[63] = (minhash[63]! + 1) % 0x100000000;
    const changedSketch = { ...realistic, minhash };
    const changedNeighbor = { ...realistic, neighbors: [...realistic.neighbors.slice(1), nodeId("function", "new")] };
    const changedTokens = { ...realistic, tokenCount: realistic.tokenCount + 1 };
    for (const other of [changedSketch, changedNeighbor, changedTokens]) {
      expect(sameFingerprint(serializeFingerprint(realistic), serializeFingerprint(other))).toBe(false);
      expect(sameFingerprint(legacy(realistic), serializeFingerprint(other))).toBe(false);
      expect(sameFingerprint(legacy(realistic), legacy(other))).toBe(false);
    }
  });

  it("compares strings that do not decode only by identity", () => {
    expect(sameFingerprint("not-a-fingerprint", "not-a-fingerprint")).toBe(true);
    expect(sameFingerprint("not-a-fingerprint", "also-not")).toBe(false);
    expect(sameFingerprint("not-a-fingerprint", serializeFingerprint(realistic))).toBe(false);
    expect(canonicalFingerprint("not-a-fingerprint")).toBe("not-a-fingerprint");
  });

  it("is under a third of the original encoding's length", () => {
    expect(serializeFingerprint(realistic).length).toBeLessThan(legacy(realistic).length / 3);
  });

  it("rejects malformed and non-canonical payloads", () => {
    const good = serializeFingerprint(realistic);
    const bytes = payload(good);
    const malformed = [
      good.replace("mh2:64:", "mh2:32:"),
      good.replace("mh2:64:", "mh3:64:"),
      `${good}:extra`,
      `${good}=`,
      good.replace(/.$/, "!"),
      "mh2:64:",
      withPayload(bytes.subarray(0, bytes.length - 1)),
      withPayload(Buffer.concat([bytes, Buffer.of(0)])),
    ];
    for (const value of malformed) expect(deserializeFingerprint(value)).toBeNull();
  });

  it("rejects payloads that decode but are not what the encoder writes", () => {
    const minimal: Fingerprint = { minhash: realistic.minhash, neighbors: [nodeId("function", "a")], tokenCount: 5 };
    const bytes = payload(serializeFingerprint(minimal));
    // tokenCount 5 as a two-byte varint: same number, different bytes.
    expect(deserializeFingerprint(withPayload(Buffer.concat([Buffer.of(0x85, 0x00), bytes.subarray(1)])))).toBeNull();
    // An unused kind in the table.
    const sketch = bytes.subarray(1, 1 + 256);
    const neighbor = bytes.subarray(1 + 256 + 1 + 1 + "function".length);
    const extraKind = Buffer.concat([
      Buffer.of(5), sketch, Buffer.of(2, 8), Buffer.from("function"), Buffer.of(6), Buffer.from("method"), neighbor,
    ]);
    expect(deserializeFingerprint(withPayload(extraKind))).toBeNull();
    // A kind index past the table.
    const badIndex = Buffer.from(bytes);
    badIndex[1 + 256 + 1 + 1 + "function".length + 1] = 7;
    expect(deserializeFingerprint(withPayload(badIndex))).toBeNull();
  });

  it("refuses an impossible count before allocating for it", () => {
    const sketch = payload(serializeFingerprint(realistic)).subarray(1, 1 + 256);
    // Kind count 2^49 in seven varint bytes, with nothing after it.
    const huge = Buffer.concat([Buffer.of(5), sketch, Buffer.of(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01)]);
    expect(deserializeFingerprint(withPayload(huge))).toBeNull();
  });

  it("rejects invalid UTF-8 in a verbatim neighbour", () => {
    const fingerprint = { ...realistic, neighbors: ["ab"] };
    const bytes = Buffer.from(payload(serializeFingerprint(fingerprint)));
    bytes[bytes.length - 1] = 0xff;
    expect(deserializeFingerprint(withPayload(bytes))).toBeNull();
  });
});
