//! A disposable, shared cache of file-local facts. Resolution never writes here.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender};
use std::time::Duration;

use mex_graph_core::facts::{FACTS_VERSION, FileFacts};
use mex_graph_core::timing::Timer;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};
use sha2::{Digest, Sha256};

const MIN_CAPACITY: usize = 64 * 1024 * 1024;
const MAX_CAPACITY: usize = 256 * 1024 * 1024;
// Reserve room for a corpus and revisions of its busiest files.
const BYTES_PER_FILE: usize = 12 * 1024;
const BLOCK_BYTES: usize = 3 * 1024 * 1024;
const MAX_COMPRESSED: usize = 4 * 1024 * 1024;
const MAX_ENCODED: usize = 32 * 1024 * 1024;
const MAX_DECODED: usize = 64 * 1024 * 1024;
// 320 MiB of database pages leaves room for the path index and page overhead.
const MAX_PAGES: u32 = 81_920;
// Bump the filename when changing the codec or the SQLite layout. The facts
// version in the key also covers changes to the serialized Rust types.
const CACHE_FILE: &str = "facts-v2.db";
const WINDOW_LOG: u32 = 22;
const TABLE_LOG: u32 = 19;

/// Level 11 with smaller match-finder tables. Every extraction thread holds a
/// compressor, and level 11's default tables for a 3 MiB block cost about
/// 90 MiB of peak memory on Hono against 1% of the cache's size on novu.
fn compressor() -> Option<zstd::bulk::Compressor<'static>> {
    use zstd::zstd_safe::CParameter;
    let mut encoder = zstd::bulk::Compressor::new(11).ok()?;
    for parameter in [
        CParameter::WindowLog(WINDOW_LOG),
        CParameter::HashLog(TABLE_LOG),
        CParameter::ChainLog(TABLE_LOG),
    ] {
        encoder.set_parameter(parameter).ok()?;
    }
    Some(encoder)
}

fn codec() -> impl bincode::config::Config {
    bincode::config::standard().with_limit::<MAX_DECODED>()
}

struct PackedFacts {
    size: usize,
    packed: Box<[u8]>,
}

/// Pin the compressed disk-cache blocks once, and keep edited records in
/// private blocks. The resolver only materializes records while using them.
pub struct ResidentFacts {
    block: Arc<PackedFacts>,
    record: Option<DiskRecord>,
}

struct DiskRecord {
    span: Range<usize>,
    path: Box<str>,
    language: &'static str,
    version: Box<str>,
    hash: [u8; 32],
}

impl ResidentFacts {
    pub fn encoded_size(&self) -> usize {
        self.record
            .as_ref()
            .map_or(self.block.size, |record| record.span.len())
    }

    pub fn pack(facts: &FileFacts) -> Option<Self> {
        let bytes = bincode::encode_to_vec(facts, codec()).ok()?;
        Some(Self {
            block: Arc::new(PackedFacts {
                size: bytes.len(),
                packed: zstd::bulk::compress(&bytes, 1).ok()?.into_boxed_slice(),
            }),
            record: None,
        })
    }
}

/// Keep a bounded set of decompressed cache blocks. The facts and indexes
/// decoded from them are owned by the current edit and are never retained.
pub struct ResidentDecoder {
    blocks: VecDeque<(Arc<PackedFacts>, Vec<u8>)>,
    limit: usize,
    used: usize,
    decoder: zstd::bulk::Decompressor<'static>,
}

impl ResidentDecoder {
    pub fn new(limit: usize) -> Option<Self> {
        Some(Self {
            blocks: VecDeque::new(),
            limit,
            used: 0,
            decoder: zstd::bulk::Decompressor::new().ok()?,
        })
    }

    pub fn unpack(&mut self, resident: &ResidentFacts) -> Option<FileFacts> {
        let block = &resident.block;
        let found = self
            .blocks
            .iter()
            .position(|(prior, _)| Arc::ptr_eq(prior, block));
        if let Some(position) = found {
            let hit = self.blocks.remove(position)?;
            self.blocks.push_front(hit);
        } else {
            let mut bytes = Vec::new();
            bytes.try_reserve_exact(block.size).ok()?;
            if self
                .decoder
                .decompress_to_buffer(&block.packed, &mut bytes)
                .ok()?
                != block.size
            {
                return None;
            }
            if block.size > self.limit {
                return unpack_record(resident, &bytes);
            }
            while self.used + block.size > self.limit {
                self.used -= self.blocks.pop_back()?.0.size;
            }
            self.used += block.size;
            self.blocks.push_front((Arc::clone(block), bytes));
        }
        unpack_record(resident, &self.blocks.front()?.1)
    }
}

fn unpack_record(resident: &ResidentFacts, bytes: &[u8]) -> Option<FileFacts> {
    if let Some(record) = &resident.record {
        decode_entry(
            bytes.get(record.span.clone())?,
            &record.path,
            record.language,
            &record.version,
            &record.hash,
        )
    } else {
        let (facts, len) = bincode::decode_from_slice(bytes, codec()).ok()?;
        (len == bytes.len()).then_some(facts)
    }
}

/// Retain the checked, decoded facts repeatedly used by the resident resolver.
/// A multiple of the serialized size accounts for sparse Rust fields and
/// allocation overhead. Resolver indexes and projections remain edit-local.
#[derive(Default)]
pub struct ResidentFileCache {
    files: HashMap<String, (Rc<FileFacts>, usize)>,
    order: VecDeque<String>,
    weight: usize,
}

impl ResidentFileCache {
    const BUDGET: usize = 64 * 1024 * 1024;
    const MAX_FILES: usize = 1_024;

    pub fn get(&self, path: &str) -> Option<Rc<FileFacts>> {
        self.files.get(path).map(|(facts, _)| Rc::clone(facts))
    }

    pub fn insert(&mut self, path: &str, facts: &Rc<FileFacts>, encoded_size: usize) {
        let weight = encoded_size.saturating_mul(6);
        if weight > Self::BUDGET {
            return;
        }
        while self.weight + weight > Self::BUDGET || self.files.len() >= Self::MAX_FILES {
            let Some(first) = self.order.pop_front() else {
                break;
            };
            if let Some((_, weight)) = self.files.remove(&first) {
                self.weight -= weight;
            }
        }
        self.order.push_back(path.into());
        self.files.insert(path.into(), (Rc::clone(facts), weight));
        self.weight += weight;
    }

    pub fn remove(&mut self, path: &str) {
        if let Some((_, weight)) = self.files.remove(path) {
            self.weight -= weight;
            self.order.retain(|entry| entry != path);
        }
    }
}

fn decode_entry(
    entry: &[u8],
    path: &str,
    language: &str,
    version: &str,
    hash: &[u8; 32],
) -> Option<FileFacts> {
    let ((stored_version, facts), bytes): ((&str, FileFacts), _) =
        bincode::borrow_decode_from_slice(entry, codec()).ok()?;
    (bytes == entry.len()
        && stored_version == version
        && facts.facts_version == FACTS_VERSION
        && facts.content_hash == *hash
        && facts.path == path
        && facts.language == language)
        .then_some(facts)
}

pub struct FactsCache(PathBuf);

impl FactsCache {
    pub fn open(directory: &Path, file_count: usize) -> Option<Self> {
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

        let mut conn = cache.connect().ok()?;
        conn.pragma_update(None, "page_size", 4096).ok()?;
        conn.pragma_update(None, "journal_mode", "WAL").ok()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .ok()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS blocks (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 checksum BLOB NOT NULL,
                 payload BLOB NOT NULL
             ) STRICT;
             CREATE TABLE IF NOT EXISTS facts (
                 path TEXT NOT NULL,
                 version TEXT NOT NULL,
                 hash BLOB NOT NULL,
                 block INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
                 offset INTEGER NOT NULL,
                 size INTEGER NOT NULL,
                 PRIMARY KEY(path, version, hash)
             ) STRICT, WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS facts_block ON facts(block);
             CREATE TABLE IF NOT EXISTS budget (
                 id INTEGER PRIMARY KEY CHECK(id = 1),
                 bytes INTEGER NOT NULL CHECK(bytes >= 0),
                 capacity INTEGER NOT NULL
             ) STRICT;",
        )
        .ok()?;
        let capacity = file_count
            .saturating_mul(BYTES_PER_FILE)
            .clamp(MIN_CAPACITY, MAX_CAPACITY);
        // Shared checkouts never shrink the budget estimated by a larger corpus.
        tx.execute(
            "INSERT INTO budget VALUES (1, 0, ?1)
             ON CONFLICT(id) DO UPDATE SET capacity = excluded.capacity WHERE excluded.capacity > budget.capacity",
            [capacity as i64],
        )
        .ok()?;
        tx.commit().ok()?;
        Some(cache)
    }

    fn connect(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open_with_flags(
            &self.0,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        conn.busy_timeout(Duration::from_millis(200))?;
        Ok(conn)
    }

    pub fn reader(&self) -> Option<CacheReader> {
        let conn = self.connect().ok()?;
        conn.pragma_update(None, "cache_size", -1024).ok()?;
        Some(CacheReader {
            conn,
            decoder: zstd::bulk::Decompressor::new().ok()?,
            decoded: Vec::new(),
            block: None,
            pinned: HashMap::new(),
        })
    }

    pub fn worker(&self, blocks: SyncSender<Block>) -> Option<CacheWorker> {
        Some(CacheWorker {
            reader: self.reader()?,
            encoder: compressor()?,
            encoded: Vec::new(),
            entries: Vec::new(),
            block: Vec::new(),
            blocks,
        })
    }

    pub fn write_blocks(&self, blocks: Receiver<Block>) {
        if let Ok(first) = blocks.recv() {
            // Contention, I/O failure and cancellation leave previously
            // committed facts usable. The graph can always parse a missed file.
            let _ = self.write_transaction(std::iter::once(first).chain(blocks));
        }
    }

    fn write_transaction(&self, blocks: impl Iterator<Item = Block>) -> rusqlite::Result<()> {
        let mut conn = self.connect()?;
        conn.execute_batch(
            "PRAGMA cache_size = -8192;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        conn.pragma_update(None, "max_page_count", MAX_PAGES)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (mut used, capacity) = tx.query_row(
            "SELECT bytes, capacity FROM budget WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, u32>(0)? as usize,
                    row.get::<_, u32>(1)? as usize,
                ))
            },
        )?;
        let capacity = capacity.clamp(MIN_CAPACITY, MAX_CAPACITY);
        for block in blocks {
            let _timer = Timer::start("worker.cacheWrite");
            used = write_block(&tx, &block, used, capacity)?;
        }
        let _timer = Timer::start("worker.cacheWrite");
        tx.execute("UPDATE budget SET bytes = ?1 WHERE id = 1", [used as i64])?;
        tx.commit()?;
        conn.close().map_err(|(_, error)| error)
    }
}

pub struct CacheReader {
    conn: Connection,
    decoder: zstd::bulk::Decompressor<'static>,
    decoded: Vec<u8>,
    block: Option<i64>,
    pinned: HashMap<i64, Arc<PackedFacts>>,
}

impl CacheReader {
    pub fn get(
        &mut self,
        path: &str,
        language: &str,
        version: &str,
        hash: &[u8; 32],
    ) -> Option<FileFacts> {
        let _timer = Timer::start("worker.cacheRead");
        let (block, span) = self.locate(path, version, hash)?;
        if self.block != Some(block) {
            self.load_block(block)?;
        }
        decode_entry(self.decoded.get(span)?, path, language, version, hash)
    }

    pub fn pin(
        &mut self,
        path: &str,
        language: &'static str,
        version: String,
        hash: [u8; 32],
    ) -> Option<ResidentFacts> {
        let (id, span) = self.locate(path, &version, &hash)?;
        let block = match self.pinned.get(&id) {
            Some(block) => Arc::clone(block),
            None => {
                let block = Arc::new(self.read_block(id)?);
                self.pinned.insert(id, Arc::clone(&block));
                block
            }
        };
        (span.end <= block.size).then_some(ResidentFacts {
            block,
            record: Some(DiskRecord {
                span,
                language,
                version: version.into_boxed_str(),
                hash,
                path: path.into(),
            }),
        })
    }

    fn locate(&self, path: &str, version: &str, hash: &[u8; 32]) -> Option<(i64, Range<usize>)> {
        let (block, offset, size): (i64, u32, u32) = self
            .conn
            .prepare_cached("SELECT block, offset, size FROM facts WHERE path = ?1 AND version = ?2 AND hash = ?3")
            .ok()?
            .query_row(params![path, version, hash.as_slice()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()
            .ok()??;
        Some((block, offset as usize..offset.checked_add(size)? as usize))
    }

    fn read_block(&self, block: i64) -> Option<PackedFacts> {
        let (checksum, payload): ([u8; 32], Vec<u8>) = self
            .conn
            .prepare_cached(
                "SELECT checksum, payload FROM blocks WHERE id = ?1
                 AND length(checksum) = 32 AND length(payload) BETWEEN 1 AND ?2",
            )
            .ok()?
            .query_row(params![block, MAX_COMPRESSED as i64], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .ok()?;
        if Sha256::digest(&payload).as_slice() != checksum {
            return None;
        }
        let size = zstd::zstd_safe::get_frame_content_size(&payload).ok()??;
        if size > MAX_ENCODED as u64 {
            return None;
        }
        Some(PackedFacts {
            size: size as usize,
            packed: payload.into_boxed_slice(),
        })
    }

    fn load_block(&mut self, block: i64) -> Option<()> {
        let packed = self.read_block(block)?;
        self.block = None;
        self.decoded.clear();
        self.decoded.try_reserve_exact(packed.size).ok()?;
        if self
            .decoder
            .decompress_to_buffer(&packed.packed, &mut self.decoded)
            .ok()?
            != packed.size
        {
            return None;
        }
        self.block = Some(block);
        Some(())
    }
}

struct Entry {
    path: String,
    version: String,
    hash: [u8; 32],
    offset: usize,
    size: usize,
}

pub struct Block {
    entries: Vec<Entry>,
    payload: Vec<u8>,
}

pub struct CacheWorker {
    pub reader: CacheReader,
    encoder: zstd::bulk::Compressor<'static>,
    encoded: Vec<u8>,
    entries: Vec<Entry>,
    block: Vec<u8>,
    blocks: SyncSender<Block>,
}

impl CacheWorker {
    pub fn put(&mut self, version: &str, facts: &FileFacts) {
        let timer = Timer::start("worker.cacheEncode");
        self.encoded.clear();
        if bincode::encode_into_std_write((version, facts), &mut self.encoded, codec()).is_err()
            || self.encoded.len() > MAX_ENCODED
        {
            return;
        }
        drop(timer);
        if self.block.len() + self.encoded.len() > BLOCK_BYTES {
            self.flush();
        }
        self.entries.push(Entry {
            path: facts.path.clone(),
            version: version.to_owned(),
            hash: facts.content_hash,
            offset: self.block.len(),
            size: self.encoded.len(),
        });
        self.block.extend_from_slice(&self.encoded);
        if self.block.len() >= BLOCK_BYTES {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        let timer = Timer::start("worker.cacheEncode");
        let mut payload = Vec::with_capacity(
            zstd::zstd_safe::compress_bound(self.block.len()).min(MAX_COMPRESSED),
        );
        let compressed = self.encoder.compress_to_buffer(&self.block, &mut payload);
        self.block.clear();
        let entries = std::mem::take(&mut self.entries);
        if compressed.is_ok() && payload.len() <= MAX_COMPRESSED {
            payload.shrink_to_fit();
            drop(timer);
            let _ = self.blocks.send(Block { entries, payload });
        }
    }
}

fn write_block(
    tx: &Transaction<'_>,
    block: &Block,
    mut used: usize,
    capacity: usize,
) -> rusqlite::Result<usize> {
    tx.prepare_cached("INSERT INTO blocks(checksum, payload) VALUES (?1, ?2)")?
        .execute(params![
            Sha256::digest(&block.payload).as_slice(),
            block.payload
        ])?;
    let id = tx.last_insert_rowid();
    let mut insert =
        tx.prepare_cached("INSERT OR REPLACE INTO facts VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
    for entry in &block.entries {
        insert.execute(params![
            entry.path,
            entry.version,
            entry.hash.as_slice(),
            id,
            entry.offset as u32,
            entry.size as u32,
        ])?;
    }
    used += block.payload.len();
    while used > capacity {
        let (oldest, bytes) = tx.query_row(
            "SELECT id, length(payload) FROM blocks ORDER BY id LIMIT 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, u32>(1)? as usize)),
        )?;
        tx.prepare_cached("DELETE FROM blocks WHERE id = ?1")?
            .execute([oldest])?;
        used = used.saturating_sub(bytes);
    }
    Ok(used)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mex_graph_core::facts::{Call, CallForm, NONE, Receiver};
    use std::sync::mpsc::sync_channel;

    #[test]
    fn cache_checks_adapter_version_hash_path_and_payload() {
        let directory =
            std::env::temp_dir().join(format!("mex-facts-cache-{}", std::process::id()));
        let cache = FactsCache::open(&directory, 10_000).unwrap();
        let facts = FileFacts {
            facts_version: FACTS_VERSION,
            path: "src/app.py".into(),
            language: "python".into(),
            content_hash: [9; 32],
            calls: vec![Call {
                form: CallForm::Member,
                name: "handle".into(),
                receiver: Some(Receiver::CallResult {
                    name: "create".into(),
                    receiver: Some(Box::new(Receiver::Name { name: "app".into() })),
                }),
                scope: NONE,
                caller: NONE,
                range: Default::default(),
                name_range: Default::default(),
                text: "app.create().handle".into(),
            }],
            ..FileFacts::default()
        };
        let second = FileFacts {
            path: "src/next.py".into(),
            ..facts.clone()
        };
        let put = || {
            let (sender, blocks) = sync_channel(1);
            let mut writer = cache.worker(sender).unwrap();
            writer.put("python-1", &facts);
            writer.put("python-1", &second);
            writer.flush();
            drop(writer);
            cache.write_blocks(blocks);
        };
        put();
        let mut reader = FactsCache::open(&directory, 1).unwrap().reader().unwrap();
        let capacity: u32 = reader
            .conn
            .query_row("SELECT capacity FROM budget", [], |row| row.get(0))
            .unwrap();
        assert_eq!(capacity as usize, 10_000 * BYTES_PER_FILE);
        assert_eq!(
            reader.get(&facts.path, "python", "python-1", &[9; 32]),
            Some(facts.clone())
        );
        assert_eq!(
            reader.get(&second.path, "python", "python-1", &[9; 32]),
            Some(second.clone())
        );
        assert_eq!(
            reader.get(&facts.path, "python", "python-2", &[9; 32]),
            None
        );
        assert_eq!(
            reader.get(&facts.path, "python", "python-1", &[8; 32]),
            None
        );
        assert_eq!(
            reader.get(&facts.path, "typescript", "python-1", &[9; 32]),
            None
        );
        assert_eq!(reader.get("moved.py", "python", "python-1", &[9; 32]), None);
        reader
            .conn
            .execute("UPDATE blocks SET payload = zeroblob(length(payload))", [])
            .unwrap();
        drop(reader);
        let mut reader = cache.reader().unwrap();
        assert_eq!(
            reader.get(&facts.path, "python", "python-1", &[9; 32]),
            None
        );
        put();
        assert_eq!(
            reader.get(&facts.path, "python", "python-1", &[9; 32]),
            Some(facts)
        );
        drop(reader);
        fs::remove_dir_all(directory).unwrap();
    }
}
