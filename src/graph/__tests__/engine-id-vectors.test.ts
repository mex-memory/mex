import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalNodeIdentity, generateNodeId } from "../extraction/node-id.js";
import type { NodeKind } from "../types.js";

// The Rust tests cover both identity profiles. Node's extractor shares the
// signature vectors with Rust, while ECMAScript ordinal ids are engine-owned.
const VECTORS = join(import.meta.dirname, "../../../native/engine/core/tests/id-vectors.json");

interface SignatureInput {
  profile: "signature";
  path: string;
  kind: NodeKind;
  qualifiedName: string;
  declarationRole?: string;
  signature: string;
}

describe("shared node-id vectors for the Rust engine", () => {
  const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Array<{
    input: SignatureInput | { profile: "ordinal" };
    identity: string;
    id: string;
  }>;

  it("matches Node extraction for the signature profile", () => {
    for (const { input, identity, id } of vectors) {
      if (input.profile !== "signature") continue;
      const { path, kind, qualifiedName, declarationRole = kind, signature } = input;
      expect(canonicalNodeIdentity(path, kind, qualifiedName, declarationRole, signature)).toBe(identity);
      expect(generateNodeId(path, kind, qualifiedName, qualifiedName, declarationRole, signature)).toBe(id);
    }
  });

  it("covers both profiles and distinct ids", () => {
    expect(new Set(vectors.map(({ input }) => input.profile))).toEqual(new Set(["signature", "ordinal"]));
    expect(new Set(vectors.map(({ id }) => id)).size).toBe(vectors.length);
  });
});
