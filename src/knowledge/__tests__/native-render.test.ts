import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPS, renderNative } from "../native-render.js";
import type { Candidate } from "../native-select.js";
import { entry } from "./fixtures.js";

const golden = (name: string) => readFileSync(join(__dirname, "golden", name), "utf8").replace(/\r\n/gu, "\n");
const team = (id: string, text: string, evidence: "person" | "docs" = "person"): Candidate => ({ level: "team", entry: entry(id, { evidence, scope: ["apps/api/**"] }, text) });

describe("rendering native rule files", () => {
  it("matches the Claude rules golden file: paths, marker, strongest first, ids as comments", () => {
    const out = renderNative("claude-rules", "apps/api", [
      team("mx_api002", "API errors go through AppError, so clients get one error shape."),
      team("mx_api001", "Validate request bodies with zod,\n because handlers trust their input."),
    ]);
    expect(out.text).toBe(golden("claude-rules-api.md"));
    expect(out.ids).toEqual(["mx_api001", "mx_api002"]);
  });

  it("matches the Codex AGENTS.md golden file", () => {
    const out = renderNative("codex-agents", "", [{ level: "team", entry: entry("mx_root01", {}, "Use date-fns, not moment, because moment is unmaintained.") }]);
    expect(out.text).toBe(golden("codex-agents-root.md"));
  });

  it("says under every title that existing code takes precedence", () => {
    for (const format of Object.keys(CAPS) as (keyof typeof CAPS)[]) for (const area of ["", "apps/api"]) {
      const out = renderNative(format, area, [team("mx_api001", "Validate request bodies with zod.")]);
      expect(out.text).toMatch(/^# MEX rules(?: for apps\/api)?\n\nExisting code takes precedence over these notes\.\nReport a wrong rule with `mex wrong <id> "<reason>"`\.\n\n- /mu);
    }
  });

  it("drops the weakest items over the format's cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => team(`mx_n${String(i).padStart(5, "0")}`, `Rule number ${i} ${"x".repeat(300)}.`, i < 5 ? "person" : "docs"));
    const out = renderNative("claude-rules", "apps/api", many);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(CAPS["claude-rules"]);
    expect(out.dropped.length).toBeGreaterThan(0);
    expect(out.ids.slice(0, 5)).toEqual(["mx_n00000", "mx_n00001", "mx_n00002", "mx_n00003", "mx_n00004"]);
  });
});

describe("retrieval aids stay out of rule files", () => {
  it("never renders aliases or asks, and skips proposed entries", async () => {
    const { selectNative } = await import("../native-select.js");
    const c = team("mx_api003", "Retry webhooks with backoff, because providers rate-limit.");
    Object.assign(c.entry.mex, { aliases: ["webhook storm"], asks: ["why do webhooks fail with 429?"] });
    const out = renderNative("codex-agents", "", [c]);
    expect(out.text).not.toMatch(/webhook storm|429/u);
    const proposed: Candidate = { level: "team", entry: entry("mx_api004", { status: "proposed", scope: ["**"] }, "Use the queue for webhooks.") };
    expect(selectNative([proposed]).skipped).toEqual([{ id: "mx_api004", reason: "not yet accepted" }]);
  });
});
