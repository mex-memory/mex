import { expect, it, vi } from "vitest";
import { Gaps } from "../harvest/evidence.js";
import { RegionReader, reviewRegions } from "../harvest/regions.js";
import { sourceDigest } from "../source.js";

const path = "src/transport.ts";
const original = "a".repeat(40), merge = "b".repeat(40), head = "c".repeat(40);
const gap = "Some merged review anchors could not be located uniquely.";

async function review(before: string[] | undefined, after: string[], first: number, options: {
  last?: number; current?: string[]; hunk?: string;
} = {}) {
  const { last = first, current, hunk = `@@ -${first} +${first} @@\n ${before?.[first - 1]}` } = options;
  const reader = new RegionReader(".");
  const snapshots = new Map([[original, before], [merge, after], [head, current]]);
  vi.spyOn(reader, "read").mockImplementation(async commit => snapshots.get(commit));
  const gaps = new Gaps();
  const result = await reviewRegions({ path, original, merge, head: current ? head : merge, side: "RIGHT", first, last,
    hunk, changedPaths: [path] }, reader, gaps);
  return { ...result, gaps: gaps.list() };
}

function region(commit: string, start: number, lines: string[]) {
  const text = lines.join("\n");
  return { path, commit, start, end: start + lines.length - 1, text, hash: sourceDigest(text) };
}

it("recovers a replacement when the comment and both direct neighbours changed", async () => {
  const before = ["// test setup", "const suite = prepare();", "describe('authorization', () => {",
    "  it.only('Should authorize', checkOldToken);", "  recordOldMetrics();", "});", "// test teardown", "finalize();"];
  const after = [...before.slice(0, 2), "describe('session authorization', () => {",
    "  it('Should authorize', checkSession);", "  recordSessionMetrics();", ...before.slice(5)];

  const result = await review(before, after, 4);

  expect(result.actedOn).toBe(true);
  expect(result.code?.anchor).toBe(before[3]);
  expect(result.code?.after).toEqual(region(merge, 1, after.slice(0, 8)));
  expect(result.code?.head).toEqual(result.code?.after);
  expect(result.gaps).toEqual([]);
});

it("cuts three lines on each side of a deletion and maps that point to HEAD", async () => {
  const before = ["// startup", "initialize();", "validate();", "useLegacyFallback();", "legacyCleanup();",
    "connect();", "await ready();", "run();", "// end"];
  const after = [...before.slice(0, 3), ...before.slice(5)];
  const current = ["// new header", "configure();", ...after];

  const result = await review(before, after, 4, { last: 5, current,
    hunk: "@@ -4,2 +4,2 @@\n useLegacyFallback();\n legacyCleanup();" });

  expect(result.actedOn).toBe(true);
  expect(result.code?.after).toEqual(region(merge, 1, after.slice(0, 6)));
  expect(result.code?.head).toEqual(region(head, 3, after.slice(0, 6)));
});

it("maps unchanged lines when the same block occurs twice in the merged file", async () => {
  const block = ["  {", "    mode: Mode;", "    region: Region;", "    topic: string;",
    "    retries: number;", "    active: boolean;", "  };"];
  const before = ["type Incoming =", ...block, "// incoming ends", "// end of file", "// later move"];
  const after = ["// later move", ...before.slice(0, -2), "type Outgoing =", ...block, "// end of file"];

  const result = await review(before, after, 5, { last: 6,
    hunk: "@@ -5,2 +5,2 @@\n     topic: string;\n     retries: number;" });

  expect(result.actedOn).toBe(false);
  expect(result.code?.after).toEqual(region(merge, 3, after.slice(2, 10)));
  expect(result.gaps).toEqual([]);
});

it("maps a merged replacement through later insertions and changed neighbours", async () => {
  const before = ["openConnection();", "prepareOldOptions();", "connectInsecurely();",
    "useOldChannel();", "closeConnection();", "report();"];
  const after = ["openConnection();", "prepareOptions();", "connectSecurely();",
    "useChannel();", "closeConnection();", "report();"];
  const current = ["// transport settings", "const port = readPort();", "openConnection();",
    "prepareOptions(port);", "connectSecurely();", "useNewChannel();", "closeConnection();", "report();"];

  const result = await review(before, after, 3, { current });

  expect(result.actedOn).toBe(true);
  expect(result.code?.head).toEqual(region(head, 1, current));
});

it("keeps the anchor unchanged when whitespace and adjacent lines change", async () => {
  const before = ["openConnection();", "const port = readPort();", "connect(port);", "closeConnection();"];
  const after = [before[0]!, "const port  =  readPort();", "validatePort(port);", ...before.slice(2)];
  const result = await review(before, after, 2);

  expect(result.actedOn).toBe(false);
  expect(result.code?.after).toEqual(region(merge, 1, after));
});

it("keeps the gap when a file is rewritten", async () => {
  const before = ["{", "prepareTransport();", "connectLocally();", "closeTransport();", "}"];
  const after = ["{", "const endpoint = configuredUrl();", "await startServer(endpoint);", "await checkHealth();", "}"];
  const result = await review(before, after, 3, { current: before });

  expect(result.actedOn).toBe(false);
  expect(result.code?.before).toEqual(region(original, 1, before));
  expect(result.code?.after).toBeUndefined();
  expect(result.code?.head).toBeUndefined();
  expect(result.gaps).toEqual([gap]);
});

it("rejects a mapped gap wider than 60 merged lines", async () => {
  const before = ["openConnection();", "connectInsecurely();", "closeConnection();"];
  const result = await review(before, [before[0]!, ...Array<string>(60).fill("retry();"), before[2]!], 2);

  expect(result.code?.after).toBeUndefined();
  expect(result.gaps).toEqual([gap]);
});

it("rejects a bracket whose original flanks are too far from the comment", async () => {
  const before = ["openConnection();", ...Array<string>(60).fill("retry();"), "connectInsecurely();", "closeConnection();"];
  const result = await review(before, [before[0]!, "connectSecurely();", before.at(-1)!], 62);

  expect(result.code?.after).toBeUndefined();
  expect(result.gaps).toEqual([gap]);
});

it("uses the file boundary and a mapped flank for a deletion at EOF", async () => {
  const after = ["openConnection();", "connectSecurely();", "closeConnection();"];
  const result = await review([...after, "reopenConnection();"], after, 4);

  expect(result.actedOn).toBe(true);
  expect(result.code?.after).toEqual(region(merge, 1, after));
});

it("keeps alignment for hunk-only evidence", async () => {
  const after = ["// transport", "openConnection();", "connectSecurely();", "closeConnection();"];
  const result = await review(undefined, after, 2, {
    hunk: "@@ -1,3 +1,3 @@\n openConnection();\n-connect();\n+connectInsecurely();\n closeConnection();",
  });

  expect(result.actedOn).toBe(true);
  expect(result.code?.before?.start).toBe(1);
  expect(result.code?.after).toEqual(region(merge, 1, after));
});

it("falls back to alignment on files over 20,000 lines", async () => {
  const padding = Array<string>(20_000).fill("");
  const before = ["openConnection();", "connectInsecurely();", "closeConnection();", ...padding];
  const after = ["openConnection();", "connectSecurely();", "closeConnection();", ...padding];
  const result = await review(before, after, 2);

  expect(result.actedOn).toBe(true);
  expect(result.code?.after).toEqual(region(merge, 1, after.slice(0, 17)));
});
