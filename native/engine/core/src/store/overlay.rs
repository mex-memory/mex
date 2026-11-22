//! A v5 overlay reuses the base's keys for surviving paths and public ids.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, Error, OpenFlags, OptionalExtension, params};

use super::{OVERLAY_KEY_START, SCHEMA_VERSION, Writer, decode_hex};

pub struct BaseFile {
    pub key: i64,
    pub hash: [u8; 32],
    pub size: u64,
    pub resolution: [u8; 32],
    pub extractor_version: String,
}

pub struct RefreshBase(Connection);

impl RefreshBase {
    pub fn open(path: &Path, refresh_format: &str) -> rusqlite::Result<Option<Self>> {
        let conn = Connection::open_with_flags(
            immutable_uri(path)?,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )?;
        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != SCHEMA_VERSION {
            return Ok(None);
        }
        let format: Option<String> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'refresh_format'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let is_overlay = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'overlay_info')",
            [],
            |row| row.get::<_, bool>(0),
        )?;
        if format.as_deref() != Some(refresh_format) || is_overlay {
            return Ok(None);
        }
        Ok(Some(Self(conn)))
    }

    pub fn files(&self) -> rusqlite::Result<HashMap<String, BaseFile>> {
        let mut stmt = self.0.prepare(
            "SELECT f.path, f.id, f.content_hash, f.size, r.digest, f.extractor_version
             FROM files f LEFT JOIN file_resolution r ON r.file = f.id",
        )?;
        stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                BaseFile {
                    key: row.get(1)?,
                    hash: row.get(2)?,
                    size: row.get::<_, u32>(3)?.into(),
                    resolution: row.get(4)?,
                    extractor_version: row.get(5)?,
                },
            ))
        })?
        .collect()
    }

    pub fn resolution_context(&self) -> rusqlite::Result<String> {
        self.0.query_row(
            "SELECT value FROM meta WHERE key = 'resolution_context'",
            [],
            |row| row.get(0),
        )
    }

    pub fn frameworks(&self) -> rusqlite::Result<String> {
        self.0.query_row(
            "SELECT value FROM meta WHERE key = 'frameworks'",
            [],
            |row| row.get(0),
        )
    }

    pub fn node_key(&self, public_id: &str) -> rusqlite::Result<Option<i64>> {
        let (_, digest) = public_id.split_once(':').ok_or(Error::InvalidQuery)?;
        self.0
            .prepare_cached("SELECT id FROM nodes WHERE public_id = ?1")?
            .query_row([decode_hex(digest)?], |row| row.get(0))
            .optional()
    }
}

fn immutable_uri(path: &Path) -> rusqlite::Result<String> {
    let path = path
        .to_str()
        .ok_or_else(|| Error::InvalidPath(path.to_owned()))?;
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    let mut uri = String::from("file:");
    if !path.starts_with('/') {
        uri.push('/');
    }
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'_' | b'-' | b'.') {
            uri.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(uri, "%{byte:02X}").expect("writing to a String");
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    Ok(uri)
}

pub(super) fn attach_base(conn: &Connection, base: &Path) -> rusqlite::Result<()> {
    let basename = base
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(Error::InvalidQuery)?;
    conn.execute("ATTACH DATABASE ?1 AS base", [immutable_uri(base)?])?;
    conn.execute_batch(
        "CREATE TABLE overlay_info (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
         CREATE TABLE shadow_files (path TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;",
    )?;
    conn.execute("INSERT INTO overlay_info VALUES ('base', ?1)", [basename])?;
    Ok(())
}

const SHADOWED_BASE_NODES: &str = "
    SELECT n.id FROM main.shadow_files s
    CROSS JOIN base.files f ON f.path = s.path
    CROSS JOIN base.nodes n ON n.file = f.id";
const CALL_KIND: &str = "coalesce((SELECT id FROM base.edge_kinds WHERE name = 'calls'),
                                    (SELECT id FROM main.edge_kinds WHERE name = 'calls'))";

impl Writer {
    pub fn shadow(&self, path: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO shadow_files VALUES (?1)")?
            .execute([path])?;
        Ok(())
    }

    pub fn copy_outgoing(&self, key: i64) -> rusqlite::Result<()> {
        for (table, owner) in [
            ("edges", "source"),
            ("unresolved_calls", "source"),
            ("unresolved_other", "source"),
        ] {
            self.conn
                .prepare_cached(&format!(
                    "INSERT INTO main.{table} SELECT * FROM base.{table} WHERE {owner} IN
                 (SELECT id FROM base.nodes WHERE file = ?1)"
                ))?
                .execute([key])?;
        }
        Ok(())
    }

    /// Other files whose owned fingerprints changed when these call pairs
    /// were replaced. The opposite call, when present on an unshadowed file,
    /// already contributes the same undirected neighbour.
    pub fn neighbouring_files(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare(&format!(
            "WITH old(source, target) AS MATERIALIZED (
               SELECT DISTINCT source, target FROM base.edges WHERE kind = {CALL_KIND}
                   AND source IN ({SHADOWED_BASE_NODES})
             ), new(source, target) AS MATERIALIZED (
               SELECT DISTINCT source, target FROM main.edges WHERE kind = {CALL_KIND}
             ), removed AS (SELECT * FROM old EXCEPT SELECT * FROM new),
                added AS (SELECT * FROM new EXCEPT SELECT * FROM old),
                delta AS (SELECT * FROM removed UNION ALL SELECT * FROM added)
             SELECT DISTINCT f.path FROM delta d
             CROSS JOIN base.fingerprints fp ON fp.node = d.target
             CROSS JOIN base.nodes n ON n.id = d.target
             CROSS JOIN base.files f ON f.id = n.file
             WHERE f.path NOT IN (SELECT path FROM main.shadow_files)
               AND NOT EXISTS (SELECT 1 FROM base.edges e
                   WHERE e.source = d.target AND e.kind = {CALL_KIND} AND e.target = d.source)
             ORDER BY f.path",
        ))?;
        stmt.query_map([], |row| row.get(0))?.collect()
    }

    pub(super) fn finish_overlay_fingerprints(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(&format!(
            "INSERT INTO main.fingerprint_neighbours
             SELECT fp.node, e.target FROM main.fingerprints fp CROSS JOIN main.edges e ON e.source = fp.node
             WHERE e.kind = {CALL_KIND}
             UNION
             SELECT fp.node, e.source FROM main.fingerprints fp CROSS JOIN main.edges e ON e.target = fp.node
             WHERE e.kind = {CALL_KIND}
             UNION
             SELECT fp.node, e.source FROM main.fingerprints fp CROSS JOIN base.edges e ON e.target = fp.node
             WHERE e.kind = {CALL_KIND} AND e.source NOT IN ({SHADOWED_BASE_NODES});",
        ))?;
        Ok(())
    }

    pub fn overlay_counts(&self) -> rusqlite::Result<[usize; 4]> {
        self.conn.query_row(&format!(
            "SELECT (SELECT count(*) FROM base.files) + (SELECT count(*) FROM main.files) -
                       (SELECT count(*) FROM main.shadow_files s CROSS JOIN base.files f ON f.path = s.path),
                    coalesce((SELECT CAST(value AS INTEGER) FROM base.meta WHERE key = 'node_count'),
                             (SELECT count(*) FROM base.nodes)) + (SELECT count(*) FROM main.nodes) -
                       (SELECT count(*) FROM ({SHADOWED_BASE_NODES})),
                    coalesce((SELECT CAST(value AS INTEGER) FROM base.meta WHERE key = 'edge_count'),
                             (SELECT count(*) FROM base.edges)) + (SELECT count(*) FROM main.edges) -
                       (SELECT count(*) FROM base.edges WHERE source IN ({SHADOWED_BASE_NODES})),
                    (SELECT count(*) FROM main.shadow_files)"
        ), params![], |row| Ok([row.get::<_, u32>(0)? as usize, row.get::<_, u32>(1)? as usize, row.get::<_, u32>(2)? as usize, row.get::<_, u32>(3)? as usize]))
    }

    pub fn carry_parse_gaps(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "INSERT INTO main.coverage SELECT f.path, 'parse failed' FROM base.files f
             WHERE f.parse_status = 2 AND f.path NOT IN (SELECT path FROM main.shadow_files);",
        )
    }

    pub fn failed_files(&self) -> rusqlite::Result<usize> {
        self.conn
            .query_row("SELECT count(*) FROM main.coverage", [], |row| {
                Ok(row.get::<_, u32>(0)? as usize)
            })
    }

    pub fn next_overlay_key(index: usize) -> i64 {
        OVERLAY_KEY_START + 1 + index as i64
    }
}
