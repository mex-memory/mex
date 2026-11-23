import type { SqliteDatabase } from "./sqlite.js";

/** SQLite's FTS5 averages and docsize records contain SQLite varints. */
function lengths(bytes: Uint8Array): number[] {
  const values: number[] = [];
  let value = 0;
  let count = 0;
  for (const byte of bytes) {
    const last = ++count === 9;
    value = last ? value * 256 + byte : value * 128 + (byte & 0x7f);
    if (last || byte < 128) {
      if (!Number.isSafeInteger(value)) throw new Error("Invalid FTS5 token total.");
      values.push(value);
      value = count = 0;
    }
  }
  if (count) throw new Error("Incomplete FTS5 token total.");
  return values;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const idf = (docs: number, hits: number) => {
  const weight = Math.log((docs - hits + 0.5) / (hits + 0.5));
  return weight <= 0 ? 1e-6 : weight;
};
const lengthPenalty = (tokens: number, average: number) => 1.2 * (0.25 + 0.75 * tokens / average);

interface Side {
  docs: number;
  tokens: number;
  average: number;
  table: string;
  schema: "base" | "main";
}

interface Corpus {
  docs: number;
  average: number;
  sides: Side[];
  shadowed: Set<number>;
}

const corpora = new WeakMap<SqliteDatabase, Map<string, Corpus>>();

function corpus(db: SqliteDatabase, table: "nodes" | "source_chunks"): Corpus {
  let existing = corpora.get(db);
  const cached = existing?.get(table);
  if (cached) return cached;
  const sides = (["base", "main"] as const).map(schema => {
    const row = db.prepare(`SELECT block FROM ${schema}.${table}_fts_data WHERE id = 1`).get() as { block: Uint8Array };
    const [docs = 0, ...columns] = lengths(row.block);
    const tokens = sum(columns);
    return { docs, tokens, average: tokens / docs, table: `${schema}.${table}_fts`, schema };
  });
  const shadowed = new Set<number>();
  let hiddenTokens = 0;
  const rows = db.prepare(`SELECT d.id, d.sz FROM temp.v5_shadowed_files f
    CROSS JOIN base.${table} r ON r.file = f.id
    CROSS JOIN base.${table}_fts_docsize d ON d.id = r.id`).iterate() as Iterable<{ id: number; sz: Uint8Array }>;
  for (const row of rows) {
    shadowed.add(row.id);
    hiddenTokens += sum(lengths(row.sz));
  }
  const docs = sum(sides.map(side => side.docs)) - shadowed.size;
  const tokens = sum(sides.map(side => side.tokens)) - hiddenTokens;
  const combined = { docs, average: tokens / docs, sides, shadowed };
  if (!existing) corpora.set(db, existing = new Map());
  existing.set(table, combined);
  return combined;
}

/**
 * Rank the live union using the same BM25 statistics as a fresh index. FTS5
 * evaluates each phrase (including prefixes and compound identifiers) on the
 * two physical indexes. Within one phrase, the local BM25 score and docsize
 * recover the integer weighted occurrence count. Use that count with the
 * live document frequency and average length, then sum in query order.
 */
export function rankV5Overlay(db: SqliteDatabase, table: "nodes" | "source_chunks", phrases: readonly string[]): Array<[number, number]> {
  const combined = corpus(db, table);
  const weights = table === "nodes" ? "0, 20, 5, 1, 2" : "4, 2, 1, 3";
  const scores = new Map<number, number>();
  const fts = `${table}_fts`;
  for (const phrase of phrases) {
    const matches: Array<{ id: number; frequency: number; tokens: number }> = [];
    for (const side of combined.sides) {
      const { hits } = db.prepare(`SELECT count(*) AS hits FROM ${side.table} WHERE ${fts} MATCH ?`).get(phrase) as { hits: number };
      if (hits === 0) continue;
      const localIdf = idf(side.docs, hits);
      const rows = db.prepare(`SELECT ${fts}.rowid AS id, d.sz, bm25(${fts}, ${weights}) AS rank
        FROM ${side.table} AS ${fts} CROSS JOIN ${side.table}_docsize d ON d.id = ${fts}.rowid
        WHERE ${fts} MATCH ?`).iterate(phrase) as Iterable<{ id: number; sz: Uint8Array; rank: number }>;
      for (const row of rows) {
        if (side.schema === "base" && combined.shadowed.has(row.id)) continue;
        const tokens = sum(lengths(row.sz));
        const ratio = -row.rank / localIdf;
        const frequency = Math.round(ratio * lengthPenalty(tokens, side.average) / (2.2 - ratio));
        matches.push({ id: row.id, tokens, frequency });
      }
    }
    const weight = idf(combined.docs, matches.length);
    for (const { id, tokens, frequency } of matches) {
      const score = weight * (frequency * 2.2 / (frequency + lengthPenalty(tokens, combined.average)));
      scores.set(id, (scores.get(id) ?? 0) - score);
    }
  }
  return [...scores];
}
