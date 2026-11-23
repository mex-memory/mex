//! Pack base projection frames into rows below SQLite's overflow threshold.
//! Overlays keep independent frames so retained origins can be copied by SQL.

use rusqlite::{OptionalExtension, params};

use super::{Error, Writer};

const PAGE_OVERHEAD: usize = 64;
const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Blocks {
    written: usize,
    tail: Vec<u8>,
}

pub enum StoredProjection {
    Origin(Vec<u8>),
    Frame {
        compressed: Vec<u8>,
        start: usize,
        size: usize,
    },
}

impl Writer {
    /// A null overlay projection masks the base inputs of a deleted file.
    pub fn put_projection(&self, origin: i64, blob: Option<&[u8]>) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached(
                "INSERT INTO main.resolution_inputs (origin, projection) VALUES (?1, ?2)",
            )?
            .execute(params![origin, blob])?;
        Ok(())
    }

    /// Each entry locates an origin in the uncompressed frame.
    pub fn put_projection_frame(
        &self,
        mut frame: &[u8],
        entries: &[(i64, usize, usize)],
    ) -> rusqlite::Result<()> {
        let frame_size = frame.len();
        let block_bytes = self.page_size as usize - PAGE_OVERHEAD;
        let mut blocks = self.projection_blocks.borrow_mut();
        let frame_start = blocks.written * block_bytes + blocks.tail.len();
        while !frame.is_empty() {
            let take = frame.len().min(block_bytes - blocks.tail.len());
            blocks.tail.extend_from_slice(&frame[..take]);
            frame = &frame[take..];
            if blocks.tail.len() == block_bytes {
                self.write_block(&mut blocks)?;
            }
        }
        let mut insert = self.conn.prepare_cached(
            "INSERT INTO main.resolution_inputs
             (origin, frame_start, frame_size, entry_start, entry_size)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for &(origin, start, size) in entries {
            insert.execute(params![
                origin,
                frame_start as i64,
                frame_size as i64,
                start as i64,
                size as i64,
            ])?;
        }
        Ok(())
    }

    fn write_block(&self, blocks: &mut Blocks) -> rusqlite::Result<()> {
        self.conn
            .prepare_cached("INSERT INTO main.resolution_blocks VALUES (?1, ?2)")?
            .execute(params![blocks.written as i64 + 1, blocks.tail])?;
        blocks.written += 1;
        blocks.tail.clear();
        Ok(())
    }

    pub fn flush_projection_blocks(&self) -> rusqlite::Result<()> {
        let mut blocks = self.projection_blocks.borrow_mut();
        if !blocks.tail.is_empty() {
            self.write_block(&mut blocks)?;
        }
        Ok(())
    }

    pub fn prior_projection(&self, file: i64) -> rusqlite::Result<Option<StoredProjection>> {
        let sql = self.prior_sql(
            "resolution_inputs",
            "projection, frame_start, frame_size, entry_start, entry_size",
            "origin = ?1",
        );
        self.read_projection(&sql, "base", file)
    }

    pub fn projection(&self, file: i64) -> rusqlite::Result<Option<StoredProjection>> {
        self.read_projection(
            "SELECT projection, frame_start, frame_size, entry_start, entry_size
             FROM main.resolution_inputs WHERE origin = ?1",
            "main",
            file,
        )
    }

    fn read_projection(
        &self,
        sql: &str,
        schema: &str,
        file: i64,
    ) -> rusqlite::Result<Option<StoredProjection>> {
        self.conn
            .prepare_cached(sql)?
            .query_row([file], |row| {
                if let Some(blob) = row.get(0)? {
                    return Ok(Some(StoredProjection::Origin(blob)));
                }
                let Some(offset) = row.get::<_, Option<i64>>(1)? else {
                    return Ok(None);
                };
                let offset = memory_offset(offset)?;
                Ok(Some(StoredProjection::Frame {
                    compressed: self.read_frame(schema, offset, memory_offset(row.get(2)?)?)?,
                    start: memory_offset(row.get(3)?)?,
                    size: memory_offset(row.get(4)?)?,
                }))
            })
            .optional()
            .map(Option::flatten)
    }

    fn read_frame(&self, schema: &str, start: usize, size: usize) -> rusqlite::Result<Vec<u8>> {
        let page_size: u32 = self.conn.pragma_query_one(Some(schema), "page_size")?;
        let block_bytes = page_size as usize - PAGE_OVERHEAD;
        let end = start.checked_add(size).ok_or(Error::InvalidQuery)?;
        if size == 0 || size > MAX_FRAME_BYTES {
            return Err(Error::InvalidQuery);
        }
        let mut query = self.conn.prepare_cached(&format!(
            "SELECT data FROM {schema}.resolution_blocks WHERE id BETWEEN ?1 AND ?2 ORDER BY id"
        ))?;
        let mut rows = query.query(params![
            (start / block_bytes + 1) as i64,
            end.div_ceil(block_bytes) as i64,
        ])?;
        let mut frame = Vec::with_capacity(size);
        let mut skip = start % block_bytes;
        while let Some(row) = rows.next()? {
            let chunk = row.get_ref(0)?.as_blob()?;
            let available = chunk.get(skip..).ok_or(Error::InvalidQuery)?;
            let take = available.len().min(size - frame.len());
            frame.extend_from_slice(&available[..take]);
            skip = 0;
        }
        if frame.len() != size {
            return Err(Error::InvalidQuery);
        }
        Ok(frame)
    }
}

fn memory_offset(value: i64) -> rusqlite::Result<usize> {
    usize::try_from(value).map_err(|_| Error::InvalidQuery)
}
