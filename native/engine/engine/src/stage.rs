//! Project Python facts and resolution into rows for Node's schema v4 writer.

use mex_graph_core::facts::{Def, FileFacts, Health, Kind, ParseStatus};
use mex_graph_python::resolve::{Resolution, call_source};
use mex_graph_python::{EXCLUDED, LANGUAGE};
use serde::Serialize;

use crate::hex;
use crate::job::{ExtractedFile, ExtractedFiles, JobCounts, JobError, emit};

pub(super) fn write(extracted: &ExtractedFiles<'_>) -> Result<JobCounts, JobError> {
    let Resolution {
        edges,
        unresolved_calls,
        ..
    } = extracted.resolve();
    let mut edges = edges.into_iter().peekable();
    let mut unresolved = unresolved_calls.into_iter().peekable();

    // Cross-file edge targets can be written later in the stream. Keep an id
    // per written definition, but only assemble one file's rows at a time.
    let ids: Vec<_> = extracted.facts.iter().map(node_ids).collect();
    let mut counts = JobCounts::default();
    for entry in &extracted.files {
        let (index, size) = match *entry {
            ExtractedFile::Python { index, size } => (index, size),
            ExtractedFile::EcmaScript { .. } => unreachable!("stage only extracts Python"),
            ExtractedFile::Skipped { path, reason } => {
                emit(&serde_json::json!({
                    "type": "file", "path": path, "status": "skipped", "reason": reason,
                }))?;
                counts.coverage_gaps += 1;
                continue;
            }
        };
        let facts = &extracted.facts[index];
        let mut file = StagedFile {
            event_type: "staged",
            path: &facts.path,
            content_hash: hex(&facts.content_hash),
            size,
            language: LANGUAGE,
            parse_status: facts.health.status,
            health: StagedHealth::from(&facts.health),
            nodes: Vec::new(),
            edges: Vec::new(),
            unresolved: Vec::new(),
        };
        for (def, id) in facts.defs.iter().zip(&ids[index]) {
            let Some(id) = id.as_deref() else { continue };
            let parent = usize::try_from(def.parent)
                .ok()
                .and_then(|parent| node_id(&ids[index], parent));
            let node = StagedNode::new(&facts.path, def, id, parent);
            if let Some(parent) = parent {
                file.edges.push(StagedEdge {
                    source: parent,
                    target: id,
                    kind: "contains",
                    line: node.start_line,
                    column: None,
                    provenance: "tree-sitter",
                    confidence: 1,
                    resolution_method: "lexical-containment",
                });
            }
            file.nodes.push(node);
        }
        while let Some(edge) = edges.next_if(|edge| edge.from.0 == index) {
            let source = node_id(&ids[index], edge.from.1);
            let target = node_id(&ids[edge.to.0], edge.to.1);
            if let (Some(source), Some(target)) = (source, target) {
                file.edges.push(StagedEdge {
                    source,
                    target,
                    kind: edge.kind,
                    line: edge.line,
                    column: Some(edge.col),
                    provenance: "tree-sitter",
                    confidence: 1,
                    resolution_method: "engine-python",
                });
            }
        }
        while let Some((_, call_index, reason)) = unresolved.next_if(|call| call.0 == index) {
            let call = &facts.calls[call_index];
            let source = call_source(facts, call.caller);
            if let Some(id) = node_id(&ids[index], source) {
                file.unresolved.push(StagedRef {
                    from_node_id: id,
                    reference_name: &call.name,
                    reference_kind: "calls",
                    file_path: &facts.path,
                    language: LANGUAGE,
                    line: call.name_range.start_line + 1,
                    column: call.name_range.start_col,
                    status: "unresolved",
                    resolver: "engine-python",
                    metadata: StagedRefMetadata { reason },
                });
            }
        }
        counts.files += 1;
        counts.nodes += file.nodes.len();
        counts.edges += file.edges.len();
        counts.coverage_gaps += usize::from(file.parse_status == ParseStatus::Failed);
        emit(&file)?;
    }
    debug_assert!(edges.next().is_none() && unresolved.next().is_none());
    Ok(counts)
}

fn node_ids(facts: &FileFacts) -> Vec<Option<String>> {
    if facts.health.status == ParseStatus::Failed {
        return Vec::new();
    }
    facts
        .defs
        .iter()
        .map(|def| {
            (!def.flags.iter().any(|flag| flag == EXCLUDED)).then(|| def.signature_id(&facts.path))
        })
        .collect()
}

fn node_id(ids: &[Option<String>], index: usize) -> Option<&str> {
    ids.get(index).and_then(Option::as_deref)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedFile<'a> {
    #[serde(rename = "type")]
    event_type: &'static str,
    path: &'a str,
    content_hash: String,
    size: u64,
    language: &'static str,
    parse_status: ParseStatus,
    health: StagedHealth<'a>,
    nodes: Vec<StagedNode<'a>>,
    edges: Vec<StagedEdge<'a>>,
    unresolved: Vec<StagedRef<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedHealth<'a> {
    status: ParseStatus,
    diagnostic_count: u32,
    missing_count: u32,
    error_coverage: f32,
    diagnostics: Vec<StagedDiagnostic<'a>>,
}

impl<'a> From<&'a Health> for StagedHealth<'a> {
    fn from(health: &'a Health) -> Self {
        Self {
            status: health.status,
            diagnostic_count: health.error_count,
            missing_count: health.missing_count,
            error_coverage: health.error_coverage,
            diagnostics: health
                .diagnostics
                .iter()
                .map(|diagnostic| StagedDiagnostic {
                    kind: &diagnostic.code,
                    start_line: diagnostic.range.start_line + 1,
                    end_line: diagnostic.range.end_line + 1,
                })
                .collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedDiagnostic<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    start_line: u32,
    end_line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedNode<'a> {
    id: &'a str,
    kind: Kind,
    name: &'a str,
    qualified_name: &'a str,
    file_path: &'a str,
    language: &'static str,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
    identity_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    container_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    docstring: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    return_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_async: Option<bool>,
    is_exported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minhash: Option<&'a [u32]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_count: Option<u32>,
}

impl<'a> StagedNode<'a> {
    fn new(path: &'a str, def: &'a Def, id: &'a str, parent: Option<&'a str>) -> Self {
        Self {
            id,
            kind: def.kind,
            name: &def.name,
            qualified_name: &def.qualified_name,
            file_path: path,
            language: LANGUAGE,
            start_line: def.range.start_line + 1,
            end_line: def.range.end_line + 1,
            start_column: def.range.start_col,
            end_column: def.range.end_col,
            identity_key: def.signature_identity(path),
            container_id: parent,
            signature: (!def.signature.is_empty()).then_some(def.signature.as_str()),
            docstring: def.docstring.as_deref(),
            return_type: def.return_type.as_deref(),
            is_async: matches!(def.kind, Kind::Function | Kind::Method)
                .then(|| def.flags.iter().any(|flag| flag == "async")),
            is_exported: def.exported,
            body_hash: def.body_hash.as_ref().map(|hash| hex(hash)),
            minhash: def.sketch.as_ref().map(|sketch| sketch.minhash.as_slice()),
            token_count: def.sketch.as_ref().map(|sketch| sketch.token_count),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedEdge<'a> {
    source: &'a str,
    target: &'a str,
    kind: &'static str,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
    provenance: &'static str,
    confidence: u8,
    resolution_method: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedRef<'a> {
    from_node_id: &'a str,
    reference_name: &'a str,
    reference_kind: &'static str,
    file_path: &'a str,
    language: &'static str,
    line: u32,
    column: u32,
    status: &'static str,
    resolver: &'static str,
    metadata: StagedRefMetadata,
}

#[derive(Serialize)]
struct StagedRefMetadata {
    reason: &'static str,
}
