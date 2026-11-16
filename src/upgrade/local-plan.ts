/** Bounded, read-only ownership checks for old skills, caches and watch hooks. */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "../knowledge/share-plan.js";
import { KnowledgeError } from "../knowledge/entry.js";
import type { UpgradeFileChange } from "./cleanup-plan.js";
import { digest, readBytes, readText, safePath } from "./safe-files.js";
import { ownedWatchHook } from "./watch-hook.js";

export interface UpgradeIssue { code: string; path: string; blocking?: boolean; }
export interface CacheRemoval { path: string; hash: string; bytes: number; }
export interface OldAssets { skills: UpgradeFileChange[]; caches: CacheRemoval[]; hook?: UpgradeFileChange; gitDirectory: string; issues: UpgradeIssue[]; }

export function oldAssets(root: string): OldAssets {
  const gitDirectory = resolve(root, git(root, "rev-parse", "--git-common-dir"));
  const out: OldAssets = { skills: [], caches: [], gitDirectory, issues: [] };
  let count = 0, bytes = 0;
  const visit = (path: string): string[] => {
    if (++count > 1000 || path.split("/").length > 16) throw new KnowledgeError("UPGRADE_LIMIT", "Old skill discovery reached its work limit.");
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error("redirected skill");
    if (stat.isFile()) return [path];
    if (!stat.isDirectory()) throw new Error("non-regular skill");
    return readdirSync(join(root, path)).sort().flatMap(child => visit(`${path}/${child}`));
  };
  for (const base of [".agents/skills", ".claude/skills", ".codex/skills"]) for (const skill of ["mex-inbox", "mex-relay"]) {
    const dir = `${base}/${skill}`;
    if (!existsSync(join(root, dir))) continue;
    try {
      const marker = `${dir}/.mex-managed.json`;
      const original = readText(root, marker);
      if (!original) throw new Error("unowned skill");
      const files = visit(dir);
      const metadata = JSON.parse(original) as { schemaVersion: number; owner: string; skill: string; files: Record<string, string> };
      if (metadata.schemaVersion !== 1 || metadata.owner !== "mex-agent" || metadata.skill !== skill || !metadata.files || Array.isArray(metadata.files)) throw new Error("unowned skill");
      const changes: UpgradeFileChange[] = [];
      if (files.length !== Object.keys(metadata.files).length + 1) throw new Error("extra skill file");
      for (const [path, hash] of Object.entries(metadata.files)) {
        if (!safePath(path) || typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error("bad manifest");
        const full = `${dir}/${path}`, text = readText(root, full);
        if (text === null || (digest(text) !== hash && digest(text.replace(/\r\n/gu, "\n")) !== hash)) throw new Error("modified skill");
        bytes += Buffer.byteLength(text);
        if (bytes > 4 * 1024 * 1024) throw new KnowledgeError("UPGRADE_LIMIT", "Old skills exceed the preview limit.");
        changes.push({ path: full, before: text, after: null });
      }
      out.skills.push(...changes, { path: marker, before: original, after: null });
    } catch { out.issues.push({ code: "SKILL_REVIEW", path: dir }); }
  }
  for (const path of [".mex/wiki.db", ".mex/wiki.db-wal", ".mex/wiki.db-shm"]) {
    try {
      const data = readBytes(root, path, 64 * 1024 * 1024);
      if (data !== null) out.caches.push({ path, hash: digest(data), bytes: data.length });
    } catch { out.issues.push({ code: "CACHE_REVIEW", path }); }
  }
  const path = "hooks/post-commit";
  try {
    // Never rewrite a custom hook directory or a redirected Git directory.
    const actual = resolve(root, git(root, "rev-parse", "--git-path", "hooks/post-commit"));
    if (actual !== join(gitDirectory, path)) { out.issues.push({ code: "CUSTOM_HOOKS_PATH", path: "post-commit" }); return out; }
    const text = readText(gitDirectory, path);
    if (text?.includes("# mex-drift-check")) {
      // 0.8 kept no backup and trimmed mixed hooks. Only a wholly generated
      // hook can be removed without inventing the original human bytes.
      if (ownedWatchHook(text)) out.hook = { path, before: text, after: null };
      else out.issues.push({ code: "WATCH_HOOK_REVIEW", path: "post-commit" });
    }
  } catch { out.issues.push({ code: "WATCH_HOOK_REVIEW", path: "post-commit" }); }
  return out;
}
