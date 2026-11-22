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
use mex_graph_csharp::CSharp;
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_ecmascript::{EcmaScript, language_for_path};
use mex_graph_python::resolve::{Resolution, resolve};
use mex_graph_python::{LANGUAGE, Python};
use mex_graph_rust::Rust;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::facts_cache::{CacheWorker, FactsCache};
use crate::frameworks::{self, Enabled};
use crate::guard::{Breach, Guard, Limits, ProcessSampler};
use crate::stage;
use crate::syntax_language::SyntaxLanguage;

const GUARD_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub contract: u32,
    pub mode: String,
    pub root: PathBuf,
    pub files: Vec<RequestFile>,
    #[serde(default)]
    pub(super) configs: Vec<RequestConfig>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    frameworks: bool,
    // A database job writes here. Stage ignores the output field.
    output: Option<PathBuf>,
    #[serde(default)]
    pub base: Option<PathBuf>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub facts_cache: Option<PathBuf>,
    pub limits: RequestLimits,
    pub(super) build_metadata: Option<BuildMetadata>,
    source_directory: Option<PathBuf>,
    pub(super) observation_root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum RequestConfig {
    Path(String),
    Source { path: String, source: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestFile {
    pub path: String,
    #[serde(default)]
    pub size: u64,
    pub(super) modified_at: Option<f64>,
    pub(super) extractor_version: Option<String>,
    staged: Option<String>,
    pub(super) content_hash: Option<String>,
    pub(super) source_identity: Option<String>,
    pub(super) utf8_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLimits {
    pub memory_mb: u64,
    pub deadline_ms: u64,
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
    let _ = emit(&serde_json::json!({ "type": "error", "code": code, "message": message }));
}

/// The candidate and its SQLite side files.
fn remove_candidate(output: Option<&Path>) {
    let Some(output) = output else { return };
    for suffix in ["", "-journal", "-wal", "-shm"] {
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
    if mode == "stage" {
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
    if mode == "refresh" {
        let base = request
            .base
            .as_deref()
            .ok_or_else(|| JobError::request("base is required for refresh"))?;
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
            .any(|path| {
                path.is_empty()
                    || path.contains('\\')
                    || path
                        .split('/')
                        .any(|part| part.is_empty() || matches!(part, "." | ".."))
                    || Path::new(path).is_absolute()
            })
        {
            return Err(JobError::request(
                "refresh paths must be repository-relative and normalized",
            ));
        }
    }
    Ok(request)
}

/// Run a job to completion. Never returns on a guard breach: the guard
/// deletes the candidate and exits the process.
pub fn run(request: Request) -> Result<(), JobError> {
    let started = Instant::now();
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
                // A large staged line can fill stdout's pipe. The guard must
                // still exit if the parent stops draining it.
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

    // The start barrier: nothing touches the repository before Node says so.
    let mut line = String::new();
    let stdin = std::io::stdin();
    if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 || line.trim() != "start" {
        remove_candidate(request.output.as_deref());
        return Err(JobError {
            code: "graph_parent_gone",
            exit: 5,
            message: "stdin closed before start".into(),
        });
    }
    // After the barrier, stdin closing means the parent is gone.
    {
        let guard = Arc::clone(&guard);
        std::thread::spawn(move || {
            let mut sink = String::new();
            while std::io::stdin().lock().read_line(&mut sink).unwrap_or(0) > 0 {
                sink.clear();
            }
            guard.parent_gone();
        });
    }

    let counts =
        run_started(&request).inspect_err(|_| remove_candidate(request.output.as_deref()))?;
    let result = emit(&serde_json::json!({
        "type": "result",
        "files": counts.files,
        "nodes": counts.nodes,
        "edges": counts.edges,
        "coverageGaps": counts.coverage_gaps,
        "filesReextracted": counts.reextracted,
        "shadowedFiles": counts.shadowed,
        "usage": {
            "wallMs": started.elapsed().as_millis() as u64,
            "peakRssMb": guard.peak_bytes() / (1024 * 1024),
        },
    }));
    if request.output.is_none() {
        result?;
    }
    Ok(())
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
    let cache = request.facts_cache.as_deref().and_then(FactsCache::open);
    let configs = read_configs(&root, &request.configs);
    if request.mode == "refresh" {
        return stage::refresh::write(&root, request, &configs, cache.as_ref());
    }
    let inputs: Vec<_> = request.files.iter().collect();
    let mut extracted = extract_files(&root, request, &inputs, cache.as_ref());
    let enabled = if request.frameworks || request.output.is_some() {
        let package = configs
            .iter()
            .find(|(path, _)| *path == "package.json")
            .map(|(_, text)| text.as_ref());
        let enabled = Enabled::detect(&extracted.facts, &extracted.ecmascript, package);
        enabled.activate(&mut extracted.facts);
        enabled.activate(&mut extracted.ecmascript);
        enabled
    } else {
        Enabled::default()
    };
    let mut counts = match request.output.as_deref() {
        Some(output) => stage::build::write(output, &extracted, &root, request, &configs, &enabled),
        None => stage::write(
            &extracted,
            &root,
            &configs,
            request.frameworks.then_some(&enabled),
        ),
    }?;
    counts.reextracted = extracted.reextracted.len();
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
    Skipped {
        path: &'a str,
        reason: &'static str,
    },
}

pub(super) struct ExtractedFiles<'a> {
    /// Dense Python facts, including failed parses, indexed by its resolver.
    pub(super) facts: Vec<FileFacts>,
    pub(super) ecmascript: Vec<FileFacts>,
    pub(super) syntax: [Vec<FileFacts>; 2],
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

#[derive(Clone, Copy)]
enum Adapter {
    Python,
    EcmaScript,
    Syntax(SyntaxLanguage),
}

const FRAMEWORK_CAPTURE_VERSION: u32 = 1;

/// Bump the prefix when persisted projection or digest semantics change.
pub(super) fn refresh_format() -> String {
    format!(
        "1:{FACTS_VERSION}:{}:{}:{}:{}:{FRAMEWORK_CAPTURE_VERSION}",
        mex_graph_python::ADAPTER_VERSION,
        mex_graph_ecmascript::ADAPTER_VERSION,
        mex_graph_rust::ADAPTER_VERSION,
        mex_graph_csharp::ADAPTER_VERSION
    )
}

impl Adapter {
    fn version(self, path: &str, frameworks: bool) -> (&'static str, String) {
        // The capture version covers framework extraction before activation.
        let (language, adapter) = match self {
            Self::Python => (LANGUAGE, mex_graph_python::ADAPTER_VERSION),
            Self::EcmaScript => (
                language_for_path(path).unwrap(),
                mex_graph_ecmascript::ADAPTER_VERSION,
            ),
            Self::Syntax(SyntaxLanguage::Rust) => {
                (mex_graph_rust::LANGUAGE, mex_graph_rust::ADAPTER_VERSION)
            }
            Self::Syntax(SyntaxLanguage::CSharp) => (
                mex_graph_csharp::LANGUAGE,
                mex_graph_csharp::ADAPTER_VERSION,
            ),
        };
        (
            language,
            format!(
                "{language}:{FACTS_VERSION}:{adapter}:{}",
                if frameworks {
                    FRAMEWORK_CAPTURE_VERSION
                } else {
                    0
                }
            ),
        )
    }
}

pub(super) fn captured_facts_key(language: &str, path: &str) -> (&'static str, String) {
    let adapter = match language {
        LANGUAGE => Adapter::Python,
        mex_graph_rust::LANGUAGE => Adapter::Syntax(SyntaxLanguage::Rust),
        mex_graph_csharp::LANGUAGE => Adapter::Syntax(SyntaxLanguage::CSharp),
        _ => Adapter::EcmaScript,
    };
    adapter.version(path, true)
}

/// Resolve inputs in request order and retain one extraction result per input.
pub(super) fn extract_files<'a>(
    root: &Path,
    request: &Request,
    files: &[&'a RequestFile],
    cache: Option<&FactsCache>,
) -> ExtractedFiles<'a> {
    let enabled = |language: &str| request.languages.iter().any(|name| name == language);
    let python_enabled = enabled(LANGUAGE);
    let capture_frameworks = request.frameworks || request.output.is_some();
    let inputs: Vec<_> = files
        .iter()
        .map(|&file| {
            let adapter = if python_enabled
                && file
                    .path
                    .rsplit_once('.')
                    .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("py"))
            {
                Some(Adapter::Python)
            } else if language_for_path(&file.path).is_some_and(enabled) {
                Some(Adapter::EcmaScript)
            } else {
                SyntaxLanguage::for_path(&file.path)
                    .filter(|language| enabled(language.name()))
                    .map(Adapter::Syntax)
            };
            match adapter {
                Some(adapter) => Ok((file, adapter, OnceLock::new())),
                None => {
                    request.source_path(root, file)?;
                    Err("no adapter yet")
                }
            }
        })
        .collect();

    let count = inputs.iter().filter(|input| input.is_ok()).count();
    if count != 0 {
        let next = AtomicUsize::new(0);
        let threads = request
            .limits
            .threads
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
            .clamp(1, count);
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| {
                    let mut python = None;
                    let mut ecmascript = None;
                    let mut rust = None;
                    let mut csharp = None;
                    let mut cache = cache.and_then(FactsCache::worker);
                    while let Some(input) = inputs.get(next.fetch_add(1, Ordering::Relaxed)) {
                        if let Ok((file, adapter, result)) = input {
                            result.get_or_init(|| {
                                let key = cache
                                    .as_ref()
                                    .map(|_| adapter.version(&file.path, capture_frameworks));
                                extract(
                                    request,
                                    root,
                                    file,
                                    key.as_ref(),
                                    cache.as_mut(),
                                    |path, text, hash| {
                                        let mut facts = match adapter {
                                            Adapter::Python => python
                                                .get_or_insert_with(Python::new)
                                                .extract(path, text, hash),
                                            Adapter::EcmaScript => ecmascript
                                                .get_or_insert_with(EcmaScript::new)
                                                .extract(path, text, hash),
                                            Adapter::Syntax(SyntaxLanguage::Rust) => rust
                                                .get_or_insert_with(Rust::new)
                                                .extract(path, text, hash),
                                            Adapter::Syntax(SyntaxLanguage::CSharp) => csharp
                                                .get_or_insert_with(CSharp::new)
                                                .extract(path, text, hash),
                                        };
                                        if capture_frameworks {
                                            frameworks::capture(&mut facts, text);
                                        }
                                        facts
                                    },
                                )
                            });
                        }
                    }
                    if let Some(mut cache) = cache {
                        cache.flush();
                    }
                });
            }
        });
    }

    let mut facts = Vec::new();
    let mut ecmascript = Vec::new();
    let mut syntax = [Vec::new(), Vec::new()];
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
                        (adapter, extracted)
                    })
            });
            match result {
                Ok((Adapter::Python, extracted)) => {
                    let index = facts.len();
                    facts.push(extracted.facts);
                    ExtractedFile::Python {
                        index,
                        size: extracted.size,
                    }
                }
                Ok((Adapter::EcmaScript, extracted)) => {
                    let index = ecmascript.len();
                    ecmascript.push(extracted.facts);
                    ExtractedFile::EcmaScript {
                        index,
                        size: extracted.size,
                    }
                }
                Ok((Adapter::Syntax(language), extracted)) => {
                    let facts = &mut syntax[language as usize];
                    let index = facts.len();
                    facts.push(extracted.facts);
                    ExtractedFile::Syntax {
                        language,
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
        files,
        reextracted,
    }
}

fn extract(
    request: &Request,
    root: &Path,
    file: &RequestFile,
    key: Option<&(&str, String)>,
    cache: Option<&mut CacheWorker>,
    adapter: impl FnOnce(&str, &str, [u8; 32]) -> FileFacts,
) -> Result<Extracted, &'static str> {
    // Node captured these hashes under the maintenance lease. A standalone
    // job without that capture hashes the source before its cache lookup.
    let cached = |cache: Option<&CacheWorker>, hash: &[u8; 32]| {
        let (language, version) = key?;
        cache?.get(&file.path, language, version, hash)
    };
    if request.source_directory.is_some()
        && let Some(hash) = file.content_hash.as_deref().and_then(decode_hash)
        && let Some(facts) = cached(cache.as_deref(), &hash)
    {
        return Ok(Extracted {
            size: file.size,
            facts,
            reextracted: false,
        });
    }
    let canonical = request.source_path(root, file)?;
    let (text, size, hash) = read_source(&canonical, file)?;
    if let Some(facts) = cached(cache.as_deref(), &hash) {
        return Ok(Extracted {
            size,
            facts,
            reextracted: false,
        });
    }
    let facts = adapter(&file.path, &text, hash);
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
    let text = String::from_utf8_lossy(&bytes);
    let hash: [u8; 32] = if file.content_hash.is_some() {
        Sha256::digest(text.as_bytes()).into()
    } else {
        Sha256::digest(&bytes).into()
    };
    if file
        .content_hash
        .as_ref()
        .is_some_and(|expected| decode_hash(expected) != Some(hash))
    {
        return Err("source changed");
    }
    Ok((text.into_owned(), size, hash))
}

pub(super) type ConfigSource<'a> = (&'a str, Cow<'a, str>);

fn read_configs<'a>(root: &Path, configs: &'a [RequestConfig]) -> Vec<ConfigSource<'a>> {
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
