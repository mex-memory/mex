//! One build or refresh job, as `docs/design/graph-engine-contract.md` sets it out.
//!
//! Order matters: validate the request, start the guard, wait for `start` on
//! stdin, then touch the repository. Every way out other than success deletes
//! the candidate first.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{BufRead, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use mex_graph_core::CONTRACT_VERSION;
use mex_graph_core::facts::{FileFacts, ParseStatus};
use mex_graph_core::id::id_bytes;
use mex_graph_core::store::{self, EdgeRow, FileRow, NodeRow, Writer};
use mex_graph_python::{EXCLUDED, LANGUAGE, Python};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::guard::{Breach, Guard, Limits, ProcessSampler};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(dead_code, reason = "contract fields the adapters read from M2")]
pub struct Request {
    pub contract: u32,
    pub mode: String,
    pub root: PathBuf,
    pub files: Vec<RequestFile>,
    #[serde(default)]
    pub configs: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    pub output: PathBuf,
    #[serde(default)]
    pub base: Option<PathBuf>,
    #[serde(default)]
    pub changed: Vec<String>,
    #[serde(default)]
    pub facts_cache: Option<PathBuf>,
    pub limits: RequestLimits,
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
}

fn emit(value: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

pub fn emit_error(code: &str, message: &str) {
    emit(serde_json::json!({ "type": "error", "code": code, "message": message }));
}

/// The candidate and its SQLite side files.
fn remove_candidate(output: &Path) {
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
    let request: Request = serde_json::from_str(&text)
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
    if !request.output.is_absolute() || request.output.exists() {
        return Err(JobError::request(
            "output must be an absolute path that doesn't exist yet",
        ));
    }
    if !request.output.parent().is_some_and(Path::is_dir) {
        return Err(JobError::request("output's folder must exist"));
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
            interval: Duration::from_millis(10),
        },
        ProcessSampler,
        move |breach: Breach| {
            remove_candidate(&output);
            emit_error(breach.code(), "the guard stopped the job");
            std::process::exit(breach.exit_code());
        },
    ));

    // The start barrier: nothing touches the repository before Node says so.
    let mut line = String::new();
    let stdin = std::io::stdin();
    if stdin.lock().read_line(&mut line).unwrap_or(0) == 0 || line.trim() != "start" {
        remove_candidate(&request.output);
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

    let result = build(&request);
    if let Err(error) = result {
        remove_candidate(&request.output);
        return Err(error);
    }
    let counts = result.unwrap_or_default();
    emit(serde_json::json!({
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
    Ok(())
}

#[derive(Default)]
struct BuildCounts {
    files: usize,
    nodes: usize,
    edges: usize,
    coverage_gaps: usize,
}

fn build(request: &Request) -> Result<BuildCounts, JobError> {
    let write = |e: store::Error| JobError {
        code: "graph_write_failed",
        exit: 6,
        message: e.to_string(),
    };
    let root = request
        .root
        .canonicalize()
        .map_err(|e| JobError::request(format!("root: {e}")))?;
    let extracted = extract_files(&root, request);
    let mut writer = Writer::create(&request.output).map_err(write)?;
    let mut counts = BuildCounts::default();
    let mut file_facts = Vec::new();
    let mut node_rows = Vec::new();
    let mut file_rows = Vec::new();
    for (done, (file, extraction)) in request.files.iter().zip(extracted).enumerate() {
        match extraction {
            Ok(ExtractedPython { size, facts }) => {
                let id = writer
                    .add_file(&FileRow {
                        path: &facts.path,
                        content_hash: &facts.content_hash,
                        language: LANGUAGE,
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
                        .add_coverage(&file.path, "parse failed")
                        .map_err(write)?;
                    counts.coverage_gaps += 1;
                    vec![None; facts.defs.len()]
                } else {
                    write_nodes(&mut writer, id, &facts, &mut counts).map_err(write)?
                };
                file_facts.push(facts);
                node_rows.push(nodes);
                file_rows.push(id);
            }
            Err(reason) => {
                writer.add_coverage(&file.path, reason).map_err(write)?;
                counts.coverage_gaps += 1;
            }
        }
        if done % 1000 == 999 {
            emit(
                serde_json::json!({ "type": "progress", "phase": "extract", "done": done + 1, "total": request.files.len() }),
            );
        }
    }
    write_resolution(
        &mut writer,
        &file_facts,
        &node_rows,
        &file_rows,
        &mut counts,
    )
    .map_err(write)?;
    writer
        .set_meta("engine", env!("CARGO_PKG_VERSION"))
        .map_err(write)?;
    writer.finish().map_err(write)?;
    Ok(counts)
}

struct ExtractedPython {
    size: u64,
    facts: FileFacts,
}

/// Resolve inputs in request order and retain one extraction result per input.
fn extract_files(root: &Path, request: &Request) -> Vec<Result<ExtractedPython, &'static str>> {
    let python_enabled = request
        .languages
        .iter()
        .any(|language| language == LANGUAGE);
    let inputs: Vec<_> = request
        .files
        .iter()
        .map(|file| {
            let use_python = python_enabled
                && Path::new(&file.path)
                    .extension()
                    .is_some_and(|ext| ext == "py");
            match root.join(&file.path).canonicalize() {
                Ok(path) if !path.starts_with(root) => Err("outside the repository"),
                Ok(path) if !path.is_file() => Err("missing"),
                Ok(path) if use_python => Ok((&file.path, path, OnceLock::new())),
                Ok(_) => Err("no adapter yet"),
                Err(_) => Err("missing"),
            }
        })
        .collect();

    if inputs.iter().any(Result::is_ok) {
        let next = AtomicUsize::new(0);
        let threads = request
            .limits
            .threads
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
            .max(1);
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| {
                    let mut python = Python::new();
                    while let Some(input) = inputs.get(next.fetch_add(1, Ordering::Relaxed)) {
                        if let Ok((path, canonical, result)) = input {
                            result.get_or_init(|| extract_python(&mut python, path, canonical));
                        }
                    }
                });
            }
        });
    }

    inputs
        .into_iter()
        .map(|input| {
            input.and_then(|(_, _, result)| result.into_inner().expect("every input was processed"))
        })
        .collect()
}

fn extract_python(
    python: &mut Python,
    path: &str,
    canonical: &Path,
) -> Result<ExtractedPython, &'static str> {
    let bytes = std::fs::read(canonical).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "missing",
        _ => "read failed",
    })?;
    let hash = Sha256::digest(&bytes).into();
    let text = String::from_utf8_lossy(&bytes);
    Ok(ExtractedPython {
        size: bytes.len() as u64,
        facts: python.extract(path, &text, hash),
    })
}

fn write_nodes(
    writer: &mut Writer,
    file: i64,
    facts: &FileFacts,
    counts: &mut BuildCounts,
) -> Result<Vec<Option<i64>>, store::Error> {
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
        let is_async = def.flags.iter().any(|flag| flag == "async");
        let node = writer.add_node(&NodeRow {
            public_id: &id_bytes(&def.signature_identity(&facts.path)),
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
            flags: u32::from(def.exported) | (u32::from(is_async) << 1),
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
                col: 0,
                provenance: "tree-sitter",
                confidence: 1.0,
            })?;
            counts.edges += 1;
        }
    }
    Ok(rows)
}

/// Resolve calls, bases and imports across every Python file, write the
/// edges between written nodes and the per-file unresolved counts, then the
/// fingerprints: a sketch's neighbours are its callers and callees, so they
/// come after resolution. Neighbours are ordered by text id, as today.
fn write_resolution(
    writer: &mut Writer,
    files: &[FileFacts],
    node_rows: &[Vec<Option<i64>>],
    file_rows: &[i64],
    counts: &mut BuildCounts,
) -> Result<(), store::Error> {
    let resolution = mex_graph_python::resolve::resolve(files);
    let row = |(f, d): (usize, usize)| node_rows.get(f).and_then(|r| r.get(d)).copied().flatten();
    let mut written = HashSet::new();
    let mut neighbours: HashMap<(usize, usize), BTreeSet<(usize, usize)>> = HashMap::new();
    for edge in &resolution.edges {
        let (Some(source), Some(target)) = (row(edge.from), row(edge.to)) else {
            continue;
        };
        if !written.insert((source, edge.kind, target, edge.line, edge.col)) {
            continue;
        }
        writer.add_edge(&EdgeRow {
            source,
            kind: edge.kind,
            target,
            line: edge.line,
            col: edge.col,
            provenance: "tree-sitter",
            confidence: 1.0,
        })?;
        counts.edges += 1;
        if edge.kind == "calls" {
            neighbours.entry(edge.from).or_default().insert(edge.to);
            neighbours.entry(edge.to).or_default().insert(edge.from);
        }
    }
    for &(file, reason, count) in &resolution.unresolved {
        writer.add_unresolved(file_rows[file], reason, count)?;
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
                .map(|&(nf, nd)| files[nf].defs[nd].signature_id(&files[nf].path))
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
