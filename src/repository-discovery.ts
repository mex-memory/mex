import { delimiter, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** Keep filesystem discovery inside the same explicit boundary as Git. */
export function gitDiscoveryCeilingReached(directory: string): boolean {
  const canonical = (path: string): string => {
    let result = resolve(path);
    try { result = realpathSync(result); } catch { /* A missing ceiling cannot be visited. */ }
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  const ceilings = process.env.GIT_CEILING_DIRECTORIES;
  if (!ceilings) return false;
  const current = canonical(directory);
  return ceilings.split(delimiter).filter(isAbsolute).some((path) => canonical(path) === current);
}
