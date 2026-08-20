import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createFingerprint, createFingerprintBuilder } from "../fingerprint.js";
import { FingerprintStore } from "../fingerprint-store.js";
import type { Fingerprint } from "../reconcile.js";

describe("corpus fingerprint builder", () => {
  it("is bit-for-bit equivalent to independent fingerprint construction", () => {
    const builder = createFingerprintBuilder();
    const cases = [
      { tokens: [] as string[], callers: [] as string[], callees: [] as string[] },
      { tokens: ["Identifier", "OpenParenToken"], callers: ["b"], callees: ["a"] },
      {
        tokens: [
          "FunctionKeyword", "Identifier", "OpenParenToken", "CloseParenToken",
          "OpenBraceToken", "ReturnKeyword", "Identifier", "SemicolonToken", "CloseBraceToken",
        ],
        callers: ["caller-b", "caller-a"],
        callees: ["callee", "caller-a"],
      },
      {
        tokens: [
          "FunctionKeyword", "Identifier", "OpenParenToken", "CloseParenToken",
          "OpenBraceToken", "ReturnKeyword", "StringLiteral", "SemicolonToken", "CloseBraceToken",
        ],
        callers: ["other"],
        callees: [],
      },
    ];

    for (const entry of cases) {
      expect(builder.create(entry.tokens, entry.callers, entry.callees)).toEqual(
        createFingerprint(entry.tokens, entry.callers, entry.callees),
      );
    }
  });

  it("batch-upserts deterministic final fingerprints and replaces old LSH rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    for (const id of ["a", "b"]) {
      db.prepare(
        `INSERT INTO nodes (
           id, kind, name, qualified_name, identity_key, file_path, language,
           start_line, end_line, start_column, end_column, updated_at
         ) VALUES (?, 'function', ?, ?, ?, 'src/a.ts', 'typescript', 1, 1, 0, 1, 1)`,
      ).run(id, id, id, id);
    }
    const value = (offset: number): Fingerprint => ({
      minhash: Array.from({ length: 64 }, (_, index) => offset + index),
      neighbors: [],
      tokenCount: 40,
    });
    const oldA = value(1);
    const newA = value(10_000);
    const b = value(20_000);
    const store = new FingerprintStore(db);

    store.upsertMany([
      { nodeId: "a", fingerprint: oldA },
      { nodeId: "b", fingerprint: b },
      { nodeId: "a", fingerprint: newA },
    ]);
    expect(store.get("a")).toEqual(newA);
    expect(store.get("b")).toEqual(b);
    expect(store.lookup(newA).map((entry) => entry.nodeId)).toContain("a");
    expect(store.lookup(oldA).map((entry) => entry.nodeId)).not.toContain("a");

    store.upsert("a", oldA);
    expect(store.get("a")).toEqual(oldA);
    expect(store.lookup(newA).map((entry) => entry.nodeId)).not.toContain("a");
    db.close();
  });
});
