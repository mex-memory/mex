import { describe, expect, it } from "vitest";
import { shareProblems } from "../share-checks.js";
import { entry } from "./fixtures.js";

const reasons = (text: string) => shareProblems(entry("mx_share1", {}, text)).map(p => p.reason);

describe("share checks", () => {
  it("pass ordinary knowledge", () => {
    expect(reasons("Use date-fns, not moment, because moment is unmaintained.")).toEqual([]);
    expect(reasons("Config lives in src/config/index.ts; see https://github.com/acme/app/pull/12.")).toEqual([]);
  });
  it.each([
    ["The key is ghp_abcdefghijklmnopqrstuvwxyz0123456789 for now.", "contains a possible secret"],
    [String.raw`Fixtures are in C:\Users\sam\fixtures because CI copies them.`,"names a folder on someone's machine"],
    ["Fixtures are in /home/sam/fixtures because CI copies them.", "names a folder on someone's machine"],
    ["Ask sam@acme.test before changing the schema.", "contains an email address"],
    ["The staging DB is at 10.0.3.14, so tests never touch it.", "names a private network address"],
    ["Deploys go through build.acme.internal, because it holds the keys.", "names a private host"],
    ["Hidden\u200b text.", "contains hidden characters"],
  ])("stop %s", (text, reason) => {
    expect(reasons(text)).toContain(reason);
  });
});
