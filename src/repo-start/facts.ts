/**
 * The setup facts contract's files: derived, local and rebuilt by `mex`, never
 * in the working tree. Each is written atomically (a temp file, then a rename)
 * into `<MEX home>/projects/<project-id>/`.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDataDirectory, type RecordLocation } from "../record/location.js";
import type { Caller } from "./caller.js";

export const SETUP_FACTS_VERSION = 1;
const MAX_FACT_BYTES = 8 << 20;

export interface SetupRun {
  version: 1;
  last_run: string;
  ms: number;
  caller: Caller;
  found: { packages: number; recipes: number; rule_files: number; rule_conflicts: number; hints: number };
  exclude: { file: string; block: boolean };
}

export function writeFactFile(location: RecordLocation, projectId: string, name: "setup.json" | "recipes.json" | "code-facts.json" | "setup-answers.json", value: unknown): string {
  const directory = projectDataDirectory(location, projectId);
  const file = join(directory, name);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_FACT_BYTES) throw new Error(`${name} exceeds its size bound.`);
  removeAbandonedTemporaries(directory, name);
  const temporary = join(directory, `.${name}.${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return file;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Temp files a killed writer left behind; never one a live process may still rename. */
function removeAbandonedTemporaries(directory: string, name: string): void {
  let entries: string[] = [];
  try { entries = readdirSync(directory); } catch { return; }
  for (const entry of entries) {
    const match = new RegExp(`^\\.${name.replace(/[.]/gu, "\\.")}\\.(\\d+)-[0-9a-f]{12}$`, "u").exec(entry);
    if (!match || Number(match[1]) === process.pid || alive(Number(match[1]))) continue;
    try { unlinkSync(join(directory, entry)); } catch { /* another writer removed it */ }
  }
}

/** A missing, unreadable or unknown-version file reads as nothing found. */
export function readFactFile<T extends { version: number }>(location: RecordLocation, projectId: string, name: string): T | undefined {
  if (!/^[gf]-[a-f0-9]{24}$/u.test(projectId)) return undefined;
  const file = join(location.home, "projects", projectId, name);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FACT_BYTES) return undefined;
    const value = JSON.parse(readFileSync(file, "utf8")) as T;
    return value?.version === SETUP_FACTS_VERSION ? value : undefined;
  } catch { return undefined; }
}
