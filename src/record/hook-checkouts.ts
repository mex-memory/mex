import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../file-index/store.js";
import { shortHash } from "./project.js";

/**
 * The hook decides whether MEX is on for a path without opening SQLite. For
 * every registered checkout, `<record directory>/hook-checkouts/<key>.json`
 * mirrors its `checkouts` row, keyed by shortHash of the real checkout path
 * (native/internal/hook reads it). The database stays the source of truth;
 * whoever changes a checkout row calls writeHookCheckouts afterwards.
 */
export const HOOK_CHECKOUT_VERSION = 1;
export const HOOK_CHECKOUTS_DIRECTORY = "hook-checkouts";

interface Row { project_id: string; path: string; state: string; off_until: string | null; provisional: string | null; }
interface Source { prepare(sql: string): { all(): unknown[] } }

export function hookCheckoutText(row: Row): string {
  return `${JSON.stringify({
    version: HOOK_CHECKOUT_VERSION, project_id: row.project_id, root: row.path,
    state: row.state, off_until: row.off_until ?? "", provisional: row.provisional !== null,
  })}\n`;
}

/** Rewrites changed mirrors and removes mirrors of checkouts that are gone. Best effort: never throws. */
export function writeHookCheckouts(db: Source, recordDirectory: string): void {
  try {
    const directory = join(recordDirectory, HOOK_CHECKOUTS_DIRECTORY);
    const rows = db.prepare("SELECT project_id,path,state,off_until,provisional FROM checkouts").all() as Row[];
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keep = new Set<string>();
    for (const row of rows) {
      const name = `${shortHash(row.path)}.json`;
      keep.add(name);
      const file = join(directory, name);
      const text = hookCheckoutText(row);
      try { if (readFileSync(file, "utf8") === text) continue; } catch { /* not written yet */ }
      try { writeAtomic(file, text); } catch { /* the next registration retries */ }
    }
    for (const name of readdirSync(directory)) {
      if (name.endsWith(".json") && !keep.has(name)) { try { unlinkSync(join(directory, name)); } catch { /* retried next time */ } }
    }
  } catch { /* the hook then treats the checkout as off, which is safe */ }
}
