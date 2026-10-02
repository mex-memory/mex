/**
 * `mex graph compact-fingerprints`: re-encode every committed `mh:` grounding
 * fingerprint as `mh2:` in one explicit pass (#233).
 *
 * Nothing needs this to keep working. Both encodings are read everywhere and
 * compared by value, and an `mh:` entry is re-encoded on its own whenever its
 * file's groundings are rewritten. This is for a team that wants the smaller
 * scaffold now rather than file by file, in one reviewable commit.
 *
 * ## What it touches, and what it never does
 *
 * Only the fingerprint scalar of a `grounds_to` entry: the root frontmatter
 * list, the `mex.grounds_to` list, and the list in a `<!-- mex:entity -->`
 * block. Each value is replaced in place with its quoting kept, so every other
 * byte of the file — prose, key order, comments, line endings — is unchanged.
 * It needs no code graph: the conversion is a pure function of the committed
 * value, which is why it can run on a fresh clone.
 *
 * Before a file is written, every grounding it holds is decoded again and must
 * equal what it held before. A value that does not decode in either encoding
 * is left exactly as written and counted. Team-owned records are never read,
 * and a document is published only through the same contained, compare-and-
 * swap writer capture uses, so a file edited during the pass is reported and
 * left alone.
 */

import { relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { loadConfiguredWikiConfig } from "./config.js";
import { GRAPH_CORPUS_LIMITS } from "./graph/corpus-policy.js";
import { canonicalFingerprint, deserializeFingerprint } from "./graph/fingerprint.js";
import { COMPACT_FINGERPRINT_PREFIX, FINGERPRINT_PREFIX, type Fingerprint } from "./graph/reconcile.js";
import { readBoundedText, replaceGroundingDocument } from "./graph/runtime.js";
import { toPosix } from "./paths.js";
import type { MexConfig } from "./types.js";
import { addWikiCorpusBytes, WikiCorpusLimitError } from "./wiki/index/corpus-policy.js";
import { discoverMarkdownFiles } from "./wiki/index/discover.js";
import { applyEdits, type PatchEdit } from "./wiki/markdown/patch.js";
import { parseDocument, type YamlRegion } from "./wiki/markdown/parse.js";
import { isTeamOwnedReadOnlyPath } from "./wiki/model/team-owned-paths.js";

/** One file's fingerprints, re-encoded or not. */
export interface TextCompaction {
  text: string;
  /** `mh:` values re-encoded. */
  compacted: number;
  /** Values already in the compact encoding. */
  alreadyCompact: number;
  /** Values that decode in neither encoding, or are not written as a plain or quoted scalar; left as written. */
  undecodable: number;
}

export interface FingerprintCompactionFile {
  /** Project-relative POSIX path. */
  file: string;
  compacted: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface FingerprintCompactionResult {
  dryRun: boolean;
  /** Files holding at least one `mh:` fingerprint, with what was (or, on a dry run, would be) re-encoded. */
  files: FingerprintCompactionFile[];
  compacted: number;
  alreadyCompact: number;
  undecodable: number;
  /** Files that could not be read or published safely. None of them was changed. */
  skipped: Array<{ file: string; reason: string }>;
}

/** Where a document keeps grounding lists. */
interface GroundingList {
  region: YamlRegion;
  path: readonly string[];
}

interface FingerprintScalar {
  start: number;
  end: number;
  value: string;
  quote: "" | "\"" | "'";
}

/** Re-encode the `mh:` fingerprints in one document, changing nothing else. */
export function compactFingerprintsInText(text: string): TextCompaction {
  const edits: PatchEdit[] = [];
  let alreadyCompact = 0;
  let undecodable = 0;
  for (const scalar of fingerprintScalars(text)) {
    if (text.slice(scalar.start, scalar.end) !== `${scalar.quote}${scalar.value}${scalar.quote}`) {
      // An escaped or otherwise unusual spelling: rewriting it would mean
      // re-serializing YAML, so it stays exactly as written.
      undecodable += 1;
      continue;
    }
    if (scalar.value.startsWith(`${COMPACT_FINGERPRINT_PREFIX}:`) && deserializeFingerprint(scalar.value) !== null) {
      alreadyCompact += 1;
      continue;
    }
    const compact = scalar.value.startsWith(`${FINGERPRINT_PREFIX}:`) ? canonicalFingerprint(scalar.value) : scalar.value;
    if (compact === scalar.value) {
      undecodable += 1;
      continue;
    }
    edits.push({ start: scalar.start, end: scalar.end, text: `${scalar.quote}${compact}${scalar.quote}`, label: "fingerprint" });
  }
  if (edits.length === 0) return { text, compacted: 0, alreadyCompact, undecodable };

  const next = applyEdits(text, edits).text;
  // The whole claim of this command, checked rather than assumed: every
  // grounding decodes to exactly the fingerprint it held before.
  if (!isDeepStrictEqual(decodedFingerprints(next), decodedFingerprints(text))) {
    throw new Error("Re-encoding would change a grounding fingerprint; the document was left unchanged.");
  }
  return { text: next, compacted: edits.length, alreadyCompact, undecodable };
}

/** Re-encode every `mh:` fingerprint committed in the scaffold. A dry run writes nothing. */
export function compactScaffoldFingerprints(
  config: MexConfig,
  options: { dryRun?: boolean } = {},
): FingerprintCompactionResult {
  const result: FingerprintCompactionResult = {
    dryRun: options.dryRun === true,
    files: [],
    compacted: 0,
    alreadyCompact: 0,
    undecodable: 0,
    skipped: [],
  };
  const limit = GRAPH_CORPUS_LIMITS.maxSourceFileBytes;
  const projectPath = (absolutePath: string): string => toPosix(relative(config.projectRoot, absolutePath));

  const discovery = discoverMarkdownFiles({
    root: config.scaffoldRoot,
    exclude: loadConfiguredWikiConfig(config.scaffoldRoot).exclude,
  });
  for (const diagnostic of discovery.diagnostics) {
    if (typeof diagnostic.file === "string") result.skipped.push({ file: diagnostic.file, reason: diagnostic.message });
  }

  let corpusBytes = 0;
  for (const file of discovery.files) {
    // Team records are canonical, exact-byte artifacts with their own writers.
    if (isTeamOwnedReadOnlyPath(file.path)) continue;
    const path = projectPath(file.absolutePath);
    let text: string;
    try {
      text = readBoundedText(file.absolutePath, limit);
      corpusBytes = addWikiCorpusBytes(corpusBytes, Buffer.byteLength(text, "utf8"));
    } catch (error) {
      if (error instanceof WikiCorpusLimitError) {
        result.skipped.push({ file: path, reason: "The scaffold exceeds the corpus limit; this and later files were not read." });
        break;
      }
      result.skipped.push({ file: path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    let compaction: TextCompaction;
    try {
      compaction = compactFingerprintsInText(text);
    } catch (error) {
      result.skipped.push({ file: path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    result.alreadyCompact += compaction.alreadyCompact;
    result.undecodable += compaction.undecodable;
    if (compaction.compacted === 0) continue;

    if (!result.dryRun) {
      try {
        replaceGroundingDocument(config, file.absolutePath, text, compaction.text, limit);
      } catch (error) {
        result.skipped.push({ file: path, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    result.compacted += compaction.compacted;
    result.files.push({
      file: path,
      compacted: compaction.compacted,
      bytesBefore: Buffer.byteLength(text, "utf8"),
      bytesAfter: Buffer.byteLength(compaction.text, "utf8"),
    });
  }
  return result;
}

/** CLI entry: report or apply, as text or JSON. A skipped file makes the exit status non-zero. */
export function runCompactFingerprints(config: MexConfig, options: { dryRun?: boolean; json?: boolean } = {}): void {
  const result = compactScaffoldFingerprints(config, options);
  if (result.skipped.length > 0) process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const before = result.files.reduce((sum, file) => sum + file.bytesBefore, 0);
  const after = result.files.reduce((sum, file) => sum + file.bytesAfter, 0);
  if (result.compacted === 0) {
    console.log("No mh: fingerprints to re-encode.");
  } else {
    const verb = result.dryRun ? "Would re-encode" : "Re-encoded";
    const fingerprints = `${result.compacted} fingerprint${result.compacted === 1 ? "" : "s"}`;
    const files = `${result.files.length} file${result.files.length === 1 ? "" : "s"}`;
    console.log(`${verb} ${fingerprints} in ${files}: ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} bytes.`);
    for (const file of result.files) console.log(`  ${file.file}  ${file.compacted}`);
  }
  if (result.alreadyCompact > 0) console.log(`${result.alreadyCompact} already compact.`);
  if (result.undecodable > 0) {
    console.log(`${result.undecodable} fingerprint value${result.undecodable === 1 ? " is" : "s are"} not a valid fingerprint and ${result.undecodable === 1 ? "was" : "were"} left as written.`);
  }
  for (const entry of result.skipped) console.log(`Skipped ${entry.file}: ${entry.reason}`);
  if (result.compacted > 0) {
    console.log(result.dryRun
      ? "Nothing was written. Run without --dry-run to re-encode."
      : "Review the diff and commit the scaffold to share it. Teammates need a MEX version that reads mh2: fingerprints.");
  }
}

/** Every grounding list a document holds: root frontmatter, the `mex:` map, and each entity block. */
function groundingLists(text: string): GroundingList[] {
  const document = parseDocument(text);
  const lists: GroundingList[] = [];
  if (document.frontmatter !== null) {
    lists.push({ region: document.frontmatter, path: ["grounds_to"] });
    lists.push({ region: document.frontmatter, path: ["mex", "grounds_to"] });
  }
  for (const block of document.htmlBlocks) {
    if (block.isEntityMarker) lists.push({ region: block, path: ["grounds_to"] });
  }
  return lists;
}

/** The `fingerprint` scalar of every entry, in file order, with its exact file range. */
function fingerprintScalars(text: string): FingerprintScalar[] {
  const scalars: FingerprintScalar[] = [];
  for (const list of groundingLists(text)) {
    let document: YAML.Document.Parsed;
    try {
      document = YAML.parseDocument(list.region.text);
    } catch {
      continue;
    }
    if (document.errors.length > 0) continue;
    const entries = document.getIn(list.path, true);
    if (!YAML.isSeq(entries)) continue;
    for (const entry of entries.items) {
      if (!YAML.isMap(entry)) continue;
      const value = entry.get("fingerprint", true);
      if (!YAML.isScalar(value) || typeof value.value !== "string" || !value.range) continue;
      const quote = value.type === "QUOTE_DOUBLE" ? "\"" : value.type === "QUOTE_SINGLE" ? "'" : value.type === "PLAIN" ? "" : null;
      if (quote === null) continue;
      scalars.push({
        start: list.region.innerStart + value.range[0],
        end: list.region.innerStart + value.range[1],
        value: value.value,
        quote,
      });
    }
  }
  return scalars.sort((left, right) => left.start - right.start);
}

function decodedFingerprints(text: string): Array<Fingerprint | string> {
  return fingerprintScalars(text).map((scalar) => deserializeFingerprint(scalar.value) ?? scalar.value);
}
