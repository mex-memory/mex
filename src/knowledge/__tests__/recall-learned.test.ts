import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLearnedRecall, recallLearned } from "../recall-learned.js";
import { BROAD_LEARNED_REASON } from "../learned-scope.js";
import { entry } from "./fixtures.js";

const { expand, readChecks } = vi.hoisted(() => ({ expand: vi.fn(), readChecks: vi.fn() }));
vi.mock("../store.js", async importOriginal => ({ ...await importOriginal<typeof import("../store.js")>(), expand }));
vi.mock("../check.js", async importOriginal => ({ ...await importOriginal<typeof import("../check.js")>(),
  nativeBinary: () => "fixture-native", runNative: readChecks, cachedVerdicts: () => undefined }));

const root = mkdtempSync(join(tmpdir(), "mex-recall-learned-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const options = { projectPath: root, home: join(root, "home") };
const id = "mx_review1";
const source = "https://github.com/example/project/pull/12#discussion_r31";
const evidence = { type: "review", producer: "learn-deeper", ref: source,
  label: "from 2 PRs, 3 maintainers", quote: "Use the stable accessor for shared keys." } as const;
const fix = { path: "src/keys.ts", lines: "2-3", commit: "a".repeat(40), snippet: "  const key = stableKey()\n  return key" };

function subject(level: "personal" | "team", verdict: "held" | "changed" | "broken" | "unknown", scopePass = false, scope = "**") {
  const prepared = entry(id, { evidence: "review", source: evidence, one_line: "Use the stable accessor.", scope: [scope] }, "It normalizes shared keys.");
  Object.assign(prepared.mex, { fix });
  expand.mockReturnValue({ entry: prepared, level, label: "[learned]" });
  readChecks.mockReturnValue({ items: [{ id, level, verdict }], results: [{ entry_id: id, checks: scopePass ? [{ kind: "scope", status: "pass" }] : [] }] });
  const item = recallLearned(id, options);
  expect(item).toBeDefined();
  return item!;
}

describe("recall by learned entry id", () => {
  it("returns a broad filename rule and explains its always-on setting", () => {
    const item = subject("personal", "held", false, "**/*.go");
    expect(item).toMatchObject({ claim: "Use the stable accessor.", deliveryReason: BROAD_LEARNED_REASON });
    expect(formatLearnedRecall(item)).toContain(BROAD_LEARNED_REASON);
  });

  it("prints the current claim, why, code, provenance, label and personal quote", () => {
    const item = subject("personal", "held");
    expect(item).toMatchObject({ verdict: "held", action: "given", claim: "Use the stable accessor.",
      why: "It normalizes shared keys.", quote: evidence.quote, fix, sources: [source] });
    expect(formatLearnedRecall(item)).toContain("Current checks hold.");
    expect(formatLearnedRecall(item)).toContain("from 2 PRs, 3 maintainers");
    expect(formatLearnedRecall(item)).toContain(fix.snippet);
    expect(formatLearnedRecall(item)).toContain("src/keys.ts:2-3 at " + fix.commit);
  });

  it("omits the quote for a shared copy", () => {
    const item = subject("team", "held");
    expect(item).not.toHaveProperty("quote");
    expect(formatLearnedRecall(item)).not.toContain(evidence.quote);
  });

  it.each([
    ["personal", "changed", "replaced", "Being checked"],
    ["team", "changed", "replaced", "Being checked"],
    ["personal", "broken", "withheld", "no longer supports"],
    ["team", "broken", "withheld", "no longer supports"],
    ["personal", "unknown", "withheld", "could not verify"],
  ] as const)("keeps %s %s entry text out of the response", (level, verdict, action, status) => {
    const item = subject(level, verdict);
    expect(item).toMatchObject({ verdict, action });
    for (const key of ["claim", "why", "quote", "fix", "sources"]) expect(item).not.toHaveProperty(key);
    expect(formatLearnedRecall(item)).toContain(status);
    expect(formatLearnedRecall(item)).not.toContain("Use the stable accessor.");
  });

  it("gives an unknown entry with a verified scope", () => {
    const item = subject("personal", "unknown", true);
    expect(item).toMatchObject({ verdict: "unknown", action: "given", fix });
  });
});
