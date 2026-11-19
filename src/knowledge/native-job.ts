import { existsSync } from "node:fs";
import { mexHomeDir } from "../global-config.js";
import { registerJobKind } from "../record/jobs.js";
import { liveSessions } from "./agents-in-use.js";

/**
 * `stale`: the hook found a note in these files that the code no longer
 * supports. `local`: the person's own notes changed, so their hidden local
 * files are rewritten now; the shared files keep waiting for the session.
 */
export interface NativeJobParams { checkout: string; stale?: boolean; local?: boolean; }

/**
 * Rebuild the native rule files after entries change. It waits while a
 * session runs in the checkout, so shared files never change mid-session,
 * except when the files already carry a note the code has made false: then it
 * runs at once, and the rebuild drops that note. A note the person saves,
 * edits or forgets rewrites only their local files, also at once: otherwise a
 * session left open keeps every later session from loading it.
 */
registerJobKind<NativeJobParams, Record<string, never>>({
  name: "native-files",
  label: "Rule files",
  scope: "project",
  // A rebuild writes what the entries say; running it twice changes nothing.
  sideEffects: "idempotent",
  async runBatch({ params, writer }) {
    const { rebuildNative } = await import("./native.js");
    const rebuild = params.stale === true ? { force: true } : params.local === true ? { force: true, localOnly: true } : {};
    const result = rebuildNative({ projectPath: params.checkout, home: writer.location.home }, rebuild);
    if (result.deferred) return { checkpoint: {}, wait: `A ${result.deferred.agents.join(" and ")} session is running here` };
    const changed = (result.written?.length ?? 0) + (result.removed?.length ?? 0);
    return { checkpoint: {}, done: true, results: changed, summary: changed ? `${changed} rule files updated` : "Rule files already match the entries" };
  },
  ready(job) {
    try {
      const { checkout, stale, local } = JSON.parse(job.params) as NativeJobParams;
      return stale === true || local === true || !existsSync(checkout) || liveSessions(checkout, mexHomeDir()).length === 0;
    } catch { return true; }
  },
  // One job per checkout and purpose. A rebuild that has started may have read
  // the entries before this change, and one waiting for a session must not
  // hold back a request that has to run now.
  joins(open, next) {
    let have: NativeJobParams;
    try { have = JSON.parse(open.params) as NativeJobParams; } catch { return false; }
    if (have.checkout !== next.checkout || open.state === "running") return false;
    if (have.stale === true) return true;
    if (next.stale === true) return false;
    return (have.local === true) === (next.local === true);
  },
});
