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
use mex_graph_core::facts::FileFacts;
use mex_graph_core::store::BuildMetadata;
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_ecmascript::{EcmaScript, language_for_path};
use mex_graph_python::resolve::{Resolution, resolve};
use mex_graph_python::{LANGUAGE, Python};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::guard::{Breach, Guard, Limits, ProcessSampler};
use crate::stage;

const GUARD_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(dead_code, reason = "contract fields the adapters read from M2")]
pub struct Request {
    pub contract: u32,
    pub mode: String,
    pub root: PathBuf,
    pub files: Vec<RequestFile>,
    #[serde(default)]
    pub(super) configs: Vec<RequestConfig>,
    #[serde(default)]
    pub languages: Vec<String>,
    // Validated for build and cleared for stage before starting the job.
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
    content_hash: Option<String>,
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
}

fn run_started(request: &Request) -> Result<JobCounts, JobError> {
    let root = request
        .root
        .canonicalize()
        .map_err(|e| JobError::request(format!("root: {e}")))?;
    let extracted = extract_files(&root, request);
    match request.output.as_deref() {
        Some(output) => stage::build::write(output, &extracted, &root, request),
        None => stage::write(&extracted, &root, &request.configs),
    }
}

struct Extracted {
    size: u64,
    facts: FileFacts,
}

pub(super) enum ExtractedFile<'a> {
    Python { index: usize, size: u64 },
    EcmaScript { index: usize, size: u64 },
    Skipped { path: &'a str, reason: &'static str },
}

pub(super) struct ExtractedFiles<'a> {
    /// Dense Python facts, including failed parses, indexed by its resolver.
    pub(super) facts: Vec<FileFacts>,
    pub(super) ecmascript: Vec<FileFacts>,
    /// One entry per requested path, including skips, in request order.
    pub(super) files: Vec<ExtractedFile<'a>>,
}

impl ExtractedFiles<'_> {
    pub(super) fn resolve(&self) -> Resolution {
        resolve(&self.facts)
    }

    pub(super) fn modules(&self, root: &Path, configs: &[RequestConfig]) -> ModuleResolver {
        let configs = read_configs(root, configs);
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
}

/// Resolve inputs in request order and retain one extraction result per input.
fn extract_files<'a>(root: &Path, request: &'a Request) -> ExtractedFiles<'a> {
    let enabled = |language: &str| request.languages.iter().any(|name| name == language);
    let python_enabled = enabled(LANGUAGE);
    let inputs: Vec<_> = request
        .files
        .iter()
        .map(|file| {
            let adapter = if python_enabled
                && Path::new(&file.path)
                    .extension()
                    .is_some_and(|ext| ext == "py")
            {
                Some(Adapter::Python)
            } else if language_for_path(&file.path).is_some_and(enabled) {
                Some(Adapter::EcmaScript)
            } else {
                None
            };
            request.source_path(root, file).and_then(|path| {
                adapter
                    .map(|adapter| (file, path, adapter, OnceLock::new()))
                    .ok_or("no adapter yet")
            })
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
                    while let Some(input) = inputs.get(next.fetch_add(1, Ordering::Relaxed)) {
                        if let Ok((file, canonical, adapter, result)) = input {
                            result.get_or_init(|| {
                                extract(file, canonical, |path, text, hash| match adapter {
                                    Adapter::Python => python
                                        .get_or_insert_with(Python::new)
                                        .extract(path, text, hash),
                                    Adapter::EcmaScript => ecmascript
                                        .get_or_insert_with(EcmaScript::new)
                                        .extract(path, text, hash),
                                })
                            });
                        }
                    }
                });
            }
        });
    }

    let mut facts = Vec::new();
    let mut ecmascript = Vec::new();
    let files = inputs
        .into_iter()
        .zip(&request.files)
        .map(|(input, file)| {
            let result = input.and_then(|(_, _, adapter, result)| {
                result
                    .into_inner()
                    .expect("every input was processed")
                    .map(|extracted| (adapter, extracted))
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
        files,
    }
}

fn extract(
    file: &RequestFile,
    canonical: &Path,
    adapter: impl FnOnce(&str, &str, [u8; 32]) -> FileFacts,
) -> Result<Extracted, &'static str> {
    let (text, size, hash) = read_source(canonical, file)?;
    Ok(Extracted {
        size,
        facts: adapter(&file.path, &text, hash),
    })
}

impl Request {
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
            (None, None) if !Path::new(&file.path).is_absolute() => (root, root.join(&file.path)),
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
        .is_some_and(|expected| crate::hex(&hash) != *expected)
    {
        return Err("source changed");
    }
    Ok((text.into_owned(), size, hash))
}

fn read_configs<'a>(root: &Path, configs: &'a [RequestConfig]) -> Vec<(&'a str, Cow<'a, str>)> {
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
