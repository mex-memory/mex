//! One build or refresh job, as `docs/design/graph-engine-contract.md` sets it out.
//!
//! Order matters: validate the request, start the guard, wait for `start` on
//! stdin, then touch the repository. Every way out other than success deletes
//! the candidate first.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mex_graph_core::CONTRACT_VERSION;
use mex_graph_core::store::Writer;
use serde::Deserialize;

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
#[expect(dead_code, reason = "contract fields the adapters read from M2")]
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
    let (files, gaps) = result.unwrap_or_default();
    emit(serde_json::json!({
        "type": "result",
        "files": files,
        "nodes": 0,
        "edges": 0,
        "coverageGaps": gaps,
        "usage": {
            "wallMs": started.elapsed().as_millis() as u64,
            "peakRssMb": guard.peak_bytes() / (1024 * 1024),
        },
    }));
    Ok(())
}

/// M1: check every requested file and record it; extraction arrives with the
/// first adapter (M2). Returns (files indexed, coverage gaps).
fn build(request: &Request) -> Result<(usize, usize), JobError> {
    let write = |e: mex_graph_core::store::Error| JobError {
        code: "graph_write_failed",
        exit: 6,
        message: e.to_string(),
    };
    let root = request
        .root
        .canonicalize()
        .map_err(|e| JobError::request(format!("root: {e}")))?;
    let mut writer = Writer::create(&request.output).map_err(write)?;
    let mut gaps = 0;
    for (done, file) in request.files.iter().enumerate() {
        let reason = match root.join(&file.path).canonicalize() {
            Ok(path) if !path.starts_with(&root) => "outside the repository",
            Ok(path) if !path.is_file() => "missing",
            Ok(_) => "no adapter yet",
            Err(_) => "missing",
        };
        writer.add_coverage(&file.path, reason).map_err(write)?;
        gaps += 1;
        if done % 1000 == 999 {
            emit(
                serde_json::json!({ "type": "progress", "phase": "extract", "done": done + 1, "total": request.files.len() }),
            );
        }
    }
    writer
        .set_meta("engine", env!("CARGO_PKG_VERSION"))
        .map_err(write)?;
    writer.finish().map_err(write)?;
    Ok((0, gaps))
}
