import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSnapshot, replaceFile } from "../install/files.js";
import { containedDirectory } from "../knowledge/files.js";
import { openHooksReadOnly, type RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import { compactEvidence, findWindowOffer } from "./evidence.js";

const agents = ["claude-code", "codex"] as const;
const markerData = Buffer.from("1\n").toString("base64");
const pendingPath = (directory: string, agent: string) => join(directory, `compaction-offer-pending.${agent}`);

export function compactOffersPending(directory: string): boolean {
  return agents.some(agent => existsSync(pendingPath(directory, agent)));
}

/** Publish small, derived hints. The hook owns the once-per-host receipt. */
export function publishCompactOffers(writer: RecordWriter): void {
  for (const agent of agents) {
    const pending = pendingPath(writer.location.directory, agent);
    try { unlinkSync(pending); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try {
      if (writer.setting("global", "capture.enabled") === "false") continue;
      const hooks = openHooksReadOnly({ home: writer.location.home });
      try {
        if (!hooks || hooks.diagnostic || hooks.get("SELECT 1 FROM notices_shown WHERE notice_id=?", `compaction.offer.${agent}`)) continue;
      } finally { hooks?.close(); }
      const samples = compactEvidence(writer.location, agent);
      const keys = agent === "claude-code" ? (findWindowOffer(samples, agent) ? [agent] : [])
        : [...new Set(samples.map(sample => sample.checkout))]
            .filter(checkout => findWindowOffer(samples.filter(sample => sample.checkout === checkout), agent))
            .map(checkout => `codex.${shortHash(checkout)}`);
      if (!keys.length) continue;
      const directory = containedDirectory(writer.location.directory, ["compaction-offers"], true)!;
      for (const key of keys) {
        const path = join(directory, key);
        const current = readSnapshot(path, 2);
        replaceFile(path, current, { data: markerData, mode: 0o600 });
      }
    } catch (error) {
      // Another hook may already have requested a newer pass.
      try { writeFileSync(pending, "", { flag: "wx", mode: 0o600 }); } catch { /* later lifecycle signals also retry */ }
      throw error;
    }
  }
}
