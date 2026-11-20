import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRecordReadOnly } from "../../record/index.js";
import { knowledgeProject } from "../context.js";
import { propose, summarizeResults, type GateContext, type Proposal, type ProposedCheck } from "../gate.js";
import { parseEntry, type EntryCheck } from "../entry.js";
import { entryProducer, listProducers, producerEntryId } from "../producers.js";
import { expandPersonal } from "../store.js";
import { forget } from "../mutations.js";
import { reviewQueue } from "../../review/queue.js";
import { prepareTeamWrite } from "../team.js";

let base: string, context: GateContext;
const now = new Date("2026-11-19T12:00:00Z");
const fact = (over: Partial<Proposal> = {}): Proposal => ({
  producer: "code-facts", key: "generated", kind: "pitfall", text: "The generated types are refreshed from the schema.",
  source: { type: "mined", ref: "generator" }, anchors: { scope: ["src/**"] }, model: "none", ...over,
});
const target = { file: "src/config.ts", symbol: "PORT" };
const check = { kind: "value", role: "supporting", target } as const;
const observed = { ...check, saw: { value: 3000 }, files: {} } satisfies EntryCheck;
const save = async (p: Proposal, over: Partial<GateContext> = {}) => (await propose([p], { ...context, ...over }))[0]!;
const root = () => context.projectPath;
function write(path: string, text: string) {
  const file = join(root(), path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mex-producer-gate-"));
  context = { projectPath: join(base, "repo"), home: join(base, "home"), isNetwork: () => false, now,
    observeChecks: checks => checks.map(request => ({ check: { ...request, saw: observed.saw, files: {} } as EntryCheck })) };
  mkdirSync(root());
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("producer validation", () => {
  it("uses the first failure and refuses machine commands and inactive producers", async () => {
    const result = await propose([
      fact({ producer: "session-ongoing", text: "" }),
      fact({ producer: "session-ongoing", text: "Use the vault password=abcdefgh12345678." }),
      fact({ text: "Use the vault password=abcdefgh12345678." }),
      fact({ text: "Use `npm run absent`." }),
      fact({ anchors: { scope: ["**/**"] } }),
      fact({ source: { type: "review", ref: "Review comment", quote: "Something else", text: "What was said" } }),
    ], context);
    expect(result.map(item => item.status === "dropped" && item.reason))
      .toEqual(["invalid", "inactive-producer", "secret", "undefined-command", "no-anchor", "quote-not-found"]);
    expect(listProducers().filter(p => !p.active).map(p => p.id)).toEqual(["session-import", "session-ongoing"]);
  });

  it("sanitizes a note and verifies inert environment prefixes", async () => {
    write("package.json", JSON.stringify({ scripts: { test: "node tests.js" } }));
    const text = "Use `TZ=UTC npm test` before applying the schema. Run `npm run absent` when testing.";
    const result = await save(fact({ producer: "note", text, anchors: undefined, source: { type: "person", ref: "mex note", quote: text, text } }));
    expect(result).toMatchObject({ status: "accepted", sanitized: ["text", "oneLine", "quote"] });
    if (result.status !== "accepted") throw new Error("Expected a saved note");
    expect(expandPersonal(result.entryId, context).entry.text).toContain("`TZ=UTC npm test`");
    expect(expandPersonal(result.entryId, context).entry.text).toContain("[unverified command removed]");
    expect(await save(fact({ text: "TZ=UTC npm run absent" }))).toMatchObject({ reason: "undefined-command" });
  });

  it("uses the contained file for a file quote and normalizes whitespace", async () => {
    write("src/guide.md", "Line one\r\n   line two.");
    expect(await save(fact({ source: { type: "docs", ref: "src/guide.md", quote: "Line one line two." } }))).toMatchObject({ status: "accepted" });
    expect(await save(fact({ key: "other", source: { type: "docs", ref: "src/guide.md", quote: "Implicit source", text: "Implicit source" } })))
      .toMatchObject({ reason: "quote-not-found" });
  });

  it("re-observes one batch, preserves order, and writes only fresh checks", async () => {
    const different: ProposedCheck = { ...check, saw: { value: 123 } };
    const observeChecks = vi.fn<NonNullable<GateContext["observeChecks"]>>(() => [
      { reason: "No matching symbol." }, { check: observed }, { check: observed },
    ]);
    const results = await propose([
      fact({ key: "missing", checks: [check] }),
      fact({ key: "different", checks: [different] }),
      fact({ key: "fresh", checks: [check] }),
    ], { ...context, observeChecks });
    expect(observeChecks).toHaveBeenCalledTimes(1);
    expect(results).toMatchObject([{ reason: "check-fails", detail: "No matching symbol." }, { reason: "check-fails" }, { status: "accepted", change: "new" }]);
    expect(expandPersonal(producerEntryId("code-facts", "fresh"), context).entry.mex.checks).toEqual([observed]);
    expect(await save(fact({ text: "The manifest defines runtime dependencies.", checks: [check] }), { observeChecks: () => undefined }))
      .toMatchObject({ reason: "checks-unavailable" });
    expect(summarizeResults(results)).toBe("1 saved, 0 to Review, 2 dropped (check-fails 2)");
  });

  it("rejects matching claims and rule lines, and never restores forgotten claims", async () => {
    write("AGENTS.md", "# Instructions\n\n- Keep generated files out of coverage.\n");
    expect(await save(fact({ text: "Keep generated files out of coverage." }))).toMatchObject({ reason: "duplicate-rule-line" });
    const first = await save(fact());
    expect(first).toMatchObject({ status: "accepted" });
    expect(await save(fact({ key: "duplicate" }))).toMatchObject({ reason: "duplicate-entry" });
    const id = producerEntryId("code-facts", "generated");
    forget(id, "Keep this out of knowledge.", context, now);
    expect(await save(fact({ key: "forgotten" }))).toMatchObject({ reason: "forgotten" });
    expect(await save(fact({ text: "A changed claim for the same id." }))).toMatchObject({ reason: "forgotten" });
  });
});

describe("producer publication", () => {
  it("does not rewrite identical files or record data and stores evidence locally", async () => {
    const proposal = fact({ evidence: ["journal-row-4", 9], label: "mined from code, 9 of 10 sites" });
    const id = producerEntryId("code-facts", "generated");
    expect(await save(proposal)).toEqual({ status: "accepted", entryId: id, change: "new" });
    const project = knowledgeProject(context);
    const path = join(context.home!, "projects", project.projectId, "notes", id + ".md");
    const before = statSync(path).mtimeMs, raw = readFileSync(path, "utf8");
    const reader = openRecordReadOnly(context)!;
    try { expect(JSON.parse(reader.setting(project.projectId, `knowledge.gate.${id}`)!).evidence).toEqual(proposal.evidence); }
    finally { reader.close(); }
    expect(raw).not.toContain("journal-row");
    expect(entryProducer(parseEntry(raw).mex)).toBe("code-facts");
    expect(await save(proposal, { now: new Date("2026-11-20") })).toEqual({ status: "accepted", entryId: id, change: "unchanged" });
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("rolls back files and side data together when an owning job fails to save", async () => {
    const first = fact();
    const id = producerEntryId("code-facts", "generated");
    expect(await save(first)).toMatchObject({ change: "new" });
    await expect(save(fact({ text: "The updated schema changes these types." }), {
      validate: writer => { expect(writer.checkout(root())).toBeDefined(); },
      onAccepted: (writer, accepted) => {
        expect(accepted[0]).toMatchObject({ entryId: id, change: "updated" });
        writer.db.prepare("INSERT INTO settings VALUES(?,?,?)").run("global", "fixture", "wrote");
        throw new Error("lost lease");
      },
    })).rejects.toThrow("lost lease");
    expect(expandPersonal(id, context).entry.text).toBe(first.text);
    const reader = openRecordReadOnly(context)!;
    try { expect(reader.setting("global", "fixture")).toBeUndefined(); } finally { reader.close(); }
  });

  it("retires an owned replacement target and sweeps only its given subset", async () => {
    const id = (key: string) => producerEntryId("code-facts", key);
    await propose([fact(), fact({ key: "other", text: "The adapter owns error reporting.", anchors: { scope: ["adapter/**"] } })], context);
    const replacement = fact({ key: "replacement", text: "The generated types now follow the API schema.", replaces: id("generated") });
    expect(await save(replacement)).toMatchObject({ change: "new" });
    expect(await save(replacement)).toMatchObject({ change: "unchanged" });
    expect(() => expandPersonal(id("generated"), context)).toThrow();
    expect(await propose([], { ...context, sweep: { producer: "code-facts", includes: entry => entry.mex.scope.includes("src/**") } })).toEqual([]);
    expect(() => expandPersonal(id("replacement"), context)).toThrow();
    expect(expandPersonal(id("other"), context).entry.text).toBe("The adapter owns error reporting.");
  });

  it("routes opposite triggers with overlapping globs to Review", async () => {
    const pattern = "import internal";
    await save(fact({ anchors: { scope: ["src/*/internal/**"], when: [{ type: "anti", match: "literal", pattern }] } }));
    const opposite = fact({ key: "opposite", text: "Internal modules use the common import.", anchors: {
      scope: ["src/api/**"], when: [{ type: "required", match: "literal", pattern }],
    } });
    const first = await save(opposite);
    expect(first).toMatchObject({ status: "review", reason: "contradiction", conflictsWith: [producerEntryId("code-facts", "generated")] });
    expect(await save(opposite)).toEqual(first);
    expect(reviewQueue(context, now.getTime()).items).toHaveLength(1);
  });

  it("accepts a changed observation if the conflicting older baseline is already broken", async () => {
    const old = { ...observed, saw: { value: 2000 } } as EntryCheck;
    await save(fact({ checks: [check] }), { observeChecks: () => [{ check: old }] });
    const proposal = fact({ key: "new", text: "The default port is now 3000.", checks: [check] });
    expect(await save(proposal, { observeVerdicts: () => new Map([[producerEntryId("code-facts", "generated"), "held"]]) }))
      .toMatchObject({ status: "review" });
    expect(await save(proposal, { observeVerdicts: () => new Map([[producerEntryId("code-facts", "generated"), "changed"]]) }))
      .toMatchObject({ status: "accepted" });
  });
});

describe("replacement, sweep and team regressions", () => {
  const id = (key: string) => producerEntryId("code-facts", key);
  const complete = { kind: "value", role: "complete", target } as const;
  const port = (over: Partial<Proposal> = {}) => fact({ key: "port", kind: "fact", text: "The server listens on port 3000 by default.",
    checks: [complete], ...over });

  it("replaces an entry with the same claim and check, without forgetting the claim", async () => {
    expect(await save(port())).toMatchObject({ change: "new" });
    const replacement = port({ key: "port-api", anchors: { scope: ["src/api/**"] }, replaces: id("port") });
    expect(await save(replacement)).toMatchObject({ status: "accepted", entryId: id("port-api"), change: "new" });
    expect(() => expandPersonal(id("port"), context)).toThrow();
    expect(await save(replacement)).toMatchObject({ change: "unchanged" });
    expect(await save(port({ key: "port-api", anchors: { scope: ["src/api/**"] }, label: "mined from code, 2 of 2" })))
      .toMatchObject({ status: "accepted", change: "updated" });
    // The producer never revives the id it replaced.
    expect(await save(port())).toMatchObject({ reason: "forgotten" });
  });

  it("keeps a producer's entry when a re-keyed proposal duplicates it under a sweep", async () => {
    const sweep = { producer: "code-facts" } as const;
    expect((await propose([port()], { ...context, sweep }))[0]).toMatchObject({ status: "accepted" });
    const rekeyed = await propose([port({ key: "port-2", text: "Port 3000 is the default listen port." })], { ...context, sweep });
    expect(rekeyed).toMatchObject([{ reason: "duplicate-entry", detail: id("port") }]);
    expect(expandPersonal(id("port"), context).entry.mex.status).toBe("active");
  });

  it("retires stale entries even when another proposal in the batch is dropped", async () => {
    const sweep = { producer: "code-facts" } as const;
    await propose([fact(), fact({ key: "stale", text: "The adapter owns error reporting.", anchors: { scope: ["adapter/**"] } }),
      fact({ key: "kept", text: "Schemas live under src/schema.", anchors: { scope: ["src/schema/**"] } })], context);
    const results = await propose([fact(), fact({ key: "kept", text: "Schemas live under src/schema. Use `npm run absent`.", anchors: { scope: ["src/schema/**"] } })],
      { ...context, sweep });
    expect(results).toMatchObject([{ change: "unchanged" }, { reason: "undefined-command" }]);
    expect(() => expandPersonal(id("stale"), context)).toThrow();
    expect(expandPersonal(id("kept"), context).entry.text).toBe("Schemas live under src/schema.");
    expect(expandPersonal(id("generated"), context).entry.mex.status).toBe("active");
  });

  it("skips the sweep when a dropped proposal names no entry", async () => {
    const sweep = { producer: "code-facts" } as const;
    await propose([fact(), fact({ key: "stale", text: "The adapter owns error reporting.", anchors: { scope: ["adapter/**"] } })], context);
    const unnamed = { ...fact({ text: "" }), key: undefined };
    expect(await propose([fact(), unnamed], { ...context, sweep })).toMatchObject([{ change: "unchanged" }, { reason: "invalid" }]);
    expect(expandPersonal(id("stale"), context).entry.mex.status).toBe("active");
  });

  it("verifies npm workspace scripts with the flag before or after the script", async () => {
    write("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    write("packages/api/package.json", JSON.stringify({ name: "@acme/api", scripts: { generate: "node gen.mjs" } }));
    const text = (command: string) => `Regenerate the client with \`${command}\` after schema changes.`;
    for (const [key, command] of [["after", "npm run generate --workspace packages/api"], ["before", "npm run -w packages/api generate"]]) {
      expect(await save(fact({ key, text: text(command) }))).toMatchObject({ status: "accepted" });
    }
    expect(await save(fact({ key: "missing", text: text("npm run missing --workspace packages/api") }))).toMatchObject({ reason: "undefined-command" });
  });

  it("writes team files without provenance and skips malformed team files", async () => {
    write(".mex/learned/mx_broken01.md", ["---", "mex:", "  id: mx_broken01", "---", "Not an entry.", ""].join("\n"));
    const onSkipped = vi.fn();
    const text = "Keep the release notes in docs/releases.";
    const saved = await save(fact({ producer: "note", text, anchors: undefined, label: "a person's note", source: { type: "person", ref: "mex note", quote: text, text } }),
      { onSkipped });
    expect(saved).toMatchObject({ status: "accepted" });
    expect(onSkipped).toHaveBeenCalledWith({ team: 1, hint: 0 });
    if (saved.status !== "accepted") throw new Error("Expected a saved note");
    const personal = expandPersonal(saved.entryId, context).entry;
    expect(personal.mex.source).toMatchObject({ producer: "note", label: "a person's note" });
    const preview = prepareTeamWrite(personal, context, text);
    expect(preview.after).not.toMatch(/producer:|model:|label:/u);
    expect(parseEntry(preview.after).mex.source).toEqual({ type: "person", ref: "mex note", quote: text });
  });
});
