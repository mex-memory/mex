/**
 * Equal broader-tier scores are broken by how much an entity's text is about
 * the matched terms, not by title: in a wiki where one entity per fact repeats
 * the same nouns, title order buried the answer below its alphabetical peers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { openWikiQuery } from "../session.js";
import { openWikiContractReadSession } from "../contract-session.js";
import { createScaffold, steppingClock, type Scaffold } from "../../index/__tests__/harness.js";

const PASSING = "mx_01KW0KKT00Q5R49QMFGW64X5T6";
const FOCUSED = "mx_01KWJMCV00XQ0PJ1A3TAPZR2ZN";
const FILLER = ["mx_01KRMEXM00JAAVJPQVVRX8N56V", "mx_01KS6FPN00RT04JXY9QEG0JN19", "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV"];

function block(id: string, title: string, body: string): string {
  return `<!-- mex:entity\nid: ${id}\ntype: fact\nstatus: promoted\nrevision: 1\n-->\n## ${title}\n\n${body}\n\n`;
}

let scaffold: Scaffold;
let indexPath: string;

beforeAll(() => {
  scaffold = createScaffold();
  indexPath = join(scaffold.root, "wiki.db");
  scaffold.write(
    "context/facts.md",
    block(PASSING, "Alpha notes", "Logging and metrics are per environment; refresh tokens rotate, among many other settings.")
      + block(FOCUSED, "Zeta notes", "Refresh tokens rotate: each refresh issues new tokens and the old refresh tokens rotate out.")
      + FILLER.map((id, index) => block(id, `Filler ${index}`, "Unrelated prose about builds and releases.")).join(""),
  );
  rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath, now: steppingClock() });
});

afterAll(() => scaffold.dispose());

describe("ties in the broader tier", () => {
  it("puts the entity most about the matched terms first, in the CLI and the Hub", () => {
    const opened = openWikiQuery(indexPath);
    if (!opened.ok) throw new Error(opened.diagnostic.message);
    try {
      const page = opened.value.search("When do refresh tokens rotate weekly?");
      expect(page.match).toBe("some_terms");
      expect(page.items.map((hit) => hit.entity.id)).toEqual([FOCUSED, PASSING]);
    } finally {
      opened.value.close();
    }
    const session = openWikiContractReadSession({ scaffoldRoot: scaffold.root, indexPath });
    try {
      expect(session.search({ query: "When do refresh tokens rotate weekly?" }).items.map((hit) => hit.entity.id))
        .toEqual([FOCUSED, PASSING]);
    } finally {
      session.close();
    }
  });
});
