import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkoutKey, indexDirectory, writeAtomic, writeLocator } from "../file-index/store.js";
import { recordLocation, type LocationOptions } from "../record/location.js";
import { absolutePath, projectIdentity, realPath } from "../record/project.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import { installGraphViews } from "./overlay.js";

export const INDEX_DISK_CAP = 5 * 1024 ** 3;
const GRACE_MS = 60_000;
const BASE = /^graph-base-[a-z0-9-]+\.db$/;
const OVERLAY = /^graph-o-[a-f0-9]{24}-[a-z0-9-]+\.db$/;
const TEMP = /^graph-tmp-(\d+)-[a-z0-9-]+\.db(?:-(?:journal|wal|shm))?$/;
export interface GraphPointer {
  version: 1; root: string; base: string;
  /** The checkout's overlay over `base`, or null when its files equal the base. */
  overlay: string | null; as_of: string;
  head: string | null; files: number; nodes: number; edges: number;
  build: Record<string, unknown>;
}
export interface GraphLocation { root: string; projectId: string; recordDirectory: string; directory: string; key: string; }
const storageContext = new AsyncLocalStorage<Map<string, GraphLocation>>();
/** Freeze project location for one operation; filesystem and snapshot proofs still run. */
export function withGraphStorageContext<T>(run: () => T): T {
  return storageContext.getStore() ? run() : storageContext.run(new Map(), run);
}
/** Locations already resolved in this process, by requested folder and record directory. */
const resolvedLocations = new Map<string, GraphLocation>();
function locationFor(location: ReturnType<typeof recordLocation>, rootPath: string, projectId: string): GraphLocation {
  return { root: rootPath, projectId, recordDirectory: location.directory,
    directory: indexDirectory(location.directory, projectId), key: checkoutKey(rootPath) };
}
/** The checkout's locator (`index-checkouts/<key>.json`, shared with the file index), when it names this root. */
function readLocator(recordDirectory: string, rootPath: string): string | undefined {
  try {
    const file = join(recordDirectory, "index-checkouts", `${checkoutKey(rootPath)}.json`);
    if (statSync(file).size > 4096) return undefined;
    const locator = JSON.parse(readFileSync(file, "utf8")) as { project_id?: unknown; root?: unknown };
    return locator.root === rootPath && typeof locator.project_id === "string" && /^[gf]-[a-f0-9]{24}$/.test(locator.project_id)
      ? locator.project_id : undefined;
  } catch { return undefined; }
}
/**
 * Where a checkout's graph lives. Reads trust the checkout locator, so they
 * never run Git; without one, the project identity is computed once per
 * process. Writers call {@link verifiedGraphLocation}, which recomputes the
 * identity and corrects the locator.
 */
export function graphLocation(root: string, options: LocationOptions = {}): GraphLocation {
  const location = recordLocation({ ...options, create: options.create ?? false });
  const cacheKey = `${absolutePath(root)}\u0000${location.directory}`;
  const cache = storageContext.getStore();
  const cached = cache?.get(cacheKey) ?? resolvedLocations.get(cacheKey);
  if (cached) return cached;
  let result: GraphLocation | undefined;
  try {
    const rootPath = realPath(root);
    const projectId = readLocator(location.directory, rootPath);
    if (projectId) result = locationFor(location, rootPath, projectId);
  } catch { /* fall back to the project identity, which reports a missing folder */ }
  if (!result) {
    const project = projectIdentity(root);
    result = locationFor(location, realPath(root), project.id);
  }
  cache?.set(cacheKey, result);
  resolvedLocations.set(cacheKey, result);
  return result;
}
/** For writers: the identity from Git, with the checkout locator written or corrected. */
export function verifiedGraphLocation(root: string, options: LocationOptions = {}): GraphLocation {
  const location = recordLocation({ ...options, create: options.create ?? true });
  const project = projectIdentity(root);
  // The checkout is the folder being indexed (as for the file index), which
  // may sit below Git's top level; the project id still comes from Git.
  const result = locationFor(location, realPath(root), project.id);
  writeLocator(location.directory, result.key, result.projectId, result.root);
  const cacheKey = `${absolutePath(root)}\u0000${location.directory}`;
  storageContext.getStore()?.set(cacheKey, result);
  resolvedLocations.set(cacheKey, result);
  resolvedLocations.set(`${result.root}\u0000${location.directory}`, result);
  return result;
}
function regular(file: string): boolean {
  try { const s = lstatSync(file); return s.isFile() && !s.isSymbolicLink(); } catch { return false; }
}
/** Refuse linked ancestors before reading, collecting or writing index data. */
export function assertGraphDirectory(directory: string): void {
  let current = resolve(directory);
  for (;;) {
    try { const s = lstatSync(current); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe graph directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
export function graphPointerFile(location: GraphLocation): string { return join(location.directory, "graph-checkouts", `${location.key}.json`); }
export function readGraphPointer(location: GraphLocation): GraphPointer | undefined {
  assertGraphDirectory(location.directory);
  const file = graphPointerFile(location);
  try {
    if (!regular(file) || statSync(file).size > 64 * 1024) return undefined;
    const p = JSON.parse(readFileSync(file, "utf8")) as GraphPointer;
    if (p.version !== 1 || p.root !== location.root || !BASE.test(p.base) || (p.overlay !== null && !(OVERLAY.test(p.overlay) && p.overlay.startsWith(`graph-o-${location.key}-`)))
      || !Number.isFinite(Date.parse(p.as_of))) return undefined;
    return p;
  } catch { return undefined; }
}
/** An absent pointer is an absent graph; legacy checkout databases are never opened. */
export function currentGraphPath(root: string, options: LocationOptions = {}): string {
  let location: GraphLocation;
  try { location = graphLocation(root, options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(resolve(root), ".mex", "graph-missing.db"); throw error; }
  const pointer = readGraphPointer(location);
  if (pointer) touchLocation(location);
  const file = join(location.directory, pointer?.overlay ?? pointer?.base ?? "graph-missing.db");
  if (!pointer && existsSync(file)) throw new Error("Graph data has no published pointer");
  return file;
}
export function graphStoragePathAllowed(root: string, file: string): boolean {
  try {
    const location = graphLocation(root);
    assertGraphDirectory(location.directory);
    if (absolutePath(dirname(file)) !== absolutePath(location.directory)) return false;
    const name = basename(file);
    if (!BASE.test(name) && !OVERLAY.test(name) && !TEMP.test(name) && name !== "graph-missing.db") return false;
    return !existsSync(file) || regular(file);
  } catch { return false; }
}
/** Whether `file` is a published base of this checkout's project (named, located and shaped like one). */
export function isPublishedGraph(root: string, file: string): boolean {
  return (BASE.test(basename(file)) || OVERLAY.test(basename(file))) && graphStoragePathAllowed(root, file);
}
export function openCurrentGraph(root: string): SqliteDatabase | undefined {
  const location = graphLocation(root);
  const pointer = readGraphPointer(location);
  if (!pointer) return undefined;
  const file = join(location.directory, pointer.overlay ?? pointer.base);
  if (!regular(file)) return undefined;
  touchGraph(root);
  const db = openSqlite(file, { readOnly: true, immutable: true });
  try { if (pointer.overlay) installGraphViews(db, file); } catch (error) { db.close(); throw error; }
  return db;
}
export function touchGraph(root: string, now = Date.now()): void {
  touchLocation(graphLocation(root), now);
}
function touchLocation(location: GraphLocation, now = Date.now()): void {
  if (!existsSync(location.directory)) return;
  const file = join(location.directory, "last-used");
  try { if (now - statSync(file).mtimeMs < 3_600_000) return; } catch { /* first use */ }
  try { writeAtomic(file, new Date(now).toISOString()); } catch { /* reads remain available */ }
}
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function graphTemporary(location: GraphLocation): string {
  assertGraphDirectory(location.directory);
  mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  return join(location.directory, `graph-tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(12).toString("hex")}.db`);
}
export function discardGraphTemporary(file: string): void {
  if (!TEMP.test(basename(file))) throw new Error("Not a graph temporary file");
  assertGraphDirectory(dirname(file));
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const path = file + suffix;
    if (regular(path)) { try { unlinkSync(path); } catch { /* open Windows handle; collect later */ } }
  }
}
export function cloneGraph(source: string, target: string): void {
  if (!regular(source) || existsSync(target)) throw new Error("Unsafe graph clone");
  copyFileSync(source, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
}
export function finalizeGraph(file: string): void {
  if (!regular(file)) throw new Error("Unsafe graph candidate");
  const db = openSqlite(file);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"); }
  finally { db.close(); }
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (existsSync(file + suffix)) throw new Error("Graph candidate has a sidecar");
  }
  const fd = openSync(file, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
type PointerData = Omit<GraphPointer, "version" | "root" | "base" | "overlay" | "as_of">;
function publishedName(location: GraphLocation, kind: "base" | "overlay"): string {
  const stamp = `${Date.now().toString(36)}-${randomBytes(16).toString("hex")}`;
  return kind === "base" ? `graph-base-${stamp}.db` : `graph-o-${location.key}-${stamp}.db`;
}
function renameTemporary(location: GraphLocation, temporary: string, name: string): string {
  assertGraphDirectory(location.directory);
  if (dirname(temporary) !== location.directory || !TEMP.test(basename(temporary))) throw new Error("Unsafe graph candidate path");
  const target = join(location.directory, name);
  renameSync(temporary, target);
  return target;
}
/** Point the checkout at `base` (and `overlay`), last. No published database name is ever overwritten. */
export function publishGraphPointer(location: GraphLocation, base: string, overlay: string | null, data: PointerData): void {
  assertGraphDirectory(location.directory);
  if (!BASE.test(base) || !regular(join(location.directory, base))
    || (overlay !== null && (!OVERLAY.test(overlay) || !regular(join(location.directory, overlay))))) throw new Error("Unsafe graph pointer");
  const pointer: GraphPointer = { ...data, version: 1, root: location.root, base, overlay, as_of: new Date().toISOString() };
  mkdirSync(join(location.directory, "graph-checkouts"), { recursive: true, mode: 0o700 });
  assertGraphDirectory(join(location.directory, "graph-checkouts"));
  writeAtomic(graphPointerFile(location), `${JSON.stringify(pointer)}\n`);
  touchLocation(location);
}
/** Publish a finished temporary file as a new base for this checkout. */
export function publishGraph(location: GraphLocation, temporary: string, data: PointerData): string {
  const name = publishedName(location, "base");
  const target = renameTemporary(location, temporary, name);
  publishGraphPointer(location, name, null, data);
  return target;
}
/** Publish a finished temporary file as this checkout's overlay over `base`. */
export function publishGraphOverlay(location: GraphLocation, temporary: string, base: string, data: PointerData): string {
  const name = publishedName(location, "overlay");
  const target = renameTemporary(location, temporary, name);
  publishGraphPointer(location, base, name, data);
  return target;
}
export function acquireGraphWriter(location: GraphLocation): { assertOwned(): void; release(): void } {
  assertGraphDirectory(location.directory);
  mkdirSync(location.directory, { recursive: true, mode: 0o700 });
  const file = join(location.directory, "graph.lock");
  const token = randomBytes(24).toString("hex");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      const directoryIdentity = lstatSync(location.directory, { bigint: true });
      const lockIdentity = lstatSync(file, { bigint: true });
      const assertOwned = () => {
        assertGraphDirectory(location.directory);
        const directoryNow = lstatSync(location.directory, { bigint: true });
        const lockNow = lstatSync(file, { bigint: true });
        if (directoryNow.ino !== directoryIdentity.ino || directoryNow.dev !== directoryIdentity.dev
          || lockNow.ino !== lockIdentity.ino || lockNow.dev !== lockIdentity.dev
          || !regular(file) || readFileSync(file, "utf8") !== JSON.stringify({ pid: process.pid, token })) throw new Error("Graph writer ownership changed");
      };
      try { collectGraphGarbage(location); } catch (error) { try { assertOwned(); unlinkSync(file); } catch { /* replaced owner */ } throw error; }
      return { assertOwned, release() {
        assertGraphDirectory(location.directory);
        try { assertOwned(); unlinkSync(file); } catch { /* replaced owner */ }
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!regular(file) || statSync(file).size > 4096) throw new Error("Unsafe graph lock");
      const before = lstatSync(file, { bigint: true });
      let owner: { pid: number };
      try { owner = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("Invalid graph lock"); }
      if (processAlive(owner.pid)) throw Object.assign(new Error("Another graph writer is active"), { code: "GRAPH_MAINTENANCE_LOCKED" });
      const after = lstatSync(file, { bigint: true });
      if (before.ino === after.ino && before.dev === after.dev && before.ctimeNs === after.ctimeNs) unlinkSync(file);
    }
  }
  throw new Error("Graph lock changed during acquisition");
}
function pointers(directory: string): GraphPointer[] {
  assertGraphDirectory(directory);
  const out: GraphPointer[] = [];
  try {
    assertGraphDirectory(join(directory, "graph-checkouts"));
    for (const name of readdirSync(join(directory, "graph-checkouts"))) {
      const file = join(directory, "graph-checkouts", name);
      if (!name.endsWith(".json") || !regular(file) || statSync(file).size > 65536) continue;
      try { const p = JSON.parse(readFileSync(file, "utf8")) as GraphPointer; if (p.version === 1 && BASE.test(p.base) && (p.overlay === null || OVERLAY.test(p.overlay))) out.push(p); } catch { /* incomplete pointer */ }
    }
  } catch { /* absent */ }
  return out;
}
export function collectGraphGarbage(location: GraphLocation, now = Date.now()): number {
  assertGraphDirectory(location.directory);
  const live = new Set(pointers(location.directory).flatMap(p => [p.base, p.overlay]));
  let count = 0;
  let names: string[]; try { names = readdirSync(location.directory); } catch { return 0; }
  for (const name of names) {
    const file = join(location.directory, name);
    if (!regular(file)) continue;
    // An audit record goes with its database.
    if (name.endsWith(".db-audit.json")) {
      const database = name.slice(0, -"-audit.json".length);
      if ((BASE.test(database) || OVERLAY.test(database)) && !names.includes(database)) {
        try { unlinkSync(file); count++; } catch { /* retried next time */ }
      }
      continue;
    }
    const temp = TEMP.exec(name);
    if ((temp && !processAlive(Number(temp[1]))) || ((BASE.test(name) || OVERLAY.test(name)) && !live.has(name) && now - statSync(file).mtimeMs > GRACE_MS)) {
      try { unlinkSync(file); count++; } catch { /* reader may hold the old base on Windows */ }
    }
  }
  return count;
}
export interface StoredProject { projectId: string; folder: string; bytes: number; graphBytes: number; fileIndexBytes: number; checkouts: string[]; lastUse: number; }
function filesBelow(directory: string): string[] {
  assertGraphDirectory(directory);
  let names: string[]; try { names = readdirSync(directory); } catch { return []; }
  return names.flatMap(name => {
    const file = join(directory, name);
    let s; try { s = lstatSync(file); } catch { return []; } // removed while listing
    if (s.isSymbolicLink()) return []; // never followed, counted or deleted through
    return s.isDirectory() ? filesBelow(file) : s.isFile() ? [file] : [];
  });
}
export function whatMexStores(recordDirectory: string, cap = INDEX_DISK_CAP): { cap: number; bytes: number; projects: StoredProject[] } {
  const projects: StoredProject[] = [];
  const parent = join(recordDirectory, "projects");
  assertGraphDirectory(parent);
  let names: string[]; try { names = readdirSync(parent); } catch { return { cap, bytes: 0, projects }; }
  for (const projectId of names) {
    if (!/^[gf]-[a-f0-9]{24}$/.test(projectId)) continue;
    const folder = indexDirectory(recordDirectory, projectId);
    if (!existsSync(folder)) continue;
    const files = filesBelow(folder);
    let bytes = 0, graphBytes = 0, lastUse = 0;
    for (const file of files) {
      let s; try { s = statSync(file); } catch { continue; } // removed while listing
      bytes += s.size;
      if (basename(file).startsWith("graph-")) graphBytes += s.size;
      if (basename(file) === "last-used") lastUse = Math.max(lastUse, s.mtimeMs);
      if (dirname(file) === join(folder, "checkouts") || dirname(file) === join(folder, "graph-checkouts")) {
        try { lastUse = Math.max(lastUse, Date.parse(JSON.parse(readFileSync(file, "utf8")).as_of) || 0); } catch { /* invalid pointer */ }
      }
    }
    projects.push({ projectId, folder, bytes, graphBytes, fileIndexBytes: bytes - graphBytes, checkouts: pointers(folder).map(p => p.root), lastUse });
  }
  return { cap, bytes: projects.reduce((n, p) => n + p.bytes, 0), projects };
}
/** Delete files only, checking the entire tree for links before deleting any entry. */
export function enforceIndexCap(location: GraphLocation, cap = INDEX_DISK_CAP): string[] {
  const summary = whatMexStores(location.recordDirectory, cap), removed: string[] = [];
  let bytes = summary.bytes;
  for (const project of summary.projects.sort((a,b) => a.lastUse - b.lastUse || a.projectId.localeCompare(b.projectId))) {
    if (bytes <= cap) break;
    if (project.projectId === location.projectId || existsSync(join(project.folder, "graph.lock")) || existsSync(join(project.folder, "index.lock"))) continue;
    let writer: ReturnType<typeof acquireGraphWriter>;
    try { writer = acquireGraphWriter({ ...location, directory: project.folder, projectId: project.projectId }); }
    catch (error) { if ((error as { code?: string }).code === "GRAPH_MAINTENANCE_LOCKED") continue; throw error; }
    try {
    const files = filesBelow(project.folder);
    for (const file of files) {
      if (file === join(project.folder, "graph-state.json") || file === join(project.folder, "graph.lock")) continue;
      writer.assertOwned();
      assertGraphDirectory(dirname(file));
      if (regular(file)) { try { const size = statSync(file).size; unlinkSync(file); bytes -= size; } catch { /* open reader; retry later */ } }
    }
    removed.push(project.projectId);
    } finally { writer.release(); }
  }
  return removed;
}

/** The newest base another checkout of this project points at, for a checkout that has none yet. */
export function siblingBase(location: GraphLocation): GraphPointer | undefined {
  return pointers(location.directory)
    .filter(pointer => pointer.root !== location.root && regular(join(location.directory, pointer.base)))
    .sort((left, right) => Date.parse(right.as_of) - Date.parse(left.as_of))[0];
}
/** The other bases this project's checkouts point at, newest first. */
export function siblingBases(location: GraphLocation, own: string): string[] {
  const bases = pointers(location.directory)
    .filter(pointer => pointer.root !== location.root && pointer.base !== own && regular(join(location.directory, pointer.base)))
    .sort((left, right) => Date.parse(right.as_of) - Date.parse(left.as_of))
    .map(pointer => pointer.base);
  return [...new Set(bases)];
}
/** Point a checkout with no graph at a sibling's base; its next refresh writes the overlay. */
export function adoptSiblingBase(location: GraphLocation): boolean {
  if (readGraphPointer(location)) return false;
  const sibling = siblingBase(location);
  if (!sibling) return false;
  publishGraphPointer(location, sibling.base, null, { head: null, files: sibling.files, nodes: sibling.nodes, edges: sibling.edges, build: { adoptedFrom: sibling.root } });
  return true;
}
