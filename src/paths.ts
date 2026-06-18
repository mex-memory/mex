import { sep } from "node:path";

/**
 * Normalize a filesystem path to forward slashes.
 *
 * `path.relative()` and `glob` return native separators (`\` on Windows). mex's
 * output contracts — drift issue `file` fields, heartbeat `staleFiles`, scanner
 * entry-point `path`s — are forward-slash strings: they're printed to users,
 * JSON-serialized, consumed by mex-agent, and compared with literals like
 * `source.includes("patterns/")`. Run every native path through this before it
 * crosses one of those boundaries so behavior is identical on every OS.
 */
export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
