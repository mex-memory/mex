/**
 * §7.2's `WikiEngine` facade.
 *
 * The facade wraps; it does not re-decide. So the assertions that matter here
 * are not "does `list` return entities" — the synchronous service has its own
 * suite for that — but the three things a wrapper can get wrong:
 *
 *   1. **It answers identically to the function it wraps.** A facade that
 *      reshaped an answer would make two callers of one engine disagree, which
 *      is the drift §20.7's parity requirement exists to forbid. Every read is
 *      asserted deep-equal against the service call it delegates to.
 *   2. **It carries diagnostics through.** §7.2's literal signatures return
 *      bare data; dropping the diagnostics half would make a scaffold with no
 *      index indistinguishable from an empty one.
 *   3. **The two-phase migration means something.** `applyMigration(plan)`
 *      re-plans and refuses when the scaffold moved, rather than accepting a
 *      plan argument it ignores.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiEngine } from "../service.js";
import { wikiBacklinks, wikiGet, wikiGraph, wikiList, wikiNeighborhood, wikiSearch } from "../service/read.js";
import { wikiRebuildIndex } from "../service/write.js";
import { readAuditLog } from "../operations/audit.js";
import { locateEntity } from "../operations/locate.js";
import { entityContentHash } from "../model/hash.js";
import { entityTextOf } from "../markdown/codec.js";

const ARCH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const GATEWAY = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";

const SCAFFOLD: Record<string, string> = {
  "context/architecture.md": `<!-- mex:entity
id: ${ARCH}
type: architecture
status: promoted
revision: 1
relations:
  - type: depends_on
    target: ${GATEWAY}
-->
## System architecture

Three services behind one gateway.

<!-- mex:entity
id: ${GATEWAY}
type: component
status: promoted
revision: 1
-->
## Gateway

Terminates TLS and routes by path prefix.
`,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed SQLite files.
    }
  }
});

function scaffold(indexed = true): string {
  const root = mkdtempSync(join(tmpdir(), "mex-facade-"));
  roots.push(root);
  for (const [path, text] of Object.entries(SCAFFOLD)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  if (indexed) wikiRebuildIndex({ scaffoldRoot: root });
  return root;
}

describe("the WikiEngine facade", () => {
  it("answers every read exactly as the function it wraps", async () => {
    const root = scaffold();
    const engine = createWikiEngine({ scaffoldRoot: root });

    // Deep equality against the delegate, not a re-assertion of the delegate's
    // own contract. A facade that "helpfully" reshaped one of these would pass
    // a test that only checked the shape it produced.
    expect(await engine.list()).toEqual(wikiList({ scaffoldRoot: root }));
    expect(await engine.get(ARCH)).toEqual(wikiGet({ scaffoldRoot: root, id: ARCH }));
    expect(await engine.get(ARCH, { includeBody: true })).toEqual(
      wikiGet({ scaffoldRoot: root, id: ARCH, includeBody: true }),
    );
    expect(await engine.search("gateway")).toEqual(wikiSearch({ scaffoldRoot: root, text: "gateway" }));
    expect(await engine.related(ARCH)).toEqual(wikiNeighborhood({ scaffoldRoot: root, id: ARCH }));
    expect(await engine.backlinks(GATEWAY)).toEqual(wikiBacklinks({ scaffoldRoot: root, id: GATEWAY }));
    expect(await engine.graph()).toEqual(wikiGraph({ scaffoldRoot: root }));
  });

  it("is answering over a scaffold with something in it", async () => {
    // The equality assertions above would all hold over two empty answers, so
    // the subject is asserted non-empty before they are trusted.
    const engine = createWikiEngine({ scaffoldRoot: scaffold() });
    const listed = await engine.list();
    expect(listed.data.entities).toHaveLength(2);
    expect(listed.data.entities.map((entity) => entity.id).sort()).toEqual([GATEWAY, ARCH].sort());
    const related = await engine.related(ARCH);
    expect(related.data?.relations.map((edge) => edge.targetId)).toEqual([GATEWAY]);
  });

  it("passes filters through rather than dropping them", async () => {
    const engine = createWikiEngine({ scaffoldRoot: scaffold() });
    const components = await engine.list({ type: "component" });
    expect(components.data.entities.map((entity) => entity.id)).toEqual([GATEWAY]);
    const architectures = await engine.list({ type: "architecture" });
    expect(architectures.data.entities.map((entity) => entity.id)).toEqual([ARCH]);
  });

  it("reports a missing index as a diagnostic rather than as an empty wiki", async () => {
    const engine = createWikiEngine({ scaffoldRoot: scaffold(false) });
    expect(await engine.hasIndex()).toBe(false);

    const listed = await engine.list();
    expect(listed.data.entities).toEqual([]);
    // The distinction §7.2's bare `Promise<WikiEntitySummary[]>` cannot make.
    expect(listed.diagnostics.map((entry) => entry.code)).toContain("WIKI_INDEX_MISSING");
    expect(listed.diagnostics[0]?.remediation).toContain("rebuild-index");
  });

  it("does not create an index by being read", async () => {
    const root = scaffold(false);
    const engine = createWikiEngine({ scaffoldRoot: root });
    await engine.list();
    await engine.get(ARCH);
    await engine.search("gateway");
    // A read that rebuilds turns a 10ms query into a 5s one at random and
    // hides that the index was broken. Asserted as an absence on disk.
    expect(existsSync(join(root, "wiki.db"))).toBe(false);
  });

  it("builds and refreshes an index through the service, not through `index/`", async () => {
    const root = scaffold(false);
    const engine = createWikiEngine({ scaffoldRoot: root });

    const built = await engine.rebuildIndex();
    expect(built.data.entityCount).toBe(2);
    expect(existsSync(join(root, "wiki.db"))).toBe(true);

    const file = join(root, "context", "architecture.md");
    writeFileSync(file, `${readFileSync(file, "utf-8")}\nAn extra sentence.\n`, "utf-8");
    const refreshed = await engine.refreshFiles(["context/architecture.md"]);
    expect(refreshed.data.reparsed).toEqual(["context/architecture.md"]);
    expect(refreshed.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("refuses to refresh an index that is not there, without building one", async () => {
    const root = scaffold(false);
    const engine = createWikiEngine({ scaffoldRoot: root });
    const refreshed = await engine.refreshFiles(["context/architecture.md"]);
    expect(refreshed.diagnostics.map((entry) => entry.code)).toContain("WIKI_INDEX_MISSING");
    expect(existsSync(join(root, "wiki.db"))).toBe(false);
  });

  it("plans an operation without writing, and writes only when told to", async () => {
    const root = scaffold();
    const engine = createWikiEngine({ scaffoldRoot: root });
    const before = readFileSync(join(root, "context", "architecture.md"), "utf-8");

    // Two things a caller has to get right, and both are load-bearing rather
    // than ceremony. `entityId` and the preconditions are **envelope** fields,
    // not payload fields — the envelope says which entity and in what state,
    // the payload says what to make of it. And `baseContentHash` is *required*
    // on a mutating operation: an unconditional write would silently overwrite
    // an edit made between plan and apply, and the audit log would record a
    // success. The hash comes from locating the entity, which is what any real
    // caller does.
    const located = locateEntity(GATEWAY, { scaffoldRoot: root });
    expect(located, "the fixture entity must be locatable before it can be updated").not.toBeNull();
    const envelope = {
      opId: "op_facade_1",
      type: "update-entry",
      actor: { kind: "human", id: "tester" },
      timestamp: "2026-08-25T00:00:00.000Z",
      entityId: GATEWAY,
      baseRevision: 1,
      baseContentHash: entityContentHash(entityTextOf(located!.text, located!.entity.location!)),
      payload: { summary: "Terminates TLS." },
    };

    const planned = await engine.planOperation(envelope);
    expect(planned.data.planned).toBe(true);
    expect(planned.data.diff).toContain("Terminates TLS.");
    expect(readFileSync(join(root, "context", "architecture.md"), "utf-8")).toBe(before);

    // The default is a plan, not an error and not a write. An agent that
    // forgets the flag gets a diff.
    const withheld = await engine.applyOperation(envelope);
    expect(withheld.data.applied).toBe(false);
    expect(readFileSync(join(root, "context", "architecture.md"), "utf-8")).toBe(before);
    expect(readAuditLog(root).entries).toEqual([]);

    const applied = await engine.applyOperation(envelope, { apply: true });
    expect(applied.data.applied).toBe(true);
    expect(readFileSync(join(root, "context", "architecture.md"), "utf-8")).not.toBe(before);
  });

  it("validates with no code graph, and reports how much was checked", async () => {
    const engine = createWikiEngine({ scaffoldRoot: scaffold() });
    const report = await engine.validate();
    expect(report.data.entitiesChecked).toBe(2);
    expect(report.data.counts.error).toBe(0);
  });
});

describe("the facade's two-phase migration", () => {
  /**
   * A pre-wiki scaffold, shaped the way migration actually requires.
   *
   * Two things this fixture has to get right, both learned by watching it
   * abstain. A file-level entity's metadata *is* the frontmatter `mex:` key, so
   * a file with no frontmatter block is abstained on rather than having one
   * invented above its prose. And a section under the substantiality threshold
   * — 3 lines and 25 words — is deliberately not made into an entity. A fixture
   * missing either produces an empty plan, and then every assertion downstream
   * of it passes over nothing.
   */
  const LEGACY: Record<string, string> = {
    "context/architecture.md": `---
name: architecture
description: How the system fits together.
---
# Architecture

## System architecture

Three services sit behind one gateway, which terminates TLS and routes by
path prefix. The services do not talk to one another directly; everything
crosses the gateway so that authentication happens in exactly one place and
the audit trail has a single writer.
`,
    "patterns/retry.md": `---
name: retry-with-backoff
description: Retry idempotent calls with exponential backoff.
---
# Retry with backoff

Retry idempotent calls with exponential backoff and full jitter. A fixed
delay synchronises every client that failed at the same moment, so the
retry storm arrives together and the recovering service falls over again.
Cap the total elapsed time rather than the attempt count.
`,
  };

  function legacyScaffold(): string {
    const root = mkdtempSync(join(tmpdir(), "mex-facade-mig-"));
    roots.push(root);
    for (const [path, text] of Object.entries(LEGACY)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      writeFileSync(absolute, text, "utf-8");
    }
    return root;
  }

  it("plans without writing, and mints no id", async () => {
    const root = legacyScaffold();
    const engine = createWikiEngine({ scaffoldRoot: root });
    const before = readFileSync(join(root, "patterns", "retry.md"), "utf-8");

    const plan = await engine.planMigration();
    expect(plan.data.report.dryRun).toBe(true);
    expect(plan.data.report.planned.length).toBeGreaterThan(0);
    expect(plan.data.report.idsGenerated).toEqual([]);
    expect(plan.data.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, "patterns", "retry.md"), "utf-8")).toBe(before);
  });

  it("digests the same work identically across two plans of one tree", async () => {
    const engine = createWikiEngine({ scaffoldRoot: legacyScaffold() });
    const first = await engine.planMigration();
    const second = await engine.planMigration();
    // P6 made the decided work deterministic precisely so a re-run recomputes
    // it. If this ever fails, the digest is measuring something volatile and
    // `applyMigration` would refuse every honest plan.
    expect(second.data.digest).toBe(first.data.digest);
  });

  it("applies a plan that still describes the tree", async () => {
    const root = legacyScaffold();
    const engine = createWikiEngine({ scaffoldRoot: root });
    const plan = await engine.planMigration();

    const applied = await engine.applyMigration(plan.data);
    expect(applied.data.applied).toBe(true);
    expect(applied.data.report.dryRun).toBe(false);
    expect(applied.data.report.idsGenerated.length).toBeGreaterThan(0);
    expect(readFileSync(join(root, "patterns", "retry.md"), "utf-8")).toContain("mex:");
  });

  it("refuses a plan the scaffold has moved out from under, and writes nothing", async () => {
    const root = legacyScaffold();
    const engine = createWikiEngine({ scaffoldRoot: root });
    const plan = await engine.planMigration();

    // A new file is new work: the plan the caller reviewed no longer describes
    // what applying would do.
    writeFileSync(
      join(root, "patterns", "caching.md"),
      `---
name: cache-reads
description: Cache idempotent reads at the edge.
---
# Cache reads

Cache idempotent reads at the edge, keyed on the full request path and on
the caller's tenant. A cache keyed on the path alone serves one tenant's
data to another, which is the kind of bug that gets found by a customer.
`,
      "utf-8",
    );
    const before = readFileSync(join(root, "patterns", "retry.md"), "utf-8");

    const refused = await engine.applyMigration(plan.data);
    expect(refused.data.applied).toBe(false);
    expect(refused.diagnostics.map((entry) => entry.code)).toContain("CONTENT_HASH_CONFLICT");
    expect(readFileSync(join(root, "patterns", "retry.md"), "utf-8")).toBe(before);
    // The refusal is worth nothing if it happened after the write.
    expect(readAuditLog(root).entries).toEqual([]);
  });

  it("does not refuse for a change that is not the plan's business", async () => {
    // The digest deliberately excludes diffs and diagnostics. A file the
    // migration abstains on gaining a sentence must not invalidate a plan —
    // refusing then would be refusing for a reason that is not about the work.
    const root = legacyScaffold();
    writeFileSync(join(root, "ROUTER.md"), "# Router\n\nNavigation.\n", "utf-8");
    const engine = createWikiEngine({ scaffoldRoot: root });
    const plan = await engine.planMigration();

    writeFileSync(join(root, "ROUTER.md"), "# Router\n\nNavigation, revised.\n", "utf-8");
    const applied = await engine.applyMigration(plan.data);
    expect(applied.data.applied).toBe(true);
  });
});
