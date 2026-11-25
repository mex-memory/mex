import { opendirSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { containedDirectory, readBoundedTextFile } from "../knowledge/files.js";
import { hasSecret, stripHidden } from "../knowledge/gates.js";
import type { RecordWriter } from "../record/index.js";
import { shortHash } from "../record/project.js";
import type { CaptureAgent } from "./profiles.js";
import { timestampNs } from "./time.js";

const Cache = z.object({ version: z.literal(1), project_id: z.string(), checkout: z.string(), agent: z.string(), session_id: z.string(),
  at: z.string().datetime({ offset: true }), text: z.string().max(12_000), for_prompt_at: z.string().datetime({ offset: true }).optional(),
}).strict();
const CACHE_FILE = /^[0-9]{19}\.json$/u;
export interface ReplyCache { file: string; at: string; promptAt?: string; text: string; }

/** Reads one generation. A malformed new record cannot expose an older response. */
export function readReplyCache(writer: Pick<RecordWriter, "location">, project: string, checkout: string, agent: CaptureAgent, session: string, now: number): ReplyCache | undefined {
  const key = shortHash([project, checkout, agent, session].join("\0"));
  try {
    const folder = containedDirectory(writer.location.directory, ["filter-replies", key]);
    if (!folder) return;
    const dir = opendirSync(folder);
    let last = "";
    try {
      for (let i = 0; i < 128; i++) {
        const entry = dir.readSync();
        if (!entry) break;
        if (entry.isFile() && CACHE_FILE.test(entry.name) && entry.name > last) last = entry.name;
      }
    } finally { dir.closeSync(); }
    if (!last) return;
    const file = join(folder, last), raw = readBoundedTextFile(file, 16 << 10);
    if (!raw) return;
    const cache = Cache.parse(JSON.parse(raw));
    if (cache.project_id !== project || cache.checkout !== checkout || cache.agent !== agent || cache.session_id !== session
      || last !== `${timestampNs(cache.at)}.json`) return;
    const at = Date.parse(cache.at);
    const text = now - 86_400_000 <= at && at <= now && Buffer.byteLength(cache.text) <= 12_000 && stripHidden(cache.text) === cache.text
      && !hasSecret(cache.text) && !/<\s*\/?\s*private\b/iu.test(cache.text) ? cache.text : "";
    return { file, at: cache.at, promptAt: cache.for_prompt_at, text };
  } catch { return undefined; }
}

/** A newly captured response has a different path even if the session resumes during cleanup. */
export function removeReplyCache(writer: Pick<RecordWriter, "location">, file: string): void {
  const folder = dirname(file), slot = basename(folder);
  try {
    if (!/^[a-f0-9]{24}$/u.test(slot) || !CACHE_FILE.test(basename(file)) ||
      folder !== containedDirectory(writer.location.directory, ["filter-replies", slot])) return;
    unlinkSync(file);
    rmdirSync(folder);
  } catch { /* already unavailable or a newer response arrived */ }
}
