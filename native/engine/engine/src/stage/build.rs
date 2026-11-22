//! Persist the staged facts directly, without serializing the graph to Node.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use mex_graph_core::facts::FileFacts;
use mex_graph_core::fingerprint::K;
use mex_graph_core::id::decode_node_id;
use mex_graph_core::store::{FileRow, NodeRow, Writer};
use mex_graph_core::timing::{self, Timer};
use sha2::{Digest, Sha256};

use super::{
    StagedNode, coverage_reason, declared_nodes, edit_facts::Signature, incremental::Corpus,
    node_ids, relations,
};
use crate::frameworks::Enabled;
use crate::job::{
    ConfigSource, ExtractedFiles, JobCounts, JobError, Request, RequestFile, emit, process_usage,
    read_source,
};

pub(crate) fn write(
    output: &Path,
    mut extracted: ExtractedFiles<'_>,
    root: &Path,
    request: &Request,
    configs: &[ConfigSource<'_>],
    frameworks: &Enabled,
) -> Result<JobCounts, JobError> {
    progress("parse", 0, request.files.len())?;
    let _timer = Timer::start("v5.write");
    let write = JobError::write;
    let mut counts = JobCounts::default();
    let mut file_keys = HashMap::new();
    let mut node_keys = HashMap::new();
    // Row IDs are dense on a new base. Slot zero is never a node.
    let mut public_ids = vec![[0; 16]];
    let mut identities = HashMap::new();
    let mut sizes = HashMap::new();
    // Register every declaration before writing cross-file references.
    let ids_by_file: Vec<_> = extracted
        .files
        .iter()
        .map(|entry| {
            extracted
                .file(entry)
                .map(|(facts, _)| node_ids(facts))
                .unwrap_or_default()
        })
        .collect();
    let nodes = ids_by_file
        .iter()
        .flatten()
        .filter(|id| id.is_some())
        .count();
    let mut writer = Writer::create(output, nodes).map_err(write)?;
    let declarations = Timer::start("v5.declarations");
    // A large base can sign each origin while the main thread writes the
    // declarations. Keep one producer so normalization does not clone
    // several large fact arenas at once.
    let signatures = std::thread::scope(|scope| {
        let signatures = (!cfg!(target_os = "wasi")
            && request.files.len() >= 1024
            && request.limits.threads != Some(1))
        .then(|| scope.spawn(|| build_signatures(&extracted, request)));
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
            let ids = &ids_by_file[index];
            register_nodes(ids, &mut node_keys, &mut public_ids)?;
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
            file_keys.insert(input.path.as_str(), file);
            identities.insert(input.path.as_str(), ids.as_slice());
            sizes.insert(input.path.as_str(), size);
            counts.files += 1;
            counts.coverage_gaps += usize::from(coverage_reason(facts).is_some());
        }
        match signatures {
            Some(worker) => worker.join().expect("signature worker"),
            None => Ok(HashMap::new()),
        }
    })?;
    counts.nodes = node_keys.len();
    drop(declarations);
    progress("parse", request.files.len(), request.files.len())?;

    // The published rows already own these fields. Release their allocations
    // before building the resolver models and dependency recorder.
    for facts in extracted
        .facts
        .iter_mut()
        .chain(&mut extracted.ecmascript)
        .chain(extracted.syntax.iter_mut().flatten())
        .chain(&mut extracted.basic)
    {
        for def in &mut facts.defs {
            if def.kind != mex_graph_core::facts::Kind::Route {
                def.sketch = None;
                def.docstring = None;
            }
        }
    }
    let by_path: HashMap<_, _> = extracted
        .files
        .iter()
        .filter_map(|file| extracted.file(file).ok())
        .map(|(facts, _)| (facts.path.as_str(), facts))
        .collect();
    progress("resolve", 0, counts.files)?;
    let load = |path: &str| by_path[path];
    let selected: HashSet<_> = by_path.keys().copied().collect();
    let mut outgoing = OutgoingBuild {
        public_ids: &public_ids,
        signatures,
        total: counts.files,
        written: 0,
        edges: 0,
        deferred: Vec::new(),
    };
    Corpus {
        root: request.module_root(root),
        request,
        configs,
        sizes: &sizes,
        load: &load,
        modules: None,
        identities: Some(&identities),
    }
    .resolve(
        &mut writer,
        frameworks,
        &selected,
        Some(&mut outgoing),
        |path| file_keys[path],
        |id| Ok(node_keys[id]),
    )?;
    counts.edges = outgoing.finish(&mut writer)?;
    drop((file_keys, by_path, node_keys, public_ids, identities));
    drop((ids_by_file, extracted));

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

fn build_signatures<'a>(
    extracted: &ExtractedFiles<'_>,
    request: &'a Request,
) -> Result<HashMap<&'a str, Signature>, JobError> {
    extracted
        .files
        .iter()
        .zip(&request.files)
        .filter_map(|(entry, input)| {
            let (facts, _) = extracted.file(entry).ok()?;
            Some(Signature::new(facts).map(|signature| (input.path.as_str(), signature)))
        })
        .collect()
}

pub(super) struct OutgoingBuild<'a> {
    public_ids: &'a [[u8; 16]],
    signatures: HashMap<&'a str, Signature>,
    total: usize,
    written: usize,
    edges: usize,
    deferred: Vec<i64>,
}

impl OutgoingBuild<'_> {
    pub(super) fn take_signature(&mut self, path: &str) -> Option<Signature> {
        self.signatures.remove(path)
    }

    pub(super) fn project(
        &mut self,
        writer: &mut Writer,
        file: i64,
        path: &str,
        projection: relations::Projection<'_>,
        incoming_callback: bool,
    ) -> Result<(), JobError> {
        if incoming_callback {
            // Only these owners need a second pass after all sites are known.
            self.deferred.push(file);
            return Ok(());
        }
        self.write(writer, file, relations::Outgoing::local(path, projection))
    }

    fn write(
        &mut self,
        writer: &mut Writer,
        file: i64,
        outgoing: relations::Outgoing<'_>,
    ) -> Result<(), JobError> {
        let _timer = Timer::start("v5.relationships");
        let digest = outgoing.digest(|key| {
            self.public_ids
                .get(key as usize)
                .copied()
                .filter(|_| key > 0)
                .ok_or_else(|| JobError::request("Missing projected node"))
        })?;
        writer
            .set_file_resolution(file, &digest)
            .map_err(JobError::write)?;
        self.edges += outgoing.write(writer)?;
        self.written += 1;
        if self.written.is_multiple_of(256) || self.written == self.total {
            progress("resolve", self.written, self.total)?;
        }
        Ok(())
    }

    fn finish(mut self, writer: &mut Writer) -> Result<usize, JobError> {
        for file in std::mem::take(&mut self.deferred) {
            let path = writer.file_path(file).map_err(JobError::write)?;
            let blob = writer
                .projection(file)
                .map_err(JobError::write)?
                .ok_or_else(|| JobError::request("Missing build projection"))?;
            let outgoing = relations::Outgoing::load(
                writer,
                file,
                &path,
                relations::decode_projection(blob)?,
            )?;
            self.write(writer, file, outgoing)?;
        }
        Ok(self.edges)
    }
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
        hash.update((input.len() as u64).to_le_bytes());
        hash.update(input.as_bytes());
    };
    append(&request.module_root(root).to_string_lossy());
    for language in &request.languages {
        append(language);
    }
    for (path, text) in configs {
        append(path);
        append(text);
    }
    crate::hex(&hash.finalize())
}

fn register_nodes<'a>(
    ids: &'a [Option<String>],
    keys: &mut HashMap<&'a str, i64>,
    public_ids: &mut Vec<[u8; 16]>,
) -> Result<(), JobError> {
    for id in ids.iter().filter_map(Option::as_deref) {
        let key = public_ids.len() as i64;
        public_ids.push(decode_node_id(id).expect("generated public ID"));
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
    if let Some(reason) = coverage_reason(facts) {
        writer.add_coverage(&facts.path, reason).map_err(write)?;
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
    index_source(writer, root, request, input, &facts.content_hash, file)?;
    Ok(file)
}

pub(super) fn index_source(
    writer: &mut Writer,
    root: &Path,
    request: &Request,
    input: &RequestFile,
    expected: &[u8; 32],
    file: i64,
) -> Result<(), JobError> {
    let _timer = Timer::start("v5.sourceIndex");
    let (source, _, hash) = timing::measure("v5.sourceRead", || {
        request
            .source_path(root, input)
            .and_then(|path| read_source(&path, input))
    })
    .map_err(|reason| {
        JobError::request(format!("Unable to index source {}: {reason}", input.path))
    })?;
    if hash != *expected {
        return Err(JobError::request(
            "Source changed before full-text indexing",
        ));
    }
    write_source_chunks(writer, file, &input.path, &source).map_err(JobError::write)
}

fn progress(phase: &str, done: usize, total: usize) -> Result<(), JobError> {
    emit(&serde_json::json!({
        "type": "progress", "phase": phase, "done": done, "total": total,
        "usage": process_usage(0, 0),
    }))
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
