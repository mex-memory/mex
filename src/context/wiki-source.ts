/**
 * The tracked Wiki Markdown, observed.
 *
 * Discovery, contained reads and hashing are the Wiki engine's own (a bounded,
 * symlink-safe walk of the scaffold); this module only adds the context
 * index's identity: a digest over every file's path and exact bytes. A cheap
 * listing (one stat per file) proves that nothing changed since an index was
 * built; only when it did does a staleness check read and hash.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfiguredWikiConfig } from "../config.js";
import { discoverMarkdownFiles, type DiscoveredFile } from "../wiki/index/discover.js";
import { WikiCorpusLimitError } from "../wiki/index/corpus-policy.js";
import { readContainedSource } from "../wiki/index/source-read.js";
import { exactFileContentHash } from "../wiki/model/hash.js";
import type { ContextDiagnostic } from "./types.js";

export interface ObservedWikiFile {
  path: string;
  hash: string;
  /** Size, timestamps and inode when the bytes were read; see {@link statSignature}. */
  stat: string;
  text: string;
}

export interface WikiObservation {
  files: ObservedWikiFile[];
  digest: string;
  diagnostics: ContextDiagnostic[];
}

/** Checkout-local state is never canonical knowledge, whatever it contains. */
const ALWAYS_EXCLUDED = ["local/**"] as const;

/** A cheap fingerprint of a file's metadata: changes whenever it is rewritten. */
export function statSignature(absolutePath: string): string {
  try {
    const s = statSync(absolutePath, { bigint: true });
    return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
  } catch {
    return "unreadable";
  }
}

export interface WikiListing {
  files: Array<DiscoveredFile & { stat: string }>;
  diagnostics: ContextDiagnostic[];
}

/**
 * Which Markdown files the Wiki would read, with a metadata signature each.
 *
 * Reading a file through the Wiki's contained reader costs several filesystem
 * round trips, which adds up on every prompt; a listing costs one stat per file.
 */
export function listWikiMarkdown(scaffoldRoot: string): WikiListing {
  const root = resolve(scaffoldRoot);
  const diagnostics: ContextDiagnostic[] = [];
  let exclude: string[] = [];
  try {
    exclude = loadConfiguredWikiConfig(root).exclude;
  } catch {
    // An unreadable config falls back to the defaults baked into the loader.
  }
  try {
    const discovery = discoverMarkdownFiles({ root, exclude: [...exclude, ...ALWAYS_EXCLUDED] });
    return { files: discovery.files.map((f) => ({ ...f, stat: statSignature(f.absolutePath) })), diagnostics };
  } catch (error) {
    diagnostics.push({
      code: "CONTEXT_WIKI_UNREADABLE",
      severity: "error",
      message: `The Wiki Markdown could not be enumerated: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { files: [], diagnostics };
  }
}

/** Read and hash every listed file through the Wiki's contained reader. */
export function observeWikiMarkdown(scaffoldRoot: string, listing: WikiListing = listWikiMarkdown(scaffoldRoot)): WikiObservation {
  const root = resolve(scaffoldRoot);
  const diagnostics: ContextDiagnostic[] = [...listing.diagnostics];
  const files: ObservedWikiFile[] = [];
  try {
    for (const file of listing.files) {
      try {
        const text = readContainedSource(root, file.absolutePath);
        files.push({ path: file.path, hash: exactFileContentHash(text), stat: file.stat, text });
      } catch (error) {
        if (error instanceof WikiCorpusLimitError) throw error;
        diagnostics.push({
          code: "CONTEXT_WIKI_UNREADABLE",
          severity: "warning",
          message: `Could not safely read ${file.path}; its entities are left out of the context index.`,
        });
      }
    }
  } catch (error) {
    diagnostics.push({
      code: "CONTEXT_WIKI_UNREADABLE",
      severity: "error",
      message: `The Wiki Markdown could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return { files, digest: digestFiles(files), diagnostics };
}

export function digestFiles(files: ReadonlyArray<{ path: string; hash: string }>): string {
  const hash = createHash("sha256");
  hash.update("context-wiki-digest-v1\u0000");
  for (const file of files) hash.update(`${file.path}\u0000${file.hash}\u0000`);
  return hash.digest("hex");
}
