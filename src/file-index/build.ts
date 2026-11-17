/**
 * Building and refreshing a checkout's file index. A refresh stats every file
 * and reads only those whose size or mtime changed; a file whose content is
 * already indexed (by hash, in any checkout of the project) isn't parsed again.
 * So a branch switch re-reads only what changed.
 */
import { existsSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { realPath } from "../record/project.js";
import { processBatch, type BatchInput, type BatchOutput, type BatchRow } from "./batch.js";
import { discoverFiles } from "./discover.js";
import { removeStaleShifts } from "./shifts.js";
import {
  baseSize, checkoutKey, checkoutSnapshots, collectGarbage, currentBase, indexDirectory, liveRecordKeys, loadPrevious, patternsVersion,
  readPatterns, readPointer, RecordSource, writeBase, writeCheckout, writeLocator, type PathRow, type Pointer,
} from "./store.js";
import { EXTRACTOR_VERSION, type FileRecord, type NotIndexedReason } from "./types.js";

export interface BuildOptions {
  /** The checkout folder. */
  root: string;
  projectId: string;
  /** The local record's directory (`RecordLocation.directory`). */
  recordDirectory: string;
  /** Worker threads; 0 runs in this thread. Default: cores − 1, at most 8, fewer on low memory. */
  workers?: number;
  /** Ignore the previous snapshot and read every file. */
  full?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildResult {
  pointer: Pointer;
  directory: string;
  key: string;
  via: "git" | "walk";
  files: number;
  indexed: number;
  notIndexed: Partial<Record<NotIndexedReason, number>>;
  read: number;
  parsed: number;
  reused: number;
  unchanged: number;
  base: "new" | "kept" | "grown" | "compacted";
  extras: number;
  ms: { discover: number; process: number; write: number; total: number };
}

/** Below this many files, worker start-up costs more than it saves. */
const WORKER_THRESHOLD = 1500;

/** Build or refresh the index of one checkout. */
export async function buildIndex(options: BuildOptions): Promise<BuildResult> {
  const started = performance.now();
  const startedAt = Date.now();
  const root = realPath(options.root);
  const key = checkoutKey(root);
  const directory = indexDirectory(options.recordDirectory, options.projectId);
  const patterns = readPatterns(directory);
  const pointer = options.full ? undefined : readPointer(directory, key);
  const previous = pointer ? loadPrevious(directory, pointer) : undefined;
  const base = currentBase(directory, patterns);
  const reuse = !options.full && (previous === undefined || (previous.patterns === patternsVersion(patterns) && previous.extractor === String(EXTRACTOR_VERSION)));

  const discovered = await discoverFiles(root);
  const afterDiscover = performance.now();

  // Records can come from the base, this checkout's last snapshot, or another checkout's (a worktree on another branch).
  const others = checkoutSnapshots(directory).filter((name) => name !== pointer?.snapshot).slice(0, 8);
  const sources = [...new Set([base, pointer?.snapshot, pointer?.base, ...others].filter((name): name is string => name !== undefined))].map((name) => join(directory, name));
  const previousRows = previous && reuse ? previous.paths : new Map<string, PathRow>();
  const outputs = await runBatches(discovered.paths, (paths) => ({
    root, paths, sources, patterns, reuse,
    previous: Object.fromEntries(paths.flatMap((path) => { const row = previousRows.get(path); return row ? [[path, row]] : []; })),
  }), options);
  const afterProcess = performance.now();

  const rows: BatchRow[] = outputs.flatMap((output) => output.rows);
  const parsedHere = new Map<string, FileRecord>();
  for (const row of rows) if (row.record) parsedHere.set(`${row.hash}:${row.lang}`, row.record);
  const referenced = new Set<string>();
  for (const row of rows) if (row.hash && row.lang) referenced.add(`${row.hash}:${row.lang}`);

  const lookup = new RecordSource(sources);
  try {
    const record = (keyText: string): FileRecord | undefined => {
      const found = parsedHere.get(keyText);
      if (found) return found;
      const [hash, lang] = keyText.split(":") as [string, FileRecord["lang"]];
      return lookup.get(hash, lang);
    };
    const notInBase = (keyText: string): boolean => {
      if (!base) return true;
      const [hash, lang] = keyText.split(":") as [string, FileRecord["lang"]];
      return !lookup.inFirst(hash, lang);
    };
    const missing = [...referenced].filter(notInBase);
    let baseName = base;
    let baseOutcome: BuildResult["base"] = "kept";
    if (!baseName) {
      baseName = writeBase(directory, collect([...referenced], record), patterns);
      baseOutcome = "new";
    } else if (missing.length > Math.max(500, referenced.size / 10)) {
      const size = baseSize(directory, baseName);
      const live = liveRecordKeys(directory);
      if (size > 2 * Math.max(live.size, referenced.size)) {
        // Mostly old versions: start a fresh base from what checkouts use now.
        for (const keyText of referenced) live.add(keyText);
        baseName = writeBase(directory, collect([...live], record), patterns);
        baseOutcome = "compacted";
      } else {
        baseName = writeBase(directory, collect(missing, record), patterns, baseName);
        baseOutcome = "grown";
      }
    }
    const extrasKeys = baseOutcome === "kept" ? missing : [];
    const paths: PathRow[] = rows.map(({ record: _record, ...row }) => row);
    const written = writeCheckout(directory, key, { root, via: discovered.via, paths, extras: collect(extrasKeys, record), base: baseName, patterns });
    writeLocator(options.recordDirectory, key, options.projectId, root);
    removeStaleShifts(directory, key, new Map(paths.filter((row) => row.hash).map((row) => [row.path, row.mtime_ns])), startedAt);
    collectGarbage(directory);
    const ended = performance.now();
    const notIndexed: Partial<Record<NotIndexedReason, number>> = {};
    for (const row of rows) if (row.reason) notIndexed[row.reason] = (notIndexed[row.reason] ?? 0) + 1;
    const sum = (field: keyof Omit<BatchOutput, "rows">) => outputs.reduce((total, output) => total + output[field], 0);
    return {
      pointer: written, directory, key, via: discovered.via, files: rows.length,
      indexed: rows.filter((row) => !row.reason).length, notIndexed,
      read: sum("read"), parsed: sum("parsed"), reused: sum("reused"), unchanged: sum("unchanged"),
      base: baseOutcome, extras: extrasKeys.length,
      ms: { discover: Math.round(afterDiscover - started), process: Math.round(afterProcess - afterDiscover), write: Math.round(ended - afterProcess), total: Math.round(ended - started) },
    };
  } finally { lookup.close(); }
}

function* collect(keys: readonly string[], record: (key: string) => FileRecord | undefined): Generator<FileRecord> {
  for (const key of keys) {
    const found = record(key);
    if (found) yield found;
  }
}

/** The worker script next to this module in the built CLI; absent when running from source. */
function workerScript(): string | undefined {
  try {
    const file = fileURLToPath(new URL("./file-index-worker.js", import.meta.url));
    return existsSync(file) ? file : undefined;
  } catch { return undefined; }
}

/** Cores − 1, at most 8, and one per 512 MB of free memory. */
export function defaultWorkers(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 1, Math.floor(freemem() / (512 * 1024 * 1024))));
}

async function runBatches(paths: readonly string[], input: (paths: string[]) => BatchInput, options: BuildOptions): Promise<BatchOutput[]> {
  const script = workerScript();
  const wanted = options.workers ?? (paths.length < WORKER_THRESHOLD ? 0 : defaultWorkers());
  const threads = script ? wanted : 0;
  // About six batches per worker, so a slow batch doesn't hold the others up.
  const size = Math.max(50, Math.min(400, Math.ceil(paths.length / (Math.max(1, threads) * 6))));
  const batches: string[][] = [];
  for (let at = 0; at < paths.length; at += size) batches.push(paths.slice(at, at + size));
  const count = Math.min(threads, batches.length);
  const outputs: BatchOutput[] = new Array(batches.length);
  let next = 0, done = 0;
  const report = (output: BatchOutput) => { done += output.rows.length; options.onProgress?.(done, paths.length); };
  if (count <= 0) {
    // In this thread: still overlap the reads of several batches.
    await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
      while (next < batches.length) {
        const index = next++;
        outputs[index] = await processBatch(input(batches[index]!));
        report(outputs[index]!);
      }
    }));
    return outputs;
  }
  const workers = Array.from({ length: count }, () => new Worker(script!));
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      const send = () => {
        if (next >= batches.length) { resolve(); return; }
        const index = next++;
        worker.postMessage({ id: index, input: input(batches[index]!) });
      };
      worker.on("message", (message: { id: number; output?: BatchOutput; error?: string }) => {
        if (message.error !== undefined || !message.output) { reject(new Error(message.error ?? "index worker failed")); return; }
        outputs[message.id] = message.output;
        report(message.output);
        send();
      });
      worker.on("error", reject);
      send();
    })));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
  return outputs;
}
