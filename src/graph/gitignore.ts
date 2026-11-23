/**
 * `.gitignore` for the graph corpus, matched in process: discovery runs on
 * every freshness check, and starting Git there costs more than the walk.
 *
 * Reads the checkout's `.gitignore` files (each applies below its own folder)
 * and `.git/info/exclude`. A rule file is parsed once and reused while its
 * file identity is unchanged. The user's global excludes file
 * is not read; the file index, which lists files through Git, does honour it.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";

interface Parsed { identity: string; rules: Ignore }
const parsed = new Map<string, Parsed>();

function rulesIn(file: string): Ignore | undefined {
  let identity: string;
  try {
    const stats = statSync(file, { bigint: true });
    if (!stats.isFile()) return undefined;
    identity = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch { return undefined; }
  const previous = parsed.get(file);
  if (previous?.identity === identity) return previous.rules;
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return undefined; }
  const rules = ignore().add(text);
  if (parsed.size > 4096) parsed.clear();
  parsed.set(file, { identity, rules });
  return rules;
}

/**
 * A predicate telling whether a checkout-relative, `/`-separated path is
 * ignored. Build one per discovery: it remembers which folders have rules.
 */
export function gitignoreMatcher(root: string): (path: string) => boolean {
  const folders = new Map<string, Ignore | undefined>();
  const exclude = rulesIn(join(root, ".git", "info", "exclude"));
  const at = (folder: string): Ignore | undefined => {
    if (!folders.has(folder)) folders.set(folder, rulesIn(join(root, folder, ".gitignore")));
    return folders.get(folder);
  };
  return (path: string): boolean => {
    if (exclude?.ignores(path)) return true;
    let slash = -1;
    for (;;) {
      const folder = slash < 0 ? "" : path.slice(0, slash);
      const rules = at(folder);
      if (rules?.ignores(slash < 0 ? path : path.slice(slash + 1))) return true;
      const next = path.indexOf("/", slash + 1);
      if (next < 0) return false;
      slash = next;
    }
  };
}
