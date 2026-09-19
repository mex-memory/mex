import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Same-directory files owned by graph maintenance publication/recovery. */
export const OWNED_DATABASE_PREFIXES = [
  "graph.db.candidate-",
  "graph.db.rollback-",
  "graph.db.recovery-",
] as const;

export function isOwnedDatabaseBasename(name: string): boolean {
  return OWNED_DATABASE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Regular files in `.mex/` whose names start with an owned maintenance prefix.
 * Read-only: does not follow a symlink `.mex` directory or any symlink entry.
 */
export function listOwnedDatabaseArtifacts(mexDir: string): string[] {
  let directoryStats;
  try {
    directoryStats = lstatSync(mexDir);
  } catch {
    return [];
  }
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return [];

  let names: string[];
  try {
    names = readdirSync(mexDir);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const name of names) {
    if (!isOwnedDatabaseBasename(name)) continue;
    try {
      const stats = lstatSync(join(mexDir, name));
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      found.push(name);
    } catch {
      // An entry that disappears between readdir and lstat is not reported.
    }
  }
  return found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
