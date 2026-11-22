//! A disposable, shared cache of file-local facts. Resolution never writes here.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use mex_graph_core::facts::{FACTS_VERSION, FileFacts};
use mex_graph_core::timing::Timer;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use sha2::{Digest, Sha256};

const MAX_BYTES: usize = 192 * 1024 * 1024;
const MAX_ENTRY: usize = 4 * 1024 * 1024;
const MAX_DECODED: usize = 32 * 1024 * 1024;
const BATCH_BYTES: usize = 1024 * 1024;
// Bump the filename when changing the encoding or the SQLite layout.
const CACHE_FILE: &str = "facts-v1.db";

pub struct FactsCache(PathBuf);

impl FactsCache {
    pub fn open(directory: &Path) -> Option<Self> {
        if !directory.is_absolute() {
            return None;
        }
        fs::create_dir_all(directory).ok()?;
        if !fs::symlink_metadata(directory).ok()?.is_dir() {
            return None;
        }
        let cache = Self(directory.canonicalize().ok()?.join(CACHE_FILE));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&cache.0) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        if !fs::symlink_metadata(&cache.0).ok()?.is_file() {
            return None;
        }
        let conn = cache.connect().ok()?;
        conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS facts (
                 id INTEGER PRIMARY KEY,
                 path TEXT NOT NULL,
                 version TEXT NOT NULL,
                 hash BLOB NOT NULL,
                 checksum BLOB NOT NULL,
                 payload BLOB NOT NULL,
                 UNIQUE(path, version, hash)
             ) STRICT;
             CREATE TABLE IF NOT EXISTS budget (bytes INTEGER NOT NULL) STRICT;
             INSERT INTO budget SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM budget);
             COMMIT;",
        )
        .ok()?;
        Some(cache)
    }

    fn connect(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open_with_flags(
            &self.0,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.busy_timeout(Duration::from_millis(200))?;
        conn.execute_batch(
            "PRAGMA cache_size = -1024;
             PRAGMA synchronous = NORMAL;
             PRAGMA max_page_count = 65536;",
        )?;
        Ok(conn)
    }

    pub fn worker(&self) -> Option<CacheWorker> {
        Some(CacheWorker {
            conn: self.connect().ok()?,
            pending: Vec::new(),
            bytes: 0,
        })
    }
}

struct Entry {
    path: String,
    version: String,
    hash: [u8; 32],
    checksum: [u8; 32],
    payload: Vec<u8>,
}

pub struct CacheWorker {
    conn: Connection,
    pending: Vec<Entry>,
    bytes: usize,
}

impl CacheWorker {
    pub fn get(
        &self,
        path: &str,
        language: &str,
        version: &str,
        hash: &[u8; 32],
    ) -> Option<FileFacts> {
        let _timer = Timer::start("worker.cacheRead");
        let (checksum, payload): (Vec<u8>, Vec<u8>) = self
            .conn
            .prepare_cached(
                "SELECT checksum, payload FROM facts WHERE path = ?1 AND version = ?2 AND hash = ?3
                 AND length(checksum) = 32 AND length(payload) BETWEEN 5 AND ?4",
            )
            .ok()?
            .query_row(
                params![path, version, hash.as_slice(), MAX_ENTRY as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .ok()??;
        if Self::checksum(version, &payload).as_slice() != checksum {
            return None;
        }
        let decoded_size = u32::from_le_bytes(payload[..4].try_into().ok()?) as usize;
        if decoded_size > MAX_DECODED {
            return None;
        }
        let decoded = lz4_flex::block::decompress(&payload[4..], decoded_size).ok()?;
        let facts: FileFacts = serde_json::from_slice(&decoded).ok()?;
        (facts.facts_version == FACTS_VERSION
            && facts.content_hash == *hash
            && facts.path == path
            && facts.language == language)
            .then_some(facts)
    }

    pub fn put(&mut self, version: &str, facts: &FileFacts) {
        let timer = Timer::start("worker.cacheEncode");
        let Ok(encoded) = serde_json::to_vec(facts) else {
            return;
        };
        if encoded.len() > MAX_DECODED {
            return;
        }
        let payload = lz4_flex::block::compress_prepend_size(&encoded);
        if payload.len() > MAX_ENTRY {
            return;
        }
        self.bytes += payload.len();
        self.pending.push(Entry {
            path: facts.path.clone(),
            version: version.to_owned(),
            hash: facts.content_hash,
            checksum: Self::checksum(version, &payload),
            payload,
        });
        drop(timer);
        if self.bytes >= BATCH_BYTES {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        if !self.pending.is_empty() {
            let _timer = Timer::start("worker.cacheWrite");
            // An unavailable cache is a miss. A failed transaction leaves all
            // previously committed entries available to other processes.
            let _ = Self::write_batch(&mut self.conn, &self.pending, self.bytes);
            self.pending.clear();
            self.bytes = 0;
        }
    }

    fn checksum(version: &str, payload: &[u8]) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(version.as_bytes());
        hash.update([0]);
        hash.update(payload);
        hash.finalize().into()
    }

    fn write_batch(conn: &mut Connection, entries: &[Entry], bytes: usize) -> rusqlite::Result<()> {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut used: usize = tx.query_row("SELECT bytes FROM budget", [], |row| {
            Ok(row.get::<_, u32>(0)? as usize)
        })?;
        while used.saturating_add(bytes) > MAX_BYTES {
            let boundary = "SELECT id FROM facts ORDER BY id LIMIT 512";
            let evicted: usize = tx.query_row(
                &format!(
                    "SELECT coalesce(sum(length(payload)), 0) FROM facts WHERE id IN ({boundary})"
                ),
                [],
                |row| Ok(row.get::<_, u32>(0)? as usize),
            )?;
            if evicted == 0 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(&format!("DELETE FROM facts WHERE id IN ({boundary})"), [])?;
            used = used.saturating_sub(evicted);
        }
        {
            let mut existing = tx.prepare_cached(
                "SELECT length(payload) FROM facts WHERE path = ?1 AND version = ?2 AND hash = ?3",
            )?;
            let mut insert = tx.prepare_cached(
                "INSERT OR REPLACE INTO facts(path, version, hash, checksum, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for entry in entries {
                let old: usize = existing
                    .query_row(
                        params![entry.path, entry.version, entry.hash.as_slice()],
                        |row| Ok(row.get::<_, u32>(0)? as usize),
                    )
                    .optional()?
                    .unwrap_or(0);
                insert.execute(params![
                    entry.path,
                    entry.version,
                    entry.hash.as_slice(),
                    entry.checksum.as_slice(),
                    entry.payload
                ])?;
                used = used.saturating_sub(old) + entry.payload.len();
            }
        }
        tx.execute("UPDATE budget SET bytes = ?1", [used as i64])?;
        tx.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_checks_adapter_version_hash_path_and_payload() {
        let directory =
            std::env::temp_dir().join(format!("mex-facts-cache-{}", std::process::id()));
        let cache = FactsCache::open(&directory).unwrap();
        let mut writer = cache.worker().unwrap();
        let facts = FileFacts {
            facts_version: FACTS_VERSION,
            path: "src/app.py".into(),
            language: "python".into(),
            content_hash: [9; 32],
            ..FileFacts::default()
        };
        writer.put("python-1", &facts);
        writer.flush();
        let reader = FactsCache::open(&directory).unwrap().worker().unwrap();
        let get = |version, hash| reader.get(&facts.path, &facts.language, version, hash);
        assert_eq!(get("python-1", &[9; 32]), Some(facts.clone()));
        assert_eq!(get("python-2", &[9; 32]), None);
        assert_eq!(get("python-1", &[8; 32]), None);
        assert_eq!(reader.get("moved.py", "python", "python-1", &[9; 32]), None);
        writer
            .conn
            .execute("UPDATE facts SET payload = zeroblob(length(payload))", [])
            .unwrap();
        assert_eq!(get("python-1", &[9; 32]), None);
        writer.put("python-1", &facts);
        writer.flush();
        assert_eq!(get("python-1", &[9; 32]), Some(facts));
        drop(reader);
        drop(writer);
        fs::remove_dir_all(directory).unwrap();
    }
}
