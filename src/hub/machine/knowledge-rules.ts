import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  MachineKnowledgeRulesSchema, type MachineKnowledgeCheckout, type MachineKnowledgeRules,
} from "@mex/hub-contracts/machine";
import { containedDirectory, readBoundedTextFile } from "../../knowledge/files.js";
import { LOCAL_MANIFEST, readNativeManifest, SHARED_MANIFEST } from "../../knowledge/native-write.js";
import { readRuleFiles, type RuleCache } from "../../knowledge/rule-cache.js";
import { fileHash } from "../../knowledge/sections.js";
import type { LocationOptions } from "../../record/location.js";
import { ControlSnapshot } from "./control-snapshot.js";
import { registeredKnowledgeCheckout } from "./knowledge-checkout.js";

const SNAPSHOT_LIMIT = 8;
const MANIFEST_FILE_LIMIT = 200;
const GENERATED_FILE_BYTES = 8 << 10;
const PROJECTION_BYTES = 256 << 10;
const UNAVAILABLE = "Rule files couldn’t be read.";
const EMPTY: MachineKnowledgeRules = { cache: { state: "missing" }, generated: [] };
type Generated = MachineKnowledgeRules["generated"];
type Target = ReturnType<typeof registeredKnowledgeCheckout>;

function importedRules(cache: RuleCache): MachineKnowledgeRules["cache"] {
  const counts = new Map<string, number>();
  for (const { path } of cache.entries) counts.set(path, (counts.get(path) ?? 0) + 1);
  const files = cache.files.map(({ path, agents, scope }) => ({ path, agents, scope, entryCount: counts.get(path) ?? 0 }));
  const result = MachineKnowledgeRulesSchema.shape.cache.parse({ state: "current", files, findings: cache.review });
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

function generatedRules(target: Target, sharing: Generated[number]["sharing"]): Generated {
  const shared = sharing === "shared";
  const directory = shared
    ? containedDirectory(target.root, [".mex"])
    : containedDirectory(target.location.home, ["projects", target.projectId]);
  if (!directory) return [];
  const { files } = readNativeManifest(join(directory, shared ? SHARED_MANIFEST.split("/").at(-1)! : LOCAL_MANIFEST));
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

function readRules(target: Target): MachineKnowledgeRules {
  let cache = EMPTY.cache;
  const generated: Generated = [];
  let issue: string | undefined;
  try {
    const saved = readRuleFiles({ home: target.location.home, projectId: target.projectId });
    if (saved) cache = importedRules(saved);
  } catch { issue = UNAVAILABLE; }
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

  constructor(private readonly location: LocationOptions, private readonly now: () => number) {}

  get version() {
    return this.#retiredVersion + [...this.#snapshots.values()].reduce((total, sample) => total + sample.version, 0);
  }

  get(scope: MachineKnowledgeCheckout): MachineKnowledgeRules {
    registeredKnowledgeCheckout(this.location, scope);
    const key = JSON.stringify([scope.repoId, scope.checkout]);
    let sample = this.#snapshots.get(key);
    if (sample) this.#snapshots.delete(key);
    else if (this.#snapshots.size >= SNAPSHOT_LIMIT) {
      const [oldKey, old] = this.#snapshots.entries().next().value!;
      this.#retiredVersion += old.version + 1;
      old.close();
      this.#snapshots.delete(oldKey);
    }
    sample ??= new ControlSnapshot(this.now, async () => readRules(registeredKnowledgeCheckout(this.location, scope)), UNAVAILABLE);
    this.#snapshots.set(key, sample);
    return { ...EMPTY, ...sample.get() };
  }

  touch() {
    for (const sample of this.#snapshots.values()) sample.touch();
  }

  close() {
    for (const sample of this.#snapshots.values()) sample.close();
    this.#snapshots.clear();
  }
}
