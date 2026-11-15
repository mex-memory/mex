import { canonicalFileDiff } from "../team/artifacts/unified-diff.js";
import type { RepoRelativePath } from "../team/contracts/shared.js";

export function upgradeDiff(path: string, before: string | null, after: string | null): string {
  if (after !== null) return canonicalFileDiff(path as RepoRelativePath, before, after);
  if (before === null) return "";
  return canonicalFileDiff(path as RepoRelativePath, before, "")
    .replace(`diff --git a/${path} b/${path}\n`, `diff --git a/${path} b/${path}\ndeleted file mode 100644\n`)
    .replace(`+++ b/${path}\n`, "+++ /dev/null\n");
}
