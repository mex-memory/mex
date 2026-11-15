import { afterEach, describe, expect, it } from "vitest";
import { closeSync, cpSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readLegacyScaffold } from "../legacy-reader.js";
import { LEGACY_LIMITS, LegacyFiles } from "../legacy-files.js";

const roots: string[] = [];
const ID = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SECOND = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NODE = "function:12345678abcdefab";
const FP = "mh:2:0123456789abcdef";
const metadata = (id = ID) => `id: ${id}\ntype: decision\nstatus: promoted\nrevision: 3`;
const wiki = (id = ID, body = "Keep writes explicit.") => `---\nmex:\n${metadata(id).split("\n").map(line => `  ${line}`).join("\n")}\n---\n# Decision\n${body}\n`;

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "mex-upgrade-reader-"));
  roots.push(path);
  return path;
}
function put(repo: string, path: string, text: string | Buffer): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
function digestTree(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const child of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${child.name}` : child.name;
      if (child.isDirectory()) walk(path);
      else out[path] = createHash("sha256").update(readFileSync(join(repo, path))).digest("hex");
    }
  };
  walk("");
  return out;
}
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("0.8 scaffold upgrade reader", () => {
  it("does nothing in a repo without a scaffold or a MEX home", () => {
    const repo = root();
    put(repo, "AGENTS.md", "Instructions are not a legacy scaffold by themselves.\n");
    const before = digestTree(repo);
    expect(readLegacyScaffold(repo)).toEqual({ present: false, complete: true, documents: [], logRows: [], retained: [], excluded: [], diagnostics: [] });
    expect(digestTree(repo)).toEqual(before);
  });

  it("reads a real-shaped scaffold without Git or either valid index and changes no bytes", () => {
    const repo = root();
    put(repo, ".mex/config.json", '{"scaffold_id":"existing","wiki":{"exclude":["private/**"]}}');
    put(repo, ".mex/AGENTS.md", "# MEX\nPreserve the local convention.\n");
    put(repo, ".mex/ROUTER.md", "# Router\n| Task | File |\n| Setup | context/setup.md |\n");
    put(repo, ".mex/context/design.md", wiki());
    put(repo, ".mex/patterns/recovery.md", "# Recovery\nRun the explicit recovery command.\n");
    put(repo, ".mex/SETUP.md", "Old setup instructions.\n");
    put(repo, ".mex/SYNC.md", "Old sync instructions.\n");
    put(repo, "AGENTS.md", "# Local rules\nKeep unrelated edits.\n");
    put(repo, "CLAUDE.md", "<!-- mex-agent:skills:start -->\nOld managed text.\n<!-- mex-agent:skills:end -->\nHuman text.\n");
    put(repo, ".mex/wiki.db", "deliberately not SQLite");
    put(repo, ".mex/wiki.db-wal", "also not SQLite");
    put(repo, ".mex/graph.db", "not a graph database");
    put(repo, ".mex/private/hidden.md", wiki(SECOND));
    put(repo, ".mex/local/do-not-read.md", "---\nmex: [broken\n---\n");
    put(repo, ".mex/diagrams/saved/record.md", wiki(SECOND));
    put(repo, ".mex/learned/mx_existing.md", "Already a new entry.\n");
    put(repo, ".mex/inbox/proposal.md", "A pending proposal, unchanged.\n");
    put(repo, ".mex/relays/open.md", "An open handoff, unchanged.\n");
    const before = digestTree(repo);
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(true);
    expect(result.present).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.documents.map(file => file.path)).toEqual([
      ".mex/AGENTS.md", ".mex/ROUTER.md", ".mex/SETUP.md", ".mex/SYNC.md", ".mex/context/design.md", ".mex/patterns/recovery.md", "AGENTS.md", "CLAUDE.md",
    ]);
    expect(result.documents.map(file => file.kind)).toEqual(["instructions", "router", "obsolete", "obsolete", "context", "pattern", "instructions", "instructions"]);
    expect(result.retained.map(file => file.path)).toEqual([".mex/inbox/proposal.md", ".mex/relays/open.md"]);
    expect(result.excluded).toEqual([".mex/private"]);
    expect(result.documents.find(file => file.kind === "context")?.parsed.entities[0].entity).toMatchObject({ id: ID, revision: 3, body: "Keep writes explicit.\n" });
    expect(readLegacyScaffold(repo)).toEqual(result);
    expect(digestTree(repo)).toEqual(before);
    expect(readdirSync(repo).sort()).toEqual([".mex", "AGENTS.md", "CLAUDE.md"]);
  });

  it("preserves canonical, root-level and unassigned groundings without refreshing a baseline", () => {
    const repo = root();
    const text = `---\ngrounds_to:\n  - node: ${NODE}\n    fingerprint: ${FP}\n    bodyHash: old-body\n    codeHash: old-code\n    file: src/api.ts\n    verifiedAt: 2026-10-01T10:00:00Z\n    reason: Old evidence\nmex:\n${metadata().split("\n").map(line => `  ${line}`).join("\n")}\n---\n# Decision\nOriginal text.\n`;
    put(repo, ".mex/context/root.md", text);
    put(repo, ".mex/context/section.md", `---\ngrounds_to:\n  - node: ${NODE}\n    fingerprint: ${FP}\n---\n<!-- mex:entity\n${metadata(SECOND)}\n-->\n## Section\nIts claim.\n`);
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(true);
    const first = result.documents[0];
    expect(first.text).toBe(text);
    expect(first.parsed.entities[0].entity.groundsTo).toEqual(first.parsed.legacy.groundsTo);
    expect(first.parsed.entities[0].entity.groundsTo[0]).toMatchObject({ bodyHash: "old-body", codeHash: "old-code", reason: "Old evidence" });
    expect(result.documents[1].parsed.entities[0].entity.groundsTo).toEqual([]);
    expect(result.documents[1].parsed.legacy.groundsTo).toEqual([{ node: NODE, fingerprint: FP }]);
    expect(result.diagnostics).toEqual([{ code: "GROUNDING_MIXED_SHAPE", path: first.path, severity: "info" }]);
  });

  it("retains BOM, CRLF, Unicode, relationships and source attribution exactly", () => {
    const repo = root();
    const text = `\uFEFF---\nmex:\n${metadata().split("\n").map(line => `  ${line}`).join("\n")}\n  relations:\n    - type: related_to\n      target: ${SECOND}\n      note: Kept evidence\n  provenance:\n    createdBy: {kind: human, id: original-author}\n    createdAt: 2026-10-01T10:00:00Z\n---\n# Décision 🧭\nThe original reason.\n`.replace(/\n/gu, "\r\n");
    put(repo, ".mex/context/a.md", text);
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(true);
    const source = result.documents[0];
    expect(source.text).toBe(text);
    expect(source.hash).toBe(`sha256:${createHash("sha256").update(Buffer.from(text)).digest("hex")}`);
    expect(source.bytes).toBe(Buffer.byteLength(text));
    expect(source.parsed.entities[0].entity.title).toBe("Décision 🧭");
    expect(source.parsed.entities[0].entity.relations[0]).toMatchObject({ target: SECOND, note: "Kept evidence" });
    expect(source.parsed.entities[0].entity.provenance).toMatchObject({ createdBy: { kind: "human", id: "original-author" }, createdAt: "2026-10-01T10:00:00Z" });
    expect(source.parsed.text).toBe(text);
  });

  it("preserves raw log fields and source lines; malformed rows do not hide later decisions", () => {
    const repo = root();
    const row = { timestamp: "2026-10-01T10:00:00Z", kind: "decision", message: "Keep the cache disposable.", files: ["src/api.ts"], actor: "original", extra: "unrecognised field" };
    const log = `${JSON.stringify(row)}\r\nnot JSON\r\n${JSON.stringify({ ...row, message: "A later decision." })}\r\n`;
    put(repo, ".mex/events/decisions.jsonl", log);
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(false);
    expect(result.log?.text).toBe(log);
    expect(result.logRows).toEqual([{ line: 1, value: row }, { line: 3, value: { ...row, message: "A later decision." } }]);
    expect(result.diagnostics).toEqual([{ code: "LEGACY_INVALID_LOG_ROW", path: ".mex/events/decisions.jsonl", line: 2, severity: "error" }]);
    expect(readFileSync(join(repo, ".mex/events/decisions.jsonl"), "utf8")).toBe(log);
  });

  it("reports malformed YAML and duplicate entity ids while keeping all source text", () => {
    const repo = root();
    put(repo, ".mex/context/a.md", wiki());
    put(repo, ".mex/context/b.md", wiki());
    put(repo, ".mex/context/c.md", "---\nmex: [secret private malformed text\n---\n# Broken\nOriginal prose.\n");
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(false);
    expect(result.documents).toHaveLength(3);
    expect(result.diagnostics.map(d => d.code)).toEqual(["LEGACY_DUPLICATE_ENTITY_ID", "WIKI_PARSE_ERROR"]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret private");
    expect(result.documents[2].text).toContain("Original prose.");
  });

  it("does not invent entities for metadata examples in code fences", () => {
    const repo = root();
    put(repo, ".mex/patterns/example.md", `# Recipe\n\n\`\`\`md\n<!-- mex:entity\n${metadata()}\n-->\n## Example\nNot a claim.\n\`\`\`\n`);
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(true);
    expect(result.documents[0].parsed.entities).toEqual([]);
  });

  it("diagnoses invalid config instead of silently accepting a different exclusion policy", () => {
    const repo = root();
    put(repo, ".mex/config.json", '{"wiki":{"exclude":[123]}}');
    put(repo, ".mex/context/a.md", wiki());
    expect(readLegacyScaffold(repo)).toMatchObject({ complete: false, diagnostics: [{ code: "LEGACY_INVALID_CONFIG" }] });
  });

  it("rejects invalid UTF-8 instead of replacing source bytes", () => {
    const repo = root();
    put(repo, ".mex/context/bad.md", Buffer.from([0xff, 0xfe]));
    put(repo, ".mex/context/good.md", wiki());
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(false);
    expect(result.documents.map(file => file.path)).toEqual([".mex/context/good.md"]);
    expect(result.diagnostics[0].code).toBe("LEGACY_UNREADABLE");
  });

  it("refuses oversize sparse files without reading or truncating them", () => {
    const repo = root();
    put(repo, ".mex/context/huge.md", "");
    const fd = openSync(join(repo, ".mex/context/huge.md"), "r+");
    try { ftruncateSync(fd, LEGACY_LIMITS.fileBytes + 1); } finally { closeSync(fd); }
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(false);
    expect(result.diagnostics[0].code).toBe("LEGACY_LIMIT");
    expect(lstatSync(join(repo, ".mex/context/huge.md")).size).toBe(LEGACY_LIMITS.fileBytes + 1);
  });

  it("bounds diagnostics while still retaining all readable documents", () => {
    const repo = root();
    for (let i = 0; i < LEGACY_LIMITS.diagnostics + 10; i++) put(repo, `.mex/context/${i}.md`, "---\nmex: [broken\n---\n# Original\n");
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(false);
    expect(result.documents).toHaveLength(LEGACY_LIMITS.diagnostics + 10);
    expect(result.diagnostics).toHaveLength(LEGACY_LIMITS.diagnostics);
    expect(result.diagnostics.at(-1)?.code).toBe("LEGACY_DIAGNOSTICS_OMITTED");
  });

  it("reads the existing Markdown fixture scaffold without depending on its index", () => {
    const repo = root();
    cpSync(resolve(__dirname, "../../../test/fixtures/wiki/scaffold"), join(repo, ".mex"), { recursive: true });
    const before = digestTree(repo);
    const result = readLegacyScaffold(repo);
    expect(result.documents).toHaveLength(8);
    expect(result.documents.flatMap(file => file.parsed.entities)).toHaveLength(8);
    expect(result.complete).toBe(true);
    expect(digestTree(repo)).toEqual(before);
  });
});

describe("legacy filesystem boundary", () => {
  it("rejects traversal and an absolute path", () => {
    const repo = root();
    const files = new LegacyFiles(repo);
    for (const path of ["../escape.md", "a/../escape.md", "a\\escape.md", "/escape.md"]) expect(() => files.read(path)).toThrow();
  });

  it("detects edits, replacements, newly created files and directory additions after observation", () => {
    for (const mutation of ["edit", "replace", "new-file", "directory"] as const) {
      const repo = root();
      put(repo, ".mex/context/a.md", "original");
      const files = new LegacyFiles(repo);
      files.list(".mex");
      files.read(".mex/context/a.md");
      files.read(".mex/missing.md");
      if (mutation === "edit") put(repo, ".mex/context/a.md", "changed");
      if (mutation === "replace") { rmSync(join(repo, ".mex/context/a.md")); put(repo, ".mex/context/a.md", "replacement"); }
      if (mutation === "new-file") put(repo, ".mex/missing.md", "new");
      if (mutation === "directory") mkdirSync(join(repo, ".mex/new"));
      expect(() => files.verify(), mutation).toThrow();
    }
  });

  it("refuses parent and leaf redirects without reading the destination", () => {
    const repo = root();
    const outside = root();
    put(outside, "secret.md", wiki());
    mkdirSync(join(repo, ".mex/context"), { recursive: true });
    // Directory junctions are available without Windows developer mode.
    symlinkSync(outside, join(repo, ".mex/redirect"), process.platform === "win32" ? "junction" : "dir");
    if (process.platform !== "win32") symlinkSync(join(outside, "secret.md"), join(repo, ".mex/context/leaf.md"));
    put(repo, ".mex/context/good.md", wiki(SECOND));
    const result = readLegacyScaffold(repo);
    expect(result.complete).toBe(false);
    expect(result.documents.map(file => file.path)).toEqual([".mex/context/good.md"]);
    expect(result.diagnostics.every(d => d.code === "LEGACY_UNSAFE_PATH")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(outside);
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe(wiki());
  });

  it("rejects a linked scaffold root", () => {
    const repo = root();
    const outside = root();
    put(outside, "AGENTS.md", "Private source");
    symlinkSync(outside, join(repo, ".mex"), process.platform === "win32" ? "junction" : "dir");
    expect(readLegacyScaffold(repo)).toMatchObject({ complete: false, documents: [], diagnostics: [{ code: "LEGACY_UNSAFE_PATH" }] });
  });
});
