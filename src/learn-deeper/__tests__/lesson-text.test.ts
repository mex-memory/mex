import { describe, expect, it } from "vitest";
import { unclippedQuote } from "../lesson-text.js";

describe("quote restrictions", () => {
  it.each([
    "Keep the second line blank.\n3. Do not wrap long URLs.",
    "Keep the second line blank.\n\nDo not leave the release summary blank.",
    "Keep the second line blank.\n## Release notes\nDo not leave the release summary blank.",
    "Keep the second line blank.\nWhen to write release notes\n---------------------------\nUse the template.",
  ])("stops at an unrelated item or section in %j", source => {
    expect(unclippedQuote("Keep the second line blank.", source)).toBe(true);
  });

  it("can cite consecutive list items without inheriting the neighboring items", () => {
    const source = [
      "1. Use no more than 72 characters in the subject.",
      "2. Keep the second line blank.",
      "3. Wrap the body at 72 columns, except for long URLs.",
      "4. Do not add links to the footer.",
    ].join("\r\n");
    const quote = "2. Keep the second line blank. 3. Wrap the body at 72 columns, except for long URLs.";
    expect(unclippedQuote(quote, source)).toBe(true);
    expect(unclippedQuote(quote, source, true)).toBe(false);
  });

  it("keeps negation and conditions across soft line breaks in the same sentence", () => {
    const source = "- Do not run `tasks.release!()`\n  before the build is signed.";
    expect(unclippedQuote("run `tasks.release!()` before the build is signed.", source)).toBe(false);
    expect(unclippedQuote("Do not run `tasks.release!()`", source)).toBe(false);
    expect(unclippedQuote("Do not run `tasks.release!()` before the build is signed.", source)).toBe(true);
  });

  it("checks the leading clause of a neighboring sentence for attached restrictions", () => {
    const quote = "Explain why the change was made, not how it works.";
    const source = `${quote} The diff shows what changed; add context the diff cannot convey.`;
    expect(unclippedQuote(quote, source)).toBe(true);
  });

  it.each([
    "Use the shared cache. But only for release builds.",
    "Use the shared cache.\n\nUnless the job is public.",
    "- Use the shared cache.\n- But only for release builds.",
    "- Use the shared cache.\n  - One exception: jobs with untrusted inputs.",
  ])("keeps an explicit follow-on qualifier in %j", source => {
    expect(unclippedQuote("Use the shared cache.", source)).toBe(false);
  });

  it("still rejects a quotation inside a word", () => {
    expect(unclippedQuote("test the build", "Retest the build.")).toBe(false);
  });
});
