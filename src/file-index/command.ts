import { queueJob } from "../record/background.js";
import { openRecord, type RecordWriter } from "../record/index.js";
import type { IndexJobParams } from "./job.js";
import type { OutlineAnswer } from "./read.js";

/** The checkout and project for a folder, registering the project if it is new. */
function locate(path: string): { writer: RecordWriter; projectId: string; checkout: string } {
  const writer = openRecord({ projectPath: path });
  const row = writer.checkout(path);
  if (!row) { writer.close(); throw new Error(`MEX couldn't find a project for ${path}.`); }
  return { writer, projectId: row.project_id, checkout: row.path };
}

/** Queue a build or refresh of this checkout's index for the background process. */
export function queueIndexBuild(writer: RecordWriter, projectId: string, checkout: string, full = false): void {
  queueJob(writer, { kind: "file-index", projectId, params: { checkout, ...(full ? { full } : {}) } satisfies IndexJobParams });
}

/** `mex index`: build or refresh now, in this terminal. */
export async function runIndexBuild(options: { path?: string; full?: boolean; json?: boolean; workers?: number }): Promise<void> {
  const { writer, projectId, checkout } = locate(options.path ?? process.cwd());
  const directory = writer.location.directory;
  writer.close();
  const { buildIndex } = await import("./build.js");
  const showProgress = !options.json && process.stderr.isTTY;
  const result = await buildIndex({
    root: checkout, projectId, recordDirectory: directory, full: options.full, workers: options.workers,
    onProgress: showProgress ? (done, total) => process.stderr.write(`\rIndexing ${done} of ${total} files`) : undefined,
  });
  if (showProgress) process.stderr.write("\r\x1b[K");
  if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
  const skipped = Object.entries(result.notIndexed).map(([reason, count]) => `${count} ${reason}`).join(", ");
  console.log(`Indexed ${result.indexed} of ${result.files} files in ${(result.ms.total / 1000).toFixed(1)} s (measured).`);
  console.log(`  Read ${result.read}, parsed ${result.parsed}, reused ${result.reused}, unchanged ${result.unchanged}.`);
  if (skipped) console.log(`  Not indexed: ${skipped}.`);
  console.log(`  Listing ${result.ms.discover} ms, reading and parsing ${result.ms.process} ms, writing ${result.ms.write} ms.`);
}

/** `mex index outline <file>`: the symbols with their current line spans. */
export async function runIndexOutline(file: string, options: { json?: boolean }): Promise<void> {
  const { writer, projectId, checkout } = locate(process.cwd());
  const directory = writer.location.directory;
  writer.close();
  const { openIndex } = await import("./read.js");
  const index = openIndex({ recordDirectory: directory, projectId, checkout });
  if (!index) { console.log("This checkout has no index yet. Run `mex index` to build it."); process.exitCode = 1; return; }
  try {
    const answer = index.outline(file);
    if (options.json) { console.log(JSON.stringify(answer, null, 2)); return; }
    if ("not_indexed" in answer) { console.log(`${answer.path}: not indexed (${answer.not_indexed}).`); return; }
    printOutline(answer);
  } finally { index.close(); }
}

function printOutline(answer: OutlineAnswer): void {
  console.log(`${answer.path} (index as of ${answer.as_of})`);
  const depth = (index: number): number => {
    let level = 0;
    for (let parent = answer.symbols[index]!.parent; parent !== undefined; parent = answer.symbols[parent]!.parent) level++;
    return level;
  };
  answer.symbols.forEach((item, index) => {
    const lines = item.start === item.end ? `${item.start}` : `${item.start}-${item.end}`;
    console.log(`${"  ".repeat(depth(index) + 1)}${item.kind} ${item.name}  ${lines}`);
  });
  if (answer.dropped > 0) console.log(`  (${answer.dropped} symbols left out: an edit changed their first or last line; they come back at the next re-parse.)`);
}

/** `mex index status`: when the index was built and what it covers. */
export async function runIndexStatus(options: { json?: boolean }): Promise<void> {
  const { writer, projectId, checkout } = locate(process.cwd());
  const directory = writer.location.directory;
  writer.close();
  const { openIndex } = await import("./read.js");
  const index = openIndex({ recordDirectory: directory, projectId, checkout });
  if (!index) {
    if (options.json) console.log(JSON.stringify({ checkout, indexed: false }));
    else console.log("This checkout has no index yet. Run `mex index` to build it.");
    return;
  }
  try {
    const coverage = index.coverage("**");
    if (options.json) { console.log(JSON.stringify({ checkout, as_of: index.asOf, ...coverage }, null, 2)); return; }
    console.log(`Index of ${checkout}, as of ${index.asOf}.`);
    console.log(`  ${coverage.indexed} of ${coverage.files} files indexed.`);
    for (const [reason, count] of Object.entries(coverage.not_indexed)) console.log(`  ${count} not indexed: ${reason}.`);
  } finally { index.close(); }
}
