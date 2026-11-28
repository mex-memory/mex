import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { coversMostCode, indexedSourcePaths } from "../learned-scope.js";

const cases = JSON.parse(readFileSync(new URL("../../../test/fixtures/knowledge/broad-learned.json", import.meta.url), "utf8")) as
  Array<{ name: string; scopes: string[]; paths: string[]; broad: boolean }>;

it.each(cases)("$name", ({ scopes, paths, broad }) => {
  expect(coversMostCode(scopes, () => indexedSourcePaths(paths))).toBe(broad);
});
