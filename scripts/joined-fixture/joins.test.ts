import { describe, expect, it } from "vitest";
import { checkAccepted, checkCard, checkKept, checkProbe, checkReceipt, checkSetupJobs, JoinError, type Receipt } from "./joins.js";

// Each join, broken on purpose, fails with a message that names it.
const file = "src/widget.ts";
const card = `[mex abc123]\n${file}:1-3\nexport function makeWidget() {\n  return 31;\n}`;
const given: Receipt = { entry_id: "mex:span:1", surface: "search-span", action: "given", block_id: "abc123", form: "full" };

describe("joined fixture checks", () => {
  it("setup: a job that did not finish", () => {
    expect(() => checkSetupJobs([{ kind: "file-index", state: "done", reason: null }], ["file-index", "code-facts"]))
      .toThrow(new JoinError("bare mex did not finish its code-facts job (missing)"));
    expect(() => checkSetupJobs([{ kind: "file-index", state: "failed", reason: "no git" }], ["file-index"]))
      .toThrow("bare mex did not finish its file-index job (failed: no git)");
    expect(() => checkSetupJobs([{ kind: "file-index", state: "done", reason: null }], ["file-index"])).not.toThrow();
  });

  it("producer gate: a proposal without anchors is dropped", () => {
    expect(() => checkAccepted({ status: "dropped" }, "symbol")).toThrow(/the gate did not accept the symbol proposal/);
    expect(checkAccepted({ status: "accepted", entryId: "mx_1" }, "symbol")).toBe("mx_1");
  });

  it("card: the surface is off, or the card lacks the code", () => {
    expect(() => checkCard("", "codex", "search-span", file, "makeWidget", "return 31;")).toThrow("codex returned no context for makeWidget with search-span enabled");
    expect(() => checkCard(card, "codex", "search-span", file, "makeWidget", "return 470;")).toThrow("codex sent no search-span card for makeWidget");
    expect(() => checkCard(card, "codex", "search-span", file, "makeWidget", "return 31;")).not.toThrow();
  });

  it("receipt: the delivered block has no receipt", () => {
    expect(() => checkReceipt(card, [], "claude-code", "search-span")).toThrow("claude-code has no search-span receipt for the delivered block");
    expect(() => checkReceipt(card, [{ ...given, block_id: "other" }], "claude-code", "search-span")).toThrow(/no search-span receipt/);
    expect(() => checkReceipt(card, [given], "claude-code", "search-span")).not.toThrow();
  });

  it("never stale: restated text, or no withheld or pointer receipt", () => {
    const when = "after its symbol changed";
    expect(() => checkKept("Keep one widget for each request.", [], "mx_1", "Keep one widget", when)).toThrow("entry mx_1 was restated after its symbol changed");
    expect(() => checkKept("", [{ ...given, entry_id: "mx_1" }], "mx_1", "Keep one widget", when)).toThrow(/was not withheld or reduced to a pointer/);
    expect(() => checkKept("", [{ ...given, entry_id: "mx_1", action: "withheld", form: "one-line" }], "mx_1", "Keep one widget", when)).not.toThrow();
  });

  it("never stale: the controller would still send the entry in full", () => {
    const when = "after a shell write";
    expect(() => checkProbe({ ok: true, results: [{ id: "mx_1", verdict: "held", form: "full", text: "makeWidget returns 31." }] }, "mx_1", "returns 31", when))
      .toThrow("entry mx_1 would still be sent in full after a shell write (held, full)");
    expect(() => checkProbe({ ok: true, results: [{ id: "mx_1", verdict: "changed", form: "pointer", text: "returns 31" }] }, "mx_1", "returns 31", when)).toThrow(/in full/);
    expect(() => checkProbe({ ok: false }, "mx_1", "x", when)).toThrow(/no verdict, no form/);
    expect(() => checkProbe({ ok: true, results: [{ id: "mx_1", verdict: "changed", form: "pointer", text: "See src/widget.ts:1." }] }, "mx_1", "returns 31", when)).not.toThrow();
  });
});
