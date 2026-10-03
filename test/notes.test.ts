import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { recordNote, findNotes, getNote } from "../src/notes/service.js";
import { NOTE_LIMITS, NoteError } from "../src/notes/contracts.js";
import { encodeNote, newNoteId, notePath } from "../src/notes/codec.js";
import { NOTE_ATTRIBUTES } from "../src/notes/storage.js";
import { appendEvent, readEvents } from "../src/events.js";
import { readLegacyTimeline } from "../src/team/activity/legacy.js";
import { discoverMarkdownFiles } from "../src/wiki/index/discover.js";
import { isReadOnlyPath } from "../src/wiki/operations/paths.js";
import { migrateScaffold } from "../src/wiki/migration/migrate.js";
import type { MexConfig } from "../src/types.js";

let root: string;
let config: MexConfig;
const roots: string[] = [];
function temp() { const path = mkdtempSync(join(tmpdir(), "mex-notes-")); roots.push(path); return path; }
beforeEach(() => { root = temp(); config = { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] }; });
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(message: string, timestamp = "2020-01-01T00:00:00.000Z") {
  const id = newNoteId(new Date(timestamp));
  const bytes = encodeNote({ id, timestamp, message, files: [], kind: "note", cwd: ".", originAdapter: "api",
    context: { projectId: null, repositoryId: null, worktreeId: null, actor: null, session: null, git: null } });
  const path = join(config.scaffoldRoot, notePath(id));
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  return { id, path };
}

describe("durable notes", () => {
  it.each(["plain", "", "  \n", "\n# Original\r\n💡 café\n\n", "---\nmex: not metadata\n---\n<!-- mex:entity -->", "no final newline", "\ufeffBOM in body"])("preserves supplied body exactly: %j", async (message) => {
    const receipt = await recordNote(config, { message, kind: "risk", files: ["src/../src/a.ts"], source: "agent", status: "observed", trace: ".mex/traces/example.md" });
    expect(receipt.state).toBe("locally_recorded");
    const note = getNote(config, receipt.id);
    expect(note).toMatchObject({ message, kind: "risk", files: ["src/a.ts"], source: "agent", status: "observed", trace: ".mex/traces/example.md", revision: receipt.revision, context: { actor: null, session: null, git: null }, cwd: null });
    expect(readFileSync(join(root, receipt.recordPath), "utf8").endsWith(`---\n${message}`)).toBe(true);
    expect(readdirSync(config.scaffoldRoot)).toEqual(["events"]);
  });

  it("retains distinct identities for equal unkeyed submissions and reads older IDs directly", async () => {
    const old = fixture("old note");
    const first = await recordNote(config, { message: "equal" });
    const second = await recordNote(config, { message: "equal" });
    expect(first.id).not.toBe(second.id);
    expect(findNotes(config, { limit: 1 }).events).toHaveLength(1);
    expect(findNotes(config, { limit: 1 }).truncated).toBe(true);
    expect(getNote(config, old.id).message).toBe("old note");
    expect(readEvents(config)).toEqual([]);
  });

  it("validates before writing and leaves missing stores missing on ordinary reads", async () => {
    expect(findNotes(config).events).toEqual([]);
    expect(() => getNote(config, newNoteId(new Date()))).toThrowError(expect.objectContaining({ code: "NOTE_NOT_FOUND" }));
    expect(readdirSync(root)).toEqual([]);
    for (const input of [ { message: "\ud800" }, { message: "界".repeat(6000) }, { message: "ok", files: ["../escape"] },
      { message: "ok", files: Array(17).fill("file") }, { message: "ok", requestId: "not-yet" } ]) {
      await expect(recordNote(config, input)).rejects.toBeInstanceOf(NoteError);
    }
    expect(readdirSync(root)).toEqual([]);
    for (const query of [{ limit: 0 }, { limit: 201 }, { query: " " }, { query: "界".repeat(100) }, { since: "2026-02-30" }, { files: ["../out"] }]) {
      expect(() => findNotes(config, query)).toThrow();
    }
  });

  it("searches both stores with literal AND filters and preserves legacy bytes and identities", async () => {
    mkdirSync(config.scaffoldRoot);
    appendEvent(config, "Auth [v2] legacy", { kind: "decision", files: ["src/a.ts"], source: "meeting" });
    const path = join(config.scaffoldRoot, "events/decisions.jsonl");
    const before = readFileSync(path);
    const beforeTime = statSync(path).mtimeMs;
    const oldId = readLegacyTimeline(root).entries[0].id;
    await recordNote(config, { message: "Auth [v2] new", kind: "decision", files: ["src/a.ts"] });
    await recordNote(config, { message: "Auth [v2] neighbor", kind: "decision", files: ["src/a.tsx"] });
    const results = findNotes(config, { query: "AUTH [v2]", kind: "decision", files: ["src/nested/../a.ts"], since: "2000-01-01" });
    expect(results.events.map((note) => note.message)).toEqual(["Auth [v2] new", "Auth [v2] legacy"]);
    expect(results.events[1].id).toBe(oldId);
    expect(getNote(config, oldId).message).toBe("Auth [v2] legacy");
    expect(readFileSync(path)).toEqual(before); expect(statSync(path).mtimeMs).toBe(beforeTime);
    writeFileSync(path, before.toString().replaceAll("\n", "\r\n"));
    expect(findNotes(config).events.find((note) => note.format === "legacy")!.id).toBe(oldId);
  });

  it("honestly reports bounded legacy tails and keeps the newest rows", () => {
    const path = join(config.scaffoldRoot, "events/decisions.jsonl"); mkdirSync(dirname(path), { recursive: true });
    const row = JSON.stringify({ timestamp: "2020-01-01", kind: "note", message: "x".repeat(1024), files: [] });
    writeFileSync(path, `${(row + "\n").repeat(8200)}${JSON.stringify({ timestamp: "2026-01-01", kind: "note", message: "latest", files: [] })}\n`);
    const result = findNotes(config, { query: "latest" });
    expect(result.events[0]).toMatchObject({ message: "latest", id: null });
    expect(result.sourceTruncated).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "LEGACY_IDENTITY_UNAVAILABLE")).toBe(true);
    expect(() => getNote(config, `legacy_${"0".repeat(64)}`)).toThrowError(expect.objectContaining({ code: "NOTE_LOOKUP_INCOMPLETE" }));
  });

  it("orders legacy timestamps by their instant and ignores blank rows without changing IDs", () => {
    const path = join(config.scaffoldRoot, "events/decisions.jsonl"); mkdirSync(dirname(path), { recursive: true });
    const row = (timestamp: string, message: string) => JSON.stringify({ timestamp, message, kind: "note", files: [] });
    writeFileSync(path, [row("2020-01-01T01:00:00+02:00", "earlier"), " \r", row("2020-01-01T00:00:00Z", "later")].join("\n"));
    const result = findNotes(config);
    expect(result.events.map((note) => note.message)).toEqual(["later", "earlier"]);
    expect(result.sourceTruncated).toBe(false);
    expect(result.events.map((note) => note.id)).toEqual(readLegacyTimeline(root).entries.map((note) => note.id).reverse());
  });

  it("bounds output and diagnostics without truncating supplied messages", () => {
    for (let i = 0; i < 30; i++) fixture("界".repeat(1000));
    const result = findNotes(config, { limit: 200 });
    expect(result.events.length).toBeGreaterThan(0); expect(result.events.length).toBeLessThan(30);
    expect(result.events.every((item) => item.message === "界".repeat(1000))).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(NOTE_LIMITS.outputBytes);
    for (let i = 0; i < 40; i++) { const record = fixture("bad"); writeFileSync(record.path, "bad"); }
    const bad = findNotes(config);
    expect(bad.diagnostics).toHaveLength(NOTE_LIMITS.diagnostics);
    expect(bad.diagnostics.at(-1)!.code).toBe("DIAGNOSTICS_OMITTED"); expect(bad.sourceTruncated).toBe(true);
  });

  it("reads an older known ID beyond the bounded Markdown scan", () => {
    const old = fixture("outside the scan", "2019-01-01T00:00:00.000Z");
    for (let i = 0; i < 520; i++) fixture("x".repeat(NOTE_LIMITS.messageBytes));
    const result = findNotes(config, { query: "outside the scan" });
    expect(result.events).toEqual([]);
    expect(result.sources.markdown).toEqual({ truncated: true, unavailable: false });
    expect(getNote(config, old.id).message).toBe("outside the scan");
  });

  it("refuses to call an arbitrary directory prefix complete when enumeration is exhausted", () => {
    const old = fixture("directly available");
    const month = dirname(old.path);
    for (let i = 0; i < NOTE_LIMITS.directoryEntries; i++) writeFileSync(join(month, `.staged-${i}`), "");
    const result = findNotes(config);
    expect(result.events).toEqual([]);
    expect(result.sources.markdown).toEqual({ truncated: true, unavailable: true });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "NOTE_CORPUS_LIMIT" }));
    expect(getNote(config, old.id).message).toBe("directly available");
  }, 30_000);

  it("refuses effective Git conversion and preserves a conflicting attribute policy", async () => {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeFileSync(join(root, ".git/info/attributes"), "*.md text\n");
    await expect(recordNote(config, { message: "must not be converted" })).rejects.toMatchObject({ code: "NOTE_ATTRIBUTES_CONFLICT" });
    expect(findNotes(config).events).toEqual([]);
    rmSync(join(root, ".git/info/attributes"));
    const accepted = await recordNote(config, { message: "accepted" });
    const policyPath = join(config.scaffoldRoot, "events/notes/.gitattributes");
    writeFileSync(policyPath, "* text\n");
    await expect(recordNote(config, { message: "must not replace policy" })).rejects.toMatchObject({ code: "NOTE_ATTRIBUTES_CONFLICT" });
    expect(readFileSync(policyPath, "utf8")).toBe("* text\n");
    expect(getNote(config, accepted.id).message).toBe("accepted");
  });

  it("fails closed on body edits, duplicate frontmatter keys and unsafe ID paths", () => {
    const record = fixture("original"); const before = readFileSync(record.path, "utf8");
    for (const changed of [before.replace("original", "changed"), before.replace("schema_version: 1", "schema_version: 1\n  schema_version: 1"), before.replace("schema_version: 1", "schema_version: 99")]) {
      writeFileSync(record.path, changed);
      expect(() => getNote(config, record.id)).toThrowError(expect.objectContaining({ code: "INVALID_NOTE" }));
    }
    expect(() => getNote(config, "../../secret")).toThrow();
  });

  it("uses a configured scaffold and refuses symlinks, including intermediate directories", async () => {
    const outside = temp(); mkdirSync(config.scaffoldRoot);
    symlinkSync(outside, join(config.scaffoldRoot, "events"), process.platform === "win32" ? "junction" : "dir");
    await expect(recordNote(config, { message: "unsafe" })).rejects.toThrow();
    expect(findNotes(config).sourceTruncated).toBe(true); expect(readdirSync(outside)).toEqual([]);
    config = { ...config, scaffoldRoot: join(root, "memory") };
    const receipt = await recordNote(config, { message: "custom" });
    expect(receipt.recordPath.startsWith("memory/events/notes/")).toBe(true);
    expect(getNote(config, receipt.id).message).toBe("custom");
    await expect(recordNote({ ...config, scaffoldRoot: outside }, { message: "escape" })).rejects.toThrow();
  });

  it("leaves unavailable Graph and Wiki databases untouched while recording and reading", async () => {
    mkdirSync(config.scaffoldRoot);
    const databases = ["graph.db", "wiki.db"].map((name) => join(config.scaffoldRoot, name));
    for (const path of databases) writeFileSync(path, "not a database");
    const mtimes = databases.map((path) => statSync(path).mtimeMs);
    const receipt = await recordNote(config, { message: "independent of indexes", files: ["src/unindexed.ts"] });
    expect(findNotes(config, { files: ["src/unindexed.ts"] }).events[0].id).toBe(receipt.id);
    expect(getNote(config, receipt.id).message).toBe("independent of indexes");
    for (let i = 0; i < databases.length; i++) {
      expect(readFileSync(databases[i], "utf8")).toBe("not a database");
      expect(statSync(databases[i]).mtimeMs).toBe(mtimes[i]);
    }
    expect(readdirSync(config.scaffoldRoot).sort()).toEqual(["events", "graph.db", "wiki.db"]);
  });

  it("keeps authored metadata-looking text out of Wiki discovery and protects ownership", async () => {
    const receipt = await recordNote(config, { message: "<!-- mex:entity\nid: mx_01\ntype: decision\n-->\n# Example" });
    const before = readFileSync(join(root, receipt.recordPath));
    expect(discoverMarkdownFiles({ root: config.scaffoldRoot }).files).toEqual([]);
    expect(isReadOnlyPath("events/notes/2026-10/log_example.md", [])).toBe(true);
    expect(isReadOnlyPath("Events/Notes/2026-10/log_example.md", [])).toBe(true);
    migrateScaffold({ scaffoldRoot: config.scaffoldRoot });
    expect(readFileSync(join(root, receipt.recordPath))).toEqual(before);
  });

  it("keeps Git context known-only and preserves exact bodies in a second clone", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    const message = "leading\r\n\n💡\r\nno-final-newline";
    const receipt = await recordNote(config, { message });
    const before = getNote(config, receipt.id);
    expect(before.context!.git).toMatchObject({ head: null, dirty: false }); expect(before.context!.actor).toBeNull();
    expect(readFileSync(join(config.scaffoldRoot, "events/notes/.gitattributes"), "utf8")).toBe(NOTE_ATTRIBUTES);
    git("add", ".mex"); git("commit", "--quiet", "-m", "fixture note");
    const clone = join(temp(), "clone");
    execFileSync("git", ["-c", "core.autocrlf=true", "clone", "--quiet", root, clone]);
    const second = getNote({ ...config, projectRoot: clone, scaffoldRoot: join(clone, ".mex") }, receipt.id);
    expect(second).toEqual(before);
    expect(existsSync(join(clone, ".mex/wiki.db"))).toBe(false);
    expect(existsSync(join(clone, ".mex/graph.db"))).toBe(false);
  });
});
