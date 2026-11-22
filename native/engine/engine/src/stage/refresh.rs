//! Refresh from a complete source observation using the published v5 inputs.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use mex_graph_core::store::{RefreshBase, Writer};
use mex_graph_core::timing;

use super::{
    build,
    incremental::{self, Corpus, FactLoader, Plan, Publication, PublishedOverlay},
};
use crate::facts_cache::{FactsCache, ResidentDecoder};
use crate::job::{
    ConfigSource, JobCounts, JobError, Request, RequestFile, decode_hash, extract_files,
    refresh_format, request_facts_key,
};

pub(crate) fn write(
    root: &Path,
    request: &Request,
    configs: &[ConfigSource<'_>],
    cache: Option<&FactsCache>,
) -> Result<JobCounts, JobError> {
    let base_path = request.base.as_deref().expect("validated refresh base");
    let base = open_base(base_path)?;
    let base_files = base.files().map_err(JobError::write)?;
    let overlay = request
        .overlay
        .clone()
        .map(|path| PublishedOverlay::open(path, base_path))
        .transpose()?;
    let prior = Publication {
        base: &base,
        base_files: &base_files,
        overlay: overlay.as_ref(),
    };
    let mut writer =
        Writer::overlay(request.candidate_path(), base_path).map_err(JobError::write)?;
    if let Some(overlay) = &overlay {
        writer
            .attach_previous_overlay(&overlay.path)
            .map_err(JobError::write)?;
    }
    let captured = request.captured_hashes();
    let context = build::resolution_context(root, request, configs);
    let complete = !captured
        || context
            != prior
                .current()
                .resolution_context()
                .map_err(JobError::write)?;
    let inputs: Vec<_> = request
        .files
        .iter()
        .filter(|input| {
            complete
                || !prior.file(&input.path).is_some_and(|(old, _)| {
                    Some(old.hash) == input.content_hash.as_deref().and_then(decode_hash)
                        && old.size == input.size
                        && old.extractor_version
                            == input.extractor_version.as_deref().unwrap_or("mex-graph")
                })
        })
        .collect();
    let extracted = extract_files(root, request, &inputs, cache);
    let mut reextracted: HashSet<_> = extracted.reextracted.iter().copied().collect();
    let mut sizes: HashMap<_, _> = request
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.size))
        .collect();
    for (input, entry) in inputs.iter().zip(&extracted.files) {
        match extracted.file(entry) {
            Ok((_, size)) if input.modified_at.is_none() => {
                sizes.insert(&input.path, size);
            }
            Ok(_) => {}
            Err(error) if request.build_metadata.is_some() => return Err(bad_source(error)),
            Err((path, reason)) => {
                sizes.remove(path);
                writer.add_coverage(path, reason).map_err(JobError::write)?;
            }
        }
    }
    let changed: HashMap<_, _> = extracted
        .into_facts()
        .map(|file| (file.path.clone(), file))
        .collect();
    let removed = prior
        .paths()
        .filter(|path| !sizes.contains_key(path))
        .collect();
    let enabled = incremental::framework_set(&writer, configs, &changed, &removed)?;
    let complete =
        complete || enabled.names() != prior.current().frameworks().map_err(JobError::write)?;
    // Dependency lookups jump between modules. Keep the consulted blocks
    // for this job so a traversal does not reread the same SQLite pages.
    let reader = RefCell::new(
        cache
            .and_then(FactsCache::reader)
            .zip(ResidentDecoder::new(64 * 1024 * 1024)),
    );
    let reextracted_new = RefCell::new(HashSet::new());
    let load = |input: &RequestFile| {
        if let Some(facts) = changed.get(&input.path) {
            return Ok(incremental::activate(facts.clone(), &enabled));
        }
        let cached = timing::measure("worker.cacheRead", || {
            let (language, version) = request_facts_key(&input.path, &request.languages)?;
            let hash = input.content_hash.as_deref().and_then(decode_hash)?;
            let mut cache = reader.borrow_mut();
            let (reader, decoder) = cache.as_mut()?;
            decoder.unpack(&reader.pin(&input.path, language, version, hash)?)
        });
        if let Some(facts) = cached {
            return Ok(incremental::activate(facts, &enabled));
        }
        let extracted = extract_files(root, request, &[input], cache);
        for entry in &extracted.files {
            extracted.file(entry).map_err(bad_source)?;
        }
        reextracted_new.borrow_mut().insert(input.path.clone());
        extracted
            .into_facts()
            .next()
            .map(|facts| incremental::activate(facts, &enabled))
            .ok_or_else(|| JobError::request("Unable to load resolver facts"))
    };
    let loader = FactLoader::new(request, &load, u64::MAX);
    {
        let load = |path: &str| loader.get(path);
        let corpus = Corpus {
            root,
            request,
            configs,
            sizes: &sizes,
            load: &load,
            modules: None,
        };
        Plan::new(&corpus, &prior, &writer, complete, inputs.iter().copied())?.write(
            &corpus,
            &mut writer,
            &enabled,
            &prior,
        )?;
    }
    loader.finish()?;
    let additional = reextracted_new.into_inner();
    reextracted.extend(additional.iter().map(String::as_str));
    writer
        .set_meta("frameworks", &enabled.names())
        .map_err(JobError::write)?;
    writer
        .set_meta("resolution_context", &context)
        .map_err(JobError::write)?;
    finish_with_observations(writer, request, reextracted.len(), &request.files)
}

pub(crate) fn open_base(base: &Path) -> Result<RefreshBase, JobError> {
    RefreshBase::open(base, &refresh_format())
        .map_err(JobError::write)?
        .ok_or_else(|| JobError {
            code: "graph_refresh_base_incompatible",
            exit: 2,
            message: "A base built by the current engine is required for refresh".into(),
        })
}

pub(super) fn finish_with_observations<'a>(
    writer: Writer,
    request: &Request,
    reextracted: usize,
    observed: impl IntoIterator<Item = &'a RequestFile>,
) -> Result<JobCounts, JobError> {
    writer.carry_parse_gaps().map_err(JobError::write)?;
    let [files, nodes, edges, shadowed] =
        timing::measure("v5.overlayCounts", || writer.overlay_counts()).map_err(JobError::write)?;
    let mut counts = JobCounts {
        files,
        nodes,
        edges,
        reextracted,
        shadowed: Some(shadowed),
        coverage_gaps: writer.failed_files().map_err(JobError::write)?,
    };
    build::finish_with_observations(writer, request, &mut counts, observed)?;
    Ok(counts)
}

pub(super) fn package_config<'a>(configs: &'a [ConfigSource<'_>]) -> Option<&'a str> {
    configs
        .iter()
        .find(|(path, _)| *path == "package.json")
        .map(|(_, text)| text.as_ref())
}

pub(super) fn bad_source((path, reason): (&str, &str)) -> JobError {
    JobError::request(format!("Unable to refresh input {path}: {reason}"))
}
