//! Private resolver state. Its ownership is by written site, including
//! callbacks whose publicly visible edge has a different source file.

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};

use super::{Error, OVERLAY_KEY_START, Writer};
use crate::resolve::LookupKind;

pub(super) const SCHEMA: &str = "
CREATE TABLE resolution_inputs (
    origin INTEGER PRIMARY KEY,
    projection BLOB,
    frame_start INTEGER,
    frame_size INTEGER,
    entry_start INTEGER,
    entry_size INTEGER
) STRICT;
CREATE TABLE resolution_blocks (
    id INTEGER PRIMARY KEY,
    data BLOB NOT NULL
) STRICT;
CREATE TABLE resolution_reads (
    origin INTEGER PRIMARY KEY,
    reads BLOB NOT NULL
) STRICT;

CREATE TABLE resolution_names (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE resolution_keys (
    kind INTEGER NOT NULL,
    file INTEGER NOT NULL,
    name INTEGER NOT NULL,
    id INTEGER NOT NULL,
    PRIMARY KEY (kind, file, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE resolution_callbacks (
    owner INTEGER NOT NULL,
    origin INTEGER NOT NULL,
    projection BLOB NOT NULL,
    PRIMARY KEY (owner, origin)
) STRICT;
CREATE TABLE resolution_heritage (
    target INTEGER NOT NULL,
    target_def INTEGER NOT NULL,
    origin INTEGER NOT NULL,
    origin_def INTEGER NOT NULL,
    PRIMARY KEY (target, target_def, origin, origin_def)
) STRICT, WITHOUT ROWID;
CREATE TABLE resolution_types (
    name INTEGER NOT NULL,
    origin INTEGER NOT NULL,
    declaration INTEGER NOT NULL,
    PRIMARY KEY (name, origin, declaration)
) STRICT, WITHOUT ROWID;

-- Framework activation is checked even on edits that never traverse reads.
CREATE TABLE resolution_frameworks (
    origin INTEGER NOT NULL,
    name INTEGER NOT NULL,
    PRIMARY KEY (origin, name)
) STRICT, WITHOUT ROWID;
";

pub(super) const INDEXES: &str = "
CREATE INDEX resolution_callbacks_origin ON resolution_callbacks(origin);
CREATE INDEX resolution_heritage_origin ON resolution_heritage(origin);
CREATE INDEX resolution_types_origin ON resolution_types(origin);
";

// Base paths use files.id. An overlay retains its extra IDs, including
// deleted origins that still own tombstones or lookup keys.
pub(super) const OVERLAY_SCHEMA: &str = "
CREATE TABLE resolution_paths (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE
) STRICT;
";

/// The high tag marks a function spelling. For other reads, the low bit
/// distinguishes a lookup from a file. The payload is the immutable row ID.
#[derive(Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReadId(u64);

impl ReadId {
    const FUNCTION_NAME: u64 = 1 << 62;

    pub fn file(file: i64) -> Self {
        Self((file as u64) << 1)
    }

    fn lookup(key: i64) -> Self {
        Self((key as u64) << 1 | 1)
    }

    fn function_name(name: i64) -> Self {
        Self(Self::FUNCTION_NAME | name as u64)
    }
}

#[derive(Default)]
pub(super) struct Dependencies {
    names: RefCell<HashMap<String, i64>>,
    lookups: RefCell<HashMap<(LookupKind, i64, i64), ReadId>>,
    readers: OnceCell<HashMap<ReadId, Vec<i64>>>,
    surface_reads: RefCell<Option<HashSet<ReadId>>>,
    last_lookup: Cell<i64>,
}

impl Writer {
    pub(super) fn carry_dependency_dictionaries(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "INSERT INTO main.resolution_paths SELECT * FROM previous.resolution_paths;
             INSERT INTO main.resolution_names SELECT * FROM previous.resolution_names;
             INSERT INTO main.resolution_keys SELECT * FROM previous.resolution_keys;",
        )?;
        self.dependencies.last_lookup.set(self.conn.query_row(
            "SELECT coalesce(max(id), 0) FROM main.resolution_keys",
            [],
            |row| row.get(0),
        )?);
        Ok(())
    }

    pub fn allocate_path(&self, path: &str) -> rusqlite::Result<i64> {
        if let Some(id) = self.path_key(path)? {
            return Ok(id);
        }
        self.conn
            .prepare_cached(
                "INSERT INTO main.resolution_paths
                 SELECT max(coalesce(max(id), 0), ?2) + 1, ?1 FROM main.resolution_paths
                 RETURNING id",
            )?
            .query_row(params![path, OVERLAY_KEY_START], |row| row.get(0))
    }

    fn path_key(&self, path: &str) -> rusqlite::Result<Option<i64>> {
        let sql = if self.overlay {
            "SELECT id FROM base.files WHERE path = ?1
             UNION ALL SELECT id FROM main.resolution_paths WHERE path = ?1"
        } else {
            "SELECT id FROM main.files WHERE path = ?1"
        };
        self.conn
            .prepare_cached(sql)?
            .query_row([path], |row| row.get(0))
            .optional()
    }

    pub fn file_path(&self, file: i64) -> rusqlite::Result<String> {
        let sql = if !self.overlay {
            "SELECT path FROM main.files WHERE id = ?1"
        } else if file < OVERLAY_KEY_START {
            "SELECT path FROM base.files WHERE id = ?1"
        } else {
            "SELECT path FROM main.resolution_paths WHERE id = ?1"
        };
        self.conn
            .prepare_cached(sql)?
            .query_row([file], |row| row.get(0))
    }

    fn name_key(&self, name: &str) -> rusqlite::Result<Option<i64>> {
        if let Some(&id) = self.dependencies.names.borrow().get(name) {
            return Ok(Some(id));
        }
        let sql = if self.overlay {
            "SELECT id FROM main.resolution_names WHERE name = ?1
             UNION ALL SELECT id FROM base.resolution_names WHERE name = ?1"
        } else {
            "SELECT id FROM main.resolution_names WHERE name = ?1"
        };
        self.conn
            .prepare_cached(sql)?
            .query_row([name], |row| row.get(0))
            .optional()
    }

    fn intern_name(&self, name: &str) -> rusqlite::Result<i64> {
        if let Some(&id) = self.dependencies.names.borrow().get(name) {
            return Ok(id);
        }
        let id = if self.overlay {
            match self.name_key(name)? {
                Some(id) => id,
                None => self
                    .conn
                    .prepare_cached(
                        "INSERT INTO main.resolution_names
                     SELECT max(coalesce(max(id), 0), ?2) + 1, ?1 FROM main.resolution_names
                     RETURNING id",
                    )?
                    .query_row(params![name, OVERLAY_KEY_START], |row| row.get(0))?,
            }
        } else {
            self.conn
                .prepare_cached("INSERT INTO main.resolution_names (name) VALUES (?1)")?
                .insert([name])?
        };
        self.dependencies
            .names
            .borrow_mut()
            .insert(name.to_owned(), id);
        Ok(id)
    }

    fn dependency_name(&self, id: i64) -> rusqlite::Result<String> {
        let sql = if self.overlay && id < OVERLAY_KEY_START {
            "SELECT name FROM base.resolution_names WHERE id = ?1"
        } else {
            "SELECT name FROM main.resolution_names WHERE id = ?1"
        };
        self.conn
            .prepare_cached(sql)?
            .query_row([id], |row| row.get(0))
    }

    fn lookup_key(
        &self,
        kind: LookupKind,
        file: i64,
        name: i64,
    ) -> rusqlite::Result<Option<ReadId>> {
        if let Some(&id) = self.dependencies.lookups.borrow().get(&(kind, file, name)) {
            return Ok(Some(id));
        }
        let sql = if self.overlay {
            "SELECT id FROM main.resolution_keys WHERE kind = ?1 AND file = ?2 AND name = ?3
             UNION ALL SELECT id FROM base.resolution_keys WHERE kind = ?1 AND file = ?2 AND name = ?3"
        } else {
            "SELECT id FROM main.resolution_keys WHERE kind = ?1 AND file = ?2 AND name = ?3"
        };
        self.conn
            .prepare_cached(sql)?
            .query_row(params![kind as u8, file, name], |row| row.get(0))
            .optional()
            .map(|id| id.map(ReadId::lookup))
    }

    /// Module lookups carry their importing file ID and the specifier name
    /// separately. A path probe uses the file ID if known, and a name otherwise.
    pub fn intern_lookup(
        &self,
        kind: LookupKind,
        file: i64,
        name: &str,
    ) -> rusqlite::Result<ReadId> {
        let (file, name) = if kind == LookupKind::Path
            && let Some(file) = self.path_key(name)?
        {
            (file, 0)
        } else {
            (file, self.intern_name(name)?)
        };
        if let Some(&id) = self.dependencies.lookups.borrow().get(&(kind, file, name)) {
            return Ok(id);
        }
        let existing = if self.overlay {
            self.lookup_key(kind, file, name)?
        } else {
            None
        };
        let id = if let Some(id) = existing {
            id
        } else {
            let lower = if self.overlay { OVERLAY_KEY_START } else { 0 };
            let id = self.dependencies.last_lookup.get().max(lower) + 1;
            self.conn
                .prepare_cached("INSERT INTO main.resolution_keys VALUES (?1, ?2, ?3, ?4)")?
                .execute(params![kind as u8, file, name, id])?;
            self.dependencies.last_lookup.set(id);
            ReadId::lookup(id)
        };
        self.dependencies
            .lookups
            .borrow_mut()
            .insert((kind, file, name), id);
        Ok(id)
    }

    pub fn put_reads(&self, origin: i64, reads: &mut Vec<ReadId>) -> rusqlite::Result<()> {
        if reads.is_empty() {
            return Ok(());
        }
        reads.sort_unstable();
        reads.dedup();
        let mut blob = Vec::with_capacity(reads.len());
        let mut previous = 0;
        for &ReadId(id) in reads.iter() {
            let mut delta = id - previous;
            previous = id;
            while delta >= 128 {
                blob.push(delta as u8 | 128);
                delta >>= 7;
            }
            blob.push(delta as u8);
        }
        self.conn
            .prepare_cached("INSERT INTO main.resolution_reads VALUES (?1, ?2)")?
            .execute(params![origin, blob])?;
        Ok(())
    }

    pub fn put_callback(&self, owner: i64, origin: i64, blob: &[u8]) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO main.resolution_callbacks VALUES (?1, ?2, ?3)")?
            .execute(params![owner, origin, blob])?;
        Ok(())
    }

    pub fn put_heritage(
        &self,
        target: i64,
        def: usize,
        origin: i64,
        from: usize,
    ) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached(
                "INSERT OR IGNORE INTO main.resolution_heritage VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![target, def as i64, origin, from as i64])?;
        Ok(())
    }

    pub fn put_type(&self, name: &str, origin: i64, def: usize) -> rusqlite::Result<()> {
        let name = self.intern_name(name)?;
        self.conn
            .prepare_cached("INSERT INTO main.resolution_types VALUES (?1, ?2, ?3)")?
            .execute(params![name, origin, def as i64])?;
        Ok(())
    }

    pub fn put_framework(&self, origin: i64, name: &str) -> rusqlite::Result<()> {
        let name = self.intern_name(name)?;
        self.conn
            .prepare_cached("INSERT OR IGNORE INTO main.resolution_frameworks VALUES (?1, ?2)")?
            .execute(params![origin, name])?;
        Ok(())
    }

    pub fn prior_frameworks(&self) -> rusqlite::Result<Vec<(String, String)>> {
        self.conn
            .prepare_cached(&self.prior_sql("resolution_frameworks", "origin, name", "1"))?
            .query_map([], |row| {
                Ok((
                    self.file_path(row.get(0)?)?,
                    self.dependency_name(row.get(1)?)?,
                ))
            })?
            .collect()
    }

    // Retained inputs are masked by their origin even when a different file
    // owns the derived public row or there is no public shadow for the edit.
    pub(super) fn prior_sql(&self, table: &str, columns: &str, filter: &str) -> String {
        let mut sql = format!("SELECT {columns} FROM base.{table} r WHERE {filter}");
        if self.previous_overlay {
            sql.push_str(&format!(" AND NOT EXISTS (SELECT 1 FROM previous.resolution_inputs i WHERE i.origin = r.origin)
                UNION ALL SELECT {columns} FROM previous.{table} r WHERE {filter}"));
        }
        sql
    }

    /// Surface-only edits keep only lookup keys that could change in this edit.
    pub fn restrict_read_index_to_surfaces(&self, named: HashSet<ReadId>) {
        debug_assert!(self.dependencies.readers.get().is_none());
        self.dependencies.surface_reads.replace(Some(named));
    }

    fn surface_keys(&self) -> rusqlite::Result<Option<HashSet<ReadId>>> {
        let Some(mut keys) = self.dependencies.surface_reads.take() else {
            return Ok(None);
        };
        let mut stmt = self.conn.prepare_cached(
            "SELECT id FROM base.resolution_keys WHERE kind IN (?1, ?2, ?3)
             UNION ALL SELECT id FROM main.resolution_keys WHERE kind IN (?1, ?2, ?3)",
        )?;
        let mut rows = stmt.query(params![
            LookupKind::CSharpType as u8,
            LookupKind::TsHeritage as u8,
            LookupKind::TsDispatch as u8
        ])?;
        while let Some(row) = rows.next()? {
            keys.insert(ReadId::lookup(row.get(0)?));
        }
        Ok(Some(keys))
    }

    fn read_index(&self) -> rusqlite::Result<&HashMap<ReadId, Vec<i64>>> {
        if let Some(index) = self.dependencies.readers.get() {
            return Ok(index);
        }
        let _timer = crate::timing::Timer::start("incremental.reverseReads");
        let surface_keys = self.surface_keys()?;
        let mut index: HashMap<_, Vec<_>> = HashMap::new();
        let sql = self.prior_sql("resolution_reads", "origin, reads", "1");
        let mut statement = self.conn.prepare_cached(&sql)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let origin = row.get(0)?;
            let mut bytes = row.get_ref(1)?.as_blob()?;
            let mut id = 0;
            while !bytes.is_empty() {
                id = next_read(&mut bytes, id)?;
                let key = ReadId(id);
                let relevant = if id & ReadId::FUNCTION_NAME != 0 {
                    surface_keys
                        .as_ref()
                        .is_some_and(|keys| keys.contains(&key))
                } else {
                    id & 1 == 0 || surface_keys.as_ref().is_none_or(|keys| keys.contains(&key))
                };
                if relevant {
                    index.entry(key).or_default().push(origin);
                }
            }
        }
        Ok(self.dependencies.readers.get_or_init(|| index))
    }

    pub fn readers_of(&self, id: ReadId) -> rusqlite::Result<&[i64]> {
        Ok(self.read_index()?.get(&id).map_or(&[], Vec::as_slice))
    }

    pub fn intern_function_name(&self, name: &str) -> rusqlite::Result<ReadId> {
        self.intern_name(name).map(ReadId::function_name)
    }

    pub fn function_read(&self, name: &str) -> rusqlite::Result<Option<ReadId>> {
        Ok(self.name_key(name)?.map(ReadId::function_name))
    }

    pub fn lookup_readers(&self, kind: LookupKind, name: &str) -> rusqlite::Result<Vec<i64>> {
        let mut readers = Vec::new();
        if kind == LookupKind::Path
            && let Some(file) = self.path_key(name)?
            && let Some(id) = self.lookup_key(kind, file, 0)?
        {
            readers.extend(self.readers_of(id)?);
        }
        // Retained readers can still name a path that was absent when probed.
        if let Some(name) = self.name_key(name)?
            && let Some(id) = self.lookup_key(kind, 0, name)?
        {
            readers.extend(self.readers_of(id)?);
        }
        Ok(readers)
    }

    pub fn module_reads(
        &self,
        kind: LookupKind,
    ) -> rusqlite::Result<Vec<(ReadId, String, String)>> {
        let index = self.read_index()?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT k.id, coalesce(f.path, p.path), coalesce(b.name, n.name)
             FROM (SELECT id, file, name FROM base.resolution_keys WHERE kind = ?1
                   UNION ALL SELECT id, file, name FROM main.resolution_keys WHERE kind = ?1) k
             LEFT JOIN base.files f ON f.id = k.file
             LEFT JOIN main.resolution_paths p ON p.id = k.file
             LEFT JOIN base.resolution_names b ON b.id = k.name
             LEFT JOIN main.resolution_names n ON n.id = k.name",
        )?;
        let mut rows = stmt.query([kind as u8])?;
        let mut keys = Vec::new();
        while let Some(row) = rows.next()? {
            let id = ReadId::lookup(row.get(0)?);
            if index.contains_key(&id) {
                keys.push((id, row.get(1)?, row.get(2)?));
            }
        }
        Ok(keys)
    }

    pub fn prior_callback_owners(&self, origin: i64) -> rusqlite::Result<Vec<i64>> {
        self.conn
            .prepare_cached(&self.prior_sql("resolution_callbacks", "owner", "origin = ?1"))?
            .query_map([origin], |row| row.get(0))?
            .collect()
    }

    pub fn callback_owners(&self, origin: i64) -> rusqlite::Result<Vec<i64>> {
        self.conn
            .prepare_cached("SELECT owner FROM main.resolution_callbacks WHERE origin = ?1")?
            .query_map([origin], |row| row.get(0))?
            .collect()
    }

    pub fn callbacks_for(&self, owner: i64) -> rusqlite::Result<Vec<(i64, Vec<u8>)>> {
        let sql = if self.overlay {
            format!(
                "SELECT origin, projection FROM main.resolution_callbacks WHERE owner = ?1
                UNION ALL SELECT origin, projection FROM ({}) p
                WHERE NOT EXISTS (SELECT 1 FROM main.resolution_inputs i WHERE i.origin = p.origin)",
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
        target: i64,
        def: usize,
    ) -> rusqlite::Result<Vec<(i64, usize)>> {
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

    pub fn prior_types(&self, name: &str) -> rusqlite::Result<Vec<(i64, usize)>> {
        let Some(name) = self.name_key(name)? else {
            return Ok(Vec::new());
        };
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

    pub fn prior_types_in(&self, origin: i64) -> rusqlite::Result<Vec<String>> {
        self.conn
            .prepare_cached(&self.prior_sql("resolution_types", "DISTINCT name", "origin = ?1"))?
            .query_map([origin], |row| self.dependency_name(row.get(0)?))?
            .collect()
    }

    /// Carry only unchanged origins. The projection row also acts as the
    /// shadow for the read, callback, heritage, and type tables.
    pub fn carry_resolution_inputs(&self) -> rusqlite::Result<()> {
        if self.previous_overlay {
            for table in [
                "resolution_reads",
                "resolution_callbacks",
                "resolution_heritage",
                "resolution_types",
                "resolution_frameworks",
                "resolution_inputs",
            ] {
                self.conn.execute_batch(&format!(
                    "INSERT INTO main.{table} SELECT r.* FROM previous.{table} r
                     WHERE NOT EXISTS (SELECT 1 FROM main.resolution_inputs i WHERE i.origin = r.origin)"
                ))?;
            }
        }
        Ok(())
    }

    /// A position-only change preserves the read set, raw heritage and
    /// declaration ordinals. Callbacks are copied separately with new sites.
    pub fn carry_origin_index(&self, origin: i64) -> rusqlite::Result<()> {
        for table in [
            "resolution_reads",
            "resolution_heritage",
            "resolution_types",
            "resolution_frameworks",
        ] {
            let sql = self.prior_sql(table, "r.*", "origin = ?1");
            self.conn
                .prepare_cached(&format!("INSERT INTO main.{table} {sql}"))?
                .execute([origin])?;
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
        // These are contentless indexes. SELECTing from an FTS table
        // cannot recover its indexed strings.
        self.conn
            .prepare_cached(&format!(
                "INSERT INTO main.nodes_fts(rowid, id, name, qualified_name, docstring, signature)
             SELECT n.id, coalesce(k.name, kb.name) || ':' || lower(hex(n.public_id)),
                    n.name, n.qualified_name, n.docstring, n.signature
             FROM {from}.nodes n
             LEFT JOIN {from}.node_kinds k ON k.id = n.kind
             LEFT JOIN base.node_kinds kb ON kb.id = n.kind
             WHERE n.file = ?1"
            ))?
            .execute([key])?;
        self.conn.prepare_cached(&format!("INSERT INTO main.coverage
            SELECT c.* FROM {from}.files f CROSS JOIN {from}.coverage c ON c.path = f.path WHERE f.id = ?1"))?
            .execute([key])?;
        Ok(())
    }
    /// Retained projections keep their integer endpoints. Never recycle an
    /// overlay key, including the former maximum after a deletion.
    pub fn previous_node_upper_bound(&self) -> rusqlite::Result<i64> {
        if !self.previous_overlay {
            return Ok(OVERLAY_KEY_START);
        }
        let value: String = self.conn.query_row(
            "SELECT value FROM previous.meta WHERE key = 'resolution_node_upper_bound'",
            [],
            |row| row.get(0),
        )?;
        value
            .parse::<i64>()
            .ok()
            .filter(|&key| key >= OVERLAY_KEY_START)
            .ok_or(Error::InvalidQuery)
    }

    pub fn set_node_upper_bound(&self, key: i64) -> rusqlite::Result<()> {
        self.set_meta("resolution_node_upper_bound", &key.to_string())
    }
}

fn next_read(bytes: &mut &[u8], previous: u64) -> rusqlite::Result<u64> {
    let mut delta = 0;
    for shift in (0..63).step_by(7) {
        let (&byte, rest) = bytes.split_first().ok_or(Error::InvalidQuery)?;
        *bytes = rest;
        delta |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return previous
                .checked_add(delta)
                .filter(|&id| delta != 0 && id <= i64::MAX as u64)
                .ok_or(Error::InvalidQuery);
        }
    }
    Err(Error::InvalidQuery)
}
