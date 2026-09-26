import type { GroundedSource, GroundingBaseline, GroundingSubject } from "./grounding.js";
import { bandHashInts, decodeMinhash, encodeMinhash } from "./fingerprint.js";
import type { Fingerprint } from "./reconcile.js";
import type { SQLInputValue } from "node:sqlite";

export interface SqliteDatabase {
  prepare(sql: string): {
    run(...params: SQLInputValue[]): unknown;
    get(...params: SQLInputValue[]): unknown;
    all(...params: SQLInputValue[]): unknown[];
  };
  exec(sql: string): void;
}

interface FingerprintRow {
  node_id: string;
  /** BLOB (schema v4); a pre-migration TEXT JSON array is still decodable. */
  minhash: Uint8Array | string;
  neighbors: string;
  token_count: number;
}

/**
 * Full graph publication only: the caller owns the encompassing transaction
 * and MUST roll it back if this function throws. This deliberately omits a
 * corpus-sized nested savepoint, whose SQLite memory journal can make each
 * bucket write revisit an increasingly large retained journal prefix.
 *
 * Do not select this path merely because a transaction is active. A caller
 * that catches a write failure and continues must use FingerprintStore.upsertMany.
 * Kept outside the class so it cannot leak through the public grounding types.
 * @internal
 */
export function upsertFingerprintsInOwnedTransaction(
  db: SqliteDatabase,
  entries: Iterable<{ nodeId: string; fingerprint: Fingerprint }>,
): void {
  writeFingerprints(db, entries, false);
}

/** A stored fingerprint with the row reference its LSH buckets hang from. */
export interface StoredFingerprint {
  nodeId: string;
  ref: bigint;
  fingerprint: Fingerprint;
}

/** The fingerprints of every node one file owns, as currently stored. @internal */
export function readFileFingerprints(db: SqliteDatabase, filePath: string): StoredFingerprint[] {
  const rows = db.prepare(
    `SELECT CAST(f.ref AS TEXT) AS ref, f.node_id, f.minhash, f.neighbors, f.token_count
     FROM nodes n JOIN node_fingerprints f ON f.node_id = n.id
     WHERE n.file_path = ?`,
  ).all(filePath) as Array<FingerprintRow & { ref: string }>;
  return rows.map((row) => ({ nodeId: row.node_id, ref: BigInt(row.ref), fingerprint: decodeRow(row) }));
}

/**
 * Above this many removed fingerprints, index `lsh_buckets(ref)` for the
 * duration of the write. Deleting a fingerprint row makes SQLite probe its LSH
 * children through the foreign key, and the primary key is band-first, so each
 * probe is a full scan (about 140 ms on an 870k-row table); the index takes
 * about 600 ms to build on the same table and makes each probe ~1 ms.
 */
const LSH_REF_INDEX_THRESHOLD = 4;

/**
 * Incremental publication only (issue #209): replace the fingerprints of the
 * nodes whose fingerprint changed, inside the caller's publication
 * transaction, which MUST roll back if this throws. The final rows equal what
 * {@link upsertFingerprintsInOwnedTransaction} writes for the same
 * fingerprints; only `ref` values, which nothing outside this table and its
 * LSH buckets reads, may differ.
 * @internal
 */
export function writeFingerprintDelta(
  db: SqliteDatabase,
  removed: readonly StoredFingerprint[],
  written: ReadonlyArray<{ nodeId: string; fingerprint: Fingerprint; previous?: StoredFingerprint }>,
): void {
  const deleteBucket = db.prepare("DELETE FROM lsh_buckets WHERE band = ? AND band_hash = ? AND ref = ?");
  const insertBucket = db.prepare("INSERT INTO lsh_buckets (band, band_hash, ref) VALUES (?, ?, ?)");
  const deleteBuckets = (stored: StoredFingerprint): void => {
    bandHashInts(stored.fingerprint).forEach((bandHash, band) => deleteBucket.run(band, bandHash, stored.ref));
  };
  const insertBuckets = (fingerprint: Fingerprint, ref: bigint): void => {
    bandHashInts(fingerprint).forEach((bandHash, band) => insertBucket.run(band, bandHash, ref));
  };

  const indexed = removed.length > LSH_REF_INDEX_THRESHOLD;
  if (indexed) db.exec("CREATE INDEX mex_publication_lsh_ref ON lsh_buckets(ref)");
  const deleteFingerprint = db.prepare("DELETE FROM node_fingerprints WHERE ref = ?");
  for (const stored of removed) {
    deleteBuckets(stored);
    deleteFingerprint.run(stored.ref);
  }
  if (indexed) db.exec("DROP INDEX mex_publication_lsh_ref");

  const insertFingerprint = db.prepare(
    "INSERT INTO node_fingerprints (node_id, minhash, neighbors, token_count) VALUES (?, ?, ?, ?)",
  );
  const updateFingerprint = db.prepare(
    "UPDATE node_fingerprints SET minhash = ?, neighbors = ?, token_count = ? WHERE ref = ?",
  );
  for (const { nodeId, fingerprint, previous } of written) {
    const minhash = encodeMinhash(fingerprint.minhash);
    const neighbors = JSON.stringify(fingerprint.neighbors);
    if (!previous) {
      const inserted = insertFingerprint.run(nodeId, minhash, neighbors, fingerprint.tokenCount) as {
        lastInsertRowid: number | bigint;
      };
      insertBuckets(fingerprint, BigInt(inserted.lastInsertRowid));
      continue;
    }
    const sameSketch = previous.fingerprint.minhash.length === fingerprint.minhash.length
      && previous.fingerprint.minhash.every((value, index) => fingerprint.minhash[index] === value);
    if (!sameSketch) deleteBuckets(previous);
    updateFingerprint.run(minhash, neighbors, fingerprint.tokenCount, previous.ref);
    if (!sameSketch) insertBuckets(fingerprint, previous.ref);
  }
}

// One fixed synchronous read statement per connection; weak ownership does not
// retain closed/discarded databases, and no caller-owned iterator is reused.
const fingerprintReadStatements = new WeakMap<SqliteDatabase, ReturnType<SqliteDatabase["prepare"]>>();

export class FingerprintStore {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(nodeId: string, fingerprint: Fingerprint): void {
    this.upsertMany([{ nodeId, fingerprint }]);
  }

  /**
   * Atomically replace a batch, including when an enclosing transaction catches
   * the failure and continues. The last entry for each node wins.
   */
  upsertMany(entries: Iterable<{ nodeId: string; fingerprint: Fingerprint }>): void {
    writeFingerprints(this.db, entries, true);
  }

  get(nodeId: string): Fingerprint | null {
    const row = fingerprintReadStatement(this.db).get(nodeId, nodeId) as FingerprintRow | undefined;
    return row ? decodeRow(row) : null;
  }

  lookup(fingerprint: Fingerprint): Array<{ nodeId: string; fingerprint: Fingerprint }> {
    const candidates = new Set<string>();
    const lookup = this.db.prepare(
      `SELECT fingerprints.node_id AS node_id
       FROM lsh_buckets buckets
       JOIN node_fingerprints fingerprints ON fingerprints.ref = buckets.ref
       WHERE buckets.band = ? AND buckets.band_hash = ?`,
    );
    bandHashInts(fingerprint).forEach((bandHash, band) => {
      for (const row of lookup.all(band, bandHash) as Array<{ node_id: string }>) {
        candidates.add(row.node_id);
      }
    });
    return [...candidates]
      .sort()
      .map((nodeId) => ({ nodeId, fingerprint: this.get(nodeId) }))
      .filter((entry): entry is { nodeId: string; fingerprint: Fingerprint } => entry.fingerprint !== null);
  }

  /**
   * Current nodes sharing at least `minShared` caller/callee neighbors with
   * `neighbors`, most shared first, at most `limit` (#229). It reads the same
   * `calls` edges fingerprint neighborhoods are built from, through the edge
   * indexes, so the work is bounded by the neighbors' own degree.
   */
  neighborhood(neighbors: readonly string[], minShared: number, limit: number): string[] {
    if (neighbors.length < minShared) return [];
    const ids = JSON.stringify(neighbors);
    const rows = this.db.prepare(
      `SELECT node_id FROM (
         SELECT target AS node_id, source AS neighbor FROM edges
         WHERE kind = 'calls' AND source IN (SELECT value FROM json_each(?))
         UNION
         SELECT source, target FROM edges
         WHERE kind = 'calls' AND target IN (SELECT value FROM json_each(?))
       ) GROUP BY node_id HAVING COUNT(*) >= ?
       ORDER BY COUNT(*) DESC, node_id LIMIT ?`,
    ).all(ids, ids, minShared, limit) as Array<{ node_id: string }>;
    return rows.map((row) => row.node_id);
  }

  /** A current node's body hash, or null when the node or its body hash is absent. */
  bodyHash(nodeId: string): string | null {
    const row = this.db.prepare("SELECT body_hash FROM nodes WHERE id = ?").get(nodeId) as
      { body_hash: string | null } | undefined;
    return row?.body_hash ?? null;
  }

  /**
   * The baseline for one (subject, node) pair, following a node alias when the
   * id it was grounded under has since been reconciled to a canonical one.
   *
   * Subject-generalized (schema v4). `getGroundedSource` is the scaffold-kind
   * projection of it, so there is one accessor and not two: a second one would
   * be a second place for the alias fallback to be forgotten.
   */
  getBaseline(subject: GroundingSubject, nodeId: string): GroundingBaseline | null {
    const row = this.db.prepare(
      `SELECT subject_kind, subject_id, node_id, source, body_hash, fingerprint
       FROM _mex_grounded_source
       WHERE subject_kind = ? AND subject_id = ? AND node_id = ?
       UNION ALL
       SELECT grounded.subject_kind, grounded.subject_id, grounded.node_id,
              grounded.source, grounded.body_hash, grounded.fingerprint
       FROM node_aliases aliases
       JOIN _mex_grounded_source grounded ON grounded.node_id = aliases.alias_id
       WHERE grounded.subject_kind = ? AND grounded.subject_id = ? AND aliases.canonical_node_id = ?
       LIMIT 1`,
    ).get(subject.kind, subject.id, nodeId, subject.kind, subject.id, nodeId) as BaselineRow | undefined;
    return row ? decodeBaseline(row) : null;
  }

  /** Every baseline recorded for one subject, in node order. */
  listBaselines(subject: GroundingSubject): GroundingBaseline[] {
    const rows = this.db.prepare(
      `SELECT subject_kind, subject_id, node_id, source, body_hash, fingerprint
       FROM _mex_grounded_source WHERE subject_kind = ? AND subject_id = ?
       ORDER BY node_id`,
    ).all(subject.kind, subject.id) as BaselineRow[];
    return rows.map(decodeBaseline);
  }

  saveBaseline(baseline: GroundingBaseline): void {
    this.db.prepare(
      `INSERT INTO _mex_grounded_source
       (subject_kind, subject_id, node_id, source, body_hash, fingerprint) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_kind, subject_id, node_id) DO UPDATE SET source=excluded.source,
         body_hash=excluded.body_hash, fingerprint=excluded.fingerprint`,
    ).run(
      baseline.subject.kind,
      baseline.subject.id,
      baseline.nodeId,
      baseline.source,
      baseline.bodyHash,
      baseline.fingerprint,
    );
  }

  deleteBaseline(subject: GroundingSubject, nodeId: string): void {
    this.db.prepare(
      "DELETE FROM _mex_grounded_source WHERE subject_kind = ? AND subject_id = ? AND node_id = ?",
    ).run(subject.kind, subject.id, nodeId);
  }

  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null {
    const baseline = this.getBaseline({ kind: "scaffold", id: scaffoldFile }, nodeId);
    return baseline ? {
      scaffoldFile: baseline.subject.id,
      nodeId: baseline.nodeId,
      source: baseline.source,
      bodyHash: baseline.bodyHash,
      fingerprint: baseline.fingerprint,
    } : null;
  }

  saveGroundedSource(source: GroundedSource): void {
    this.saveBaseline({
      subject: { kind: "scaffold", id: source.scaffoldFile },
      nodeId: source.nodeId,
      source: source.source,
      bodyHash: source.bodyHash,
      fingerprint: source.fingerprint,
    });
  }

  deleteGroundedSource(scaffoldFile: string, nodeId: string): void {
    this.deleteBaseline({ kind: "scaffold", id: scaffoldFile }, nodeId);
  }
}

function writeFingerprints(
  db: SqliteDatabase,
  entries: Iterable<{ nodeId: string; fingerprint: Fingerprint }>,
  independentRollback: boolean,
): void {
  const latestByNode = new Map<string, { nodeId: string; fingerprint: Fingerprint }>();
  for (const entry of entries) latestByNode.set(entry.nodeId, entry);
  const ordered = [...latestByNode.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (ordered.length === 0) return;

  const upsertFingerprint = db.prepare(
    `INSERT INTO node_fingerprints (node_id, minhash, neighbors, token_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET minhash=excluded.minhash,
       neighbors=excluded.neighbors, token_count=excluded.token_count`,
  );
  // ON CONFLICT DO UPDATE keeps the existing row, so `ref` is stable across
  // re-upserts of the same node — stale LSH rows are deleted by ref below.
  const selectRef = db.prepare(
    "SELECT CAST(ref AS TEXT) AS ref FROM node_fingerprints WHERE node_id = ?",
  );
  const bucketCount = bandHashInts(ordered[0]!.fingerprint).length;
  const insertBuckets = db.prepare(
    `INSERT INTO lsh_buckets (band, band_hash, ref) VALUES ${
      Array.from({ length: bucketCount }, () => "(?, ?, ?)").join(", ")
    }`,
  );

  if (independentRollback) db.exec("SAVEPOINT mex_fingerprint_upsert_many");
  try {
    // Delete prior buckets before inserting any replacements. Chunked IN
    // deletes over the ref subquery scan the table a bounded number of times
    // and produce the identical final rows (the last duplicate entry wins).
    const deleteChunkSize = 500;
    for (let offset = 0; offset < ordered.length; offset += deleteChunkSize) {
      const nodeIds = ordered.slice(offset, offset + deleteChunkSize).map((entry) => entry.nodeId);
      db.prepare(
        `DELETE FROM lsh_buckets WHERE ref IN (
           SELECT ref FROM node_fingerprints WHERE node_id IN (${nodeIds.map(() => "?").join(",")})
         )`,
      ).run(...nodeIds);
    }
    for (const { nodeId, fingerprint } of ordered) {
      const buckets = bandHashInts(fingerprint);
      if (buckets.length !== bucketCount) {
        throw new Error(`Inconsistent fingerprint band count for ${nodeId}.`);
      }
      upsertFingerprint.run(
        nodeId,
        encodeMinhash(fingerprint.minhash),
        JSON.stringify(fingerprint.neighbors),
        fingerprint.tokenCount,
      );
      const row = selectRef.get(nodeId) as { ref: string } | undefined;
      if (!row) throw new Error(`Fingerprint upsert failed for ${nodeId}.`);
      const ref = BigInt(row.ref);
      insertBuckets.run(...buckets.flatMap((bandHash, band) => [band, bandHash, ref]));
    }
    if (independentRollback) db.exec("RELEASE mex_fingerprint_upsert_many");
  } catch (error) {
    if (independentRollback) {
      db.exec("ROLLBACK TO mex_fingerprint_upsert_many");
      db.exec("RELEASE mex_fingerprint_upsert_many");
    }
    throw error;
  }
}

function fingerprintReadStatement(db: SqliteDatabase): ReturnType<SqliteDatabase["prepare"]> {
  const existing = fingerprintReadStatements.get(db);
  if (existing) return existing;
  const statement = db.prepare(
    `SELECT node_id, minhash, neighbors, token_count
     FROM node_fingerprints WHERE node_id = ?
     UNION ALL
     SELECT fingerprints.node_id, fingerprints.minhash, fingerprints.neighbors, fingerprints.token_count
     FROM node_aliases aliases
     JOIN node_fingerprints fingerprints ON fingerprints.node_id = aliases.canonical_node_id
     WHERE aliases.alias_id = ?
     LIMIT 1`,
  );
  fingerprintReadStatements.set(db, statement);
  return statement;
}

interface BaselineRow {
  subject_kind: string;
  subject_id: string;
  node_id: string;
  source: string;
  body_hash: string;
  fingerprint: string;
}

function decodeBaseline(row: BaselineRow): GroundingBaseline {
  return {
    subject: { kind: row.subject_kind as GroundingSubject["kind"], id: row.subject_id },
    nodeId: row.node_id,
    source: row.source,
    bodyHash: row.body_hash,
    fingerprint: row.fingerprint,
  };
}

function decodeRow(row: FingerprintRow): Fingerprint {
  const fingerprint: Fingerprint = {
    minhash: typeof row.minhash === "string"
      ? JSON.parse(row.minhash) as number[]
      : decodeMinhash(row.minhash),
    neighbors: JSON.parse(row.neighbors) as string[],
    tokenCount: row.token_count,
  };
  // The compact BLOB decoder can represent every byte sequence; validate the
  // semantic K=64 fingerprint before it reaches reconciliation.
  bandHashInts(fingerprint);
  return fingerprint;
}
