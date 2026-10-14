import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { rebuildWikiIndex } from "../../index/rebuild.js";
import { refreshWikiIndex } from "../../index/refresh.js";
import { openWikiIndexForWrite } from "../../index/open.js";
import { WIKI_META_KEYS, WIKI_SCHEMA_VERSION } from "../../index/schema.js";
import { openWikiQuery } from "../session.js";
import { openWikiContractReadSession } from "../contract-session.js";
import { createScaffold, type Scaffold } from "../../index/__tests__/harness.js";

const ROOT = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
const CHILD = "mx_01KS6FPN00RT04JXY9QEG0JN19";
const ROUTING = "mx_01KSRGFP00P5TVKWJ2P5Z9DFJV";
let scaffold: Scaffold | undefined;
afterEach(() => { scaffold?.dispose(); scaffold = undefined; });

function project(summary?: string): { root: string; indexPath: string } {
  scaffold = createScaffold();
  scaffold.write("patterns/hub.md", `---
description: Browser sessions isolate cross-origin tabs with private cookies.
triggers: [session bootstrap, browser isolation]
mex:
  id: ${ROOT}
  type: pattern
  status: promoted
  revision: 1
  metadata:
    aliases: [loopback security]
${summary === undefined ? "" : `  summary: ${summary}\n`}---
# Local Hub

The Hub runs on a local port.

<!-- mex:entity
id: ${CHILD}
type: fact
status: promoted
revision: 1
-->
## Pagination

Responses have a fixed page size.
`);
  scaffold.write("context/routing.md", `---
description: Route matching preserves path parameters.
triggers: [SmartRouter selection, route params]
mex:
  id: ${ROUTING}
  type: component
  status: promoted
  revision: 1
---
# Request Routing

Dispatch selects a handler.
`);
  scaffold.write("context/other.md", `<!-- mex:entity
id: mx_01KTAH8Q004DSGTECA5MBCRZ88
type: convention
status: promoted
revision: 1
-->
## Logging

Diagnostics include a request identifier.
`);
  const indexPath = join(scaffold.root, "wiki.db");
  rebuildWikiIndex({ scaffoldRoot: scaffold.root, indexPath });
  return { root: scaffold.root, indexPath };
}

function hits(indexPath: string, question: string): string[] {
  const opened = openWikiQuery(indexPath);
  if (!opened.ok) throw new Error(opened.diagnostic.message);
  try { return opened.value.search(question, { limit: 5 }).items.map(hit => hit.entity.id); }
  finally { opened.value.close(); }
}

describe("authored discovery hints", () => {
  it("finds unseen question wording through description and triggers in both read surfaces", () => {
    const { root, indexPath } = project();
    // New probes exercise authored hints without changing strict/broader ranking.
    const questions = [
      ["How do browser sessions isolate cross-origin tabs?", ROOT],
      ["Where is session bootstrap described?", ROOT],
      ["How does SmartRouter selection work?", ROUTING],
      ["What preserves path parameters?", ROUTING],
      ["loopback security", ROOT],
    ];
    const session = openWikiContractReadSession({ scaffoldRoot: root, indexPath });
    try {
      for (const [question, expected] of questions) {
        const ids = hits(indexPath, question!);
        expect(ids[0], question).toBe(expected);
        expect(ids).not.toContain(CHILD);
        expect(session.search({ query: question!, limit: 5 }).items.map(hit => hit.entity.id)).toEqual(ids);
      }
      for (const question of ["How are database transactions committed?", "Which machine learning models train here?", "How does GraphQL federation work?"]) {
        expect(hits(indexPath, question)).toEqual([]);
        expect(session.search({ query: question, limit: 5 }).items).toEqual([]);
      }
      // The hint changes only derived retrieval text, never authored entity summary.
      expect(session.get(ROOT)?.summary).toBeNull();
    } finally { session.close(); }
  });

  it("preserves an explicit summary and refreshes changed hints without changing Markdown", () => {
    const { root, indexPath } = project("Trusted local transport");
    expect(hits(indexPath, "Trusted local transport")[0]).toBe(ROOT);
    expect(hits(indexPath, "cross-origin tabs")).toEqual([]);
    const path = join(root, "patterns/hub.md");
    const original = readFileSync(path, "utf8");
    scaffold!.write("patterns/hub.md", original.replace("session bootstrap", "session handshake"));
    const changed = readFileSync(path, "utf8");
    const refreshed = refreshWikiIndex({ scaffoldRoot: root, indexPath, changed: ["patterns/hub.md"] });
    expect(refreshed.ok).toBe(true);
    expect(hits(indexPath, "session handshake")[0]).toBe(ROOT);
    expect(readFileSync(path, "utf8")).toBe(changed);
  });

  it("refuses indexes with the earlier FTS meaning without rebuilding them on a read", () => {
    const { indexPath } = project();
    const opened = openWikiIndexForWrite(indexPath);
    if (!opened.ok) throw new Error(opened.diagnostic.message);
    opened.index.db.prepare("UPDATE wiki_meta SET value = ? WHERE key = ?")
      .run(String(WIKI_SCHEMA_VERSION - 1), WIKI_META_KEYS.schemaVersion);
    opened.index.close();
    const before = { bytes: readFileSync(indexPath), mtime: statSync(indexPath).mtimeMs };
    const refused = openWikiQuery(indexPath);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.diagnostic.code).toBe("WIKI_INDEX_REBUILD_REQUIRED");
    expect(readFileSync(indexPath)).toEqual(before.bytes);
    expect(statSync(indexPath).mtimeMs).toBe(before.mtime);
  });
});
