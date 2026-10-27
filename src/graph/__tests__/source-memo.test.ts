import { describe, expect, it } from "vitest";
import { recallDigest, recallSource, rememberDigest, rememberSource, reserveHeldBytes, withSourceMemo, withSourceSpoolBudget } from "../source-memo.js";

// Two different files can share every identity field: on Windows a 64-bit
// file id loses precision as a number, and a checkout writes same-sized
// sibling files within one millisecond.
const identity = { dev: 7, ino: 2 ** 60, size: 42, mtimeMs: 1_790_000_000_000, ctimeMs: 1_790_000_000_000 };

describe("source memo", () => {
  it("bounds the isolated spool without reusing live-source bytes, and releases its budget on failure", async () => {
    expect(reserveHeldBytes(1)).toBe(false);
    await expect(withSourceSpoolBudget(async () => {
      expect(reserveHeldBytes(64 * 1024 * 1024)).toBe(true);
      await withSourceSpoolBudget(async () => expect(reserveHeldBytes(1)).toBe(false));
      await withSourceMemo(async () => expect(reserveHeldBytes(1)).toBe(false));
      rememberSource("/repo/src/a.ts", identity, "a");
      expect(recallSource("/repo/src/a.ts", identity)).toBeUndefined();
      throw new Error("interrupted");
    })).rejects.toThrow("interrupted");
    expect(reserveHeldBytes(1)).toBe(false);
    await withSourceSpoolBudget(async () => expect(reserveHeldBytes(64 * 1024 * 1024)).toBe(true));
  });

  it("never answers one file with another file's bytes or digest", async () => {
    await withSourceMemo(async () => {
      rememberSource("/repo/src/duplicate-b.controller.ts", identity, "export class DuplicateBController {}\n");
      rememberDigest("/repo/.mex/graph.db", identity, "b".repeat(64));
      expect(recallSource("/repo/src/duplicate-a.controller.ts", identity)).toBeUndefined();
      expect(recallDigest("/repo/.mex/graph.db.candidate", identity)).toBeUndefined();
      expect(recallSource("/repo/src/duplicate-b.controller.ts", identity)).toBe("export class DuplicateBController {}\n");
      expect(recallDigest("/repo/.mex/graph.db", identity)).toBe("b".repeat(64));
    });
  });

  it("holds nothing outside a maintenance operation", async () => {
    rememberSource("/repo/src/a.ts", identity, "a");
    expect(recallSource("/repo/src/a.ts", identity)).toBeUndefined();
    await withSourceMemo(async () => {
      expect(recallSource("/repo/src/a.ts", identity)).toBeUndefined();
    });
  });
});
