//! The projection belongs to the origin where the site was written. Keep
//! rows before SQL deduplication so removing one callback can expose the
//! next site for the same edge key.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};

use bincode::{Decode, Encode};
use mex_graph_core::facts::{FileFacts, Kind};
use mex_graph_core::store::{EdgeEvidence, EdgeRow, StoredProjection, UnresolvedRow, Writer};
use sha2::{Digest, Sha256};

use super::{StagedEvidence, StagedFile, edit_facts};
use crate::job::JobError;

const MAX_RECORD_BYTES: usize = 128 * 1024 * 1024;
type Site = (u32, Option<u32>);

#[derive(Encode, Decode)]
pub(super) struct Projection<'a> {
    pub(super) signature: edit_facts::Signature,
    routes: [u8; 32],
    edges: Vec<Edge<'a>>,
    unresolved: Vec<Unresolved<'a>>,
    remote: BTreeMap<i64, Vec<Edge<'a>>>,
}

#[derive(Encode, Decode)]
struct Edge<'a> {
    source: i64,
    target: i64,
    fields: EdgeFields<'a>,
}

#[derive(Encode, Decode)]
struct EdgeFields<'a> {
    kind: Cow<'a, str>,
    site: Site,
    provenance: Cow<'a, str>,
    confidence: f64,
    method: Cow<'a, str>,
    target_name: Option<Cow<'a, str>>,
    evidence: Option<Evidence<'a>>,
}

#[derive(Encode, Decode)]
enum Evidence<'a> {
    Declaration(Option<Cow<'a, str>>),
    Import,
    Heritage,
    Expression(Cow<'a, str>),
    Callback(u32),
    Framework(Option<Cow<'a, str>>),
    SyntaxImport(Cow<'a, str>),
}

impl Evidence<'_> {
    fn row(&self) -> EdgeEvidence<'_> {
        match self {
            Self::Declaration(role) => EdgeEvidence::Declaration(role.as_deref()),
            Self::Import => EdgeEvidence::Import,
            Self::Heritage => EdgeEvidence::Heritage,
            Self::Expression(text) => EdgeEvidence::Expression(text),
            Self::Callback(argument) => EdgeEvidence::Callback(*argument),
            Self::Framework(binding) => EdgeEvidence::Framework(binding.as_deref()),
            Self::SyntaxImport(specifier) => EdgeEvidence::SyntaxImport(specifier),
        }
    }
}

impl<'a> From<&StagedEvidence<'a>> for Evidence<'a> {
    fn from(evidence: &StagedEvidence<'a>) -> Self {
        match *evidence {
            StagedEvidence::Declaration { declaration_role } => {
                Self::Declaration(declaration_role.map(Cow::Borrowed))
            }
            StagedEvidence::Import { .. } => Self::Import,
            StagedEvidence::Heritage { .. } => Self::Heritage,
            StagedEvidence::Expression { expression } => Self::Expression(expression.into()),
            StagedEvidence::Callback { argument_index, .. } => Self::Callback(argument_index),
            StagedEvidence::Framework { import_binding, .. } => {
                Self::Framework(import_binding.map(Cow::Borrowed))
            }
            StagedEvidence::SyntaxImport { module_specifier } => {
                Self::SyntaxImport(module_specifier.into())
            }
        }
    }
}

#[derive(Encode, Decode)]
struct Unresolved<'a> {
    source: i64,
    candidate: Option<i64>,
    fields: UnresolvedFields<'a>,
}

#[derive(Encode, Decode)]
struct UnresolvedFields<'a> {
    name: Cow<'a, str>,
    written: Option<Cow<'a, str>>,
    kind: Cow<'a, str>,
    reason: Cow<'a, str>,
    line: u32,
    column: u32,
    receiver: Option<Cow<'a, str>>,
}

impl<'a> Projection<'a> {
    pub(super) fn new(
        file: &'a StagedFile<'_>,
        facts: &FileFacts,
        signature: edit_facts::Signature,
        file_key: impl Fn(&str) -> i64,
        mut node_key: impl FnMut(&str) -> Result<i64, JobError>,
    ) -> Result<Self, JobError> {
        let mut edges = Vec::with_capacity(file.edges.len());
        let mut remote: BTreeMap<i64, Vec<Edge<'a>>> = BTreeMap::new();
        for edge in &file.edges {
            let row = Edge {
                source: node_key(edge.source)?,
                target: node_key(edge.target)?,
                fields: EdgeFields {
                    kind: edge.kind.into(),
                    site: (edge.line, edge.column),
                    provenance: edge.provenance.into(),
                    confidence: edge.confidence.as_f64().expect("finite edge confidence"),
                    method: edge.resolution_method.into(),
                    target_name: edge.metadata.as_ref().map(|meta| meta.target_name.into()),
                    evidence: edge
                        .evidence
                        .as_ref()
                        .map(|[evidence]| Evidence::from(evidence)),
                },
            };
            if let Some(owner) = edge.owner {
                remote.entry(file_key(owner)).or_default().push(row);
            } else {
                edges.push(row);
            }
        }
        let unresolved = file
            .unresolved
            .iter()
            .map(|row| {
                Ok(Unresolved {
                    source: node_key(row.from_node_id)?,
                    candidate: row.candidate_id.map(&mut node_key).transpose()?,
                    fields: UnresolvedFields {
                        name: row.called_name.unwrap_or(row.reference_name).into(),
                        written: row.called_name.map(|_| row.reference_name.into()),
                        kind: row.reference_kind.into(),
                        reason: row.metadata["reason"].as_str().unwrap_or("unknown").into(),
                        line: row.line,
                        column: row.column,
                        receiver: row.receiver.map(Cow::Borrowed),
                    },
                })
            })
            .collect::<Result<_, JobError>>()?;
        Ok(Self {
            signature,
            routes: routes(facts)?,
            edges,
            unresolved,
            remote,
        })
    }

    pub(super) fn rebase(
        &mut self,
        facts: &FileFacts,
        positions: &HashMap<Site, Site>,
    ) -> Result<bool, JobError> {
        for edge in self
            .edges
            .iter_mut()
            .chain(self.remote.values_mut().flatten())
        {
            let Some(&site) = positions.get(&edge.fields.site) else {
                return Ok(false);
            };
            edge.fields.site = site;
        }
        for row in &mut self.unresolved {
            let fields = &mut row.fields;
            let Some(&(line, Some(col))) = positions.get(&(fields.line, Some(fields.column)))
            else {
                return Ok(false);
            };
            (fields.line, fields.column) = (line, col);
        }
        self.routes = routes(facts)?;
        Ok(true)
    }

    pub(super) fn unchanged_sites(
        &self,
        facts: &FileFacts,
        positions: &HashMap<Site, Site>,
    ) -> Result<bool, JobError> {
        Ok(positions.iter().all(|(old, new)| old == new) && self.routes == routes(facts)?)
    }

    pub(super) fn install(
        &self,
        writer: &Writer,
        origin: i64,
        encoder: &mut Encoder,
    ) -> Result<(), JobError> {
        let _timer = mex_graph_core::timing::Timer::start("v5.resolutionInputs");
        encoder.install(writer, origin, self)?;
        for (&owner, edges) in &self.remote {
            writer
                .put_callback(owner, origin, &encoder.encode(edges)?)
                .map_err(JobError::write)?;
        }
        Ok(())
    }
}

struct CallbackRows {
    origin: i64,
    path: String,
    rows: Vec<Edge<'static>>,
}

pub(super) struct Outgoing<'a> {
    path: &'a str,
    local: Projection<'a>,
    callbacks: Vec<CallbackRows>,
}

impl<'a> Outgoing<'a> {
    pub(super) fn local(path: &'a str, local: Projection<'a>) -> Self {
        Self {
            path,
            local,
            callbacks: Vec::new(),
        }
    }

    pub(super) fn load(
        writer: &Writer,
        file: i64,
        path: &'a str,
        local: Projection<'a>,
    ) -> Result<Self, JobError> {
        let mut callbacks = writer
            .callbacks_for(file)
            .map_err(JobError::write)?
            .into_iter()
            .map(|(origin, blob)| {
                Ok(CallbackRows {
                    origin,
                    path: writer.file_path(origin).map_err(JobError::write)?,
                    rows: decode(&blob)?,
                })
            })
            .collect::<Result<Vec<_>, JobError>>()?;
        callbacks.sort_unstable_by(|left, right| {
            left.path.encode_utf16().cmp(right.path.encode_utf16())
        });
        Ok(Self {
            path,
            local,
            callbacks,
        })
    }

    fn edges(&self) -> impl Iterator<Item = (Option<(i64, &str)>, &Edge<'_>)> {
        let before = self.callbacks.partition_point(|row| {
            row.path
                .encode_utf16()
                .cmp(self.path.encode_utf16())
                .is_lt()
        });
        fn callback_edges(
            slice: &[CallbackRows],
        ) -> impl Iterator<Item = (Option<(i64, &str)>, &Edge<'_>)> {
            slice.iter().flat_map(|callback| {
                callback
                    .rows
                    .iter()
                    .map(|edge| (Some((callback.origin, callback.path.as_str())), edge))
            })
        }
        callback_edges(&self.callbacks[..before])
            .chain(self.local.edges.iter().map(|edge| (None, edge)))
            .chain(callback_edges(&self.callbacks[before..]))
    }

    /// Keys are publication-local. Include each endpoint's public identity
    /// and, for callbacks, the actual site path in the comparable digest.
    pub(super) fn digest(
        &self,
        mut identity: impl FnMut(i64) -> Result<[u8; 16], JobError>,
    ) -> Result<[u8; 32], JobError> {
        let _timer = mex_graph_core::timing::Timer::start("v5.resolutionDigest");
        let mut bytes = Vec::new();
        let mut digest = Sha256::new();
        digest.update(self.local.routes);
        let config = bincode::config::standard();
        for (site, row) in self.edges() {
            bincode::encode_into_std_write(
                (
                    identity(row.source)?,
                    identity(row.target)?,
                    site.map(|(_, path)| path),
                    &row.fields,
                ),
                &mut bytes,
                config,
            )
            .map_err(JobError::write)?;
        }
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(&bytes);
        bytes.clear();
        for row in &self.local.unresolved {
            bincode::encode_into_std_write(
                (
                    identity(row.source)?,
                    row.candidate.map(&mut identity).transpose()?,
                    &row.fields,
                ),
                &mut bytes,
                config,
            )
            .map_err(JobError::write)?;
        }
        digest.update(bytes);
        Ok(digest.finalize().into())
    }

    pub(super) fn write(&self, writer: &mut Writer) -> Result<usize, JobError> {
        let _timer = mex_graph_core::timing::Timer::start("v5.writeOutgoing");
        let mut count = 0;
        for (site, edge) in self.edges() {
            let fields = &edge.fields;
            count += usize::from(
                writer
                    .add_edge(&EdgeRow {
                        source: edge.source,
                        target: edge.target,
                        kind: &fields.kind,
                        line: Some(fields.site.0),
                        col: fields.site.1,
                        site_file: site.map(|(file, _)| file),
                        provenance: &fields.provenance,
                        confidence: fields.confidence,
                        method: &fields.method,
                        target_name: fields.target_name.as_deref(),
                        evidence: fields.evidence.as_ref().map(Evidence::row),
                    })
                    .map_err(JobError::write)?,
            );
        }
        for row in &self.local.unresolved {
            let fields = &row.fields;
            writer
                .add_unresolved(&UnresolvedRow {
                    source: row.source,
                    name: &fields.name,
                    written_name: fields.written.as_deref(),
                    kind: &fields.kind,
                    reason: &fields.reason,
                    line: fields.line,
                    col: fields.column,
                    candidate: row.candidate,
                    receiver: fields.receiver.as_deref(),
                })
                .map_err(JobError::write)?;
        }
        Ok(count)
    }
}

fn routes(facts: &FileFacts) -> Result<[u8; 32], JobError> {
    let mut sha = Sha256::new();
    for def in facts.defs.iter().filter(|def| def.kind == Kind::Route) {
        sha.update(
            bincode::encode_to_vec(def, bincode::config::standard()).map_err(JobError::write)?,
        );
    }
    Ok(sha.finalize().into())
}

// Batch small base records for cross-file compression while keeping point
// reads small. An individual large origin gets its own frame.
const BASE_FRAME_BYTES: usize = 64 * 1024;

pub(super) struct Encoder {
    payload: Vec<u8>,
    compressor: zstd::bulk::Compressor<'static>,
    batch: Option<ProjectionBatch>,
}

#[derive(Default)]
struct ProjectionBatch {
    bytes: Vec<u8>,
    entries: Vec<(i64, usize, usize)>,
}

impl ProjectionBatch {
    fn flush(
        &mut self,
        writer: &Writer,
        compressor: &mut zstd::bulk::Compressor<'_>,
    ) -> Result<(), JobError> {
        if !self.entries.is_empty() {
            let compressed = compressor.compress(&self.bytes).map_err(JobError::write)?;
            writer
                .put_projection_frame(&compressed, &self.entries)
                .map_err(JobError::write)?;
            self.entries.clear();
            self.bytes.clear();
        }
        Ok(())
    }
}

impl Encoder {
    pub(super) fn new(base: bool) -> Result<Self, JobError> {
        Ok(Self {
            payload: Vec::new(),
            compressor: zstd::bulk::Compressor::new(if base { 3 } else { 1 })
                .map_err(JobError::write)?,
            batch: base.then(ProjectionBatch::default),
        })
    }

    fn serialize(&mut self, value: impl Encode) -> Result<(), JobError> {
        self.payload.clear();
        bincode::encode_into_std_write(value, &mut self.payload, bincode::config::standard())
            .map_err(JobError::write)?;
        Ok(())
    }

    fn encode(&mut self, value: impl Encode) -> Result<Vec<u8>, JobError> {
        self.serialize(value)?;
        self.compressor
            .compress(&self.payload)
            .map_err(JobError::write)
    }

    fn install(
        &mut self,
        writer: &Writer,
        origin: i64,
        value: &Projection<'_>,
    ) -> Result<(), JobError> {
        self.serialize(value)?;
        let Some(batch) = &mut self.batch else {
            let blob = self
                .compressor
                .compress(&self.payload)
                .map_err(JobError::write)?;
            return writer
                .put_projection(origin, Some(&blob))
                .map_err(JobError::write);
        };
        let size = self.payload.len();
        if batch.bytes.len() + size > BASE_FRAME_BYTES {
            batch.flush(writer, &mut self.compressor)?;
        }
        if size >= BASE_FRAME_BYTES {
            let blob = self
                .compressor
                .compress(&self.payload)
                .map_err(JobError::write)?;
            writer
                .put_projection_frame(&blob, &[(origin, 0, size)])
                .map_err(JobError::write)
        } else {
            batch.entries.push((origin, batch.bytes.len(), size));
            batch.bytes.extend_from_slice(&self.payload);
            Ok(())
        }
    }

    pub(super) fn finish(&mut self, writer: &Writer) -> Result<(), JobError> {
        if let Some(batch) = &mut self.batch {
            batch.flush(writer, &mut self.compressor)?;
            writer.flush_projection_blocks().map_err(JobError::write)?;
        }
        Ok(())
    }
}

pub(super) fn decode_projection(input: StoredProjection) -> Result<Projection<'static>, JobError> {
    match input {
        StoredProjection::Origin(blob) => decode(&blob),
        StoredProjection::Frame {
            compressed,
            start,
            size,
        } => {
            let payload =
                zstd::bulk::decompress(&compressed, MAX_RECORD_BYTES).map_err(JobError::write)?;
            let end = start.checked_add(size).ok_or_else(invalid_projection)?;
            decode_payload(payload.get(start..end).ok_or_else(invalid_projection)?)
        }
    }
}

fn decode<T: Decode<()>>(blob: &[u8]) -> Result<T, JobError> {
    let payload = zstd::bulk::decompress(blob, MAX_RECORD_BYTES).map_err(JobError::write)?;
    decode_payload(&payload)
}

fn decode_payload<T: Decode<()>>(payload: &[u8]) -> Result<T, JobError> {
    let (data, read) = bincode::decode_from_slice(
        payload,
        bincode::config::standard().with_limit::<MAX_RECORD_BYTES>(),
    )
    .map_err(JobError::write)?;
    if read != payload.len() {
        return Err(invalid_projection());
    }
    Ok(data)
}

fn invalid_projection() -> JobError {
    JobError::request("Invalid projected resolution record")
}
