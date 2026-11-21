//! Writing a schema v5 graph: one candidate file, one transaction.
//!
//! The writer creates the candidate, inserts rows in file order inside a
//! single transaction with cached statements (the fingerprint save once took
//! 238 of 313 s through nested savepoints and per-row statements), builds the
//! secondary indexes after the bulk insert, and records the schema version.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, params};

pub const SCHEMA_VERSION: u32 = 5;
const SCHEMA: &str = include_str!("schema_v5.sql");

/// Indexes built after the bulk insert, not before.
const INDEXES: &str = "
CREATE INDEX nodes_file   ON nodes(file);
CREATE INDEX nodes_name   ON nodes(name);
CREATE INDEX nodes_parent ON nodes(parent) WHERE parent IS NOT NULL;
CREATE INDEX edges_target ON edges(target, kind);
";

/// Small-integer code tables, interned as rows arrive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Code {
    Language,
    NodeKind,
    EdgeKind,
    Provenance,
    UnresolvedReason,
}

impl Code {
    fn table(self) -> &'static str {
        match self {
            Code::Language => "languages",
            Code::NodeKind => "node_kinds",
            Code::EdgeKind => "edge_kinds",
            Code::Provenance => "provenances",
            Code::UnresolvedReason => "unresolved_reasons",
        }
    }
}

pub struct FileRow<'a> {
    pub path: &'a str,
    pub content_hash: &'a [u8; 32],
    pub language: &'a str,
    pub size: u64,
    pub parse_status: u8,
    pub error_count: u32,
    pub missing_count: u32,
}

pub struct NodeRow<'a> {
    pub public_id: &'a [u8; 16],
    pub kind: &'a str,
    pub file: i64,
    pub parent: Option<i64>,
    pub name: &'a str,
    pub qualified_name: &'a str,
    /// 1-based start line, 0-based column, then the same for the end.
    pub span: [u32; 4],
    pub signature: Option<&'a str>,
    pub flags: u32,
    pub body_hash: Option<&'a [u8; 32]>,
    pub docstring: Option<&'a str>,
}

pub struct EdgeRow<'a> {
    pub source: i64,
    pub kind: &'a str,
    pub target: i64,
    pub line: u32,
    pub col: u32,
    pub provenance: &'a str,
    pub confidence: f64,
}

/// Writes one candidate graph. Nothing is visible until [`Writer::finish`].
pub struct Writer {
    conn: Connection,
    codes: HashMap<(Code, String), i64>,
}

impl Writer {
    /// Create `path`, which must not exist yet: the engine writes only the
    /// candidate it is given, never over another file.
    pub fn create(path: &Path) -> rusqlite::Result<Writer> {
        if path.exists() {
            return Err(rusqlite::Error::InvalidPath(path.to_path_buf()));
        }
        let conn = Connection::open(path)?;
        // A candidate is written once and validated before publication: no
        // rollback journal is needed, and a crash leaves a file Node deletes.
        conn.execute_batch(
            "PRAGMA journal_mode = OFF;
             PRAGMA synchronous = OFF;
             PRAGMA page_size = 4096;
             PRAGMA cache_size = -65536;",
        )?;
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch("BEGIN")?;
        Ok(Writer {
            conn,
            codes: HashMap::new(),
        })
    }

    fn code(&mut self, code: Code, name: &str) -> rusqlite::Result<i64> {
        if let Some(id) = self.codes.get(&(code, name.to_owned())) {
            return Ok(*id);
        }
        let table = code.table();
        self.conn
            .prepare_cached(&format!("INSERT INTO {table}(name) VALUES (?1)"))?
            .execute([name])?;
        let id = self.conn.last_insert_rowid();
        self.codes.insert((code, name.to_owned()), id);
        Ok(id)
    }

    pub fn add_file(&mut self, file: &FileRow) -> rusqlite::Result<i64> {
        let language = self.code(Code::Language, file.language)?;
        self.conn
            .prepare_cached(
                "INSERT INTO files(path, content_hash, language, size, parse_status, error_count, missing_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![
                file.path,
                &file.content_hash[..],
                language,
                i64::try_from(file.size).unwrap_or(i64::MAX),
                file.parse_status,
                file.error_count,
                file.missing_count
            ])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn add_node(&mut self, node: &NodeRow) -> rusqlite::Result<i64> {
        let kind = self.code(Code::NodeKind, node.kind)?;
        self.conn
            .prepare_cached(
                "INSERT INTO nodes(public_id, kind, file, parent, name, qualified_name,
                    start_line, start_col, end_line, end_col, signature, flags, body_hash, docstring)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )?
            .execute(params![
                &node.public_id[..],
                kind,
                node.file,
                node.parent,
                node.name,
                node.qualified_name,
                node.span[0],
                node.span[1],
                node.span[2],
                node.span[3],
                node.signature,
                node.flags,
                node.body_hash.map(|h| &h[..]),
                node.docstring
            ])?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Add an edge; a duplicate of an existing edge is folded into it.
    pub fn add_edge(&mut self, edge: &EdgeRow) -> rusqlite::Result<()> {
        let kind = self.code(Code::EdgeKind, edge.kind)?;
        let provenance = self.code(Code::Provenance, edge.provenance)?;
        self.conn
            .prepare_cached(
                "INSERT OR IGNORE INTO edges(source, kind, target, line, col, provenance, confidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?
            .execute(params![
                edge.source,
                kind,
                edge.target,
                edge.line,
                edge.col,
                provenance,
                edge.confidence
            ])?;
        Ok(())
    }

    pub fn add_unresolved(&mut self, file: i64, reason: &str, count: u32) -> rusqlite::Result<()> {
        let reason = self.code(Code::UnresolvedReason, reason)?;
        self.conn
            .prepare_cached(
                "INSERT INTO unresolved(file, reason, count) VALUES (?1, ?2, ?3)
                 ON CONFLICT(file, reason) DO UPDATE SET count = count + excluded.count",
            )?
            .execute(params![file, reason, count])?;
        Ok(())
    }

    pub fn add_coverage(&mut self, path: &str, reason: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO coverage(path, reason) VALUES (?1, ?2)")?
            .execute(params![path, reason])?;
        Ok(())
    }

    pub fn set_meta(&mut self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)")?
            .execute(params![key, value])?;
        Ok(())
    }

    /// Build the indexes, commit and close. Only now is the candidate complete.
    pub fn finish(mut self) -> rusqlite::Result<()> {
        self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        self.conn.execute_batch(INDEXES)?;
        self.conn.execute_batch("COMMIT; PRAGMA optimize;")?;
        self.conn.close().map_err(|(_, e)| e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::{id_bytes, signature_identity};

    fn temp_db(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mex-graph-store-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("graph.db");
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn writes_a_small_graph_and_refuses_an_existing_file() {
        let path = temp_db("small");
        let mut w = Writer::create(&path).unwrap();
        let file = w
            .add_file(&FileRow {
                path: "src/app.py",
                content_hash: &[7; 32],
                language: "python",
                size: 120,
                parse_status: 0,
                error_count: 0,
                missing_count: 0,
            })
            .unwrap();
        let ids: Vec<i64> = ["main", "helper"]
            .iter()
            .map(|name| {
                let identity = signature_identity("src/app.py", "function", name, None, "()");
                w.add_node(&NodeRow {
                    public_id: &id_bytes(&identity),
                    kind: "function",
                    file,
                    parent: None,
                    name,
                    qualified_name: name,
                    span: [1, 0, 3, 0],
                    signature: Some("()"),
                    flags: 1,
                    body_hash: Some(&[1; 32]),
                    docstring: None,
                })
                .unwrap()
            })
            .collect();
        let edge = EdgeRow {
            source: ids[0],
            kind: "calls",
            target: ids[1],
            line: 2,
            col: 4,
            provenance: "tree-sitter",
            confidence: 1.0,
        };
        w.add_edge(&edge).unwrap();
        w.add_edge(&edge).unwrap();
        w.add_unresolved(file, "untyped_receiver", 2).unwrap();
        w.add_unresolved(file, "untyped_receiver", 1).unwrap();
        w.finish().unwrap();

        let conn = Connection::open(&path).unwrap();
        let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count("SELECT count(*) FROM nodes"), 2);
        assert_eq!(
            count("SELECT count(*) FROM edges"),
            1,
            "duplicate edges fold"
        );
        assert_eq!(count("SELECT count FROM unresolved"), 3);
        assert_eq!(
            count("SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schema_version'"),
            5
        );
        assert_eq!(count("SELECT length(public_id) FROM nodes LIMIT 1"), 16);
        assert!(Writer::create(&path).is_err(), "never writes over a file");
    }

    /// A rough size check on the storage target (<= 1.5 KB per node): a
    /// synthetic graph with today's shape, two edges per node.
    #[test]
    fn stays_well_under_the_bytes_per_node_target() {
        let path = temp_db("size");
        let mut w = Writer::create(&path).unwrap();
        let mut nodes = Vec::new();
        for f in 0..200 {
            let file_path = format!("src/module_{f}/component_{f}.ts");
            let file = w
                .add_file(&FileRow {
                    path: &file_path,
                    content_hash: &[f as u8; 32],
                    language: "typescript",
                    size: 8_000,
                    parse_status: 0,
                    error_count: 0,
                    missing_count: 0,
                })
                .unwrap();
            for n in 0..50 {
                let name = format!("handleRequestNumber{n}");
                let qualified = format!("Component{f}.{name}");
                let identity = signature_identity(&file_path, "method", &qualified, None, "");
                nodes.push(
                    w.add_node(&NodeRow {
                        public_id: &id_bytes(&identity),
                        kind: "method",
                        file,
                        parent: None,
                        name: &name,
                        qualified_name: &qualified,
                        span: [n * 10 + 1, 2, n * 10 + 9, 3],
                        signature: Some("(request: Request, context: Context): Promise<Response>"),
                        flags: 1,
                        body_hash: Some(&[n as u8; 32]),
                        docstring: None,
                    })
                    .unwrap(),
                );
            }
        }
        for (i, &source) in nodes.iter().enumerate() {
            for step in [1, 7] {
                w.add_edge(&EdgeRow {
                    source,
                    kind: "calls",
                    target: nodes[(i + step) % nodes.len()],
                    line: 10,
                    col: 8,
                    provenance: "tree-sitter",
                    confidence: 1.0,
                })
                .unwrap();
            }
        }
        w.finish().unwrap();
        let bytes = std::fs::metadata(&path).unwrap().len();
        let per_node = bytes / nodes.len() as u64;
        eprintln!("schema v5 synthetic graph: {per_node} bytes per node");
        assert!(per_node < 1_536, "{per_node} bytes per node");
    }
}
