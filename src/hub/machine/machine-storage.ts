import type { MachineStorageSchema } from "@mex/hub-contracts/machine";
import { lstatSync, opendirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { z } from "zod";
import { indexDirectory } from "../../file-index/store.js";
import { containedDirectory } from "../../knowledge/files.js";
import type { RecordLocation } from "../../record/location.js";
import type { MachineProject } from "./machine-projects.js";

export type MachineStorage = z.infer<typeof MachineStorageSchema>;

class SizeSample {
  #entries = 0;
  #deadline = performance.now() + 500;
  partial = false;

  constructor(private readonly signal: AbortSignal) {}

  bytes(file: string) {
    try {
      const info = lstatSync(file, { throwIfNoEntry: false });
      if (!info) return 0;
      if (info.isFile()) return info.size;
    } catch { /* Count a lower bound when a store cannot be read. */ }
    this.partial = true;
    return 0;
  }

  database(path: string): number {
    return [path, path + "-wal", path + "-shm"].reduce((bytes, file) => bytes + this.bytes(file), 0);
  }

  async tree(path: string, depth = 0): Promise<number> {
    if (this.#entries >= 16_384 || performance.now() > this.#deadline || depth > 24) {
      this.partial = true;
      return 0;
    }
    if (++this.#entries % 64 === 0) await setImmediate(undefined, { signal: this.signal });
    this.signal.throwIfAborted();
    let bytes = 0;
    try {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink()) return 0;
      if (!info.isDirectory()) return info.isFile() ? info.size : 0;
      const directory = opendirSync(path);
      try {
        for (let entry; (entry = directory.readSync());) {
          if (this.#entries >= 16_384 || performance.now() > this.#deadline) { this.partial = true; break; }
          bytes += await this.tree(join(path, entry.name), depth + 1);
        }
      } finally { directory.closeSync(); }
    } catch { this.signal.throwIfAborted(); this.partial = true; }
    return bytes;
  }
}

export async function storageSnapshot(location: RecordLocation, projects: MachineProject[], partial: boolean, signal: AbortSignal): Promise<MachineStorage> {
  const { home, directory, record, hooks } = location;
  const notes = join(home, "projects");
  const telemetry = [join(home, "telemetry-id"), join(home, "telemetry", "outbox.db")];
  const sample = new SizeSample(signal);
  const recordBytes = sample.database(record), hooksBytes = sample.database(hooks);
  let telemetryBytes = sample.bytes(telemetry[0]);
  try {
    if (containedDirectory(home, ["telemetry"])) telemetryBytes += sample.database(telemetry[1]);
  } catch { partial = true; }
  const indexes: MachineStorage["indexes"] = [];
  let notesBytes = 0;
  for (const { id, name } of projects) {
    signal.throwIfAborted();
    try {
      if (containedDirectory(home, ["projects", id])) {
        notesBytes += await sample.tree(join(notes, id, "notes")) + await sample.tree(join(notes, id, "hints"));
      }
      if (containedDirectory(directory, ["projects", id, "index"])) {
        const path = indexDirectory(directory, id);
        indexes.push({ repoId: id, repo: name, path, bytes: await sample.tree(path) });
      }
    } catch { signal.throwIfAborted(); partial = true; }
  }
  return { recordBytes, hooksBytes, indexes, notesBytes, telemetryBytes,
    totalBytes: recordBytes + hooksBytes + notesBytes + telemetryBytes + indexes.reduce((bytes, index) => bytes + index.bytes, 0),
    paths: { record, hooks, notes, indexes: join(directory, "projects"), telemetry },
    partial: partial || sample.partial,
    // These are native record retention limits at session start.
    retention: { deliveryDays: 30, captureDays: 90, captureMegabytes: 200 },
  };
}

/** Include other data (logs and runtime) left by uninstall, once per on-disk root. */
export async function retainedData(location: RecordLocation, signal: AbortSignal) {
  const { home, directory } = location;
  const rel = relative(home, directory);
  const separate = rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel));
  const sample = new SizeSample(signal);
  const dataSize = await sample.tree(home) + (separate ? await sample.tree(directory) : 0);
  return { dataPath: home, additionalDataPath: separate ? directory : undefined, dataSize, partial: sample.partial };
}
