import type { GroundedSource } from "./grounding.js";
import { bandHashes } from "./fingerprint.js";
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
  minhash: string;
  neighbors: string;
  token_count: number;
}

export class FingerprintStore {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(nodeId: string, fingerprint: Fingerprint): void {
    const buckets = bandHashes(fingerprint);
    this.db.exec("SAVEPOINT mex_fingerprint_upsert");
    try {
      this.db.prepare("DELETE FROM lsh_buckets WHERE node_id = ?").run(nodeId);
      this.db.prepare(
        `INSERT INTO node_fingerprints (node_id, minhash, neighbors, token_count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET minhash=excluded.minhash,
           neighbors=excluded.neighbors, token_count=excluded.token_count`,
      ).run(nodeId, JSON.stringify(fingerprint.minhash), JSON.stringify(fingerprint.neighbors), fingerprint.tokenCount);
      const insert = this.db.prepare(
        "INSERT INTO lsh_buckets (band, band_hash, node_id) VALUES (?, ?, ?)",
      );
      buckets.forEach((bandHash, band) => insert.run(band, bandHash, nodeId));
      this.db.exec("RELEASE mex_fingerprint_upsert");
    } catch (error) {
      this.db.exec("ROLLBACK TO mex_fingerprint_upsert");
      this.db.exec("RELEASE mex_fingerprint_upsert");
      throw error;
    }
  }

  get(nodeId: string): Fingerprint | null {
    const row = this.db.prepare(
      "SELECT node_id, minhash, neighbors, token_count FROM node_fingerprints WHERE node_id = ?",
    ).get(nodeId) as FingerprintRow | undefined;
    return row ? decodeRow(row) : null;
  }

  lookup(fingerprint: Fingerprint): Array<{ nodeId: string; fingerprint: Fingerprint }> {
    const candidates = new Set<string>();
    const lookup = this.db.prepare(
      "SELECT node_id FROM lsh_buckets WHERE band = ? AND band_hash = ?",
    );
    bandHashes(fingerprint).forEach((bandHash, band) => {
      for (const row of lookup.all(band, bandHash) as Array<{ node_id: string }>) {
        candidates.add(row.node_id);
      }
    });
    return [...candidates]
      .sort()
      .map((nodeId) => ({ nodeId, fingerprint: this.get(nodeId) }))
      .filter((entry): entry is { nodeId: string; fingerprint: Fingerprint } => entry.fingerprint !== null);
  }

  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null {
    const row = this.db.prepare(
      `SELECT scaffold_file, node_id, source, body_hash, fingerprint
       FROM _mex_grounded_source WHERE scaffold_file = ? AND node_id = ?`,
    ).get(scaffoldFile, nodeId) as {
      scaffold_file: string;
      node_id: string;
      source: string;
      body_hash: string;
      fingerprint: string;
    } | undefined;
    return row ? {
      scaffoldFile: row.scaffold_file,
      nodeId: row.node_id,
      source: row.source,
      bodyHash: row.body_hash,
      fingerprint: row.fingerprint,
    } : null;
  }

  saveGroundedSource(source: GroundedSource): void {
    this.db.prepare(
      `INSERT INTO _mex_grounded_source
       (scaffold_file, node_id, source, body_hash, fingerprint) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scaffold_file, node_id) DO UPDATE SET source=excluded.source,
         body_hash=excluded.body_hash, fingerprint=excluded.fingerprint`,
    ).run(source.scaffoldFile, source.nodeId, source.source, source.bodyHash, source.fingerprint);
  }

  deleteGroundedSource(scaffoldFile: string, nodeId: string): void {
    this.db.prepare(
      "DELETE FROM _mex_grounded_source WHERE scaffold_file = ? AND node_id = ?",
    ).run(scaffoldFile, nodeId);
  }
}

function decodeRow(row: FingerprintRow): Fingerprint {
  return {
    minhash: JSON.parse(row.minhash) as number[],
    neighbors: JSON.parse(row.neighbors) as string[],
    tokenCount: row.token_count,
  };
}
