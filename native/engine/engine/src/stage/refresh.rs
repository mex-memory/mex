//! Refresh from a complete source observation, with the published base as the
//! reference for row ownership. The resolver is shared with a cold build.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use mex_graph_core::facts::{FileFacts, Kind};
use mex_graph_core::store::{BaseFile, RefreshBase, Writer};

use super::{build, node_ids, project};
use crate::facts_cache::FactsCache;
use crate::frameworks::Enabled;
use crate::job::{
    ConfigSource, ExtractedFiles, JobCounts, JobError, Request, RequestFile, captured_facts_key,
    decode_hash, extract_files, refresh_format,
};

pub(crate) fn write(
    root: &Path,
    request: &Request,
    configs: &[ConfigSource<'_>],
    cache: Option<&FactsCache>,
) -> Result<JobCounts, JobError> {
    let base_path = request.base.as_deref().expect("validated refresh base");
    let base = RefreshBase::open(base_path, &refresh_format())
        .map_err(JobError::write)?
        .ok_or_else(|| JobError {
            code: "graph_refresh_base_incompatible",
            exit: 2,
            message: "A base built by the current engine is required for refresh".into(),
        })?;
    let prior = base.files().map_err(JobError::write)?;
    let mut reextracted = HashSet::new();
    let quick = reuse_resolution(
        root,
        request,
        configs,
        cache,
        &base,
        &prior,
        &mut reextracted,
    )?;
    let mut writer =
        Writer::overlay(request.candidate_path(), base_path).map_err(JobError::write)?;
    if let Some((inputs, mut extracted)) = quick {
        // All captured facts that affect resolution match the base. Existing
        // edges already use the keys that this overlay will publish.
        extracted.activate(&Enabled::from_names(
            &base.frameworks().map_err(JobError::write)?,
        ));
        let mut nodes = HashMap::new();
        for (input, entry) in inputs.iter().zip(&extracted.files) {
            let (facts, size) = extracted.file(entry).map_err(bad_source)?;
            let old = &prior[&input.path];
            let ids = node_ids(facts);
            build::register_nodes(&ids, &mut nodes, Some(&base))?;
            write_shadow(
                &mut writer,
                old.key,
                &old.resolution,
                FileInput { input, facts, size },
                root,
                request,
                &nodes,
            )?;
            writer.copy_outgoing(old.key).map_err(JobError::write)?;
        }
    } else {
        reextracted.extend(resolve_and_shadow(
            &mut writer,
            root,
            request,
            configs,
            cache,
            &base,
            &prior,
        )?);
    }

    writer.carry_parse_gaps().map_err(JobError::write)?;
    let [files, nodes, edges, shadowed] = writer.overlay_counts().map_err(JobError::write)?;
    let mut counts = JobCounts {
        files,
        nodes,
        edges,
        reextracted: reextracted.len(),
        shadowed: Some(shadowed),
        coverage_gaps: writer.failed_files().map_err(JobError::write)?,
    };
    build::finish(writer, request, &mut counts)?;
    Ok(counts)
}

/// Full resolution stays authoritative whenever a module, a declaration, a
/// call site, framework detection, or any other resolver input might change.
/// An edit that only changes the file node's end position can reuse wiring:
/// no resolver or containment edge consumes that position.
fn reuse_resolution<'a>(
    root: &Path,
    request: &'a Request,
    configs: &[ConfigSource<'_>],
    cache: Option<&FactsCache>,
    base: &RefreshBase,
    prior: &HashMap<String, BaseFile>,
    reextracted: &mut HashSet<&'a str>,
) -> Result<Option<(Vec<&'a RequestFile>, ExtractedFiles<'a>)>, JobError> {
    if !request.captured_hashes()
        || request.files.len() != prior.len()
        || build::resolution_context(root, request, configs)
            != base.resolution_context().map_err(JobError::write)?
    {
        return Ok(None);
    }
    let mut changed = Vec::new();
    for file in &request.files {
        let Some(old) = prior.get(&file.path) else {
            return Ok(None);
        };
        if old.extractor_version != file.extractor_version.as_deref().unwrap_or("mex-graph") {
            return Ok(None);
        }
        if Some(old.hash) != file.content_hash.as_deref().and_then(decode_hash)
            || old.size != file.size
        {
            changed.push(file);
        }
    }
    if changed.is_empty() {
        return Ok(Some((changed, extract_files(root, request, &[], None))));
    }
    let Some(cache_reader) = cache.and_then(FactsCache::worker) else {
        return Ok(None);
    };
    let extracted = extract_files(root, request, &changed, cache);
    reextracted.extend(extracted.reextracted.iter().copied());
    for (input, entry) in changed.iter().zip(&extracted.files) {
        let (facts, _) = extracted.file(entry).map_err(bad_source)?;
        let (language, version) = captured_facts_key(&facts.language, &input.path);
        let Some(mut old) =
            cache_reader.get(&input.path, language, &version, &prior[&input.path].hash)
        else {
            return Ok(None);
        };
        old.content_hash = facts.content_hash;
        for (before, after) in old.defs.iter_mut().zip(&facts.defs) {
            if before.kind == Kind::File && after.kind == Kind::File {
                before.range.end_byte = after.range.end_byte;
                before.range.end_line = after.range.end_line;
                before.range.end_col = after.range.end_col;
                before.name_range.end_byte = after.name_range.end_byte;
                before.name_range.end_line = after.name_range.end_line;
                before.name_range.end_col = after.name_range.end_col;
            }
        }
        if old != *facts {
            return Ok(None);
        }
    }
    Ok(Some((changed, extracted)))
}

#[derive(Clone, Copy)]
struct FileInput<'a> {
    input: &'a RequestFile,
    facts: &'a FileFacts,
    size: u64,
}

impl FileInput<'_> {
    fn matches(self, old: &BaseFile, resolution: &[u8; 32]) -> bool {
        let size = if self.input.modified_at.is_some() {
            self.input.size
        } else {
            self.size
        };
        self.facts.content_hash == old.hash
            && size == old.size
            && *resolution == old.resolution
            && self
                .input
                .extractor_version
                .as_deref()
                .unwrap_or("mex-graph")
                == old.extractor_version
    }
}

fn resolve_and_shadow<'a>(
    writer: &mut Writer,
    root: &Path,
    request: &'a Request,
    configs: &[ConfigSource<'_>],
    cache: Option<&FactsCache>,
    base: &RefreshBase,
    prior: &HashMap<String, BaseFile>,
) -> Result<Vec<&'a str>, JobError> {
    let inputs: Vec<_> = request.files.iter().collect();
    let mut extracted = extract_files(root, request, &inputs, cache);
    let package = configs
        .iter()
        .find(|(path, _)| *path == "package.json")
        .map(|(_, text)| text.as_ref());
    let enabled = Enabled::detect(&extracted.facts, &extracted.ecmascript, package);
    extracted.activate(&enabled);

    let mut files = HashMap::with_capacity(inputs.len());
    let mut by_path = HashMap::with_capacity(inputs.len());
    let mut nodes = HashMap::new();
    for (index, (input, entry)) in inputs.into_iter().zip(&extracted.files).enumerate() {
        let (facts, size) = match extracted.file(entry) {
            Ok(file) => file,
            Err(error) if request.build_metadata.is_some() => return Err(bad_source(error)),
            Err((path, reason)) => {
                writer.add_coverage(path, reason).map_err(JobError::write)?;
                continue;
            }
        };
        let key = prior
            .get(&input.path)
            .map_or_else(|| Writer::next_overlay_key(index), |file| file.key);
        files.insert(input.path.as_str(), key);
        by_path.insert(input.path.as_str(), FileInput { input, facts, size });
        build::register_nodes(&node_ids(facts), &mut nodes, Some(base))?;
    }
    for path in prior
        .keys()
        .filter(|path| !files.contains_key(path.as_str()))
    {
        writer.shadow(path).map_err(JobError::write)?;
    }
    project(
        &extracted,
        root,
        configs,
        Some(&enabled),
        false,
        |file| {
            let input = by_path[file.path];
            let digest = build::resolution_digest(input.facts, &file)?;
            if !prior
                .get(file.path)
                .is_some_and(|old| input.matches(old, &digest))
            {
                write_shadow(
                    writer,
                    files[file.path],
                    &digest,
                    input,
                    root,
                    request,
                    &nodes,
                )?;
                build::write_relationships(writer, &file, &files, &nodes)
                    .map_err(JobError::write)?;
            }
            Ok(())
        },
        |_, _| Ok(()),
    )?;

    // Fingerprints store incoming as well as outgoing calls. Re-emit every
    // otherwise identical file with a changed neighbourhood; its independently
    // compared outgoing projection can still be taken from the base.
    for path in writer.neighbouring_files().map_err(JobError::write)? {
        let old = &prior[&path];
        write_shadow(
            writer,
            old.key,
            &old.resolution,
            by_path[path.as_str()],
            root,
            request,
            &nodes,
        )?;
        writer.copy_outgoing(old.key).map_err(JobError::write)?;
    }
    Ok(extracted.reextracted)
}

fn write_shadow(
    writer: &mut Writer,
    key: i64,
    digest: &[u8; 32],
    file: FileInput<'_>,
    root: &Path,
    request: &Request,
    nodes: &HashMap<String, i64>,
) -> Result<(), JobError> {
    writer.shadow(&file.input.path).map_err(JobError::write)?;
    build::write_file(
        writer,
        root,
        request,
        file.input,
        file.facts,
        file.size,
        &node_ids(file.facts),
        nodes,
        Some(key),
    )?;
    writer
        .set_file_resolution(key, digest)
        .map_err(JobError::write)
}

fn bad_source((path, reason): (&str, &str)) -> JobError {
    JobError::request(format!("Unable to refresh input {path}: {reason}"))
}
