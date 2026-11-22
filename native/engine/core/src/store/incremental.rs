//! Private resolver state. Its ownership is by written site, including
//! callbacks whose publicly visible edge has a different source file.

use rusqlite::{OptionalExtension, params};

use super::Writer;

pub(super) const SCHEMA: &str = "
CREATE TABLE resolution_inputs (
    path TEXT PRIMARY KEY,
    projection BLOB
) STRICT, WITHOUT ROWID;
CREATE TABLE resolution_reads (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    origin TEXT NOT NULL,
    PRIMARY KEY (kind, key, origin)
) STRICT, WITHOUT ROWID;
CREATE INDEX resolution_reads_origin ON resolution_reads(origin);
CREATE TABLE resolution_callbacks (
    owner TEXT NOT NULL,
    origin TEXT NOT NULL,
    projection BLOB NOT NULL,
    PRIMARY KEY (owner, origin)
) STRICT, WITHOUT ROWID;
CREATE INDEX resolution_callbacks_origin ON resolution_callbacks(origin);
CREATE TABLE resolution_heritage (
    target TEXT NOT NULL,
    target_def INTEGER NOT NULL,
    origin TEXT NOT NULL,
    origin_def INTEGER NOT NULL,
    PRIMARY KEY (target, target_def, origin, origin_def)
) STRICT, WITHOUT ROWID;
CREATE INDEX resolution_heritage_origin ON resolution_heritage(origin);
CREATE TABLE resolution_types (
    name TEXT NOT NULL,
    origin TEXT NOT NULL,
    declaration INTEGER NOT NULL,
    PRIMARY KEY (name, origin, declaration)
) STRICT, WITHOUT ROWID;
CREATE INDEX resolution_types_origin ON resolution_types(origin);";

impl Writer {
    /// A null projection masks the base inputs of a deleted file.
    pub fn put_projection(&self, origin: &str, blob: Option<&[u8]>) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO main.resolution_inputs VALUES (?1, ?2)")?
            .execute(params![origin, blob])?;
        Ok(())
    }

    pub fn put_read(&self, origin: &str, kind: &str, key: &str) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO main.resolution_reads VALUES (?1, ?2, ?3)")?
            .execute(params![kind, key, origin])?;
        Ok(())
    }

    pub fn put_callback(&self, owner: &str, origin: &str, blob: &[u8]) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO main.resolution_callbacks VALUES (?1, ?2, ?3)")?
            .execute(params![owner, origin, blob])?;
        Ok(())
    }

    pub fn put_heritage(
        &self,
        target: &str,
        def: usize,
        origin: &str,
        from: usize,
    ) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached(
                "INSERT OR IGNORE INTO main.resolution_heritage VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![target, def as i64, origin, from as i64])?;
        Ok(())
    }

    pub fn put_type(&self, name: &str, origin: &str, def: usize) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO main.resolution_types VALUES (?1, ?2, ?3)")?
            .execute(params![name, origin, def as i64])?;
        Ok(())
    }

    pub fn prior_projection(&self, path: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        let sql = if self.previous_overlay {
            "SELECT projection FROM previous.resolution_inputs WHERE path = ?1
             UNION ALL SELECT projection FROM base.resolution_inputs WHERE path = ?1
             AND NOT EXISTS (SELECT 1 FROM previous.resolution_inputs WHERE path = ?1)"
        } else {
            "SELECT projection FROM base.resolution_inputs WHERE path = ?1"
        };
        Ok(self
            .conn
            .prepare_cached(sql)?
            .query_row([path], |row| row.get(0))
            .optional()?
            .flatten())
    }

    // All queries against retained inputs use their origin, regardless of
    // which file owns a derived public row.
    fn prior_sql(&self, table: &str, columns: &str, filter: &str) -> String {
        let mut sql = format!("SELECT {columns} FROM base.{table} r WHERE {filter}");
        if self.previous_overlay {
            sql.push_str(&format!(" AND NOT EXISTS (SELECT 1 FROM previous.resolution_inputs i WHERE i.path = r.origin)
                UNION ALL SELECT {columns} FROM previous.{table} r WHERE {filter}"));
        }
        sql
    }

    pub fn readers(&self, kind: &str, key: &str) -> rusqlite::Result<Vec<String>> {
        self.conn
            .prepare_cached(&self.prior_sql(
                "resolution_reads",
                "origin",
                "kind = ?1 AND key = ?2",
            ))?
            .query_map(params![kind, key], |row| row.get(0))?
            .collect()
    }

    pub fn read_keys(&self, kind: &str) -> rusqlite::Result<Vec<String>> {
        self.conn
            .prepare_cached(&format!(
                "SELECT DISTINCT key FROM ({})",
                self.prior_sql("resolution_reads", "key", "kind = ?1")
            ))?
            .query_map([kind], |row| row.get(0))?
            .collect()
    }

    pub fn prior_callback_owners(&self, path: &str) -> rusqlite::Result<Vec<String>> {
        self.conn
            .prepare_cached(&self.prior_sql("resolution_callbacks", "owner", "origin = ?1"))?
            .query_map([path], |row| row.get(0))?
            .collect()
    }

    pub fn callbacks_for(&self, owner: &str) -> rusqlite::Result<Vec<(String, Vec<u8>)>> {
        let sql = if self.overlay {
            format!(
                "SELECT origin, projection FROM main.resolution_callbacks WHERE owner = ?1
                UNION ALL SELECT origin, projection FROM ({}) p
                WHERE NOT EXISTS (SELECT 1 FROM main.resolution_inputs i WHERE i.path = p.origin)",
                self.prior_sql("resolution_callbacks", "origin, projection", "owner = ?1")
            )
        } else {
            "SELECT origin, projection FROM main.resolution_callbacks WHERE owner = ?1".into()
        };
        self.conn
            .prepare_cached(&sql)?
            .query_map([owner], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
    }

    pub fn prior_descendants(
        &self,
        target: &str,
        def: usize,
    ) -> rusqlite::Result<Vec<(String, usize)>> {
        self.conn
            .prepare_cached(&self.prior_sql(
                "resolution_heritage",
                "origin, origin_def",
                "target = ?1 AND target_def = ?2",
            ))?
            .query_map(params![target, def as i64], |row| {
                Ok((row.get(0)?, row.get::<_, u32>(1)? as usize))
            })?
            .collect()
    }

    pub fn prior_types(&self, name: &str) -> rusqlite::Result<Vec<(String, usize)>> {
        self.conn
            .prepare_cached(&self.prior_sql(
                "resolution_types",
                "origin, declaration",
                "name = ?1",
            ))?
            .query_map([name], |row| {
                Ok((row.get(0)?, row.get::<_, u32>(1)? as usize))
            })?
            .collect()
    }

    /// Carry the private inputs of unchanged origins. SQL copies them as
    /// opaque records, without decompressing relationship or extraction facts.
    pub fn carry_resolution_inputs(&self) -> rusqlite::Result<()> {
        if self.previous_overlay {
            for table in [
                "resolution_reads",
                "resolution_callbacks",
                "resolution_heritage",
                "resolution_types",
            ] {
                self.conn.execute_batch(&format!(
                    "INSERT INTO main.{table} SELECT r.* FROM previous.{table} r
                     WHERE NOT EXISTS (SELECT 1 FROM main.resolution_inputs i WHERE i.path = r.origin)"
                ))?;
            }
            self.conn.execute_batch(
                "INSERT INTO main.resolution_inputs
                 SELECT p.* FROM previous.resolution_inputs p
                 WHERE NOT EXISTS (SELECT 1 FROM main.resolution_inputs i WHERE i.path = p.path)",
            )?;
        }
        Ok(())
    }

    /// A position-only change preserves the read set, raw heritage and
    /// declaration ordinals. Callbacks are copied separately with new sites.
    pub fn carry_origin_index(&self, path: &str) -> rusqlite::Result<()> {
        for table in [
            "resolution_reads",
            "resolution_heritage",
            "resolution_types",
        ] {
            let sql = self.prior_sql(table, "r.*", "origin = ?1");
            self.conn
                .prepare_cached(&format!("INSERT INTO main.{table} {sql}"))?
                .execute([path])?;
        }
        Ok(())
    }

    /// Copy indexed source and declarations for files that changed only due
    /// to an incoming callback or a fingerprint neighbour. Never open source.
    pub fn copy_declarations(&self, key: i64, previous: bool) -> rusqlite::Result<()> {
        let from = if previous { "previous" } else { "base" };
        for (table, owner) in [
            ("files", "id"),
            ("file_diagnostics", "file"),
            ("nodes", "file"),
            ("source_chunks", "file"),
        ] {
            self.conn
                .prepare_cached(&format!(
                    "INSERT INTO main.{table} SELECT * FROM {from}.{table} WHERE {owner} = ?1"
                ))?
                .execute([key])?;
        }
        for (table, owner) in [("node_attributes", "node"), ("fingerprints", "node")] {
            self.conn.prepare_cached(&format!("INSERT INTO main.{table}
                SELECT p.* FROM {from}.nodes n CROSS JOIN {from}.{table} p ON p.{owner} = n.id WHERE n.file = ?1"))?
                .execute([key])?;
        }
        for (table, fts, columns) in [
            (
                "nodes",
                "nodes_fts",
                "id, name, qualified_name, docstring, signature",
            ),
            (
                "source_chunks",
                "source_chunks_fts",
                "path_terms, identifier_terms, comment_terms, source_text",
            ),
        ] {
            self.conn
                .prepare_cached(&format!(
                    "INSERT INTO main.{fts}(rowid, {columns})
                SELECT rowid, {columns} FROM {from}.{fts}
                WHERE rowid IN (SELECT id FROM {from}.{table} WHERE file = ?1)"
                ))?
                .execute([key])?;
        }
        self.conn.prepare_cached(&format!("INSERT INTO main.coverage
            SELECT c.* FROM {from}.files f CROSS JOIN {from}.coverage c ON c.path = f.path WHERE f.id = ?1"))?
            .execute([key])?;
        Ok(())
    }
}

impl Writer {
    pub fn projection(&self, path: &str) -> rusqlite::Result<Option<Vec<u8>>> {
        Ok(self
            .conn
            .prepare_cached("SELECT projection FROM main.resolution_inputs WHERE path = ?1")?
            .query_row([path], |row| row.get(0))
            .optional()?
            .flatten())
    }

    pub fn previous_node_upper_bound(&self) -> rusqlite::Result<i64> {
        if self.previous_overlay {
            self.conn.query_row(
                "SELECT max(coalesce(max(id), 0), ?1) FROM previous.nodes",
                [super::OVERLAY_KEY_START],
                |row| row.get(0),
            )
        } else {
            Ok(super::OVERLAY_KEY_START)
        }
    }
}

impl Writer {
    pub fn prior_types_in(&self, path: &str) -> rusqlite::Result<Vec<String>> {
        self.conn
            .prepare_cached(&self.prior_sql("resolution_types", "name", "origin = ?1"))?
            .query_map([path], |row| row.get(0))?
            .collect()
    }
}
