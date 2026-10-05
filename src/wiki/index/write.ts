/**
 * Projecting parsed Markdown into rows, and resolving what only the whole set
 * knows.
 *
 * The split here is the one thing that makes an incremental refresh safe to
 * believe. Everything a *single file* determines — its entities, their
 * locations, their relations as written, its own parse diagnostics — is written
 * by {@link writeParsedFile} and dies with {@link deleteFileRows}. Everything
 * the *set* determines — which claimant of a duplicated id wins, whether a
 * relation target exists, whether a topic reference resolves — is derived from
 * scratch by {@link resolveIndexState}, over the rows, on every rebuild and
 * every refresh.
 *
 * That is why a refresh cannot drift from a rebuild: the only thing refresh
 * skips is *parsing* the files that did not change. Every derived fact is
 * recomputed from the table both times, by the same function, so there is no
 * second implementation to disagree with the first. It also answers the hard
 * half of §4.5 for free — deleting a file makes the relations that pointed into
 * it dangle, and adding one *resolves* a dangling reference, without either
 * case needing to be handled.
 */

import { diagnostic, sortDiagnostics, type WikiDiagnostic } from "../model/diagnostic.js";
import { exactFileContentHash, indexedCorpusRevision } from "../model/hash.js";
import type { EntityId } from "../model/ids.js";
import { validateRelationGraph, type RelationSubject, type WikiRelationRef } from "../model/relation.js";
import {
  buildTopicIndex,
  validateTopicHierarchy,
  validateTopicMembership,
  type TopicSubject,
} from "../model/topic.js";
import { findDuplicateSources, sourceIdentity, type WikiSource } from "../model/source.js";
import type { GroundingResolution, WikiGrounding } from "../model/grounding.js";
import type { ParsedEntity, ParsedFile } from "../markdown/contract.js";
import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import { WIKI_META_KEYS } from "./schema.js";

/**
 * The stable key of an entity row: where it is, not what it claims to be.
 *
 * Zero-padded so lexicographic order is file-then-position order, which is what
 * lets the duplicate-id winner be chosen with `MIN(entity_key)` — a total order
 * derived from content, never from insertion order.
 */
export function entityKeyOf(file: string, metadataStart: number): string {
  return `${file}#${String(metadataStart).padStart(10, "0")}`;
}

/** JSON with sorted keys, so two equal objects always render identically. */
export function canonicalJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}

/** What a file contributed, for the caller's reporting. */
export interface WrittenFile {
  path: string;
  entityCount: number;
  diagnosticCount: number;
}

/**
 * Overlapping entity ranges within one file.
 *
 * The codec's partition property means this should never fire on codec output —
 * which is exactly why it is checked rather than assumed. The index is the last
 * place an overlap can be caught before P5 computes a patch plan from two
 * locations that claim the same bytes and writes one over the other.
 */
export function detectRangeOverlaps(file: string, entities: readonly ParsedEntity[]): WikiDiagnostic[] {
  const spans = entities
    .map((parsed) => ({
      id: parsed.entity.id,
      start: parsed.entity.location.metadataStart,
      end: parsed.entity.location.bodyEnd,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const diagnostics: WikiDiagnostic[] = [];
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]!;
    const current = spans[index]!;
    if (current.start >= previous.end) continue;
    diagnostics.push(
      diagnostic(
        "ENTITY_RANGE_OVERLAP",
        `Entities ${previous.id} and ${current.id} claim overlapping regions of ${file} ` +
          `(${previous.start}..${previous.end} and ${current.start}..${current.end}).`,
        {
          file,
          entityId: current.id,
          location: { file, startOffset: current.start, endOffset: Math.min(previous.end, current.end) },
        },
      ),
    );
  }
  return diagnostics;
}

/**
 * The text a file-level entity is searchable by.
 *
 * §3c finding 23: a file-level entity's body stops at the first nested entity
 * and never resumes, so indexing `entity.body` alone under-indexes a large
 * architecture file — every paragraph after the first nested heading becomes
 * unreachable through the entity that presides over the file. The gaps are
 * exactly the regions no entity claimed, and the file-level entity is the only
 * thing that *can* own them, so it adopts them.
 *
 * Nested entities do **not** adopt anything and their bodies are not copied
 * upward. Copying them would make every term in a long file match the
 * file-level entity too, which destroys the "title beats summary beats body"
 * ranking the moment a file gets big — a subtler version of the same bug.
 *
 * Prose in a file with *no* file-level entity stays unindexed. There is nothing
 * to attribute it to, and inventing a synthetic entity to hold it would put a
 * row in the index that no Markdown declares. Recorded for P7.
 */
export function ftsBodyFor(parsed: ParsedFile, entity: ParsedEntity): string {
  if (entity.metadataKind !== "frontmatter") return entity.entity.body;

  const frontmatterEnd = parsed.frontmatter?.range.end ?? 0;
  const adopted = parsed.gaps
    .filter((gap) => gap.start >= frontmatterEnd)
    .map((gap) => parsed.text.slice(gap.start, gap.end));

  return [entity.entity.body, ...adopted].join("\n").trim();
}

/** Alias text for the FTS row: what a topic answers to besides its title. */
function aliasesOf(entity: ParsedEntity): string {
  const raw = entity.entity.metadata?.["aliases"];
  if (!Array.isArray(raw)) return "";
  return raw.filter((value): value is string => typeof value === "string").join(" ");
}

export interface WriteOptions {
  /** ISO timestamp for `indexed_at`. Excluded from the normalized dump. */
  now: string;
}

/** Remove a file and everything derived from it. Cascades do the rest. */
export function deleteFileRows(db: SqliteDatabase, path: string): void {
  // wiki_fts is a virtual table and takes no foreign key, so its rows are
  // deleted explicitly, by the same key the cascade uses.
  db.prepare(
    `DELETE FROM wiki_fts WHERE entity_key IN (SELECT entity_key FROM wiki_entities WHERE file = ?)`,
  ).run(path);
  db.prepare(`DELETE FROM wiki_diagnostics WHERE scope = 'file' AND file = ?`).run(path);
  db.prepare(`DELETE FROM wiki_files WHERE path = ?`).run(path);
}

/**
 * Write one parsed file's rows.
 *
 * Replaces whatever was there: refresh calls this after {@link deleteFileRows},
 * and a rebuild starts from an empty database, so the two paths run identical
 * statements over identical inputs.
 */
export function writeParsedFile(db: SqliteDatabase, parsed: ParsedFile, options: WriteOptions): WrittenFile {
  const diagnostics: WikiDiagnostic[] = [...parsed.diagnostics, ...detectRangeOverlaps(parsed.path, parsed.entities)];

  db.prepare(
    `INSERT INTO wiki_files (path, content_hash, parse_status, entity_count, text_length, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    parsed.path,
    parsed.entities[0]?.entity.location.fileContentHash ?? exactFileContentHash(parsed.text),
    diagnostics.length === 0 ? "ok" : "diagnostics",
    parsed.entities.length,
    parsed.text.length,
    options.now,
  );

  const insertEntity = db.prepare(
    `INSERT INTO wiki_entities (
       entity_key, id, shadowed, file, type, title, summary, body, status, revision, metadata_kind,
       metadata_start, metadata_end, heading_start, heading_end, body_start, body_end,
       start_line, end_line, heading_depth, file_content_hash, entity_content_hash, provenance, metadata
     ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO wiki_relations (source_key, ordinal, type, target_id, target_resolved, note, metadata)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  );
  const insertTopic = db.prepare(
    `INSERT INTO wiki_entity_topics (entity_key, ordinal, topic_entity_id) VALUES (?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO wiki_sources (entity_key, ordinal, type, ref, note, repository, commit_sha, captured_at, identity, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGrounding = db.prepare(
    `INSERT INTO wiki_groundings (entity_key, ordinal, node_id, fingerprint, body_hash, code_hash, file, commit_sha, verified_at, reason, state, resolved_node, health)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO wiki_fts (entity_key, title, summary, body, aliases, meta) VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const parsedEntity of parsed.entities) {
    const entity = parsedEntity.entity;
    const location = entity.location;
    const key = entityKeyOf(parsed.path, location.metadataStart);

    insertEntity.run(
      key,
      entity.id,
      parsed.path,
      entity.type,
      entity.title,
      entity.summary ?? null,
      entity.body,
      entity.status,
      entity.revision,
      parsedEntity.metadataKind,
      location.metadataStart,
      location.metadataEnd,
      location.headingStart,
      location.headingEnd,
      location.bodyStart,
      location.bodyEnd,
      location.startLine,
      location.endLine,
      location.headingDepth,
      location.fileContentHash,
      location.entityContentHash,
      canonicalJson(entity.provenance),
      canonicalJson(entity.metadata),
    );

    entity.relations.forEach((relation: WikiRelationRef, ordinal: number) => {
      insertRelation.run(key, ordinal, relation.type, relation.target, relation.note ?? null, canonicalJson(relation.metadata));
    });

    entity.topics.forEach((topicId: EntityId, ordinal: number) => {
      insertTopic.run(key, ordinal, topicId);
    });

    entity.sources.forEach((source: WikiSource, ordinal: number) => {
      insertSource.run(
        key,
        ordinal,
        source.type,
        source.ref ?? null,
        source.note ?? null,
        source.repository ?? null,
        source.commit ?? null,
        source.capturedAt ?? null,
        sourceIdentity(source),
        canonicalJson(source.metadata),
      );
    });

    entity.groundsTo.forEach((grounding: WikiGrounding, ordinal: number) => {
      // The verdict columns are left NULL here on purpose. Health is derived
      // from the *code graph*, which is not a property of this file, and a fact
      // computed during per-file projection is a fact a refresh computes from a
      // different subset than a rebuild did. It belongs to `resolveIndexState`.
      insertGrounding.run(
        key,
        ordinal,
        grounding.node,
        grounding.fingerprint,
        grounding.bodyHash ?? null,
        grounding.codeHash ?? null,
        grounding.file ?? null,
        grounding.commit ?? null,
        grounding.verifiedAt ?? null,
        grounding.reason ?? null,
      );
    });

    insertFts.run(
      key,
      entity.title,
      entity.summary ?? "",
      ftsBodyFor(parsed, parsedEntity),
      aliasesOf(parsedEntity),
      `${entity.type} ${parsed.path}`,
    );

    // Evidence duplicated within one entity is a property of that entity, so it
    // is a file-scoped diagnostic and dies with the file.
    for (const duplicate of findDuplicateSources(entity.sources)) {
      diagnostics.push({ ...duplicate, file: parsed.path, entityId: entity.id });
    }
  }

  writeDiagnostics(db, "file", parsed.path, diagnostics);
  return { path: parsed.path, entityCount: parsed.entities.length, diagnosticCount: diagnostics.length };
}

/**
 * Record a problem that belongs to one file, so it lives and dies with that
 * file's rows.
 *
 * Used for a file that could not be *read*. That is not a global fact about the
 * build, even though a rebuild happens to discover all of them at once: a
 * rebuild reports every unreadable file and a refresh only sees the ones in its
 * changed set, so recording them as global made a refresh of an unrelated file
 * silently drop a report a rebuild would have made — a refresh/rebuild
 * divergence, which is the one thing this phase's oracle exists to exclude.
 *
 * File-scoped, it survives a refresh that does not touch it, is cleared by
 * `deleteFileRows` when it is touched, and is re-derived identically by a clean
 * rebuild. There is deliberately no `wiki_files` row to hang it on — the file
 * could not be read, so there is nothing to describe.
 */
export function writeFileDiagnostics(
  db: SqliteDatabase,
  path: string,
  diagnostics: readonly WikiDiagnostic[],
): void {
  writeDiagnostics(db, "file", path, diagnostics);
}

function writeDiagnostics(
  db: SqliteDatabase,
  scope: "file" | "global",
  file: string | null,
  diagnostics: readonly WikiDiagnostic[],
): void {
  const insert = db.prepare(
    `INSERT INTO wiki_diagnostics (scope, code, severity, message, file, entity_id, path, start_offset, end_offset, start_line, end_line, remediation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of sortDiagnostics(diagnostics)) {
    insert.run(
      scope,
      entry.code,
      entry.severity,
      entry.message,
      entry.file ?? entry.location?.file ?? file,
      entry.entityId ?? null,
      entry.path ?? null,
      entry.location?.startOffset ?? null,
      entry.location?.endOffset ?? null,
      entry.location?.startLine ?? null,
      entry.location?.endLine ?? null,
      entry.remediation ?? null,
    );
  }
}

interface EntityRow {
  entity_key: string;
  id: string;
  file: string;
  type: string;
  title: string;
  status: string;
  metadata: string | null;
}

/**
 * Recompute everything the whole set determines.
 *
 * Called at the end of a rebuild and at the end of a refresh, so the two cannot
 * produce different answers. It reads rows rather than re-parsing files, which
 * is what keeps it inside the 50 ms refresh target: parsing 1,000 files is
 * expensive, reading 5,000 rows is not.
 */
/**
 * Resolve one committed grounding against the local checkout.
 *
 * A callback rather than an imported module, so this file stays free of the
 * code graph: the index must build in a checkout that has no graph, and the
 * layering lint keeps the graph behind one door in `src/wiki/grounding/`.
 */
export type GroundingResolver = (
  grounding: WikiGrounding,
  /** The entity's title and body, so a change can be weighed against the fact it supports. */
  context?: { fact?: string },
) => GroundingResolution;

export interface ResolveOptions {
  scaffoldRoot: string;
  buildKind: string;
  now: string;
  /**
   * How to resolve grounding health, when the caller has a graph.
   *
   * **Supplied identically by both build paths or by neither.** Health is the
   * one derived column whose input lives outside the scaffold, so it is also
   * the one place two dumps can legitimately differ: an index built with a
   * graph present and one built without it *should* disagree. That is not a
   * determinism failure, it is a different input — and it is why the resolver
   * is a parameter rather than something either path reaches for on its own.
   *
   * Absent, every verdict column is set to NULL. Not `'unverified'`: that is a
   * verdict, and nothing looked.
   */
  resolveGrounding?: GroundingResolver;
  /**
   * Diagnostics that belong to the scaffold rather than to any one file —
   * discovery problems, chiefly. They are supplied on every call, by both the
   * rebuild and the refresh path, because they are part of the global set and a
   * refresh that omitted them would produce a different index from a rebuild of
   * the same tree. That is why refresh re-walks: the walk is cheap, and a
   * cheaper answer that differs from the rebuild's is worth nothing.
   */
  scaffoldDiagnostics?: readonly WikiDiagnostic[];
}

export function resolveIndexState(db: SqliteDatabase, meta: ResolveOptions): void {
  // 1. Which claimant of a duplicated id wins. Chosen by the smallest
  //    entity_key — that is (file, position) order, so it is a property of the
  //    content and not of the order files were written in.
  db.prepare(`UPDATE wiki_entities SET shadowed = 0`).run();
  db.prepare(
    `UPDATE wiki_entities SET shadowed = 1
      WHERE entity_key > (SELECT MIN(other.entity_key) FROM wiki_entities other WHERE other.id = wiki_entities.id)`,
  ).run();

  // 2. Whether each relation target exists. Recomputed wholesale, so a deleted
  //    file dangles the references into it and a restored file resolves them
  //    again, with no special case for either direction.
  db.prepare(
    `UPDATE wiki_relations SET target_resolved =
       CASE WHEN EXISTS (SELECT 1 FROM wiki_entities e WHERE e.id = wiki_relations.target_id AND e.shadowed = 0)
            THEN 1 ELSE 0 END`,
  ).run();

  // 3. Grounding health, re-derived for every row from the caller's resolver.
  const groundingDiagnostics = resolveGroundings(db, meta.resolveGrounding);

  // 4. Set-level diagnostics, replaced entirely.
  //
  // The grounding ones are global rather than file-scoped, and the distinction
  // is the one §33.1 turned on: a global diagnostic must be re-derivable from
  // the whole set on *both* paths. These are — every grounding row is resolved
  // on every rebuild and every refresh, from the same resolver. The read errors
  // that had to become file-scoped were exactly the opposite: a refresh only
  // ever saw the changed set, so it could not re-derive the rest.
  db.prepare(`DELETE FROM wiki_diagnostics WHERE scope = 'global'`).run();
  writeDiagnostics(db, "global", null, [
    ...(meta.scaffoldDiagnostics ?? []),
    ...collectGlobalDiagnostics(db),
    ...groundingDiagnostics,
  ]);

  // 5. Rebuild metadata.
  const fileCount = countOf(db, `SELECT COUNT(*) AS n FROM wiki_files`);
  const entityCount = countOf(db, `SELECT COUNT(*) AS n FROM wiki_entities WHERE shadowed = 0`);
  const put = db.prepare(`INSERT INTO wiki_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  put.run(WIKI_META_KEYS.builtAt, meta.now);
  put.run(WIKI_META_KEYS.buildKind, meta.buildKind);
  put.run(WIKI_META_KEYS.scaffoldRoot, meta.scaffoldRoot);
  put.run(WIKI_META_KEYS.fileCount, String(fileCount));
  put.run(WIKI_META_KEYS.entityCount, String(entityCount));
  const indexedFiles = db.prepare(
    `SELECT path, content_hash FROM wiki_files ORDER BY path`,
  ).all() as { path: string; content_hash: string }[];
  put.run(
    WIKI_META_KEYS.indexedRevision,
    indexedCorpusRevision(indexedFiles.map((file) => ({
      path: file.path,
      contentHash: file.content_hash,
    }))),
  );
}

interface GroundingRow {
  entity_key: string;
  ordinal: number;
  entity_id: string;
  file: string;
  node_id: string;
  fingerprint: string;
  body_hash: string | null;
  code_hash: string | null;
  grounding_file: string | null;
  commit_sha: string | null;
  verified_at: string | null;
  reason: string | null;
}

/**
 * Re-derive every grounding verdict, and report the ones that are not fresh.
 *
 * Wholesale, always, on both paths — like shadowing and target resolution and
 * for the same reason. A grounding's health depends on code that changes
 * without the scaffold changing at all, so there is no changed set that could
 * scope it: the file whose entity went stale is the file nobody touched.
 *
 * With no resolver every verdict column is cleared. That is what makes a
 * refresh of an index built without a graph agree with a rebuild without one,
 * and it is why the columns are nullable rather than defaulted.
 *
 * Shadowed entities are resolved but not reported. A duplicated id already has
 * its own diagnostic naming both claimants, and a second warning about the
 * loser's grounding is noise pointing at a row no query returns.
 */
function resolveGroundings(db: SqliteDatabase, resolve?: GroundingResolver): WikiDiagnostic[] {
  db.prepare(`UPDATE wiki_groundings SET state = NULL, resolved_node = NULL, health = NULL, resolution = NULL`).run();
  if (resolve === undefined) return [];

  const rows = db
    .prepare(
      `SELECT g.entity_key, g.ordinal, e.id AS entity_id, e.file AS file, e.shadowed AS shadowed,
              e.title AS entity_title, e.body AS entity_body,
              g.node_id, g.fingerprint, g.body_hash, g.code_hash, g.file AS grounding_file,
              g.commit_sha, g.verified_at, g.reason
         FROM wiki_groundings g
         JOIN wiki_entities e ON e.entity_key = g.entity_key
        ORDER BY g.entity_key, g.ordinal`,
    )
    .all() as Array<GroundingRow & { shadowed: number; entity_title: string; entity_body: string }>;

  const update = db.prepare(
    `UPDATE wiki_groundings SET state = ?, resolved_node = ?, health = ?, resolution = ? WHERE entity_key = ? AND ordinal = ?`,
  );
  const diagnostics: WikiDiagnostic[] = [];

  for (const row of rows) {
    const resolution = resolve(groundingOf(row), { fact: `${row.entity_title}\n\n${row.entity_body}` });
    const resolvedNode = "resolvedNode" in resolution ? resolution.resolvedNode : null;
    update.run(
      resolution.state,
      resolvedNode,
      resolution.health,
      canonicalJson(resolution),
      row.entity_key,
      row.ordinal,
    );
    if (row.shadowed === 1) continue;
    const entry = groundingDiagnostic(row, resolution);
    if (entry !== null) diagnostics.push(entry);
  }
  return diagnostics;
}

/** Rebuild the committed reference from its row, exactly as Markdown had it. */
function groundingOf(row: GroundingRow): WikiGrounding {
  const grounding: WikiGrounding = { node: row.node_id, fingerprint: row.fingerprint };
  if (row.body_hash !== null) grounding.bodyHash = row.body_hash;
  if (row.code_hash !== null) grounding.codeHash = row.code_hash;
  if (row.grounding_file !== null) grounding.file = row.grounding_file;
  if (row.commit_sha !== null) grounding.commit = row.commit_sha;
  if (row.verified_at !== null) grounding.verifiedAt = row.verified_at;
  if (row.reason !== null) grounding.reason = row.reason;
  return grounding;
}

/**
 * The diagnostic one resolution deserves, or none.
 *
 * `fresh` says nothing, and `ungrounded` never reaches here — it is a property
 * of an entity with no grounding rows at all, so there is no row to carry it.
 *
 * All three are warnings, not errors, and none of them touches lifecycle. A
 * stale grounding is a local, branch-dependent fact (§5.3): the same entity is
 * fresh on the branch where the code was not edited, and letting that rewrite
 * canonical status would make a rebase change what a team had decided.
 */
function groundingDiagnostic(row: GroundingRow, resolution: GroundingResolution): WikiDiagnostic | null {
  const context = { file: row.file, entityId: row.entity_id, path: `groundsTo[${row.ordinal}]` };

  if (resolution.state === "stale") {
    return diagnostic(
      "GROUNDING_STALE",
      `The code ${row.entity_id} is grounded to has changed (${resolution.resolvedNode}).`,
      context,
    );
  }
  if (resolution.state === "missing") {
    return diagnostic(
      "GROUNDING_MISSING",
      `${row.entity_id} is grounded to ${row.node_id}, which no longer exists in the code graph.`,
      context,
    );
  }
  if (resolution.state === "unresolved") {
    return diagnostic(
      "GROUNDING_UNRESOLVED",
      resolution.reason ?? `${row.entity_id}'s grounding to ${row.node_id} could not be resolved.`,
      context,
    );
  }
  return null;
}

function countOf(db: SqliteDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { n?: unknown } | undefined;
  return typeof row?.n === "number" ? row.n : Number(row?.n ?? 0);
}

/**
 * Every diagnostic that needs more than one file to see.
 *
 * Reuses the model's set-level validators rather than reimplementing them in
 * SQL: `mex wiki validate`, operation planning and this index must agree about
 * what a supersession cycle is, and they only can if there is one definition.
 */
export function collectGlobalDiagnostics(db: SqliteDatabase): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];

  const rows = db
    .prepare(`SELECT entity_key, id, file, type, title, status, metadata FROM wiki_entities ORDER BY entity_key`)
    .all() as EntityRow[];

  const fileOf = new Map<string, string>();
  for (const row of rows) if (!fileOf.has(row.id)) fileOf.set(row.id, row.file);

  // Duplicate ids, read straight off the shadow flag so the report and the
  // resolution can never disagree about which claimant won.
  const shadowRows = db
    .prepare(`SELECT entity_key, id, file FROM wiki_entities WHERE shadowed = 1 ORDER BY entity_key`)
    .all() as { entity_key: string; id: string; file: string }[];
  for (const row of shadowRows) {
    const winner = db
      .prepare(`SELECT file FROM wiki_entities WHERE id = ? AND shadowed = 0`)
      .get(row.id) as { file?: string } | undefined;
    diagnostics.push(
      diagnostic(
        "DUPLICATE_ENTITY_ID",
        `Entity id ${row.id} is claimed by ${row.file} and by ${winner?.file ?? "another file"}. ` +
          `Only the first is indexed under that id.`,
        { file: row.file, entityId: row.id, path: "id" },
      ),
    );
  }

  const shadowedKeys = new Set(shadowRows.map((row) => row.entity_key));
  const active = rows.filter((row) => !shadowedKeys.has(row.entity_key));
  const relationsOf = loadRelations(db);
  const topicsOf = loadTopics(db);

  const subjects: RelationSubject[] = active.map((row) => ({
    id: row.id as EntityId,
    type: row.type,
    status: row.status,
    relations: relationsOf.get(row.entity_key) ?? [],
  }));
  diagnostics.push(...validateRelationGraph(subjects));

  const entitiesById = new Map<EntityId, { type: string }>();
  for (const row of active) entitiesById.set(row.id as EntityId, { type: row.type });
  diagnostics.push(
    ...validateTopicMembership(
      active.map((row) => ({ id: row.id as EntityId, topics: topicsOf.get(row.entity_key) ?? [] })),
      entitiesById,
    ),
  );

  const topicSubjects: TopicSubject[] = active.map((row) => ({
    id: row.id as EntityId,
    type: row.type,
    title: row.title,
    metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata) as Record<string, unknown>),
    relations: relationsOf.get(row.entity_key) ?? [],
  }));
  diagnostics.push(...validateTopicHierarchy(buildTopicIndex(topicSubjects)));

  // Attach the file every diagnostic belongs to. The model's set-level checks
  // know the entity but not where it lives, and a diagnostic a user cannot
  // locate is a diagnostic they ignore.
  return diagnostics.map((entry) =>
    entry.file === undefined && entry.entityId !== undefined && fileOf.has(entry.entityId)
      ? { ...entry, file: fileOf.get(entry.entityId)! }
      : entry,
  );
}

function loadRelations(db: SqliteDatabase): Map<string, WikiRelationRef[]> {
  const out = new Map<string, WikiRelationRef[]>();
  const rows = db
    .prepare(`SELECT source_key, ordinal, type, target_id, note FROM wiki_relations ORDER BY source_key, ordinal`)
    .all() as { source_key: string; type: string; target_id: string; note: string | null }[];
  for (const row of rows) {
    const list = out.get(row.source_key) ?? [];
    const relation = { type: row.type, target: row.target_id as EntityId } as WikiRelationRef;
    if (row.note !== null) (relation as { note?: string }).note = row.note;
    list.push(relation);
    out.set(row.source_key, list);
  }
  return out;
}

function loadTopics(db: SqliteDatabase): Map<string, EntityId[]> {
  const out = new Map<string, EntityId[]>();
  const rows = db
    .prepare(`SELECT entity_key, topic_entity_id FROM wiki_entity_topics ORDER BY entity_key, ordinal`)
    .all() as { entity_key: string; topic_entity_id: string }[];
  for (const row of rows) {
    const list = out.get(row.entity_key) ?? [];
    list.push(row.topic_entity_id as EntityId);
    out.set(row.entity_key, list);
  }
  return out;
}
