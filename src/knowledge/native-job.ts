import { existsSync } from "node:fs";
import { mexHomeDir } from "../global-config.js";
import { registerJobKind } from "../record/jobs.js";
import { liveSessions } from "./agents-in-use.js";

/** `stale`: the hook found a note in these files that the code no longer supports. */
export interface NativeJobParams { checkout: string; stale?: boolean; }

/**
 * Rebuild the native rule files after entries change. It waits while a
 * session runs in the checkout, so files never change mid-session, except
 * when the files already carry a note the code has made false: then it runs
 * at once, and the rebuild drops that note.
 */
registerJobKind<NativeJobParams, Record<string, never>>({
  name: "native-files",
  label: "Rule files",
  scope: "project",
  // A rebuild writes what the entries say; running it twice changes nothing.
  sideEffects: "idempotent",
  async runBatch({ params, writer }) {
    const { rebuildNative } = await import("./native.js");
    const result = rebuildNative({ projectPath: params.checkout, home: writer.location.home }, params.stale === true ? { force: true } : {});
    if (result.deferred) return { checkpoint: {}, wait: `A ${result.deferred.agents.join(" and ")} session is running here` };
    const changed = (result.written?.length ?? 0) + (result.removed?.length ?? 0);
    return { checkpoint: {}, done: true, results: changed, summary: changed ? `${changed} rule files updated` : "Rule files already match the entries" };
  },
  ready(job) {
    try {
      const { checkout, stale } = JSON.parse(job.params) as NativeJobParams;
      return stale === true || !existsSync(checkout) || liveSessions(checkout, mexHomeDir()).length === 0;
    } catch { return true; }
  },
});
