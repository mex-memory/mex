import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  MachineKnowledgeRulesSchema, type MachineKnowledgeCheckout, type MachineKnowledgeRules,
} from "@mex/hub-contracts/machine";
import { KNOWLEDGE_LIMITS, KnowledgeError } from "../../knowledge/contract.js";
import { containedDirectory, readBoundedTextFile } from "../../knowledge/files.js";
import { LOCAL_MANIFEST, readNativeManifest, SHARED_MANIFEST } from "../../knowledge/native-write.js";
import { readRuleFiles, refreshRuleFiles, RULE_CACHE, type RuleCache } from "../../knowledge/rule-cache.js";
import { GENERATED_MARK, listRepositoryFilesAsync, MAX_RULE_FILE_BYTES, ruleFormat } from "../../knowledge/rule-files.js";
import { fileHash } from "../../knowledge/sections.js";
import { openRecord } from "../../record/index.js";
import type { LocationOptions } from "../../record/location.js";
import { machineBusy } from "./agent-repair.js";
import { ControlSnapshot } from "./control-snapshot.js";
import { registeredKnowledgeCheckout } from "./knowledge-checkout.js";
import { knowledgeMissing } from "./knowledge-list.js";
import { HubRequestError } from "./security.js";

const SNAPSHOT_LIMIT = 8;
const MANIFEST_FILE_LIMIT = 200;
const GENERATED_FILE_BYTES = 8 << 10;
const PROJECTION_BYTES = 256 << 10;
const UNAVAILABLE = "Rule files couldn’t be read.";
const EMPTY: MachineKnowledgeRules = { cache: { state: "missing" }, generated: [] };
type Generated = MachineKnowledgeRules["generated"];
type Target = ReturnType<typeof registeredKnowledgeCheckout>;

function importedRules(cache: RuleCache) {
  const counts = new Map<string, number>();
  for (const { path } of cache.entries) counts.set(path, (counts.get(path) ?? 0) + 1);
  const files = cache.files.map(({ path, agents, scope }) => ({ path, agents, scope, entryCount: counts.get(path) ?? 0 }));
  const result = MachineKnowledgeRulesSchema.shape.cache.options[1].parse({ state: "current", files, findings: cache.review });
  if (Buffer.byteLength(JSON.stringify(result)) > PROJECTION_BYTES) throw new Error(UNAVAILABLE);
  return result;
}

function checkoutText(root: string, path: string, maxBytes: number): string | undefined {
  if (path.length > 4096 || /[\\:\x00\r\n]/u.test(path)) return undefined;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return undefined;
  const directory = containedDirectory(root, parts.slice(0, -1));
  if (!directory) return undefined;
  const file = join(directory, parts.at(-1)!);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > maxBytes) return undefined;
  return readBoundedTextFile(file, maxBytes);
}

async function hashesMatch(cache: RuleCache, root: string, signal: AbortSignal): Promise<boolean> {
  let remaining = KNOWLEDGE_LIMITS.scanBytes;
  for (const [index, { path, hash }] of cache.files.entries()) {
    if (index % 8 === 0) await setImmediate(undefined, { signal });
    try {
      const text = checkoutText(root, path, Math.min(MAX_RULE_FILE_BYTES, Math.max(1, remaining)));
      if (text === undefined) return false;
      remaining -= Buffer.byteLength(text);
      if (remaining < 0 || fileHash(text) !== hash) return false;
    } catch { return false; }
  }
  return true;
}

/** Where rule files usually live. A file outside these, such as a nested AGENTS.md, appears on the next Refresh. */
const RULE_FILE_SPOTS = ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md", "AGENTS.override.md", "GEMINI.md", ".cursorrules", ".github/copilot-instructions.md"];
const RULE_FILE_FOLDERS = [".claude/rules", ".cursor/rules", ".github/instructions"];
const FOLDER_ENTRIES = 200;

/**
 * A rule file added since the saved scan, without listing the whole repo. Only files changed
 * after the scan count, so one the scan deliberately leaves out (git-ignored or written by MEX)
 * doesn't keep the notice up after a Refresh.
 */
function addedRuleFile(target: Target, cache: RuleCache): boolean {
  const directory = containedDirectory(target.location.home, ["projects", target.projectId]);
  const scannedAt = directory && lstatSync(join(directory, RULE_CACHE), { throwIfNoEntry: false })?.mtimeMs;
  if (!scannedAt) return false;
  const known = new Set(cache.files.map(({ path }) => path));
  const candidates = [...RULE_FILE_SPOTS];
  for (const folder of RULE_FILE_FOLDERS) {
    const parent = containedDirectory(target.root, folder.split("/"));
    if (!parent) continue;
    try {
      for (const child of readdirSync(parent, { withFileTypes: true }).slice(0, FOLDER_ENTRIES)) {
        if (child.isFile()) candidates.push(folder + "/" + child.name);
      }
    } catch { /* an unreadable folder adds nothing */ }
  }
  return candidates.some((path) => {
    if (known.has(path) || !ruleFormat(path)) return false;
    const parts = path.split("/");
    const parent = parts.length > 1 ? containedDirectory(target.root, parts.slice(0, -1)) : target.root;
    const stat = parent ? lstatSync(join(parent, parts.at(-1)!), { throwIfNoEntry: false }) : undefined;
    if (!stat?.isFile() || stat.mtimeMs <= scannedAt) return false;
    const text = checkoutText(target.root, path, MAX_RULE_FILE_BYTES);
    return text !== undefined && !text.includes(GENERATED_MARK);
  });
}

function generatedRules(target: Target, sharing: Generated[number]["sharing"]): Generated {
  const shared = sharing === "shared";
  const directory = shared
    ? containedDirectory(target.root, [".mex"])
    : containedDirectory(target.location.home, ["projects", target.projectId]);
  if (!directory) return [];
  const { files } = readNativeManifest(join(directory, shared ? basename(SHARED_MANIFEST) : LOCAL_MANIFEST));
  const paths = Object.keys(files).sort();
  if (paths.length > MANIFEST_FILE_LIMIT) throw new Error(UNAVAILABLE);
  // The local manifest is shared across worktrees. Prove each file in this checkout.
  const generated: Generated = [];
  for (const path of paths) {
    const text = checkoutText(target.root, path, GENERATED_FILE_BYTES);
    if (text !== undefined && fileHash(text) === files[path]) generated.push({ path, sharing });
  }
  if (Buffer.byteLength(JSON.stringify(generated)) > PROJECTION_BYTES) throw new Error(UNAVAILABLE);
  return generated;
}

async function readRules(target: Target, signal: AbortSignal): Promise<MachineKnowledgeRules> {
  let cache: MachineKnowledgeRules["cache"] = EMPTY.cache;
  const generated: Generated = [];
  let issue: string | undefined;
  try {
    const saved = readRuleFiles({ home: target.location.home, projectId: target.projectId });
    if (saved && saved.root !== target.root) {
      cache = { state: "stale", files: [], findings: [] };
    } else if (saved) {
      const rules = importedRules(saved);
      const current = await hashesMatch(saved, target.root, signal) && !addedRuleFile(target, saved);
      cache = { ...rules, state: current ? "current" : "stale" };
    }
  } catch { issue = UNAVAILABLE; }
  signal.throwIfAborted();
  for (const sharing of ["shared", "local"] as const) {
    try { generated.push(...generatedRules(target, sharing)); }
    catch { issue = UNAVAILABLE; }
  }
  return { cache, generated, issue };
}

/** A request reads the latest sample. File I/O only runs in the background sampler. */
export class RuleFilesData {
  #snapshots = new Map<string, ControlSnapshot<MachineKnowledgeRules>>();
  #retiredVersion = 0;
  #refreshing = new Set<string>();
  #stop = new AbortController();

  constructor(private readonly location: LocationOptions, private readonly now: () => number) {}

  get version() {
    return this.#retiredVersion + [...this.#snapshots.values()].reduce((total, sample) => total + sample.version, 0);
  }

  get(scope: MachineKnowledgeCheckout): MachineKnowledgeRules {
    registeredKnowledgeCheckout(this.location, scope);
    return { ...EMPTY, ...this.#snapshot(scope).get() };
  }

  async refresh(scope: MachineKnowledgeCheckout): Promise<MachineKnowledgeRules> {
    let target = registeredKnowledgeCheckout(this.location, scope);
    if (this.#refreshing.has(scope.checkout)) {
      throw new HubRequestError(503, "MEX_BUSY", "MEX is busy", "Rule files are already refreshing for this checkout.");
    }
    this.#refreshing.add(scope.checkout);
    try {
      const listed = await listRepositoryFilesAsync(scope.checkout);
      this.#stop.signal.throwIfAborted();
      target = registeredKnowledgeCheckout(this.location, scope);
      const writer = openRecord({ ...this.location, create: false, busyTimeoutMs: 0 });
      try {
        // Keep registration stable through the cache publication, and fail before
        // writing the cache when a different process holds the record writer.
        writer.db.exec("BEGIN IMMEDIATE");
        refreshRuleFiles({ ...this.location, projectPath: scope.checkout }, new Date(this.now()), listed, { writer, projectId: scope.repoId });
        writer.db.exec("COMMIT");
      } finally { writer.close(); }
      const rules = await readRules(target, this.#stop.signal);
      const selected = this.#snapshot(scope);
      selected.replace(rules);
      for (const [key, sample] of this.#snapshots) {
        if (sample !== selected && key.startsWith(scope.repoId + ":")) sample.refresh();
      }
      return rules;
    } catch (error) {
      if (error instanceof HubRequestError) throw error;
      const busy = machineBusy(error);
      if (busy) throw busy;
      if (error instanceof KnowledgeError && error.code === "RECORD_UNAVAILABLE") throw knowledgeMissing(error.message);
      throw new HubRequestError(500, "RULE_FILES_UNAVAILABLE", "Rule files unavailable", "Couldn’t refresh rule files. Try again.");
    } finally {
      this.#refreshing.delete(scope.checkout);
    }
  }

  #snapshot(scope: MachineKnowledgeCheckout) {
    const key = `${scope.repoId}:${scope.checkout}`;
    let sample = this.#snapshots.get(key);
    if (sample) this.#snapshots.delete(key);
    else if (this.#snapshots.size >= SNAPSHOT_LIMIT) {
      const [oldKey, old] = this.#snapshots.entries().next().value!;
      this.#retiredVersion += old.version + 1;
      old.close();
      this.#snapshots.delete(oldKey);
    }
    sample ??= new ControlSnapshot(this.now, signal => readRules(registeredKnowledgeCheckout(this.location, scope), signal), UNAVAILABLE);
    this.#snapshots.set(key, sample);
    return sample;
  }

  touch() {
    for (const sample of this.#snapshots.values()) sample.touch();
  }

  close() {
    this.#stop.abort();
    for (const sample of this.#snapshots.values()) sample.close();
    this.#snapshots.clear();
  }
}
