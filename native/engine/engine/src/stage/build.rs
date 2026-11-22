//! Persist the staged facts directly, without serializing the graph to Node.

use std::collections::HashMap;
use std::path::Path;

use mex_graph_core::facts::{FileFacts, Kind, ParseStatus};
use mex_graph_core::fingerprint::K;
use mex_graph_core::store::{
    EdgeEvidence, EdgeRow, FileRow, NodeRow, RefreshBase, UnresolvedRow, Writer,
};
use mex_graph_core::timing::{self, Timer};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Projection, StagedEdge, StagedFile, StagedNode, declared_nodes};
use crate::frameworks::Enabled;
use crate::job::{
    ConfigSource, ExtractedFiles, JobCounts, JobError, Request, RequestFile, emit, read_source,
};

pub(crate) fn write(
    output: &Path,
    extracted: ExtractedFiles<'_>,
    root: &Path,
    request: &Request,
    configs: &[ConfigSource<'_>],
    frameworks: &Enabled,
) -> Result<JobCounts, JobError> {
    // Resolve before allocating the SQLite writer and its caches. Keep the
    // public ids for both the declaration pass and the relationship pass.
    progress("parse", 0, request.files.len())?;
    let projection = Projection::new(&extracted, root, configs, Some(frameworks));
    let _timer = Timer::start("v5.write");
    let write = JobError::write;
    let mut writer = Writer::create(output).map_err(write)?;
    let mut counts = JobCounts::default();
    let mut file_keys = HashMap::new();
    let mut node_keys = HashMap::new();
    let mut by_path = HashMap::new();
    // Register every declaration before writing cross-file references.
    let declarations = Timer::start("v5.declarations");
    for (index, (entry, input)) in extracted.files.iter().zip(&request.files).enumerate() {
        if index != 0 && index.is_multiple_of(256) {
            progress("parse", index, request.files.len())?;
        }
        let (facts, size) = match extracted.file(entry) {
            Ok(file) => file,
            Err((path, reason)) => {
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
        let ids = projection.ids(entry);
        register_nodes(ids, &mut node_keys, None)?;
        let file = write_file(
            &mut writer,
            root,
            request,
            input,
            facts,
            size,
            ids,
            &node_keys,
            None,
        )?;
        file_keys.insert(facts.path.as_str(), file);
        by_path.insert(facts.path.as_str(), facts);
        counts.files += 1;
        counts.coverage_gaps += usize::from(facts.health.status == ParseStatus::Failed);
    }
    counts.nodes = node_keys.len();
    drop(declarations);

    progress("resolve", 0, counts.files)?;
    let mut written = 0_usize;
    let mut digests = ResolutionDigests::default();
    projection.write(
        false,
        |file| {
            let _timer = Timer::start("v5.relationships");
            let digest = timing::measure("v5.resolutionDigest", || {
                digests.file(by_path[file.path], &file)
            })?;
            writer
                .set_file_resolution(file_keys[file.path], &digest)
                .map_err(write)?;
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
    // Final index creation and FTS compaction use their own working memory.
    drop((file_keys, by_path, node_keys, digests));
    drop(projection);
    drop(extracted);

    writer
        .set_meta("refresh_format", &crate::job::refresh_format())
        .map_err(write)?;
    writer
        .set_meta(
            "resolution_context",
            &resolution_context(root, request, configs),
        )
        .map_err(write)?;
    writer
        .set_meta("frameworks", &frameworks.names())
        .map_err(write)?;
    writer
        .set_meta("node_count", &counts.nodes.to_string())
        .map_err(write)?;
    writer
        .set_meta("edge_count", &counts.edges.to_string())
        .map_err(write)?;
    finish(writer, request, &mut counts)?;
    Ok(counts)
}

pub(super) fn finish(
    writer: Writer,
    request: &Request,
    counts: &mut JobCounts,
) -> Result<(), JobError> {
    finish_with_observations(writer, request, counts, &request.files)
}

pub(super) fn finish_with_observations<'a>(
    writer: Writer,
    request: &Request,
    counts: &mut JobCounts,
    observed: impl IntoIterator<Item = &'a RequestFile>,
) -> Result<(), JobError> {
    let _timer = Timer::start("v5.finish");
    let write = JobError::write;
    if let Some(root) = &request.observation_root {
        writer.set_meta("observation_root", root).map_err(write)?;
        if let Some(walk) = request
            .walk_observation
            .as_deref()
            .filter(|walk| walk.len() <= 1024 * 1024)
        {
            writer
                .set_meta("walk_observation_v1", walk)
                .map_err(write)?;
        }
        for file in observed {
            if let (Some(identity), Some(size)) = (&file.source_identity, file.utf8_size) {
                writer
                    .add_source_observation(&file.path, identity, size)
                    .map_err(write)?;
            } else {
                writer
                    .remove_source_observation(&file.path)
                    .map_err(write)?;
            }
        }
    }
    if let Some(metadata) = &request.build_metadata {
        counts.coverage_gaps += metadata.skipped.len();
        writer.set_build_metadata(metadata).map_err(write)?;
    }
    writer
        .set_meta("engine", env!("CARGO_PKG_VERSION"))
        .map_err(write)?;
    writer.finish().map_err(write)
}

// The resolver's complete dependency inputs for the same-facts shortcut.
// Root matters for absolute module references. Hash the engine's actual config
// texts, including fields not needed for the public freshness manifest.
pub(super) fn resolution_context(
    root: &Path,
    request: &Request,
    configs: &[ConfigSource<'_>],
) -> String {
    let mut hash = Sha256::new();
    let mut append = |input: &str| {
        hash.update(input.len().to_le_bytes());
        hash.update(input.as_bytes());
    };
    append(&root.to_string_lossy());
    for language in &request.languages {
        append(language);
    }
    for file in &request.files {
        append(&file.path);
    }
    for (path, text) in configs {
        append(path);
        append(text);
    }
    crate::hex(&hash.finalize())
}

#[derive(Default)]
pub(super) struct ResolutionDigests(Vec<u8>);

impl ResolutionDigests {
    pub(super) fn file(
        &mut self,
        facts: &FileFacts,
        file: &StagedFile<'_>,
    ) -> Result<[u8; 32], JobError> {
        // Activation can add route declarations to a file whose source has
        // not changed. The remaining declarations and health are file-local.
        let routes: Vec<_> = facts
            .defs
            .iter()
            .filter(|def| def.kind == Kind::Route)
            .collect();
        let unresolved_keys: Vec<_> = file
            .unresolved
            .iter()
            .map(|row| (row.called_name, row.candidate_id))
            .collect();
        self.0.clear();
        serde_json::to_writer(
            &mut self.0,
            &(routes, &file.edges, &file.unresolved, unresolved_keys),
        )
        .map_err(JobError::write)?;
        Ok(Sha256::digest(&self.0).into())
    }
}

pub(super) fn register_nodes<'a>(
    ids: &'a [Option<String>],
    keys: &mut HashMap<&'a str, i64>,
    base: Option<&RefreshBase>,
) -> Result<(), JobError> {
    for id in ids.iter().filter_map(Option::as_deref) {
        let key = match base {
            Some(base) => base
                .node_key(id)
                .map_err(JobError::write)?
                .unwrap_or_else(|| Writer::next_overlay_key(keys.len())),
            None => 1 + keys.len() as i64,
        };
        if keys.insert(id, key).is_some() {
            return Err(JobError::request("Duplicate public node id"));
        }
    }
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "one file's captured source and allocated keys"
)]
pub(super) fn write_file(
    writer: &mut Writer,
    root: &Path,
    request: &Request,
    input: &RequestFile,
    facts: &FileFacts,
    size: u64,
    ids: &[Option<String>],
    nodes: &HashMap<&str, i64>,
    key: Option<i64>,
) -> Result<i64, JobError> {
    let write = JobError::write;
    let health = &facts.health;
    let file = writer
        .add_file(
            key,
            &FileRow {
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
            },
        )
        .map_err(write)?;
    for (def, id, parent) in declared_nodes(facts, ids) {
        write_node(
            writer,
            StagedNode::new(facts, def, id, parent, String::new()),
            file,
            nodes,
        )
        .map_err(write)?;
    }
    if health.status == ParseStatus::Failed {
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
    let _timer = Timer::start("v5.sourceIndex");
    let (source, _, hash) = timing::measure("v5.sourceRead", || {
        request
            .source_path(root, input)
            .and_then(|path| read_source(&path, input))
    })
    .map_err(|reason| {
        JobError::request(format!("Unable to index source {}: {reason}", input.path))
    })?;
    if hash != facts.content_hash {
        return Err(JobError::request(
            "Source changed before full-text indexing",
        ));
    }
    write_source_chunks(writer, file, &facts.path, &source).map_err(write)?;
    Ok(file)
}

fn progress(phase: &str, done: usize, total: usize) -> Result<(), JobError> {
    emit(&serde_json::json!({ "type": "progress", "phase": phase, "done": done, "total": total }))
}

fn write_node(
    writer: &mut Writer,
    node: StagedNode,
    file_key: i64,
    nodes: &HashMap<&str, i64>,
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
        body_hash: node.body_hash.map(|hash| hash.0),
        docstring: node.docstring,
        visibility: node.visibility,
        return_type: node.return_type,
        decorators: node.decorators,
        type_parameters: node.type_parameters,
    })?;
    if let (Some(minhash), Some(token_count), Some(_)) =
        (node.minhash, node.token_count, &node.body_hash)
    {
        let _timer = Timer::start("v5.fingerprints");
        let values: &[u32; K] = minhash
            .try_into()
            .map_err(|_| mex_graph_core::store::Error::InvalidQuery)?;
        writer.add_fingerprint(
            key,
            values.map(u32::to_be_bytes).as_flattened(),
            token_count,
        )?;
    }
    Ok(())
}

pub(super) fn write_relationships(
    writer: &mut Writer,
    file: &StagedFile,
    files: &HashMap<&str, i64>,
    nodes: &HashMap<&str, i64>,
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
    writer: &mut Writer,
    file: i64,
    path: &str,
    source: &str,
) -> Result<(), mex_graph_core::store::Error> {
    let path_terms = split_index_terms(path);
    let line_starts: Vec<_> = std::iter::once(0)
        .chain(source.match_indices('\n').map(|(byte, _)| byte + 1))
        .collect();
    let mut comments = String::new();
    for start in (0..line_starts.len()).step_by(60) {
        let end = (start + 80).min(line_starts.len());
        let end_byte = line_starts.get(end).map_or(source.len(), |byte| byte - 1);
        let text = &source[line_starts[start]..end_byte];
        comments.clear();
        for line in text.split('\n') {
            let trimmed = line.trim_start_matches(|ch: char| {
                (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
            });
            if ["//", "/*", "*", "#", "<!--"]
                .iter()
                .any(|prefix| trimmed.starts_with(prefix))
            {
                if !comments.is_empty() {
                    comments.push(' ');
                }
                comments.push_str(line);
            }
        }
        writer.add_source_chunk(
            file,
            [start + 1, end],
            &path_terms,
            &split_index_terms(text),
            &comments,
            text,
        )?;
        if end == line_starts.len() {
            break;
        }
    }
    Ok(())
}

/// Same ASCII token and component rules as GraphStore's v4 source index.
fn split_index_terms(value: &str) -> String {
    use std::collections::HashSet;

    let lowercase = value.to_ascii_lowercase();
    let bytes = value.as_bytes();
    let connector = |byte| matches!(byte, b'_' | b'$');
    let mut seen = HashSet::new();
    let mut terms = String::new();
    let mut push = |start, end| {
        let term = &lowercase[start..end];
        if seen.insert(term) {
            if !terms.is_empty() {
                terms.push(' ');
            }
            terms.push_str(term);
        }
    };
    let mut offset = 0;
    for raw in bytes.split(|byte| !(byte.is_ascii_alphanumeric() || connector(*byte))) {
        let mut start = offset;
        let mut end = offset + raw.len();
        offset = end + 1;
        while start < end && bytes[start].is_ascii_digit() {
            start += 1;
        }
        while start < end && connector(bytes[start]) {
            start += 1;
        }
        while start < end && connector(bytes[end - 1]) {
            end -= 1;
        }
        if start == end {
            continue;
        }
        push(start, end);
        let mut part = start;
        for i in start + 1..end {
            let here = bytes[i];
            let previous = bytes[i - 1];
            if connector(here) {
                if i - part >= 2 {
                    push(part, i);
                }
                part = i + 1;
            } else if i > part
                && here.is_ascii_uppercase()
                && (previous.is_ascii_lowercase()
                    || previous.is_ascii_digit()
                    || (previous.is_ascii_uppercase()
                        && bytes.get(i + 1).is_some_and(u8::is_ascii_lowercase)))
            {
                if i - part >= 2 {
                    push(part, i);
                }
                part = i;
            }
        }
        if end - part >= 2 {
            push(part, end);
        }
    }
    terms
}

#[cfg(test)]
mod tests {
    use super::split_index_terms;

    #[test]
    fn source_index_preserves_ascii_boundaries_and_first_seen_order() {
        assert_eq!(
            split_index_terms("99__parseHTTP2Value__ parse_http$Value éVALUE _1Name"),
            "parsehttp2value parse http2 value parse_http$value http 1name name",
        );
    }
}
