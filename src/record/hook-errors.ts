import { join } from "node:path";
import { z } from "zod";
import { readBoundedTextFile } from "../knowledge/files.js";

const kind = z.enum(["panic", "parse", "delivery", "busy"]);
const timestamp = z.string().datetime({ offset: true }).refine(at => Number.isFinite(Date.parse(at)));
const hookErrorsFile = z.object({
  version: z.literal(1),
  counts: z.record(kind, z.number().int().nonnegative().safe()),
  first: timestamp,
  recent: z.array(z.object({
    at: timestamp,
    agent: z.string(),
    event: z.string(),
    kind,
    detail: z.string(),
  })).max(20),
});

export type HookErrors = Omit<z.infer<typeof hookErrorsFile>, "version"> & { total: number; announced: number };

/** Read the Go hook's bounded error file without opening either database. */
export function readHookErrors(directory: string): HookErrors | null {
  try {
    const text = readBoundedTextFile(join(directory, "hook-errors.json"), 64 << 10);
    if (text === undefined) return null;
    const { counts, first, recent } = hookErrorsFile.parse(JSON.parse(text));
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(total)) return null;
    return { total, announced: total - (counts.busy ?? 0), counts, first, recent };
  } catch { return null; }
}
