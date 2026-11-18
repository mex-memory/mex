import { openRecordReadOnly, type RecordReader } from "../record/index.js";
import { realPath } from "../record/project.js";
import { isTelemetryId } from "../global-config.js";
import { gitDiscoveryCeilingReached } from "../repository-discovery.js";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { TELEMETRY_AI_TOOLS } from "./schema.js";
import type { TelemetryAiTool, TelemetryProjectContext } from "./schema.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ANCESTORS = 64;
const CONFIGURED_AI_TOOLS = new Set<string>(TELEMETRY_AI_TOOLS);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && right.nlink === 1n && sameIdentity(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Match either the supplied Graph/Hub root or findConfig's nearest Git root. */
function projectRoot(startDir: string, discovery: "git-root" | "exact"): string | undefined {
  const start = realpathSync(resolve(startDir));
  if (start.split(/[\\/]/).includes(".mex")) return undefined;
  if (discovery === "exact") return start;
  let current = start;
  for (let visited = 0; visited < MAX_ANCESTORS; visited++) {
    try {
      const marker = lstatSync(join(current, ".git"));
      // A worktree/submodule .git file is sufficient; its contents are private.
      return marker.isDirectory() || marker.isFile() ? current : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const parent = dirname(current);
    if (parent === current || gitDiscoveryCeilingReached(parent)) return start;
    current = parent;
  }
  return undefined;
}

/**
 * Read a bounded snapshot of existing project metadata. Callers own snapshot
 * lifetime (one eligible CLI invocation or Hub server); no cache or project
 * state is created here. Every unavailable/unsafe observation quietly omits it.
 */
export function readTelemetryProjectContext(startDir: string, discovery: "git-root" | "exact" = "git-root"): TelemetryProjectContext {
  try {
    const root = projectRoot(startDir, discovery);
    if (!root) return {};
    const rootBefore = lstatSync(root, { bigint: true });
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return {};
    const scaffold = join(root, ".mex");
    const scaffoldBefore = lstatSync(scaffold, { bigint: true });
    if (!scaffoldBefore.isDirectory() || scaffoldBefore.isSymbolicLink() || realpathSync(scaffold) !== scaffold) return {};

    const path = join(scaffold, "config.json");
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > MAX_CONFIG_BYTES) return {};
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!sameFile(before, opened) || opened.size > MAX_CONFIG_BYTES) return {};
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      if (BigInt(length) !== opened.size || !sameFile(opened, fstatSync(fd, { bigint: true }))) return {};
      if (!sameFile(opened, lstatSync(path, { bigint: true }))) return {};
      if (!sameIdentity(rootBefore, lstatSync(root, { bigint: true }))
        || !sameIdentity(scaffoldBefore, lstatSync(scaffold, { bigint: true }))
        || realpathSync(scaffold) !== scaffold) return {};

      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
      const config = raw as Record<string, unknown>;
      const result: TelemetryProjectContext = {};
      if (typeof config.scaffold_id === "string" && config.scaffold_id.length === 36 && UUID_V4.test(config.scaffold_id)) {
        result.scaffold_id = config.scaffold_id;
      }
      if (Array.isArray(config.aiTools)) {
        const tools = [...new Set(config.aiTools.filter((tool): tool is TelemetryAiTool => typeof tool === "string" && CONFIGURED_AI_TOOLS.has(tool)))].sort();
        if (tools.length > 0 || config.aiTools.length === 0) result.configured_ai_tools = tools;
      }
      return result;
    } finally { closeSync(fd); }
  } catch {
    return {};
  }
}

/** Only a share-created ID from a proven shared record may leave this machine. */
export function readSharedProjectTelemetryContext(startDir: string, discovery: "git-root" | "exact" = "git-root"): TelemetryProjectContext {
  let reader: RecordReader | undefined;
  try {
    const root = projectRoot(startDir, discovery);
    if (!root) return {};
    reader = openRecordReadOnly({ create: false });
    if (!reader || reader.diagnostic) return {};
    const checkout = reader.get<{ project_id: string }>("SELECT project_id FROM checkouts WHERE path=?", realPath(root));
    if (!checkout || reader.project(checkout.project_id)?.shared !== 1) return {};
    const id = reader.setting(checkout.project_id, "shared.project_id");
    return isTelemetryId(id) ? { scaffold_id: id } : {};
  } catch { return {}; }
  finally { reader?.close(); }
}

/** Local-only setup deduplication. This key is never a report property. */
export function setupTelemetryKey(startDir: string): string | undefined {
  try {
    const root = projectRoot(startDir, "git-root");
    if (!root || !lstatSync(root).isDirectory()) return undefined;
    return `setup:${createHash("sha256").update(root).digest("hex")}`;
  } catch { return undefined; }
}
