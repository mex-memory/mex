//! Persist the staged facts directly, without serializing the graph to Node.

use std::collections::HashMap;
use std::path::Path;

use mex_graph_core::store::{EdgeEvidence, EdgeRow, FileRow, NodeRow, UnresolvedRow, Writer};
use serde_json::Value;

use super::{StagedEdge, StagedFile, StagedNode, declared_nodes, node_ids, project};
use crate::frameworks::Enabled;
use crate::job::{
    ConfigSource, ExtractedFile, ExtractedFiles, JobCounts, JobError, Request, emit, read_source,
};

pub(crate) fn write(
    output: &Path,
    extracted: &ExtractedFiles<'_>,
    root: &Path,
    request: &Request,
    configs: &[ConfigSource<'_>],
    frameworks: &Enabled,
) -> Result<JobCounts, JobError> {
    let write = JobError::write;
    let mut writer = Writer::create(output).map_err(write)?;
    let mut counts = JobCounts::default();
    let mut file_keys = HashMap::new();
    let mut node_keys = HashMap::new();
    // The facts already include synthesized routes. Resolve every integer key
    // before writing relationships, so SQLite can check endpoints without
    // scanning for deferred references before the secondary indexes exist.
    for (index, (entry, input)) in extracted.files.iter().zip(&request.files).enumerate() {
        if index.is_multiple_of(256) {
            progress("parse", index, request.files.len())?;
        }
        let (facts, size) = match *entry {
            ExtractedFile::Python { index, size } => (&extracted.facts[index], size),
            ExtractedFile::EcmaScript { index, size } => (&extracted.ecmascript[index], size),
            ExtractedFile::Syntax {
                language,
                index,
                size,
            } => (&extracted.syntax[language as usize][index], size),
            ExtractedFile::Skipped { path, reason } => {
                if request.build_metadata.is_some() {
                    return Err(JobError::request(format!(
                        "Unable to build input {path}: {reason}"
                    )));
                }
                writer.add_coverage(path, reason).map_err(write)?;
                counts.coverage_gaps += 1;
                continue;
            }
        };
        let health = &facts.health;
        let file = writer
            .add_file(&FileRow {
                path: &facts.path,
                content_hash: &facts.content_hash,
                language: &facts.language,
                size: if input.modified_at.is_some() {
                    input.size
                } else {
                    size
                },
                modified_at: input.modified_at.unwrap_or(0.0),
                parse_status: health.status as u8,
                error_count: health.error_count,
                missing_count: health.missing_count,
                error_coverage: health.error_coverage,
                extractor_version: input.extractor_version.as_deref().unwrap_or("mex-graph"),
            })
            .map_err(write)?;
        file_keys.insert(facts.path.as_str(), file);
        counts.files += 1;
        let ids = node_ids(facts);
        for id in ids.iter().flatten() {
            counts.nodes += 1;
            if node_keys.insert(id.clone(), counts.nodes as i64).is_some() {
                return Err(JobError::request("Duplicate public node id"));
            }
        }
        for (def, id, parent) in declared_nodes(facts, &ids) {
            write_node(
                &mut writer,
                StagedNode::new(facts, def, id, parent),
                file,
                &node_keys,
            )
            .map_err(write)?;
        }
        if health.status == mex_graph_core::facts::ParseStatus::Failed {
            counts.coverage_gaps += 1;
            writer
                .add_coverage(&facts.path, "parse failed")
                .map_err(write)?;
        }
        for (index, diagnostic) in health.diagnostics.iter().enumerate() {
            writer
                .add_diagnostic(
                    file,
                    index,
                    &diagnostic.code,
                    diagnostic.range.start_line + 1,
                    diagnostic.range.end_line + 1,
                )
                .map_err(write)?;
        }
        let (source, _, hash) = request
            .source_path(root, input)
            .and_then(|path| read_source(&path, input))
            .map_err(|reason| {
                JobError::request(format!("Unable to index source {}: {reason}", input.path))
            })?;
        if hash != facts.content_hash {
            return Err(JobError::request(
                "Source changed before full-text indexing",
            ));
        }
        write_source_chunks(&writer, file, &facts.path, &source).map_err(write)?;
    }

    progress("resolve", 0, counts.files)?;
    let mut written = 0_usize;
    project(
        extracted,
        root,
        configs,
        Some(frameworks),
        false,
        |file| {
            counts.edges +=
                write_relationships(&mut writer, &file, &file_keys, &node_keys).map_err(write)?;
            written += 1;
            if written.is_multiple_of(256) || written == counts.files {
                progress("resolve", written, counts.files)?;
            }
            Ok(())
        },
        |_, _| Ok(()),
    )?;

    if let Some(metadata) = &request.build_metadata {
        counts.coverage_gaps += metadata.skipped.len();
        writer.set_build_metadata(metadata).map_err(write)?;
    }
    writer
        .set_meta("engine", env!("CARGO_PKG_VERSION"))
        .map_err(write)?;
    writer.finish().map_err(write)?;
    Ok(counts)
}

fn progress(phase: &str, done: usize, total: usize) -> Result<(), JobError> {
    emit(&serde_json::json!({ "type": "progress", "phase": phase, "done": done, "total": total }))
}

fn write_node(
    writer: &mut Writer,
    node: StagedNode,
    file_key: i64,
    nodes: &HashMap<String, i64>,
) -> Result<(), mex_graph_core::store::Error> {
    let key = nodes[node.id];
    let flags = u32::from(node.is_exported)
        | u32::from(node.is_async.unwrap_or(false)) << 1
        | u32::from(node.is_static.unwrap_or(false)) << 2
        | u32::from(node.is_abstract.unwrap_or(false)) << 3
        | u32::from(node.is_default_export) << 4;
    writer.add_node(&NodeRow {
        key,
        public_id: node.id,
        kind: node.kind.as_str(),
        file: file_key,
        parent: node.container_id.map(|id| nodes[id]),
        name: node.name,
        qualified_name: node.qualified_name,
        span: [
            node.start_line,
            node.start_column,
            node.end_line,
            node.end_column,
        ],
        signature: node.signature,
        flags,
        body_hash: node.body_hash.as_deref(),
        docstring: node.docstring,
        visibility: node.visibility,
        return_type: node.return_type,
        decorators: node.decorators,
        type_parameters: node.type_parameters,
    })?;
    if let (Some(minhash), Some(token_count), Some(_)) =
        (node.minhash, node.token_count, &node.body_hash)
    {
        let packed: Vec<u8> = minhash
            .iter()
            .flat_map(|value| value.to_be_bytes())
            .collect();
        writer.add_fingerprint(key, &packed, token_count)?;
    }
    Ok(())
}

fn write_relationships(
    writer: &mut Writer,
    file: &StagedFile,
    files: &HashMap<&str, i64>,
    nodes: &HashMap<String, i64>,
) -> Result<usize, mex_graph_core::store::Error> {
    let file_key = files[file.path];
    let mut edges = 0;
    for edge in &file.edges {
        let (evidence, site_file) = edge_evidence(edge, files, file_key);
        edges += usize::from(writer.add_edge(&EdgeRow {
            source: nodes[edge.source],
            target: nodes[edge.target],
            kind: edge.kind,
            line: Some(edge.line),
            col: edge.column,
            site_file,
            provenance: edge.provenance,
            confidence: edge.confidence.as_f64().expect("finite edge confidence"),
            method: edge.resolution_method,
            target_name: edge.metadata.as_ref().map(|metadata| metadata.target_name),
            evidence,
        })?);
    }
    for reference in &file.unresolved {
        writer.add_unresolved(&UnresolvedRow {
            source: nodes[reference.from_node_id],
            name: reference.called_name.unwrap_or(reference.reference_name),
            written_name: reference.called_name.map(|_| reference.reference_name),
            kind: reference.reference_kind,
            reason: reference.metadata["reason"].as_str().unwrap_or("unknown"),
            line: reference.line,
            col: reference.column,
            candidate: reference.candidate_id.map(|id| nodes[id]),
            receiver: reference.receiver,
        })?;
    }
    Ok(edges)
}

fn edge_evidence<'a>(
    edge: &'a StagedEdge,
    files: &HashMap<&str, i64>,
    owning_file: i64,
) -> (Option<EdgeEvidence<'a>>, Option<i64>) {
    let Some([evidence]) = &edge.evidence else {
        return (None, None);
    };
    if let Some(role) = evidence.get("declarationRole") {
        (Some(EdgeEvidence::Declaration(role.as_str())), None)
    } else if evidence.get("resolvedFilePath").is_some() {
        (Some(EdgeEvidence::Import), None)
    } else if evidence.get("heritage").is_some() {
        (Some(EdgeEvidence::Heritage), None)
    } else if let Some(expression) = evidence.get("expression").and_then(Value::as_str) {
        (Some(EdgeEvidence::Expression(expression)), None)
    } else if let Some(index) = evidence.get("argumentIndex").and_then(Value::as_u64) {
        let file = files[evidence["wiringSite"]["filePath"]
            .as_str()
            .expect("callback site path")];
        (
            Some(EdgeEvidence::Callback(index as u32)),
            (file != owning_file).then_some(file),
        )
    } else if edge.provenance == "framework" {
        let binding = evidence.get("importBinding").and_then(Value::as_str);
        (Some(EdgeEvidence::Framework(binding)), None)
    } else if let Some(specifier) = evidence.get("moduleSpecifier").and_then(Value::as_str) {
        (Some(EdgeEvidence::SyntaxImport(specifier)), None)
    } else {
        (None, None)
    }
}

fn write_source_chunks(
    writer: &Writer,
    file: i64,
    path: &str,
    source: &str,
) -> Result<(), mex_graph_core::store::Error> {
    let path_terms = split_index_terms(path);
    let lines: Vec<_> = source.split('\n').collect();
    for start in (0..lines.len()).step_by(60) {
        let end = (start + 80).min(lines.len());
        let chunk = &lines[start..end];
        let text = chunk.join("\n");
        let comments = chunk
            .iter()
            .copied()
            .filter(|line| {
                let line = line.trim_start_matches(|ch: char| {
                    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
                });
                ["//", "/*", "*", "#", "<!--"]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
            })
            .collect::<Vec<_>>()
            .join(" ");
        writer.add_source_chunk(
            file,
            [start + 1, end],
            &path_terms,
            &split_index_terms(&text),
            &comments,
            &text,
        )?;
        if end == lines.len() {
            break;
        }
    }
    Ok(())
}

/// Same ASCII token and component rules as GraphStore's v4 source index.
fn split_index_terms(value: &str) -> String {
    use std::collections::HashSet;

    let mut seen = HashSet::new();
    let mut terms = Vec::new();
    let mut push = |term: &str| {
        let term = term.to_ascii_lowercase();
        if seen.insert(term.clone()) {
            terms.push(term);
        }
    };
    for raw in value.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')) {
        let token = raw
            .trim_start_matches(|ch: char| ch.is_ascii_digit())
            .trim_matches(['_', '$']);
        if token.is_empty() {
            continue;
        }
        push(token);
        for fragment in token.split(['_', '$']) {
            let bytes = fragment.as_bytes();
            let mut start = 0;
            for i in 1..bytes.len() {
                let previous = bytes[i - 1];
                let here = bytes[i];
                if here.is_ascii_uppercase()
                    && (previous.is_ascii_lowercase()
                        || previous.is_ascii_digit()
                        || (previous.is_ascii_uppercase()
                            && bytes.get(i + 1).is_some_and(u8::is_ascii_lowercase)))
                {
                    if i - start >= 2 {
                        push(&fragment[start..i]);
                    }
                    start = i;
                }
            }
            if bytes.len() - start >= 2 {
                push(&fragment[start..]);
            }
        }
    }
    terms.join(" ")
}
