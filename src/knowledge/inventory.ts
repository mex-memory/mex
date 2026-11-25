import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_LIMITS, parseEntry, type KnowledgeEntry } from "./entry.js";
import { readEntryFile } from "./files.js";

/** Share one scan budget across a project's stores and visit each entry without retaining its body. */
export function entryInventory(retired: ReadonlySet<string>) {
  let bytes = 0, seen = 0;
  function scan(directory: string | undefined, depth: number, visit: (entry: KnowledgeEntry) => void): number {
    if (!directory || !existsSync(directory)) return 0;
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Redirected store");
    const handle = opendirSync(directory);
    let count = 0;
    try {
      let child;
      while ((child = handle.readSync())) {
        if (++seen > KNOWLEDGE_LIMITS.entries) throw new Error("Store limit");
        const file = join(directory, child.name);
        if (child.isSymbolicLink()) throw new Error("Redirected entry");
        if (child.isDirectory() && depth) { count += scan(file, depth - 1, visit); continue; }
        if (!child.isFile() || !child.name.endsWith(".md") || child.name.startsWith(".")) continue;
        const text = readEntryFile(file);
        if (text === undefined) continue;
        bytes += Buffer.byteLength(text);
        if (bytes > KNOWLEDGE_LIMITS.scanBytes) throw new Error("Store limit");
        const entry = parseEntry(text);
        if (entry.mex.status !== "active" || retired.has(entry.mex.id)) continue;
        visit(entry);
        count++;
      }
    } finally { handle.closeSync(); }
    return count;
  }
  return scan;
}
