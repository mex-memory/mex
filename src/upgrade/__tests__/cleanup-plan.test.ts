import { describe, expect, it } from "vitest";
import { planInstructionRewrite, planLegacyCleanup } from "../cleanup-plan.js";
import type { LegacySnapshot } from "../legacy-reader.js";
import { parseWikiMarkdown } from "../../wiki/markdown/contract.js";

const old = "<!-- mex-agent:skills:start -->\nOld wiki query, logging and timeline instructions.\n<!-- mex-agent:skills:end -->";

describe("upgrade tracked cleanup preview", () => {
  it("rewrites exactly ten managed lines and preserves BOM, CRLF and human bytes", () => {
    const before = `\uFEFF# Human rules\r\nLeave these bytes alone.\r\n${old.replace(/\n/gu, "\r\n")}\r\nFooter\r\n`;
    const plan = planInstructionRewrite(before);
    expect(plan.review).toBe(false);
    expect(plan.after?.startsWith("\uFEFF# Human rules\r\nLeave these bytes alone.\r\n")).toBe(true);
    expect(plan.after?.endsWith("\r\nFooter\r\n")).toBe(true);
    expect(plan.after).not.toMatch(/(?<!\r)\n/u);
    expect(plan.after?.split("<!-- mex-agent:skills:start -->")[1].split("<!-- mex-agent:skills:end -->")[0].split("\r\n")).toHaveLength(10);
    expect(plan.after).not.toContain("wiki query");
    expect(planInstructionRewrite(plan.after!)).toEqual({ review: false });
  });

  it("keeps one guidance block when both old marker families exist", () => {
    const text = `${old}\n\nHuman middle.\n\n<!-- mex-anchor:start -->\nOld router pointer.\n<!-- mex-anchor:end -->\nHuman end.\n`;
    const plan = planInstructionRewrite(text);
    expect(plan.after).toContain("Human middle.");
    expect(plan.after).toContain("Human end.");
    expect(plan.after?.match(/## MEX project knowledge/gu)).toHaveLength(1);
    expect(plan.after).not.toContain("mex-anchor:");
  });

  it("leaves human instructions and fenced marker examples alone", () => {
    expect(planInstructionRewrite("# Human\nRun the checks.\n")).toEqual({ review: false });
    expect(planInstructionRewrite(`\`\`\`md\n${old}\n\`\`\`\n`)).toEqual({ review: false });
  });

  it("requires review for incomplete or repeated real markers", () => {
    expect(planInstructionRewrite("<!-- mex-agent:skills:start -->\nHuman remainder.\n")).toEqual({ review: true });
    expect(planInstructionRewrite(`${old}\n${old}\n`)).toEqual({ review: true });
  });

  it("only proposes existing obsolete files and preserves context and navigation", () => {
    const snapshot: LegacySnapshot = { present: true, complete: true, logRows: [], retained: [], excluded: [], diagnostics: [],
      documents: [
        { path: ".mex/SETUP.md", text: "old setup", kind: "obsolete" as const },
        { path: ".mex/SYNC.md", text: "old sync", kind: "obsolete" as const },
        { path: ".mex/ROUTER.md", text: "navigation", kind: "router" as const },
        { path: ".mex/context/rules.md", text: "human knowledge", kind: "context" as const },
      ].map(file => ({ ...file, hash: "sha256:" + "a".repeat(64), bytes: file.text.length, parsed: parseWikiMarkdown({ path: file.path, text: file.text }) })) };
    expect(planLegacyCleanup(snapshot)).toEqual({ changes: [
      { path: ".mex/SETUP.md", before: "old setup", after: null },
      { path: ".mex/SYNC.md", before: "old sync", after: null },
    ], issues: [] });
    snapshot.complete = false;
    expect(planLegacyCleanup(snapshot).changes).toEqual([]);
  });
});
