//! Bulk-write one schema v5 candidate in a single transaction.

use std::collections::HashMap;
use std::io;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use rusqlite::Error;
pub const SCHEMA_VERSION: u32 = 5;
const SCHEMA: &str = include_str!("schema_v5.sql");
mod incremental;
pub use incremental::ReadId;
mod overlay;
mod projections;
pub use overlay::{BaseFile, RefreshBase};
pub use projections::StoredProjection;
pub const OVERLAY_KEY_START: i64 = 1 << 40;
const DEFAULT_PAGE_SIZE: u32 = 4096;
const SMALL_BASE_NODE_COUNT: usize = 4096;

const INDEXES: &str = "
CREATE INDEX nodes_file_line ON nodes(file, start_line);
CREATE INDEX nodes_name ON nodes(name);
CREATE INDEX nodes_lower_name ON nodes(lower(name));
CREATE INDEX nodes_parent ON nodes(parent) WHERE parent IS NOT NULL;
CREATE INDEX edges_target ON edges(target, kind);
CREATE INDEX edges_site_file ON edges(site_file) WHERE site_file IS NOT NULL;
CREATE INDEX unresolved_calls_name ON unresolved_calls(name);
CREATE INDEX unresolved_calls_written_name ON unresolved_calls(written_name) WHERE written_name IS NOT NULL;
CREATE INDEX unresolved_calls_candidate ON unresolved_calls(candidate) WHERE candidate IS NOT NULL;
CREATE INDEX unresolved_calls_source ON unresolved_calls(source);
CREATE INDEX unresolved_other_name ON unresolved_other(name);
CREATE INDEX unresolved_other_source ON unresolved_other(source);
CREATE INDEX aliases_node ON aliases(node);
CREATE INDEX fingerprint_neighbours_neighbour ON fingerprint_neighbours(neighbour);
CREATE INDEX grounded_body_hash ON _mex_grounded_source(body_hash);
CREATE UNIQUE INDEX source_chunks_file ON source_chunks(file, start_line);
";

// Static identifiers are the only strings interpolated into SQL statements.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Code {
    Language,
    NodeKind,
    EdgeKind,
    Provenance,
    Method,
    Reason,
    Name,
}

impl Code {
    fn table(self) -> &'static str {
        match self {
            Self::Language => "languages",
            Self::NodeKind => "node_kinds",
            Self::EdgeKind => "edge_kinds",
            Self::Provenance => "provenances",
            Self::Method => "resolution_methods",
            Self::Reason => "unresolved_reasons",
            Self::Name => "unresolved_names",
        }
    }
}

pub struct FileRow<'a> {
    pub path: &'a str,
    pub content_hash: &'a [u8; 32],
    pub language: &'a str,
    pub size: u64,
    pub modified_at: f64,
    pub parse_status: u8,
    pub error_count: u32,
    pub missing_count: u32,
    pub error_coverage: f32,
    pub extractor_version: &'a str,
}

pub struct NodeRow<'a> {
    pub key: i64,
    pub public_id: &'a str,
    pub kind: &'a str,
    pub file: i64,
    pub parent: Option<i64>,
    pub name: &'a str,
    pub qualified_name: &'a str,
    pub span: [u32; 4],
    pub signature: Option<&'a str>,
    pub flags: u32,
    pub body_hash: Option<&'a [u8; 32]>,
    pub docstring: Option<&'a str>,
    pub visibility: Option<&'a str>,
    pub return_type: Option<&'a str>,
    pub decorators: &'a [String],
    pub type_parameters: &'a [String],
}

pub struct EdgeRow<'a> {
    pub source: i64,
    pub kind: &'a str,
    pub target: i64,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub site_file: Option<i64>,
    pub provenance: &'a str,
    pub confidence: f64,
    pub method: &'a str,
    pub target_name: Option<&'a str>,
    pub evidence: Option<EdgeEvidence<'a>>,
}

pub enum EdgeEvidence<'a> {
    Declaration(Option<&'a str>),
    Import,
    Heritage,
    Expression(&'a str),
    Callback(u32),
    Framework(Option<&'a str>),
    SyntaxImport(&'a str),
}

pub struct UnresolvedRow<'a> {
    pub source: i64,
    pub name: &'a str,
    pub kind: &'a str,
    pub reason: &'a str,
    pub line: u32,
    pub col: u32,
    pub candidate: Option<i64>,
    pub receiver: Option<&'a str>,
    pub written_name: Option<&'a str>,
}

/// Provenance observed by the parent under its maintenance lease. The child
/// verifies each captured source and adds the actual extraction health totals.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildMetadata {
    pub indexed_at: i64,
    pub indexed_branch: Option<String>,
    pub indexed_head: Option<String>,
    pub compiler_version: String,
    pub extractor_version: String,
    pub resolver_version: String,
    pub grammar_hash: String,
    pub config_hash: String,
    pub manifest_hash: String,
    pub source_corpus_digest: String,
    pub coverage: Option<CoverageSummary>,
    pub skipped: Vec<CoverageGap>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageSummary {
    pub policy_hash: String,
    pub total: u32,
    pub truncated: bool,
    pub entries: Vec<CoverageExtension>,
    pub directories: Vec<CoverageDirectory>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageExtension {
    pub extension: String,
    pub files: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageDirectory {
    pub path: String,
    pub stamp: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CoverageGap {
    pub path: String,
    pub reason: String,
}

pub struct Writer {
    conn: Connection,
    codes: HashMap<Code, HashMap<String, i64>>,
    dependencies: incremental::Dependencies,
    projection_blocks: std::cell::RefCell<projections::Blocks>,
    page_size: u32,
    edge_sequence: i64,
    previous_overlay: bool,
    sparse_observations: bool,
    overlay: bool,
    next_code: i64,
    next_chunk: i64,
    next_unresolved: i64,
}

impl Writer {
    /// Atomically reserve a new candidate path. The parent validates and syncs
    /// completed candidates; a stopped build is discarded with its sidecars.
    pub fn create(path: &Path, nodes: usize) -> rusqlite::Result<Writer> {
        let page_size = if nodes < SMALL_BASE_NODE_COUNT {
            2048
        } else {
            DEFAULT_PAGE_SIZE
        };
        Self::create_candidate(path, None, page_size)
    }

    pub fn overlay(path: &Path, base: &Path) -> rusqlite::Result<Writer> {
        Self::create_candidate(path, Some(base), DEFAULT_PAGE_SIZE)
    }

    fn create_candidate(
        path: &Path,
        base: Option<&Path>,
        page_size: u32,
    ) -> rusqlite::Result<Writer> {
        let mut file = std::fs::OpenOptions::new();
        file.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file.mode(0o600);
        }
        file.open(path)
            .map_err(|_| Error::InvalidPath(path.to_path_buf()))?;
        let conn = Connection::open(path)?;
        conn.set_prepared_statement_cache_capacity(64);
        conn.pragma_update(None, "page_size", page_size)?;
        conn.execute_batch(
            "PRAGMA journal_mode = OFF;
             PRAGMA synchronous = OFF;
             PRAGMA cache_size = -8192;",
        )?;
        conn.pragma_update(None, "foreign_keys", base.is_none())?;
        if base.is_none() {
            conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
        }
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch(incremental::SCHEMA)?;
        if let Some(base) = base {
            conn.execute_batch(incremental::OVERLAY_SCHEMA)?;
            overlay::attach_base(&conn, base)?;
        }
        conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")?;
        if page_size < DEFAULT_PAGE_SIZE {
            // Keep FTS leaf records inline on the smaller SQLite pages.
            let fts_page = page_size - 64;
            conn.execute(
                "INSERT INTO nodes_fts(nodes_fts, rank) VALUES ('pgsz', ?1)",
                [fts_page],
            )?;
            conn.execute(
                "INSERT INTO source_chunks_fts(source_chunks_fts, rank) VALUES ('pgsz', ?1)",
                [fts_page],
            )?;
        }
        let offset = if base.is_some() { OVERLAY_KEY_START } else { 0 };
        Ok(Writer {
            conn,
            codes: HashMap::new(),
            dependencies: incremental::Dependencies::default(),
            projection_blocks: Default::default(),
            page_size,
            edge_sequence: offset,
            previous_overlay: false,
            sparse_observations: false,
            overlay: base.is_some(),
            next_code: offset,
            next_chunk: offset,
            next_unresolved: offset,
        })
    }

    fn code(&mut self, code: Code, name: &str) -> rusqlite::Result<i64> {
        let names = self.codes.entry(code).or_default();
        if let Some(id) = names.get(name) {
            return Ok(*id);
        }
        let existing = if self.overlay {
            self.conn
                .prepare_cached(&format!(
                    "SELECT id FROM base.{0} WHERE name = ?1 UNION ALL SELECT id FROM main.{0} WHERE name = ?1",
                    code.table(),
                ))?
                .query_row([name], |row| row.get(0))
                .optional()?
        } else {
            None
        };
        let id = match existing {
            Some(id) => id,
            None => {
                self.next_code += 1;
                self.conn
                    .prepare_cached(&format!(
                        "INSERT INTO {}(id, name) VALUES (?1, ?2)",
                        code.table()
                    ))?
                    .execute(params![self.overlay.then_some(self.next_code), name])?;
                self.conn.last_insert_rowid()
            }
        };
        names.insert(name.to_owned(), id);
        Ok(id)
    }

    pub fn add_file(&mut self, key: Option<i64>, file: &FileRow) -> rusqlite::Result<i64> {
        let language = self.code(Code::Language, file.language)?;
        self.conn
            .prepare_cached(
                "INSERT INTO files(id, path, content_hash, language, size, modified_at, parse_status,
                                   error_count, missing_count, error_coverage, extractor_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?
            .execute(params![
                key,
                file.path,
                file.content_hash.as_slice(),
                language,
                i64::try_from(file.size)
                    .map_err(|error| Error::ToSqlConversionFailure(error.into()))?,
                file.modified_at,
                file.parse_status,
                file.error_count,
                file.missing_count,
                file.error_coverage,
                file.extractor_version
            ])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn set_file_resolution(&self, file: i64, digest: &[u8; 32]) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO file_resolution VALUES (?1, ?2)")?
            .execute(params![file, digest.as_slice()])?;
        Ok(())
    }

    pub fn add_source_observation(
        &self,
        path: &str,
        identity: &str,
        utf8_size: u32,
    ) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO source_observations VALUES (?1, ?2, ?3)")?
            .execute(params![path, identity, utf8_size])?;
        Ok(())
    }

    pub fn remove_source_observation(&self, path: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("DELETE FROM source_observations WHERE path = ?1")?
            .execute([path])?;
        if self.sparse_observations {
            self.conn
                .prepare_cached("INSERT OR IGNORE INTO main.source_observation_gaps VALUES (?1)")?
                .execute([path])?;
        }
        Ok(())
    }

    pub fn add_diagnostic(
        &self,
        file: i64,
        position: usize,
        code: &str,
        start: u32,
        end: u32,
    ) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO file_diagnostics VALUES (?1, ?2, ?3, ?4, ?5)")?
            .execute(params![file, position as i64, code, start, end])?;
        Ok(())
    }

    pub fn add_node(&mut self, node: &NodeRow) -> rusqlite::Result<()> {
        let kind = self.code(Code::NodeKind, node.kind)?;
        let public_id = crate::id::decode_node_id(node.public_id).ok_or(Error::InvalidQuery)?;
        self.conn
            .prepare_cached(
                "INSERT INTO nodes(id, public_id, kind, file, parent, name, qualified_name,
                    start_line, start_col, end_line, end_col, signature, flags, body_hash,
                    docstring, visibility, return_type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            )?
            .execute(params![
                node.key, public_id, kind, node.file, node.parent, node.name, node.qualified_name,
                node.span[0], node.span[1], node.span[2], node.span[3], node.signature, node.flags,
                node.body_hash.map(|hash| hash.as_slice()), node.docstring, node.visibility,
                node.return_type
            ])?;
        self.conn
            .prepare_cached("INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?
            .execute(params![node.key, node.public_id, node.name, node.qualified_name, node.docstring, node.signature])?;
        for (kind, values) in [(0, node.decorators), (1, node.type_parameters)] {
            if values.is_empty() {
                continue;
            }
            let mut insert = self
                .conn
                .prepare_cached("INSERT INTO node_attributes VALUES (?1, ?2, ?3, ?4)")?;
            for (position, value) in values.iter().enumerate() {
                insert.execute(params![node.key, kind, position as i64, value])?;
            }
        }
        Ok(())
    }

    pub fn add_edge(&mut self, edge: &EdgeRow) -> rusqlite::Result<bool> {
        let kind = self.code(Code::EdgeKind, edge.kind)?;
        let provenance = self.code(Code::Provenance, edge.provenance)?;
        let method = self.code(Code::Method, edge.method)?;
        let (detail_kind, detail, argument) = match edge.evidence {
            None => (None, None, None),
            Some(EdgeEvidence::Declaration(role)) => (Some(1), role, None),
            Some(EdgeEvidence::Import) => (Some(2), None, None),
            Some(EdgeEvidence::Heritage) => (Some(3), None, None),
            Some(EdgeEvidence::Expression(text)) => (Some(4), Some(text), None),
            Some(EdgeEvidence::Callback(index)) => (Some(5), None, Some(index)),
            Some(EdgeEvidence::Framework(binding)) => (Some(6), binding, None),
            Some(EdgeEvidence::SyntaxImport(specifier)) => (Some(7), Some(specifier), None),
        };
        self.edge_sequence += 1;
        let inserted = self
            .conn
            .prepare_cached(
                "INSERT INTO edges VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(source, kind, target, line, col) DO NOTHING",
            )?
            .execute(params![
                edge.source,
                kind,
                edge.target,
                edge.line.map_or(-1, i64::from),
                edge.col.map_or(-1, i64::from),
                edge.site_file,
                provenance,
                edge.confidence,
                method,
                edge.target_name,
                detail_kind,
                detail,
                argument,
                self.edge_sequence
            ])?;
        Ok(inserted > 0)
    }

    pub fn add_unresolved(&mut self, row: &UnresolvedRow) -> rusqlite::Result<()> {
        self.next_unresolved += 1;
        let key = self.overlay.then_some(self.next_unresolved);
        let name = self.code(Code::Name, row.name)?;
        let reason = self.code(Code::Reason, row.reason)?;
        let kind = self.code(Code::EdgeKind, row.kind)?;
        if matches!(row.kind, "calls" | "instantiates") {
            let receiver = row
                .receiver
                .map(|name| self.code(Code::Name, name))
                .transpose()?;
            let written_name = row
                .written_name
                .filter(|written| *written != row.name)
                .map(|name| self.code(Code::Name, name))
                .transpose()?;
            self.conn.prepare_cached(
                "INSERT INTO unresolved_calls(id, source, name, kind, reason, line, col, candidate, receiver, written_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )?.execute(params![key, row.source, name, kind, reason, row.line, row.col, row.candidate, receiver, written_name])?;
        } else {
            self.conn.prepare_cached(
                "INSERT INTO unresolved_other(id, source, name, kind, reason, line, col) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?.execute(params![key, row.source, name, kind, reason, row.line, row.col])?;
        }
        Ok(())
    }

    pub fn add_fingerprint(
        &self,
        node: i64,
        minhash: &[u8],
        token_count: u32,
    ) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO fingerprints VALUES (?1, ?2, ?3)")?
            .execute(params![node, minhash, token_count])?;
        Ok(())
    }

    /// Derive the stored neighborhood from exactly the published call edges.
    pub fn finish_fingerprints(&self) -> rusqlite::Result<()> {
        // Read target-owned pairs from the covering index and insert both
        // directions in primary-key order. Colliding sites share one pair.
        self.conn.execute_batch(
            "INSERT INTO fingerprint_neighbours
             SELECT e.source, e.target FROM edges e CROSS JOIN fingerprints fp ON fp.node = e.source
             WHERE e.kind = (SELECT id FROM edge_kinds WHERE name = 'calls')
             UNION ALL
             SELECT e.target, e.source FROM edges e INDEXED BY edges_target
             CROSS JOIN fingerprints fp ON fp.node = e.target
             WHERE e.kind = (SELECT id FROM edge_kinds WHERE name = 'calls')
             ORDER BY 1, 2
             ON CONFLICT(node, neighbour) DO NOTHING;",
        )
    }

    pub fn add_source_chunk(
        &mut self,
        file: i64,
        lines: [usize; 2],
        path_terms: &str,
        identifier_terms: &str,
        comments: &str,
        text: &str,
    ) -> rusqlite::Result<()> {
        self.next_chunk += 1;
        let key = self.overlay.then_some(self.next_chunk);
        self.conn
            .prepare_cached(
                "INSERT INTO source_chunks(id, file, start_line, end_line) VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![key, file, lines[0] as i64, lines[1] as i64])?;
        let id = self.conn.last_insert_rowid();
        self.conn.prepare_cached(
            "INSERT INTO source_chunks_fts(rowid, path_terms, identifier_terms, comment_terms, source_text) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?.execute(params![id, path_terms, identifier_terms, comments, text])?;
        Ok(())
    }

    pub fn add_coverage(&self, path: &str, reason: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO coverage(path, reason) VALUES (?1, ?2)")?
            .execute(params![path, reason])?;
        Ok(())
    }

    pub fn set_build_metadata(&self, meta: &BuildMetadata) -> rusqlite::Result<()> {
        let [source_count, partial_count, failed_count] = self.parse_counts()?;
        self.conn.execute(
            "INSERT INTO snapshot VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                meta.indexed_at, meta.indexed_branch, meta.indexed_head.as_deref().map(decode_hex).transpose()?,
                meta.compiler_version, meta.extractor_version, meta.resolver_version,
                decode_hex(&meta.grammar_hash)?, decode_hex(&meta.config_hash)?, decode_hex(&meta.manifest_hash)?,
                decode_hex(&meta.source_corpus_digest)?,
                source_count, partial_count, failed_count,
            ],
        )?;
        if let Some(coverage) = &meta.coverage {
            self.conn.execute(
                "INSERT INTO coverage_summary VALUES (1, ?1, ?2, ?3)",
                params![
                    decode_hex(&coverage.policy_hash)?,
                    coverage.total,
                    coverage.truncated
                ],
            )?;
            let mut extension = self
                .conn
                .prepare_cached("INSERT INTO coverage_extensions VALUES (?1, ?2)")?;
            for entry in &coverage.entries {
                extension.execute(params![entry.extension, entry.files])?;
            }
            let mut directory = self
                .conn
                .prepare_cached("INSERT INTO coverage_directories VALUES (?1, ?2)")?;
            for entry in &coverage.directories {
                directory.execute(params![entry.path, entry.stamp])?;
            }
        }
        for gap in &meta.skipped {
            self.add_coverage(&gap.path, &gap.reason)?;
        }
        Ok(())
    }

    fn parse_counts(&self) -> rusqlite::Result<[i64; 3]> {
        let counts = |sql| {
            self.conn
                .query_row(sql, [], |row| Ok([row.get(0)?, row.get(1)?, row.get(2)?]))
        };
        if self.overlay
            && let Some(base) =
                counts("SELECT source_count, partial_count, failed_count FROM base.snapshot")
                    .optional()?
        {
            let current: [i64; 3] = counts(
                "SELECT count(*), count(*) FILTER(WHERE parse_status = 1),
                        count(*) FILTER(WHERE parse_status = 2) FROM main.files",
            )?;
            let hidden: [i64; 3] = counts(
                "SELECT count(*), count(*) FILTER(WHERE f.parse_status = 1),
                        count(*) FILTER(WHERE f.parse_status = 2)
                 FROM main.shadow_files s CROSS JOIN base.files f ON f.path = s.path",
            )?;
            return Ok(std::array::from_fn(|i| base[i] + current[i] - hidden[i]));
        }
        let files = if self.overlay {
            "(SELECT parse_status FROM main.files UNION ALL SELECT parse_status FROM base.files
              WHERE path NOT IN (SELECT path FROM main.shadow_files))"
        } else {
            "main.files"
        };
        counts(&format!(
            "SELECT count(*), count(*) FILTER(WHERE parse_status = 1),
             count(*) FILTER(WHERE parse_status = 2) FROM {files}"
        ))
    }

    pub fn set_meta(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO meta VALUES (?1, ?2)")?
            .execute(params![key, value])?;
        Ok(())
    }

    pub fn finish(self) -> rusqlite::Result<()> {
        self.flush_projection_blocks()?;
        self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        crate::timing::measure("v5.indexes", || {
            self.conn.execute_batch(INDEXES)?;
            self.conn.execute_batch(incremental::INDEXES)?;
            let nodes: i64 = self
                .conn
                .query_row("SELECT count(*) FROM nodes", [], |row| row.get(0))?;
            // A scan is cheap on small stores. Larger ones use the prefix
            // index to narrow continuity probes before comparing the full hash.
            if nodes >= 4096 {
                self.conn.execute_batch(
                    "CREATE INDEX nodes_body_hash ON nodes(substr(body_hash, 1, 8))
                     WHERE body_hash IS NOT NULL",
                )?;
            }
            Ok::<_, Error>(())
        })?;
        crate::timing::measure("v5.fingerprintNeighbours", || {
            if self.overlay {
                self.finish_overlay_fingerprints()
            } else {
                self.finish_fingerprints()
            }
        })?;
        crate::timing::measure("v5.optimizeFts", || {
            self.conn.execute_batch(
                "INSERT INTO nodes_fts(nodes_fts) VALUES ('optimize');
                 INSERT INTO source_chunks_fts(source_chunks_fts) VALUES ('optimize');",
            )
        })?;
        if !self.overlay {
            crate::timing::measure("v5.reclaimPages", || {
                let mut stmt = self.conn.prepare("PRAGMA incremental_vacuum")?;
                let mut pages = stmt.query([])?;
                while pages.next()?.is_some() {}
                Ok::<_, Error>(())
            })?;
        }
        self.conn.execute_batch("COMMIT;")?;
        self.conn.close().map_err(|(_, error)| error)
    }
}

fn decode_hex(value: &str) -> rusqlite::Result<Vec<u8>> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::ToSqlConversionFailure(
            io::Error::new(io::ErrorKind::InvalidData, "invalid hex digest").into(),
        ));
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|error| Error::ToSqlConversionFailure(error.into()))
        })
        .collect()
}
