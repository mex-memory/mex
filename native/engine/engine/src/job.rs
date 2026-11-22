//! One build or stage job, as `docs/design/graph-engine-contract.md` sets it out.
//!
//! Order matters: validate the request, start the guard, wait for `start` on
//! stdin, then touch the repository. Every way out other than success deletes
//! the candidate first.

use std::borrow::Cow;
use std::io::{BufRead, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

use mex_graph_core::CONTRACT_VERSION;
use mex_graph_core::facts::{FACTS_VERSION, FileFacts};
use mex_graph_core::store::BuildMetadata;
use mex_graph_core::timing::{self, Timer};
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_python::resolve::{Resolution, resolve};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::adapters::{Adapter, Implementation, registry};
use crate::basic::Extractors;
use crate::facts_cache::{CacheWorker, FactsCache};
use crate::frameworks::{self, Enabled};
use crate::guard::{Breach, Guard, Limits, ProcessSampler};
use crate::stage;
use crate::syntax_language::SyntaxLanguage;

const GUARD_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub contract: u32,
    pub mode: String,
    pub root: PathBuf,
    pub(super) module_root: Option<PathBuf>,
    pub files: Vec<RequestFile>,
    #[serde(default)]
    pub(super) configs: Vec<RequestConfig>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub(super) frameworks: bool,
    // A database job writes here. Stage ignores the output field.
    pub(super) output: Option<PathBuf>,
    #[serde(default)]
    pub base: Option<PathBuf>,
    pub(super) overlay: Option<PathBuf>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub facts_cache: Option<PathBuf>,
    pub limits: RequestLimits,
    pub(super) build_metadata: Option<BuildMetadata>,
    pub(super) source_directory: Option<PathBuf>,
    pub(super) observation_root: Option<String>,
    pub(super) walk_observation: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum RequestConfig {
    Path(String),
    Source { path: String, source: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFile {
    pub path: String,
    #[serde(default)]
    pub size: u64,
    pub(super) modified_at: Option<f64>,
    pub(super) extractor_version: Option<String>,
    pub(super) staged: Option<String>,
    pub(super) content_hash: Option<String>,
    pub(super) source_identity: Option<String>,
    pub(super) utf8_size: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLimits {
    pub(super) memory_mb: u64,
    pub(super) deadline_ms: u64,
    #[serde(default)]
    pub threads: Option<usize>,
}

/// A job failure, with the contract's error code and exit code.
#[derive(Debug)]
pub struct JobError {
    pub code: &'static str,
    pub exit: i32,
    pub message: String,
}

impl JobError {
    pub(super) fn request_io(error: std::io::Error) -> JobError {
        Self::request(error.to_string())
    }

    pub(super) fn request(message: impl Into<String>) -> JobError {
        JobError {
            code: "graph_request_invalid",
            exit: 2,
            message: message.into(),
        }
    }

    pub(super) fn write(error: impl ToString) -> JobError {
        JobError {
            code: "graph_write_failed",
            exit: 6,
            message: error.to_string(),
        }
    }
}

pub(super) fn emit(value: &impl Serialize) -> Result<(), JobError> {
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, value).map_err(JobError::write)?;
    out.write_all(b"\n").map_err(JobError::write)?;
    out.flush().map_err(JobError::write)
}

pub fn emit_error(code: &str, message: &str) {
    let _ = emit(&serde_json::json!({
        "type": "error", "code": code, "message": message, "usage": process_usage(0.0, 0),
    }));
}

pub(super) fn process_usage(wall_ms: impl Serialize, sampled_peak: u64) -> serde_json::Value {
    #[cfg(not(target_os = "wasi"))]
    let cpu_ms = cpu_time::ProcessTime::try_now()
        .ok()
        .map(|time| time.as_duration().as_millis() as u64);
    #[cfg(target_os = "wasi")]
    let cpu_ms: Option<u64> = None;
    let rss = memory_stats::memory_stats().map_or(0, |memory| memory.physical_mem as u64);
    serde_json::json!({
        "wallMs": wall_ms, "peakRssMb": rss.max(sampled_peak).div_ceil(1024 * 1024),
        "cpuMs": cpu_ms,
    })
}

/// The candidate and its SQLite side files.
pub(super) fn remove_candidate(output: Option<&Path>) {
    let Some(output) = output else { return };
    for suffix in ["", "-journal", "-wal", "-shm", "-edit-request"] {
        let mut path = output.as_os_str().to_owned();
        path.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(path));
    }
}

/// Read and check the request before anything else happens.
pub fn load(path: &Path, mode: &str) -> Result<Request, JobError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| JobError::request(format!("can't read the request: {e}")))?;
    let mut request: Request = serde_json::from_str(&text)
        .map_err(|e| JobError::request(format!("the request is not valid: {e}")))?;
    if request.contract != CONTRACT_VERSION {
        return Err(JobError {
            code: "graph_contract_mismatch",
            exit: 2,
            message: format!(
                "the request is contract {}, this engine is {CONTRACT_VERSION}",
                request.contract
            ),
        });
    }
    if request.mode != mode {
        return Err(JobError::request(format!(
            "the request is for {}, not {mode}",
            request.mode
        )));
    }
    if !request.root.is_absolute() || !request.root.is_dir() {
        return Err(JobError::request(
            "root must be an existing absolute folder",
        ));
    }
    if matches!(mode, "stage" | "serve") {
        request.output = None;
    } else {
        let output = request
            .output
            .as_deref()
            .ok_or_else(|| JobError::request("output is required"))?;
        if !output.is_absolute() || output.exists() {
            return Err(JobError::request(
                "output must be an absolute path that doesn't exist yet",
            ));
        }
        if !output.parent().is_some_and(Path::is_dir) {
            return Err(JobError::request("output's folder must exist"));
        }
    }
    if matches!(mode, "refresh" | "serve") {
        let base = request
            .base
            .as_deref()
            .ok_or_else(|| JobError::request("base is required for refresh and serve"))?;
        if !base.is_absolute()
            || !std::fs::symlink_metadata(base).is_ok_and(|entry| entry.is_file())
        {
            return Err(JobError::request(
                "base must be an existing absolute regular file",
            ));
        }
        if request
            .changed
            .iter()
            .chain(request.files.iter().map(|file| &file.path))
            .any(|path| !repository_path(path))
        {
            return Err(JobError::request(
                "source paths must be repository-relative and normalized",
            ));
        }
    }
    Ok(request)
}

/// Run a job to completion. Never returns on a guard breach: the guard
/// deletes the candidate and exits the process.
pub fn run(request: Request) -> Result<(), JobError> {
    let started = Instant::now();
    // WASI Preview 1 has no threads. Its Node host owns the barrier and guard.
    let guard = (!cfg!(target_os = "wasi"))
        .then(|| start_guard(&request))
        .transpose()?;

    let timing_file = if cfg!(target_os = "wasi") {
        None
    } else {
        timing_file(&request.root)
    };
    if timing_file.is_some() {
        timing::enable();
    }
    let counts = timing::measure("job", || run_started(&request));
    if let (Some(path), Some(totals)) = (timing_file, timing::take()) {
        append_timings(&path, &request.mode, totals);
    }
    let usage = process_usage(
        started.elapsed().as_millis() as u64,
        guard.as_ref().map_or(0, |guard| guard.peak_bytes()),
    );
    let counts = counts.inspect_err(|_| {
        remove_candidate(request.output.as_deref());
        let _ = emit(&serde_json::json!({"type": "usage", "usage": usage}));
    })?;
    let result = emit(&serde_json::json!({
        "type": "result",
        "files": counts.files,
        "nodes": counts.nodes,
        "edges": counts.edges,
        "coverageGaps": counts.coverage_gaps,
        "filesReextracted": counts.reextracted,
        "shadowedFiles": counts.shadowed,
        "usage": usage,
    }));
    if request.output.is_none() {
        result?;
    }
    Ok(())
}

fn start_guard(request: &Request) -> Result<Arc<Guard>, JobError> {
    let output = request.output.clone();
    let guard = Arc::new(Guard::start(
        Limits {
            memory_bytes: request.limits.memory_mb.saturating_mul(1024 * 1024),
            deadline: Duration::from_millis(request.limits.deadline_ms),
            interval: GUARD_INTERVAL,
        },
        ProcessSampler,
        move |breach: Breach| {
            let report = move || emit_error(breach.code(), "the guard stopped the job");
            if output.is_some() {
                remove_candidate(output.as_deref());
                report();
            } else {
                // The parent's pipe can be full. Bound the time to report a breach.
                let (reported, completion) = mpsc::channel();
                let _ = std::thread::Builder::new().spawn(move || {
                    report();
                    let _ = reported.send(());
                });
                let _ = completion.recv_timeout(GUARD_INTERVAL);
            }
            std::process::exit(breach.exit_code());
        },
    ));
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 || line.trim() != "start" {
        remove_candidate(request.output.as_deref());
        return Err(JobError {
            code: "graph_parent_gone",
            exit: 5,
            message: "stdin closed before start".into(),
        });
    }
    let watcher = Arc::clone(&guard);
    std::thread::spawn(move || {
        let mut sink = String::new();
        while std::io::stdin().lock().read_line(&mut sink).unwrap_or(0) > 0 {
            sink.clear();
        }
        watcher.parent_gone();
    });
    Ok(guard)
}

pub(super) fn repository_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '\0'])
        && !path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        && Path::new(path)
            .components()
            .next()
            .is_some_and(|part| matches!(part, std::path::Component::Normal(_)))
}

pub(super) fn timing_file(root: &Path) -> Option<PathBuf> {
    let raw = std::env::var_os("MEX_GRAPH_PHASE_TIMINGS")?;
    match raw.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "" | "0" | "false" | "no" | "off" => None,
        "1" | "true" | "on" | "yes" => {
            let directory = root.join(".mex/local");
            std::fs::create_dir_all(&directory).ok()?;
            Some(directory.join("graph-phase-timings.jsonl"))
        }
        _ => Some(raw.into()),
    }
}

pub(super) fn append_timings(path: &Path, mode: &str, totals: timing::Totals) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let record = serde_json::json!({
            "label": format!("engine.{mode}"),
            "pid": std::process::id(),
            "phases": totals.milliseconds(),
            "memory": [],
        });
        let _ = file.write_all(format!("{record}\n").as_bytes());
    }
}

#[derive(Default)]
pub(super) struct JobCounts {
    pub(super) files: usize,
    pub(super) nodes: usize,
    pub(super) edges: usize,
    pub(super) coverage_gaps: usize,
    pub(super) reextracted: usize,
    pub(super) shadowed: Option<usize>,
}

fn run_started(request: &Request) -> Result<JobCounts, JobError> {
    let root = request
        .root
        .canonicalize()
        .map_err(|e| JobError::request(format!("root: {e}")))?;
    let cache = request
        .facts_cache
        .as_deref()
        .filter(|_| !cfg!(target_os = "wasi"))
        .and_then(|directory| FactsCache::open(directory, request.files.len()));
    let configs = read_configs(&root, &request.configs);
    if request.mode == "refresh" {
        return stage::refresh::write(&root, request, &configs, cache.as_ref());
    }
    let inputs: Vec<_> = request.files.iter().collect();
    let mut extracted = extract_files(&root, request, &inputs, cache.as_ref());
    let enabled = if request.frameworks || request.output.is_some() {
        let _timer = Timer::start("frameworks.activate");
        let package = configs
            .iter()
            .find(|(path, _)| *path == "package.json")
            .map(|(_, text)| text.as_ref());
        let enabled = Enabled::detect(&extracted.facts, &extracted.ecmascript, package);
        extracted.activate(&enabled);
        enabled
    } else {
        Enabled::default()
    };
    let reextracted = extracted.reextracted.len();
    let mut counts = match request.output.as_deref() {
        Some(output) => stage::build::write(output, extracted, &root, request, &configs, &enabled),
        None => stage::write(
            &extracted,
            request.module_root(&root),
            &configs,
            request.frameworks.then_some(&enabled),
        ),
    }?;
    counts.reextracted = reextracted;
    Ok(counts)
}

struct Extracted {
    size: u64,
    facts: FileFacts,
    reextracted: bool,
}

pub(super) enum ExtractedFile<'a> {
    Python {
        index: usize,
        size: u64,
    },
    EcmaScript {
        index: usize,
        size: u64,
    },
    Syntax {
        language: SyntaxLanguage,
        index: usize,
        size: u64,
    },
    Basic {
        index: usize,
        size: u64,
    },
    Skipped {
        path: &'a str,
        reason: &'static str,
    },
}

#[derive(Default)]
pub(super) struct ExtractedFiles<'a> {
    /// Dense Python facts, including failed parses, indexed by its resolver.
    pub(super) facts: Vec<FileFacts>,
    pub(super) ecmascript: Vec<FileFacts>,
    pub(super) syntax: [Vec<FileFacts>; 2],
    pub(super) basic: Vec<FileFacts>,
    /// One entry per requested path, including skips, in request order.
    pub(super) files: Vec<ExtractedFile<'a>>,
    pub(super) reextracted: Vec<&'a str>,
}

impl ExtractedFiles<'_> {
    pub(super) fn file<'a>(
        &'a self,
        entry: &'a ExtractedFile<'a>,
    ) -> Result<(&'a FileFacts, u64), (&'a str, &'static str)> {
        match *entry {
            ExtractedFile::Python { index, size } => Ok((&self.facts[index], size)),
            ExtractedFile::EcmaScript { index, size } => Ok((&self.ecmascript[index], size)),
            ExtractedFile::Syntax {
                language,
                index,
                size,
            } => Ok((&self.syntax[language as usize][index], size)),
            ExtractedFile::Basic { index, size } => Ok((&self.basic[index], size)),
            ExtractedFile::Skipped { path, reason } => Err((path, reason)),
        }
    }

    pub(super) fn activate(&mut self, enabled: &Enabled) {
        enabled.activate(&mut self.facts);
        enabled.activate(&mut self.ecmascript);
    }
    pub(super) fn resolve(&self) -> Resolution {
        resolve(&self.facts)
    }

    pub(super) fn modules(&self, root: &Path, configs: &[ConfigSource<'_>]) -> ModuleResolver {
        let files = self.ecmascript.iter().map(|file| file.path.as_str());
        let config_text = configs.iter().map(|(path, text)| (*path, text.as_ref()));
        match root.to_str().filter(|path| path.starts_with('/')) {
            Some(root) => ModuleResolver::with_repository_root(root, files, config_text),
            None => ModuleResolver::new(files, config_text),
        }
    }
}

impl ExtractedFiles<'_> {
    pub(super) fn into_facts(self) -> impl Iterator<Item = FileFacts> {
        self.facts
            .into_iter()
            .chain(self.ecmascript)
            .chain(self.syntax.into_iter().flatten())
            .chain(self.basic)
    }
}

const FRAMEWORK_CAPTURE_VERSION: u32 = 1;

/// Bump the prefix when persisted projection, dependency or digest semantics change.
pub(super) fn refresh_format() -> String {
    let mut format = format!(
        "8:{FACTS_VERSION}:{}:{}:{}:{}:{FRAMEWORK_CAPTURE_VERSION}",
        mex_graph_python::ADAPTER_VERSION,
        mex_graph_ecmascript::ADAPTER_VERSION,
        mex_graph_rust::ADAPTER_VERSION,
        mex_graph_csharp::ADAPTER_VERSION
    );
    if let Some(fingerprint) = registry().basic_fingerprint() {
        format.push(':');
        format.push_str(&fingerprint);
    }
    format
}

pub(super) fn request_adapter(path: &str, languages: &[String]) -> Option<&'static Adapter> {
    registry()
        .for_path(path)
        .filter(|adapter| languages.iter().any(|name| name == adapter.id()))
}

pub(super) fn request_facts_key(
    path: &str,
    languages: &[String],
) -> Option<(&'static str, String)> {
    Some(request_adapter(path, languages)?.facts_key(FRAMEWORK_CAPTURE_VERSION))
}

/// Resolve inputs in request order and retain one extraction result per input.
pub(super) fn extract_files<'a>(
    root: &Path,
    request: &Request,
    files: &[&'a RequestFile],
    cache: Option<&FactsCache>,
) -> ExtractedFiles<'a> {
    let _timer = Timer::start("extract");
    let capture_frameworks =
        request.frameworks || request.output.is_some() || request.mode == "serve";
    let inputs: Vec<ExtractInput<'_>> = files
        .iter()
        .map(
            |&file| match request_adapter(&file.path, &request.languages) {
                Some(adapter) => Ok((file, adapter, OnceLock::new())),
                None => {
                    request.source_path(root, file)?;
                    Err("no adapter yet")
                }
            },
        )
        .collect();

    let count = inputs.iter().filter(|input| input.is_ok()).count();
    if cfg!(target_os = "wasi") {
        extraction_worker(root, request, capture_frameworks)(&inputs, None);
    } else if count != 0 {
        let next = AtomicUsize::new(0);
        // Nearby paths often repeat the same strings and fingerprint tokens.
        // Claim short runs of them when packing facts into compression blocks.
        let claim = if cache.is_some() {
            count.div_ceil(128).min(16)
        } else {
            1
        };
        let threads = request
            .limits
            .threads
            .unwrap_or_else(|| {
                let available = std::thread::available_parallelism().map_or(1, |n| n.get());
                // Bound the number of simultaneous compression workspaces.
                if cache.is_some() {
                    available.min(5)
                } else {
                    available
                }
            })
            .clamp(1, count);
        std::thread::scope(|scope| {
            let measure = timing::enabled();
            let cache_writer = cache.map(|cache| {
                let (sender, blocks) = mpsc::sync_channel(4);
                let writer = scope.spawn(move || {
                    if measure {
                        timing::enable();
                    }
                    cache.write_blocks(blocks);
                    timing::take()
                });
                (sender, writer)
            });
            let mut workers = Vec::with_capacity(threads);
            let next = &next;
            let inputs = &inputs;
            for _ in 0..threads {
                let sender = cache_writer.as_ref().map(|(sender, _)| sender.clone());
                workers.push(scope.spawn(move || {
                    if measure {
                        timing::enable();
                    }
                    let mut process = extraction_worker(root, request, capture_frameworks);
                    let mut cache = cache
                        .zip(sender)
                        .and_then(|(cache, sender)| cache.worker(sender));
                    loop {
                        let start = next.fetch_add(claim, Ordering::Relaxed);
                        if start >= inputs.len() {
                            break;
                        }
                        let end = (start + claim).min(inputs.len());
                        process(&inputs[start..end], cache.as_mut());
                    }
                    if let Some(mut cache) = cache {
                        cache.flush();
                    }
                    timing::take()
                }));
            }
            for worker in workers {
                if let Some(totals) = worker.join().expect("extraction worker") {
                    timing::merge(totals);
                }
            }
            if let Some((sender, writer)) = cache_writer {
                drop(sender);
                if let Some(totals) = writer.join().expect("cache writer") {
                    timing::merge(totals);
                }
            }
        });
    }

    let mut facts = Vec::new();
    let mut ecmascript = Vec::new();
    let mut syntax = [Vec::new(), Vec::new()];
    let mut basic = Vec::new();
    let mut reextracted = Vec::new();
    let files = inputs
        .into_iter()
        .zip(files)
        .map(|(input, file)| {
            let result = input.and_then(|(_, adapter, result)| {
                result
                    .into_inner()
                    .expect("every input was processed")
                    .map(|extracted| {
                        if extracted.reextracted {
                            reextracted.push(file.path.as_str());
                        }
                        (&adapter.implementation, extracted)
                    })
            });
            match result {
                Ok((Implementation::Python, extracted)) => {
                    let index = facts.len();
                    facts.push(extracted.facts);
                    ExtractedFile::Python {
                        index,
                        size: extracted.size,
                    }
                }
                Ok((Implementation::EcmaScript, extracted)) => {
                    let index = ecmascript.len();
                    ecmascript.push(extracted.facts);
                    ExtractedFile::EcmaScript {
                        index,
                        size: extracted.size,
                    }
                }
                Ok((&Implementation::Syntax(language), extracted)) => {
                    let facts = &mut syntax[language as usize];
                    let index = facts.len();
                    facts.push(extracted.facts);
                    ExtractedFile::Syntax {
                        language,
                        index,
                        size: extracted.size,
                    }
                }
                Ok((Implementation::Basic(_), extracted)) => {
                    let index = basic.len();
                    basic.push(extracted.facts);
                    ExtractedFile::Basic {
                        index,
                        size: extracted.size,
                    }
                }
                Err(reason) => ExtractedFile::Skipped {
                    path: &file.path,
                    reason,
                },
            }
        })
        .collect();
    ExtractedFiles {
        facts,
        ecmascript,
        syntax,
        basic,
        files,
        reextracted,
    }
}

type ExtractInput<'a> = Result<
    (
        &'a RequestFile,
        &'static Adapter,
        OnceLock<Result<Extracted, &'static str>>,
    ),
    &'static str,
>;

fn extraction_worker<'a>(
    root: &'a Path,
    request: &'a Request,
    capture_frameworks: bool,
) -> impl FnMut(&[ExtractInput<'_>], Option<&mut CacheWorker>) + 'a {
    let mut extractors = Extractors::default();
    move |inputs: &[ExtractInput<'_>], mut cache: Option<&mut CacheWorker>| {
        for (file, adapter, result) in inputs.iter().flatten() {
            result.get_or_init(|| {
                let key = cache.as_ref().map(|_| {
                    adapter.facts_key(if capture_frameworks {
                        FRAMEWORK_CAPTURE_VERSION
                    } else {
                        0
                    })
                });
                extract(
                    request,
                    root,
                    file,
                    key.as_ref(),
                    cache.as_deref_mut(),
                    |path, text, hash| {
                        let mut facts = extractors.extract(adapter, path, text, hash);
                        if capture_frameworks
                            && !matches!(adapter.implementation, Implementation::Basic(_))
                        {
                            timing::measure("worker.frameworks.capture", || {
                                frameworks::capture(&mut facts, text)
                            });
                        }
                        facts
                    },
                )
            });
        }
    }
}

fn extract(
    request: &Request,
    root: &Path,
    file: &RequestFile,
    key: Option<&(&str, String)>,
    mut cache: Option<&mut CacheWorker>,
    adapter: impl FnOnce(&str, &str, [u8; 32]) -> FileFacts,
) -> Result<Extracted, &'static str> {
    // Node captured these hashes under the maintenance lease. A standalone
    // job without that capture hashes the source before its cache lookup.
    let cached = |cache: Option<&mut CacheWorker>, hash: &[u8; 32]| {
        let (language, version) = key?;
        cache?.reader.get(&file.path, language, version, hash)
    };
    if request.source_directory.is_some()
        && let Some(hash) = file.content_hash.as_deref().and_then(decode_hash)
        && let Some(facts) = cached(cache.as_deref_mut(), &hash)
    {
        return Ok(Extracted {
            size: file.size,
            facts,
            reextracted: false,
        });
    }
    let (text, size, hash) = timing::measure("worker.read", || {
        let canonical = request.source_path(root, file)?;
        read_source(&canonical, file)
    })?;
    if let Some(facts) = cached(cache.as_deref_mut(), &hash) {
        return Ok(Extracted {
            size,
            facts,
            reextracted: false,
        });
    }
    let facts = timing::measure("worker.parseExtract", || {
        let mut facts = adapter(&file.path, &text, hash);
        facts.trim_extraction_capacity();
        facts
    });
    if let (Some(cache), Some((_, version))) = (cache, key) {
        cache.put(version, &facts);
    }
    Ok(Extracted {
        size,
        facts,
        reextracted: true,
    })
}

pub(super) fn decode_hash(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (out, pair) in bytes.iter_mut().zip(text.as_bytes().as_chunks::<2>().0) {
        *out = ((pair[0] as char).to_digit(16)? as u8) << 4 | (pair[1] as char).to_digit(16)? as u8;
    }
    Some(bytes)
}

impl Request {
    pub(super) fn module_root<'a>(&'a self, source_root: &'a Path) -> &'a Path {
        if cfg!(target_os = "wasi") {
            self.module_root.as_deref().unwrap_or(source_root)
        } else {
            source_root
        }
    }

    pub(super) fn captured_hashes(&self) -> bool {
        self.source_directory.is_some()
            && self
                .files
                .iter()
                .all(|file| file.content_hash.as_deref().and_then(decode_hash).is_some())
    }

    pub(super) fn candidate_path(&self) -> &Path {
        self.output.as_deref().expect("database job has an output")
    }

    pub(super) fn source_path(
        &self,
        root: &Path,
        file: &RequestFile,
    ) -> Result<PathBuf, &'static str> {
        let (directory, path) = match (&self.source_directory, &file.staged) {
            (Some(directory), Some(staged))
                if directory.is_absolute()
                    && staged.ends_with(".source")
                    && staged.strip_suffix(".source").is_some_and(|id| {
                        !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())
                    }) =>
            {
                (directory.as_path(), directory.join(staged))
            }
            (_, None) if !Path::new(&file.path).is_absolute() => (root, root.join(&file.path)),
            _ => return Err("invalid staged source path"),
        };
        let canonical = path.canonicalize().map_err(|_| "missing")?;
        let parent = directory.canonicalize().map_err(|_| "missing")?;
        if !canonical.starts_with(parent) {
            return Err("outside the repository");
        }
        if !canonical.is_file() {
            return Err("missing");
        }
        Ok(canonical)
    }
}

pub(super) fn read_source(
    canonical: &Path,
    file: &RequestFile,
) -> Result<(String, u64, [u8; 32]), &'static str> {
    const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
    let handle = std::fs::File::open(canonical).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "missing",
        _ => "read failed",
    })?;
    let mut bytes = Vec::new();
    handle
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "read failed")?;
    let size = bytes.len() as u64;
    if size > MAX_SOURCE_BYTES {
        return Err("too big");
    }
    let raw_hash = file
        .content_hash
        .is_none()
        .then(|| Sha256::digest(&bytes).into());
    let text = String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    let hash = raw_hash.unwrap_or_else(|| Sha256::digest(text.as_bytes()).into());
    if file
        .content_hash
        .as_ref()
        .is_some_and(|expected| decode_hash(expected) != Some(hash))
    {
        return Err("source changed");
    }
    Ok((text, size, hash))
}

pub(super) type ConfigSource<'a> = (&'a str, Cow<'a, str>);

pub(super) fn read_configs<'a>(root: &Path, configs: &'a [RequestConfig]) -> Vec<ConfigSource<'a>> {
    configs
        .iter()
        .filter_map(|config| match config {
            RequestConfig::Source { path, source } => {
                Some((path.as_str(), Cow::Borrowed(source.as_str())))
            }
            RequestConfig::Path(path) => {
                let canonical = root.join(path).canonicalize().ok()?;
                if !canonical.starts_with(root) || !canonical.is_file() {
                    return None;
                }
                let text = std::fs::read_to_string(canonical).ok()?;
                Some((path.as_str(), Cow::Owned(text)))
            }
        })
        .collect()
}
