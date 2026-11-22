//! A compact, position-bearing projection of one resolver origin. Keep it
//! before edge deduplication so an edited callback can expose the next site
//! for the same edge key. The public graph still owns edges by source node.

use std::collections::{BTreeMap, HashMap};

use bincode::{Decode, Encode};
use mex_graph_core::facts::{FileFacts, Kind};
use mex_graph_core::store::{EdgeEvidence, EdgeRow, UnresolvedRow, Writer};
use sha2::{Digest, Sha256};

use super::StagedFile;
use super::{build, edit_facts};
use crate::job::JobError;

const MAX_RECORD_BYTES: usize = 128 * 1024 * 1024;

type Site = (u32, Option<u32>);

#[derive(Encode, Decode)]
pub(super) struct Projection {
    pub(super) signature: edit_facts::Signature,
    routes: [u8; 32],
    edges: Vec<Edge>,
    unresolved: Vec<Unresolved>,
    remote: BTreeMap<String, Vec<Edge>>,
}

#[derive(Encode, Decode)]
struct Edge {
    source: String,
    target: String,
    kind: String,
    site: Site,
    provenance: String,
    confidence: f64,
    method: String,
    target_name: Option<String>,
    evidence: Option<Evidence>,
}

#[derive(Encode, Decode)]
enum Evidence {
    Declaration(Option<String>),
    Import,
    Heritage,
    Expression(String),
    Callback(u32),
    Framework(Option<String>),
    SyntaxImport(String),
}

impl Evidence {
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

impl From<EdgeEvidence<'_>> for Evidence {
    fn from(evidence: EdgeEvidence<'_>) -> Self {
        match evidence {
            EdgeEvidence::Declaration(role) => Self::Declaration(role.map(str::to_owned)),
            EdgeEvidence::Import => Self::Import,
            EdgeEvidence::Heritage => Self::Heritage,
            EdgeEvidence::Expression(text) => Self::Expression(text.into()),
            EdgeEvidence::Callback(argument) => Self::Callback(argument),
            EdgeEvidence::Framework(binding) => Self::Framework(binding.map(str::to_owned)),
            EdgeEvidence::SyntaxImport(specifier) => Self::SyntaxImport(specifier.into()),
        }
    }
}

#[derive(Encode, Decode)]
struct Unresolved {
    source: String,
    name: String,
    written: Option<String>,
    kind: String,
    reason: String,
    line: u32,
    column: u32,
    candidate: Option<String>,
    receiver: Option<String>,
}

impl Projection {
    pub(super) fn new(file: &StagedFile<'_>, facts: &FileFacts) -> Result<Self, JobError> {
        let mut edges = Vec::with_capacity(file.edges.len());
        let mut remote: BTreeMap<String, Vec<Edge>> = BTreeMap::new();
        for edge in &file.edges {
            let (_, evidence) = build::edge_evidence(edge);
            let row = Edge {
                source: edge.source.into(),
                target: edge.target.into(),
                kind: edge.kind.into(),
                site: (edge.line, edge.column),
                provenance: edge.provenance.into(),
                confidence: edge.confidence.as_f64().expect("finite edge confidence"),
                method: edge.resolution_method.into(),
                target_name: edge.metadata.as_ref().map(|meta| meta.target_name.into()),
                evidence: evidence.map(Evidence::from),
            };
            if let Some(owner) = edge.owner {
                remote.entry(owner.into()).or_default().push(row);
            } else {
                edges.push(row);
            }
        }
        let unresolved = file
            .unresolved
            .iter()
            .map(|row| Unresolved {
                source: row.from_node_id.into(),
                name: row.called_name.unwrap_or(row.reference_name).into(),
                written: row.called_name.map(|_| row.reference_name.into()),
                kind: row.reference_kind.into(),
                reason: row.metadata["reason"].as_str().unwrap_or("unknown").into(),
                line: row.line,
                column: row.column,
                candidate: row.candidate_id.map(str::to_owned),
                receiver: row.receiver.map(str::to_owned),
            })
            .collect();
        Ok(Self {
            signature: edit_facts::Signature::new(facts)?,
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
            let Some(&site) = positions.get(&edge.site) else {
                return Ok(false);
            };
            edge.site = site;
        }
        for row in &mut self.unresolved {
            let Some(&(line, Some(col))) = positions.get(&(row.line, Some(row.column))) else {
                return Ok(false);
            };
            (row.line, row.column) = (line, col);
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

    pub(super) fn install(&self, writer: &Writer, path: &str) -> Result<(), JobError> {
        let _timer = mex_graph_core::timing::Timer::start("v5.resolutionInputs");
        let blob = encode(self)?;
        writer
            .put_projection(path, Some(&blob))
            .map_err(JobError::write)?;
        for (owner, edges) in &self.remote {
            writer
                .put_callback(owner, path, &encode(edges)?)
                .map_err(JobError::write)?;
        }
        Ok(())
    }
}

pub(super) struct Outgoing {
    path: String,
    local: Projection,
    callbacks: Vec<(String, Vec<Edge>)>,
}

impl Outgoing {
    pub(super) fn load(writer: &Writer, path: &str, local: Projection) -> Result<Self, JobError> {
        let mut callbacks = writer
            .callbacks_for(path)
            .map_err(JobError::write)?
            .into_iter()
            .map(|(origin, blob)| Ok((origin, decode(&blob)?)))
            .collect::<Result<Vec<_>, JobError>>()?;
        callbacks.sort_unstable_by(|(left, _), (right, _)| {
            left.encode_utf16().cmp(right.encode_utf16())
        });
        Ok(Self {
            path: path.into(),
            local,
            callbacks,
        })
    }

    fn edges(&self) -> impl Iterator<Item = (&str, &Edge)> {
        let before = self
            .callbacks
            .partition_point(|(path, _)| path.encode_utf16().cmp(self.path.encode_utf16()).is_lt());
        fn callback_edges(slice: &[(String, Vec<Edge>)]) -> impl Iterator<Item = (&str, &Edge)> {
            slice
                .iter()
                .flat_map(|(path, edges)| edges.iter().map(|edge| (path.as_str(), edge)))
        }
        callback_edges(&self.callbacks[..before])
            .chain(
                self.local
                    .edges
                    .iter()
                    .map(|edge| (self.path.as_str(), edge)),
            )
            .chain(callback_edges(&self.callbacks[before..]))
    }

    pub(super) fn digest(&self) -> Result<[u8; 32], JobError> {
        let mut bytes = Vec::new();
        let mut digest = Sha256::new();
        digest.update(self.local.routes);
        for row in self.edges() {
            bincode::encode_into_std_write(row, &mut bytes, bincode::config::standard())
                .map_err(JobError::write)?;
        }
        digest.update(bytes.len().to_le_bytes());
        digest.update(&bytes);
        bytes.clear();
        bincode::encode_into_std_write(
            &self.local.unresolved,
            &mut bytes,
            bincode::config::standard(),
        )
        .map_err(JobError::write)?;
        digest.update(bytes);
        Ok(digest.finalize().into())
    }

    pub(super) fn write(
        &self,
        writer: &mut Writer,
        file_key: impl Fn(&str) -> i64,
        mut node_key: impl FnMut(&str) -> Result<i64, JobError>,
    ) -> Result<usize, JobError> {
        let _timer = mex_graph_core::timing::Timer::start("v5.writeOutgoing");
        let mut count = 0;
        for (origin, edge) in self.edges() {
            count += usize::from(
                writer
                    .add_edge(&EdgeRow {
                        source: node_key(&edge.source)?,
                        target: node_key(&edge.target)?,
                        kind: &edge.kind,
                        line: Some(edge.site.0),
                        col: edge.site.1,
                        site_file: (origin != self.path).then(|| file_key(origin)),
                        provenance: &edge.provenance,
                        confidence: edge.confidence,
                        method: &edge.method,
                        target_name: edge.target_name.as_deref(),
                        evidence: edge.evidence.as_ref().map(Evidence::row),
                    })
                    .map_err(JobError::write)?,
            );
        }
        for row in &self.local.unresolved {
            writer
                .add_unresolved(&UnresolvedRow {
                    source: node_key(&row.source)?,
                    name: &row.name,
                    written_name: row.written.as_deref(),
                    kind: &row.kind,
                    reason: &row.reason,
                    line: row.line,
                    col: row.column,
                    candidate: row.candidate.as_deref().map(&mut node_key).transpose()?,
                    receiver: row.receiver.as_deref(),
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

fn encode(value: impl Encode) -> Result<Vec<u8>, JobError> {
    let payload =
        bincode::encode_to_vec(value, bincode::config::standard()).map_err(JobError::write)?;
    zstd::bulk::compress(&payload, 1).map_err(JobError::write)
}

pub(super) fn decode<T: Decode<()>>(blob: &[u8]) -> Result<T, JobError> {
    let payload = zstd::bulk::decompress(blob, MAX_RECORD_BYTES).map_err(JobError::write)?;
    let (data, read) = bincode::decode_from_slice(
        &payload,
        bincode::config::standard().with_limit::<MAX_RECORD_BYTES>(),
    )
    .map_err(JobError::write)?;
    if read != payload.len() {
        return Err(JobError::request("Invalid projected resolution record"));
    }
    Ok(data)
}
