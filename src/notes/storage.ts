import { lstatSync, opendirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { MexConfig } from "../types.js";
import { toPosix } from "../paths.js";
import { atomicCreateArtifact, inspectArtifactDirectory, readContainedArtifact, syncArtifactParents, tryReadContainedArtifact } from "../team/artifacts/filesystem.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";
import { NOTE_LIMITS, NoteError, type NoteRecord, type NoteSourceStatus } from "./contracts.js";
import { decodeNote, NOTE_ROOT, notePath } from "./codec.js";

export const NOTE_ATTRIBUTES = "# MEX notes retain supplied UTF-8 bytes across checkouts.\n* -text -filter -ident -working-tree-encoding\n";

export function scaffoldPrefix(config: MexConfig): string {
  const prefix = toPosix(relative(resolve(config.projectRoot), resolve(config.scaffoldRoot)));
  if (!prefix || prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix) || prefix.split("/").length > 32) {
    throw new NoteError("UNSAFE_NOTE_PATH", "The note scaffold must be contained within the project.");
  }
  return prefix;
}
export function artifactPath(config: MexConfig, path: string): RepoRelativePath {
  return `${scaffoldPrefix(config)}/${path}` as RepoRelativePath;
}
export function readNoteFile(config: MexConfig, id: string): NoteRecord {
  const path = artifactPath(config, notePath(id));
  const artifact = readContainedArtifact(config.projectRoot, path, NOTE_LIMITS.artifactBytes);
  return decodeNote(artifact.bytes, id, path);
}

/** Provision only in an explicit write; never rewrite user-supplied attributes. */
export function prepareNoteStorage(config: MexConfig, id: string): void {
  const path = artifactPath(config, `${NOTE_ROOT}/.gitattributes`);
  let existing = tryReadContainedArtifact(config.projectRoot, path, 4096);
  if (!existing) {
    try { atomicCreateArtifact(config.projectRoot, path, NOTE_ATTRIBUTES, 0o644, true); }
    catch (error) {
      // A concurrent independent note writer may have installed the exact policy.
      if (!hasCode(error, "REVISION_CONFLICT")) throw error;
    }
    existing = readContainedArtifact(config.projectRoot, path, 4096);
  }
  if (Buffer.from(existing.bytes).toString("utf8") !== NOTE_ATTRIBUTES) {
    throw new NoteError("NOTE_ATTRIBUTES_CONFLICT", "The note attribute policy differs. Preserve exact bytes before writing notes.");
  }
  // Also flush an existing policy after a previous writer lost acknowledgement.
  syncArtifactParents(config.projectRoot, path);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const args = ["-C", config.projectRoot];
  const probe = spawnSync("git", [...args, "rev-parse", "--is-inside-work-tree"], { env, encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
  if (probe.status !== 0) {
    // A non-Git project is supported. An existing but unreadable Git binding is not silently certified.
    try { lstatSync(resolve(config.projectRoot, ".git")); }
    catch (error) { if (hasCode(error, "ENOENT")) return; throw error; }
    throw new NoteError("NOTE_ATTRIBUTES_UNAVAILABLE", "Cannot verify Git byte-preservation settings.");
  }
  const result = spawnSync("git", [...args, "check-attr", "-z", "text", "filter", "ident", "working-tree-encoding", "--", artifactPath(config, notePath(id))],
    { env, encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 });
  const fields = result.stdout?.split("\0") ?? [];
  if (result.status !== 0 || fields.length !== 13 || [2, 5, 8, 11].some((index) => fields[index] !== "unset")) {
    throw new NoteError("NOTE_ATTRIBUTES_CONFLICT", "Git attributes would transform note bytes. Disable conversions for the note store.");
  }
}

export function hasCode(error: unknown, code: string): boolean {
  const value = error as { code?: string; problem?: { code?: string } } | null;
  return value?.code === code || value?.problem?.code === code;
}

export function discoverNotes(config: MexConfig, report: (code: string, message: string) => void): { entries: NoteRecord[]; state: NoteSourceStatus } {
  const state = { truncated: false, unavailable: false };
  const root = artifactPath(config, NOTE_ROOT);
  let count = 0;
  const readNames = (path: RepoRelativePath): string[] => {
    const directory = inspectArtifactDirectory(config.projectRoot, path);
    const before = lstatSync(directory, { bigint: true });
    const names: string[] = [];
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        if (++count > NOTE_LIMITS.directoryEntries) throw new NoteError("NOTE_CORPUS_LIMIT", "Note directory enumeration exceeded its limit; direct ID reads remain available.");
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    inspectArtifactDirectory(config.projectRoot, path);
    const after = lstatSync(directory, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new NoteError("NOTE_SOURCE_CHANGED", "The note directory changed during discovery; retry the read.");
    }
    return names.sort();
  };
  const candidates: string[] = [];
  try {
    let months: string[];
    try { months = readNames(root); }
    catch (error) { if (hasCode(error, "ENOENT") || hasCode(error, "NOT_FOUND")) return { entries: [], state }; throw error; }
    for (const month of months) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue;
      for (const name of readNames(`${root}/${month}` as RepoRelativePath)) {
        if (!name.endsWith(".md") || name.startsWith(".")) continue;
        const id = name.slice(0, -3);
        try {
          if (notePath(id) !== `${NOTE_ROOT}/${month}/${name}`) throw new Error();
          candidates.push(id);
        } catch { state.truncated = true; report("INVALID_NOTE_PATH", "A malformed note filename was omitted."); }
      }
    }
  } catch (error) {
    state.unavailable = true; state.truncated = true;
    report(error instanceof NoteError ? error.code : "NOTE_SOURCE_UNAVAILABLE", error instanceof NoteError ? error.message : "The note store could not be safely enumerated.");
    return { entries: [], state };
  }
  candidates.sort().reverse();
  const entries: NoteRecord[] = [];
  let bytes = 0;
  for (let index = 0; index < candidates.length; index++) {
    // Reserve the maximum read before I/O, so failures consume a bounded budget too.
    if (index >= NOTE_LIMITS.sourceRecords || bytes + NOTE_LIMITS.artifactBytes > NOTE_LIMITS.sourceBytes) { state.truncated = true; break; }
    const id = candidates[index]!;
    try {
      const path = artifactPath(config, notePath(id));
      const artifact = readContainedArtifact(config.projectRoot, path, NOTE_LIMITS.artifactBytes);
      bytes += artifact.bytes.byteLength;
      entries.push(decodeNote(artifact.bytes, id, path));
    } catch {
      bytes += NOTE_LIMITS.artifactBytes;
      state.truncated = true;
      report("NOTE_RECORD_UNAVAILABLE", "A malformed, changed or unreadable note was omitted.");
    }
  }
  return { entries, state };
}
