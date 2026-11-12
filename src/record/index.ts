import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordLocation, moveProjectData, type LocationOptions, type RecordLocation } from "./location.js";
import { projectIdentity, realPath, type ProjectIdentity, type GitRunner } from "./project.js";
import { RECORD_SCHEMA_VERSION, recordMigrations, type Migration } from "./schema.js";

export { recordLocation, projectDataDirectory } from "./location.js";
export { projectIdentity } from "./project.js";
export const WRITER_TIMEOUT_MS = 5000;
export const READER_TIMEOUT_MS = 10;
export const JOB_STATES = ["queued", "running", "paused", "waiting", "done", "done with gaps", "failed", "cancelled"] as const;
export type JobState = typeof JOB_STATES[number];
export interface ProjectRow { id: string; root_path: string; kind: "git" | "folder"; shared: number; created_at: string; }
export interface CheckoutRow { project_id: string; path: string; state: "on" | "off" | "off until"; off_until: string | null; provisional: "unborn" | "shallow" | null; }
export interface SessionRow { session_id: string; agent: string; project_id: string; checkout: string; started_at: string; last_seen_at: string; paused: number; }

export function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()!.user_version);
}
function newer(file: string, version: number): Error {
  return new Error(`${file} schema version ${version} is newer than supported version ${RECORD_SCHEMA_VERSION}; refusing to write. Upgrade MEX.`);
}

/** Each migration obtains the write lock, rechecks the version, and commits SQL + version together. */
export function migrateRecord(db: DatabaseSync, migrations: readonly Migration[] = recordMigrations): void {
  if (schemaVersion(db) > RECORD_SCHEMA_VERSION) throw newer("record.db", schemaVersion(db));
  for (const migration of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = schemaVersion(db);
      if (version > RECORD_SCHEMA_VERSION) throw newer("record.db", version);
      if (version < migration.version) {
        if (migration.version !== version + 1) throw new Error(`Missing record.db migration ${version + 1}`);
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}

/** Read-only by construction, including SQL supplied by future consumers. Never immutable: WAL stays visible. */
export class RecordReader {
  readonly version: number;
  readonly diagnostic: string | undefined;
  constructor(protected readonly db: DatabaseSync, file: string) {
    db.exec(`PRAGMA busy_timeout=${READER_TIMEOUT_MS}; PRAGMA query_only=ON`);
    this.version = schemaVersion(db);
    this.diagnostic = this.version > RECORD_SCHEMA_VERSION ? newer(file, this.version).message : undefined;
  }
  get<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
  all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  project(id: string): ProjectRow | undefined { return this.get<ProjectRow>("SELECT * FROM projects WHERE id=?", id); }
  setting(scope: string, key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM settings WHERE scope=? AND key=?", scope, key)?.value;
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}

export class RecordWriter {
  constructor(readonly db: DatabaseSync, readonly location: RecordLocation) {}
  project(id: string): ProjectRow | undefined { return this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as unknown as ProjectRow | undefined; }
  setting(scope: string, key: string): string | undefined {
    return this.db.prepare("SELECT value FROM settings WHERE scope=? AND key=?").get(scope, key)?.value as string | undefined;
  }
  /** Find a registered checkout without Git; stop at an unregistered nested repository. */
  checkout(directory: string): CheckoutRow | undefined {
    const requested = realPath(directory);
    let current = requested;
    while (true) {
      const row = this.db.prepare("SELECT * FROM checkouts WHERE path=?").get(current) as unknown as CheckoutRow | undefined;
      if (row && (current === requested || row.project_id.startsWith("g-") || row.provisional || existsSync(join(current, ".git")))) return row;
      if (existsSync(join(current, ".git"))) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  /** Stable registrations are authoritative, even if HEAD subsequently changes histories. */
  register(project: ProjectIdentity): ProjectRow {
    project = { ...project, rootPath: realPath(project.rootPath) };
    let registeredId = project.id;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM checkouts WHERE path=?").get(project.rootPath) as unknown as CheckoutRow | undefined;
      if (existing) {
        registeredId = existing.project_id;
        if (existing.provisional && project.kind === "git") {
          this.promote(existing.project_id, project);
          registeredId = project.id;
        }
      } else {
        this.db.prepare("INSERT INTO projects(id,root_path,kind,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
          .run(project.id, project.rootPath, project.kind, new Date().toISOString());
        this.db.prepare("INSERT INTO checkouts(project_id,path,provisional) VALUES(?,?,?)")
          .run(project.id, project.rootPath, project.provisional ?? null);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.finishProjectMoves();
    return this.project(registeredId)!;
  }
  private promote(oldId: string, project: ProjectIdentity): void {
    const previous = this.project(oldId)!;
    this.db.prepare("INSERT INTO projects(id,root_path,kind,shared,created_at) VALUES(?,?,'git',?,?) ON CONFLICT(id) DO NOTHING")
      .run(project.id, project.rootPath, previous.shared, previous.created_at);
    this.db.prepare("UPDATE projects SET shared=max(shared,?) WHERE id=?").run(previous.shared, project.id);
    for (const table of ["jobs", "model_calls", "review"]) {
      this.db.prepare(`UPDATE ${table} SET project_id=? WHERE project_id=?`).run(project.id, oldId);
    }
    this.db.prepare("UPDATE checkouts SET project_id=?,provisional=NULL WHERE project_id=?").run(project.id, oldId);
    // Preserve colliding records under the retired id, linked by the alias below.
    this.db.prepare(`INSERT OR IGNORE INTO judgements SELECT ?,entry_id,inputs_hash,result,at FROM judgements WHERE project_id=?`).run(project.id, oldId);
    this.db.prepare(`DELETE FROM judgements WHERE project_id=? AND EXISTS
      (SELECT 1 FROM judgements n WHERE n.project_id=? AND n.entry_id=judgements.entry_id
       AND n.inputs_hash=judgements.inputs_hash AND n.result=judgements.result AND n.at=judgements.at)`).run(oldId, project.id);
    this.db.prepare("INSERT OR IGNORE INTO settings SELECT ?,key,value FROM settings WHERE scope=?").run(project.id, oldId);
    this.db.prepare(`DELETE FROM settings WHERE scope=? AND EXISTS
      (SELECT 1 FROM settings n WHERE n.scope=? AND n.key=settings.key AND n.value=settings.value)`).run(oldId, project.id);
    const conflicts = Number(this.db.prepare("SELECT (SELECT count(*) FROM settings WHERE scope=?)+(SELECT count(*) FROM judgements WHERE project_id=?) n").get(oldId, oldId)!.n);
    if (conflicts) this.notice(`project-records-${oldId}-${project.id}`, "project-record-conflict", "Conflicting project records were kept under both identities; no values were overwritten.");
    const put = this.db.prepare("INSERT INTO settings(scope,key,value) VALUES('global',?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value");
    put.run(`project.alias.${oldId}`, project.id);
    // Commit the intent before any filesystem operation. A later Node open retries after a crash.
    put.run(`project.move.${oldId}`, project.id);
  }
  private notice(id: string, kind: string, text: string): void {
    this.db.prepare("INSERT INTO notices(id,kind,text,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(id, kind, text, new Date().toISOString());
  }
  finishProjectMoves(): void {
    const pending = this.db.prepare("SELECT key,value FROM settings WHERE scope='global' AND key LIKE 'project.move.%'").all();
    for (const row of pending) {
      const key = String(row.key), oldId = key.slice("project.move.".length), newId = String(row.value);
      // Serialize cooperating Node openers and folder moves with the record writer lock.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!this.setting("global", key)) { this.db.exec("COMMIT"); continue; }
        const result = moveProjectData(this.location, oldId, newId);
        if (result === "conflict") this.notice(`project-data-${oldId}-${newId}`, "project-data-conflict", "Project data exists in both the provisional and Git folders. Both folders were kept; review them before merging.");
        this.db.prepare("DELETE FROM settings WHERE scope='global' AND key=?").run(key);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        this.notice(`project-move-${oldId}-${newId}`, "project-data-move-failed", `Project data was kept in its original folder; the move will be retried: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}

/** A command explicitly opens its writable record; existing commands are not changed by this module. */
export function openRecord(options: LocationOptions & { projectPath?: string; git?: GitRunner } = {}): RecordWriter {
  const location = recordLocation(options);
  const db = new DatabaseSync(location.record);
  try {
    db.exec(`PRAGMA busy_timeout=${WRITER_TIMEOUT_MS}`);
    if (schemaVersion(db) > RECORD_SCHEMA_VERSION) throw newer("record.db", schemaVersion(db));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
    migrateRecord(db);
    const writer = new RecordWriter(db, location);
    if (options.projectPath) {
      const stored = writer.checkout(options.projectPath);
      if (!stored || stored.provisional) writer.register(projectIdentity(options.projectPath, options.git));
    }
    writer.finishProjectMoves();
    return writer;
  } catch (error) { db.close(); throw error; }
}

function readOnly(file: string, name: string): RecordReader | undefined {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return new RecordReader(db, name); } catch (error) { db.close(); throw error; }
}
export function openRecordReadOnly(options: LocationOptions = {}): RecordReader | undefined {
  return readOnly(recordLocation({ ...options, create: false }).record, "record.db");
}
/** There is deliberately no writable hooks opener in Node. */
export function openHooksReadOnly(options: LocationOptions = {}): RecordReader | undefined {
  return readOnly(recordLocation({ ...options, create: false }).hooks, "hooks.db");
}
