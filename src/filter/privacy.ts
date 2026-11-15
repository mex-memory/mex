import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { readBoundedTextFile } from "../knowledge/files.js";
import { assertNoSecrets } from "../knowledge/gates.js";
import type { FilterCandidate } from "./job.js";

export type PrivacyHold = "model-private" | "private-tag" | "new-name" | "new-host" | "new-email" | "source-privacy-unknown";
export interface RepoVocabulary { words: Set<string>; text: string; }
const words = (s: string) => s.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
/** Bounded, read-only repo vocabulary. Learned notes cannot attest to themselves. */
export function repoVocabulary(root: string): RepoVocabulary {
  let paths: string[];
  try { paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, timeout: 5000, maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\0"); }
  catch { paths = ["README.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]; }
  const corpus: string[] = [];
  let bytes = 0, files = 0;
  for (const path of paths.sort()) {
    if (!path || path.startsWith(".mex/") || path.startsWith(".git/") || path.split("/").some(p => p === ".." || p === ".") || path.startsWith("/")) continue;
    corpus.push(path);
    if (files++ >= 256 || bytes >= 2 << 20) continue;
    try {
      // Check every parent; a tracked symlink is never repository authority.
      let current = root;
      for (const part of path.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("redirect"); }
      const text = readBoundedTextFile(current, 64 << 10);
      if (text && !text.includes("\0") && bytes + Buffer.byteLength(text) <= 2 << 20) { corpus.push(text); bytes += Buffer.byteLength(text); }
    } catch { /* Unknown words remain held when a repository file is unavailable. */ }
  }
  const text = corpus.join("\n"); return { text, words: new Set(words(text)) };
}
/** Code can add a hold; a model's false flag cannot clear one. No raw values in reasons. */
export function privacyHolds(candidate: FilterCandidate, repo: RepoVocabulary): PrivacyHold[] {
  assertNoSecrets(candidate);
  const text = [candidate.quote, candidate.text, candidate.one_line].join("\n");
  const holds = new Set<PrivacyHold>();
  if (candidate.private) holds.add("model-private");
  if (candidate.source.private_tag === undefined) holds.add("source-privacy-unknown");
  if (candidate.source.private_tag || /<\s*\/?\s*private\b[^>]*>/iu.test(text)) holds.add("private-tag");
  for (const match of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)) if (!repo.text.includes(match[0])) holds.add("new-email");
  for (const match of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b/giu)) if (!repo.text.includes(match[0])) holds.add("new-host");
  // Capitalized proper names are deliberately conservative.
  // No common-name or product allowlist can authorize private vocabulary.
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])\p{Lu}[\p{L}\p{M}-]{1,63}(?![\p{L}\p{N}_])/gu)) if (!repo.words.has(match[0])) holds.add("new-name");
  return [...holds].sort();
}
