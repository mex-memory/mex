/**
 * The groundings the committed scaffold declares — what `impact` reports as
 * knowledge (#224).
 *
 * `impact` used to answer from `_mex_grounded_source` in `.mex/graph.db`. That
 * table is a cache of baselines, filled only by capture (setup, `mex sync`,
 * `mex graph ground`) and never by `mex graph`, `rebuild` or `refresh`. So a
 * teammate who cloned and built had an empty table and `impact` returned no
 * knowledge at all, and a checkout whose Markdown moved on kept returning links
 * the scaffold no longer made. The answer lived only in a disposable index —
 * the failure `patterns/durable-change-signal.md` describes for baselines.
 *
 * The committed Markdown is now the source of truth, read at query time. There
 * is no copy, so there is nothing to go stale. The cache table stays: `check`
 * still reads baselines from it.
 *
 * ## One walk, one reader, shared with the Wiki
 *
 * The walk is the Wiki index's own `discoverMarkdownFiles`, honouring the
 * checkout's `wiki.exclude`, and every file goes through `readContainedSource`
 * under `WIKI_CORPUS_LIMITS`. That is deliberate: `wiki for-code` answers the
 * same question from the index that walk builds, and two walks would disagree
 * about which files the scaffold contains. It also means symlink containment,
 * descriptor-bound reads and the byte ceilings are the ones already reviewed,
 * not a second set.
 *
 * It lives beside `markdown.ts` rather than under `src/graph/` for the same
 * reason that module does: no graph module imports the Wiki, and the Wiki
 * modules used here import nothing from the graph, so no cycle is formed.
 *
 * Groundings are read through `extractGroundings`, which takes the union of the
 * root `grounds_to` and `mex.grounds_to` (#226). Inline `mex://` anchors are
 * not read: they are links in prose, the Wiki does not index them as
 * groundings, and reading them would make `impact` and `wiki for-code` disagree
 * about the same node. The cache did hold them, because capture records
 * anchors too, so a link that exists only as an anchor is no longer returned.
 * `mex check` still verifies anchors.
 *
 * Two known differences from `wiki for-code` remain, both on the Wiki's side
 * of the join: a pre-wiki file with only a root `grounds_to` has no Wiki
 * entity, so `for-code` cannot return it and this does; and groundings inside
 * a section entity's `<!-- mex:entity -->` block are not frontmatter, so
 * `for-code` returns them and this, like `mex check`, does not read them.
 *
 * ## Nothing is dropped silently
 *
 * Scaffold Markdown sits outside the graph snapshot `impact` binds, so it is
 * read once per invocation and observed again before output. A file that could
 * not be read within those bounds, a walk stopped by a scaffold-wide ceiling,
 * or a file that changed during the call is returned to the caller as an
 * omission, never as an answer that merely looks complete.
 */

import { lstatSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadConfiguredWikiConfig } from "./config.js";
import { extractGroundings } from "./markdown.js";
import { toPosix } from "./paths.js";
import { addWikiCorpusBytes, WikiCorpusLimitError, type WikiCorpusLimit } from "./wiki/index/corpus-policy.js";
import { discoverMarkdownFiles, type DiscoveredFile } from "./wiki/index/discover.js";
import { readContainedSource } from "./wiki/index/source-read.js";

/** One declared grounding: a scaffold file, relative to the project root, and the node it names. */
export interface CommittedGrounding {
  file: string;
  node: string;
}

export interface CommittedGroundingObservation {
  /** Declared entries, deduplicated per file, in walk order. */
  groundings: CommittedGrounding[];
  /** Files that could not be read within bounds; their groundings are absent. Sorted. */
  unreadable: string[];
  /** The scaffold-wide ceiling that stopped the walk, if one did. */
  limit?: WikiCorpusLimit;
  /** Per-file identity taken before each read, so the same call can prove nothing moved. */
  readonly observed: ReadonlyMap<string, string>;
}

interface ScaffoldWalk {
  root: string;
  scaffoldRoot: string;
  files: DiscoveredFile[];
  unreadable: Set<string>;
  limit?: WikiCorpusLimit;
}

/** Walk and read the scaffold under `<projectRoot>/.mex` once. Never throws for scaffold content. */
export function observeCommittedGroundings(projectRoot: string): CommittedGroundingObservation {
  const walk = walkScaffold(projectRoot);
  const groundings: CommittedGrounding[] = [];
  const observed = new Map<string, string>();
  if (walk === null) return { groundings, unreadable: [], observed };

  let limit = walk.limit;
  let corpusBytes = 0;
  for (const file of walk.files) {
    const path = projectPath(walk, file.path);
    // Taken before the read: an edit that lands during it moves the identity,
    // and the second observation sees that.
    observed.set(path, fileIdentity(file.absolutePath));
    let text: string;
    try {
      text = readContainedSource(walk.scaffoldRoot, file.absolutePath);
    } catch {
      // Too large, not a regular file, not valid UTF-8, or retargeted under us.
      walk.unreadable.add(path);
      continue;
    }
    try {
      corpusBytes = addWikiCorpusBytes(corpusBytes, Buffer.byteLength(text, "utf8"));
    } catch (error) {
      limit = error instanceof WikiCorpusLimitError ? error.limit : "maxCorpusBytes";
      break;
    }
    const seen = new Set<string>();
    for (const grounding of declaredGroundings(text)) {
      if (seen.has(grounding.node)) continue;
      seen.add(grounding.node);
      groundings.push({ file: path, node: grounding.node });
    }
  }

  return {
    groundings,
    unreadable: [...walk.unreadable].sort(),
    ...(limit === undefined ? {} : { limit }),
    observed,
  };
}

/**
 * Files that differ from an earlier observation, sorted.
 *
 * Walks again and compares each file's identity — size, inode, modification
 * and change time — as `readBoundedText` does for grounding documents. A write
 * moves the change time, which no caller can set back, so a file whose
 * identity matches still holds the bytes the answer was built from. Empty
 * means the scaffold is as it was read.
 */
export function committedGroundingsChangedSince(
  projectRoot: string,
  previous: CommittedGroundingObservation,
): string[] {
  const walk = walkScaffold(projectRoot);
  const current = new Map<string, string>();
  for (const file of walk?.files ?? []) {
    current.set(projectPath(walk!, file.path), fileIdentity(file.absolutePath));
  }
  const changed = new Set<string>();
  for (const [path, identity] of previous.observed) {
    if (current.get(path) !== identity) changed.add(path);
  }
  for (const path of current.keys()) if (!previous.observed.has(path)) changed.add(path);
  for (const path of walk?.unreadable ?? []) {
    if (!previous.unreadable.includes(path) && !current.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

/** Discover the scaffold's Markdown the way the Wiki index does; null when there is no scaffold. */
function walkScaffold(projectRoot: string): ScaffoldWalk | null {
  const root = resolve(projectRoot);
  const scaffoldRoot = resolve(root, ".mex");
  // No scaffold is an ordinary state — nothing is committed, so nothing is missing.
  try {
    if (!lstatSync(scaffoldRoot).isDirectory()) return null;
  } catch {
    return null;
  }
  const walk: ScaffoldWalk = { root, scaffoldRoot, files: [], unreadable: new Set() };
  try {
    const exclude = loadConfiguredWikiConfig(scaffoldRoot).exclude;
    const discovery = discoverMarkdownFiles({ root: scaffoldRoot, exclude });
    walk.files = discovery.files;
    // Discovery names what it skipped: an escaping or broken symlink, a
    // directory it could not open. Any of them may hold groundings.
    for (const entry of discovery.diagnostics) {
      if (typeof entry.file === "string") walk.unreadable.add(projectPath(walk, entry.file));
    }
  } catch (error) {
    // A scaffold problem must cost the knowledge links, not the whole answer.
    if (error instanceof WikiCorpusLimitError) walk.limit = error.limit;
    else walk.unreadable.add(projectPath(walk, "."));
  }
  return walk;
}

function projectPath(walk: ScaffoldWalk, scaffoldRelative: string): string {
  return toPosix(relative(walk.root, resolve(walk.scaffoldRoot, scaffoldRelative)));
}

function fileIdentity(absolutePath: string): string {
  try {
    const stats = lstatSync(absolutePath, { bigint: true });
    return `${stats.size}:${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch {
    return "absent";
  }
}

/**
 * `extractGroundings` over the frontmatter block alone.
 *
 * Groundings live only in frontmatter, and parsing a whole document to reach
 * it cost most of this read. Frontmatter opens on the first line and closes at
 * the first line that is exactly `---`, so the text up to that line holds the
 * same block and parses to the same entries. A document with no such line is
 * parsed whole, as before.
 */
function declaredGroundings(text: string): ReturnType<typeof extractGroundings> {
  const close = /\r?\n---\r?(?:\n|$)/.exec(text);
  return extractGroundings(close === null ? text : text.slice(0, close.index + close[0].length));
}
