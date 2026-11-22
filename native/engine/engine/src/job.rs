//! One build or stage job, as `docs/design/graph-engine-contract.md` sets it out.
//!
//! Order matters: validate the request, start the guard, wait for `start` on
//! stdin, then touch the repository. Every way out other than success deletes
//! the candidate first.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{BufRead, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

use mex_graph_core::CONTRACT_VERSION;
use mex_graph_core::facts::{FileFacts, ParseStatus};
use mex_graph_core::id::id_bytes;
use mex_graph_core::store::{self, EdgeRow, FileRow, NodeRow, Writer};
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_ecmascript::{EcmaScript, language_for_path};
use mex_graph_python::resolve::{Resolution, resolve};
use mex_graph_python::{EXCLUDED, LANGUAGE, Python};
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
    configs: Vec<RequestConfig>,
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
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum RequestConfig {
    Path(String),
    Source { path: String, source: String },
}

#[derive(Debug, Deserialize)]
#[expect(dead_code, reason = "contract fields the adapters read from M2")]
pub struct RequestFile {
    pub path: String,
    #[serde(default)]
    pub size: u64,
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
    fn request(message: impl Into<String>) -> JobError {
        JobError {
            code: "graph_request_invalid",
            exit: 2,
            message: message.into(),
        }
    }

    fn write(error: impl ToString) -> JobError {
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
        Some(output) => build(output, &extracted, &root, &request.configs),
        None => stage::write(&extracted, &root, &request.configs),
    }
}

fn build(
    output: &Path,
    extracted: &ExtractedFiles<'_>,
    root: &Path,
    configs: &[RequestConfig],
) -> Result<JobCounts, JobError> {
    let write = JobError::write;
    let mut writer = Writer::create(output).map_err(write)?;
    let mut counts = JobCounts::default();
    let mut python = Rows::default();
    let mut ecmascript = Rows::default();
    for (done, file) in extracted.files.iter().enumerate() {
        let (facts, size, rows) = match *file {
            ExtractedFile::Python { index, size } => (&extracted.facts[index], size, &mut python),
            ExtractedFile::EcmaScript { index, size } => {
                (&extracted.ecmascript[index], size, &mut ecmascript)
            }
            ExtractedFile::Skipped { path, reason } => {
                writer.add_coverage(path, reason).map_err(write)?;
                counts.coverage_gaps += 1;
                continue;
            }
        };
        let id = writer
            .add_file(&FileRow {
                path: &facts.path,
                content_hash: &facts.content_hash,
                language: &facts.language,
                size,
                parse_status: match facts.health.status {
                    ParseStatus::Ok => 0,
                    ParseStatus::Partial => 1,
                    ParseStatus::Failed => 2,
                },
                error_count: facts.health.error_count,
                missing_count: facts.health.missing_count,
            })
            .map_err(write)?;
        counts.files += 1;
        let nodes = if facts.health.status == ParseStatus::Failed {
            writer
                .add_coverage(&facts.path, "parse failed")
                .map_err(write)?;
            counts.coverage_gaps += 1;
            vec![None; facts.defs.len()]
        } else {
            write_nodes(&mut writer, id, facts, &mut counts).map_err(write)?
        };
        rows.nodes.push(nodes);
        rows.files.push(id);
        if done % 1000 == 999 {
            let _ = emit(
                &serde_json::json!({ "type": "progress", "phase": "extract", "done": done + 1, "total": extracted.files.len() }),
            );
        }
    }
    let resolution = extracted.resolve();
    write_resolution(
        &mut writer,
        &extracted.facts,
        &python,
        resolution.edges.iter().map(ResolvedEdge::from),
        &resolution.unresolved,
        &mut counts,
    )
    .map_err(write)?;
    if !extracted.ecmascript.is_empty() {
        let modules = extracted.modules(root, configs);
        let resolution = mex_graph_ecmascript::resolve::resolve(&extracted.ecmascript, &modules);
        write_resolution(
            &mut writer,
            &extracted.ecmascript,
            &ecmascript,
            resolution.edges.iter().map(ResolvedEdge::from),
            &resolution.unresolved,
            &mut counts,
        )
        .map_err(write)?;
    }
    writer
        .set_meta("engine", env!("CARGO_PKG_VERSION"))
        .map_err(write)?;
    writer.finish().map_err(write)?;
    Ok(counts)
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
            match root.join(&file.path).canonicalize() {
                Ok(path) if !path.starts_with(root) => Err("outside the repository"),
                Ok(path) if !path.is_file() => Err("missing"),
                Ok(path) => adapter
                    .map(|adapter| (&file.path, path, adapter, OnceLock::new()))
                    .ok_or("no adapter yet"),
                Err(_) => Err("missing"),
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
                    while let Some(input) = inputs.get(next.fetch_add(1, Ordering::Relaxed)) {
                        if let Ok((path, canonical, adapter, result)) = input {
                            result.get_or_init(|| {
                                extract(path, canonical, |path, text, hash| match adapter {
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
    path: &str,
    canonical: &Path,
    adapter: impl FnOnce(&str, &str, [u8; 32]) -> FileFacts,
) -> Result<Extracted, &'static str> {
    let bytes = std::fs::read(canonical).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "missing",
        _ => "read failed",
    })?;
    let hash = Sha256::digest(&bytes).into();
    let text = String::from_utf8_lossy(&bytes);
    Ok(Extracted {
        size: bytes.len() as u64,
        facts: adapter(path, &text, hash),
    })
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

fn write_nodes(
    writer: &mut Writer,
    file: i64,
    facts: &FileFacts,
    counts: &mut JobCounts,
) -> Result<Vec<Option<i64>>, store::Error> {
    let compiler = facts.language != LANGUAGE;
    let mut rows = vec![None; facts.defs.len()];
    for (index, def) in facts.defs.iter().enumerate() {
        if def.flags.iter().any(|flag| flag == EXCLUDED) {
            continue;
        }
        // The adapter visits parents first. Skipped definitions leave empty slots.
        let parent = usize::try_from(def.parent)
            .ok()
            .and_then(|index| rows.get(index).copied().flatten());
        let start_line = def.range.start_line + 1;
        let flag = |name| u32::from(def.flags.iter().any(|flag| flag == name));
        let mut flags = u32::from(def.exported) | (flag("async") << 1);
        let identity = if compiler {
            flags |= (flag("static") << 2)
                | (flag("abstract") << 3)
                | (u32::from(def.is_default_export) << 4);
            def.ordinal_identity(&facts.path)
        } else {
            def.signature_identity(&facts.path)
        };
        let node = writer.add_node(&NodeRow {
            public_id: &id_bytes(&identity),
            kind: def.kind.as_str(),
            file,
            parent,
            name: &def.name,
            qualified_name: &def.qualified_name,
            span: [
                start_line,
                def.range.start_col,
                def.range.end_line + 1,
                def.range.end_col,
            ],
            signature: (!def.signature.is_empty()).then_some(def.signature.as_str()),
            flags,
            body_hash: def.body_hash.as_ref(),
            docstring: def.docstring.as_deref(),
        })?;
        rows[index] = Some(node);
        counts.nodes += 1;
        if let Some(parent) = parent {
            writer.add_edge(&EdgeRow {
                source: parent,
                kind: "contains",
                target: node,
                line: start_line,
                col: if compiler { def.range.start_col } else { 0 },
                site_file: None,
                provenance: "tree-sitter",
                confidence: 1.0,
            })?;
            counts.edges += 1;
        }
    }
    Ok(rows)
}

#[derive(Default)]
struct Rows {
    nodes: Vec<Vec<Option<i64>>>,
    files: Vec<i64>,
}

struct ResolvedEdge {
    from: (usize, usize),
    to: (usize, usize),
    kind: &'static str,
    line: u32,
    col: u32,
    callback: bool,
    site_file: Option<usize>,
}

impl From<&mex_graph_python::resolve::Edge> for ResolvedEdge {
    fn from(edge: &mex_graph_python::resolve::Edge) -> Self {
        Self {
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            line: edge.line,
            col: edge.col,
            callback: false,
            site_file: None,
        }
    }
}

impl From<&mex_graph_ecmascript::resolve::Edge> for ResolvedEdge {
    fn from(edge: &mex_graph_ecmascript::resolve::Edge) -> Self {
        Self {
            from: edge.from,
            to: edge.to,
            kind: edge.kind,
            line: edge.line,
            col: edge.col,
            callback: edge.is_callback(),
            site_file: (edge.site_file != edge.from.0).then_some(edge.site_file),
        }
    }
}

/// Write the resolved edges and the per-file unresolved counts, then the
/// fingerprints: a sketch's neighbours are its callers and callees, so they
/// come after resolution. Neighbours are ordered by text id, as today.
fn write_resolution(
    writer: &mut Writer,
    files: &[FileFacts],
    rows: &Rows,
    edges: impl Iterator<Item = ResolvedEdge>,
    unresolved: &[(usize, &'static str, u32)],
    counts: &mut JobCounts,
) -> Result<(), store::Error> {
    let row = |(f, d): (usize, usize)| rows.nodes.get(f).and_then(|r| r.get(d)).copied().flatten();
    let mut written = HashSet::new();
    let mut neighbours: HashMap<(usize, usize), BTreeSet<(usize, usize)>> = HashMap::new();
    for edge in edges {
        let (Some(source), Some(target)) = (row(edge.from), row(edge.to)) else {
            continue;
        };
        if !written.insert((
            source,
            edge.kind,
            target,
            edge.line,
            edge.col,
            edge.site_file,
        )) {
            continue;
        }
        writer.add_edge(&EdgeRow {
            source,
            kind: edge.kind,
            target,
            line: edge.line,
            col: edge.col,
            site_file: edge.site_file.map(|file| rows.files[file]),
            provenance: if edge.callback {
                "callback-synthesis"
            } else {
                "tree-sitter"
            },
            confidence: if edge.callback { 0.85 } else { 1.0 },
        })?;
        counts.edges += 1;
        if edge.kind == "calls" {
            neighbours.entry(edge.from).or_default().insert(edge.to);
            neighbours.entry(edge.to).or_default().insert(edge.from);
        }
    }
    for &(file, reason, count) in unresolved {
        writer.add_unresolved(rows.files[file], reason, count)?;
    }
    for (f, facts) in files.iter().enumerate() {
        for (d, def) in facts.defs.iter().enumerate() {
            let (Some(node), Some(sketch)) = (row((f, d)), &def.sketch) else {
                continue;
            };
            let minhash: Vec<u8> = sketch
                .minhash
                .iter()
                .flat_map(|v| v.to_be_bytes())
                .collect();
            let mut ids: Vec<String> = neighbours
                .get(&(f, d))
                .into_iter()
                .flatten()
                .map(|&(nf, nd)| {
                    let file = &files[nf];
                    if file.language == LANGUAGE {
                        file.defs[nd].signature_id(&file.path)
                    } else {
                        file.defs[nd].ordinal_id(&file.path)
                    }
                })
                .collect();
            ids.sort();
            let packed: Vec<u8> = ids
                .iter()
                .flat_map(|id| {
                    let hex = &id[id.find(':').map_or(0, |i| i + 1)..];
                    (0..hex.len() / 2)
                        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap_or(0))
                        .collect::<Vec<u8>>()
                })
                .collect();
            writer.add_fingerprint(node, &minhash, &packed, sketch.token_count)?;
        }
    }
    Ok(())
}
