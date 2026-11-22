//! Resident JSONL edit protocol. Only the parent publishes a candidate.

use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use mex_graph_core::store::BuildMetadata;
use mex_graph_core::timing;
use serde::Deserialize;
use serde_json::json;

use crate::guard::{Guard, Limits, ProcessSampler};
use crate::job::{
    JobError, Request, RequestConfig, RequestFile, append_timings, emit, emit_error, process_usage,
    remove_candidate, repository_path, timing_file,
};
use crate::stage::serve::{Edit, Pending, Session};

const MAX_FRAME_BYTES: u64 = 128 * 1024 * 1024;
const INTERVAL: Duration = Duration::from_millis(10);

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Edit {
        id: u64,
        output: PathBuf,
        files: Vec<RequestFile>,
        #[serde(default)]
        deleted: Vec<String>,
        configs: Option<Vec<RequestConfig>>,
        source_directory: Option<PathBuf>,
        build_metadata: Option<Box<BuildMetadata>>,
        walk_observation: Option<String>,
    },
    Verify {
        id: u64,
        stamps: Vec<Stamp>,
    },
    Accept {
        id: u64,
        overlay: PathBuf,
    },
    Discard {
        id: u64,
    },
    Close,
}

#[derive(Deserialize)]
struct Stamp {
    path: String,
    identity: Option<String>,
    directory: bool,
}

struct Candidate {
    id: u64,
    _output: CandidateFile,
    pending: Pending,
}

struct CandidateFile(PathBuf);

impl Drop for CandidateFile {
    fn drop(&mut self) {
        remove_candidate(Some(&self.0));
    }
}

pub(crate) fn run(request: Request) -> Result<(), JobError> {
    let active = Arc::new(Mutex::new(None::<PathBuf>));
    let opening = Arc::new(AtomicBool::new(true));
    let guard = Arc::new(Guard::start(
        Limits {
            memory_bytes: request.limits.memory_mb.saturating_mul(1024 * 1024),
            deadline: Duration::from_millis(request.limits.deadline_ms),
            interval: INTERVAL,
        },
        ProcessSampler,
        {
            let active = Arc::clone(&active);
            move |breach| {
                if let Some(path) = active.lock().expect("candidate lock").take() {
                    remove_candidate(Some(&path));
                }
                // Stdout can be blocked if the client stopped draining the pipe.
                let (sent, completed) = mpsc::channel();
                std::thread::spawn(move || {
                    emit_error(breach.code(), "the guard stopped the resident engine");
                    let _ = sent.send(());
                });
                let _ = completed.recv_timeout(INTERVAL);
                std::process::exit(breach.exit_code());
            }
        },
    ));

    let (sender, frames) = mpsc::sync_channel(1);
    {
        let guard = Arc::clone(&guard);
        let active = Arc::clone(&active);
        let opening = Arc::clone(&opening);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            loop {
                let line = read_frame(&mut stdin);
                if matches!(line, Ok(None))
                    && (opening.load(Ordering::Acquire)
                        || active.lock().expect("candidate lock").is_some())
                {
                    guard.parent_gone();
                }
                let done = !matches!(line, Ok(Some(_)));
                if sender.send(line).is_err() || done {
                    break;
                }
            }
        });
    }

    let start = next_frame(&frames)?;
    if start.is_none() {
        return Err(JobError {
            code: "graph_parent_gone",
            exit: 5,
            message: "stdin closed before start".into(),
        });
    }
    if start.as_deref() != Some("start\n") {
        return Err(JobError::request("Expected the start barrier"));
    }
    let timing_path = timing_file(&request.root);
    if timing_path.is_some() {
        timing::enable();
    }
    let root = request.root.clone();
    let mut session = Session::open(request)?;
    opening.store(false, Ordering::Release);
    record_timings(timing_path.as_deref(), "serve.open");
    emit(&json!({"type": "ready", "usage": process_usage(0, guard.peak_bytes())}))?;

    let mut candidate: Option<Candidate> = None;
    while let Some(line) = next_frame(&frames)? {
        let command = serde_json::from_str(&line)
            .map_err(|error| JobError::request(format!("Invalid serve frame: {error}")))?;
        match command {
            Command::Edit {
                id,
                output,
                files,
                deleted,
                configs,
                source_directory,
                build_metadata,
                walk_observation,
            } => {
                if candidate.is_some() {
                    return Err(JobError::request("An edit is already awaiting publication"));
                }
                session.output_path(&output)?;
                let started = Instant::now();
                *active.lock().expect("candidate lock") = Some(output.clone());
                let result = timing::measure("job", || {
                    session.edit(Edit {
                        output: output.clone(),
                        files,
                        deleted,
                        configs,
                        source_directory,
                        build_metadata: build_metadata.map(|metadata| *metadata),
                        walk_observation,
                    })
                });
                *active.lock().expect("candidate lock") = None;
                record_timings(timing_path.as_deref(), "serve");
                let (counts, pending) = result.inspect_err(|_| remove_candidate(Some(&output)))?;
                candidate = Some(Candidate {
                    id,
                    _output: CandidateFile(output),
                    pending,
                });
                emit(&json!({
                    "type": "result", "id": id,
                    "files": counts.files, "nodes": counts.nodes, "edges": counts.edges,
                    "coverageGaps": counts.coverage_gaps, "filesReextracted": counts.reextracted,
                    "shadowedFiles": counts.shadowed,
                    "usage": process_usage(started.elapsed().as_secs_f64() * 1000.0, guard.peak_bytes()),
                }))?;
            }
            Command::Verify { id, stamps } => {
                let pending = &require(&candidate, id)?.pending;
                let started = Instant::now();
                let verified = timing::measure("verify", || verify(&root, pending, &stamps));
                record_timings(timing_path.as_deref(), "serve.verify");
                emit(&json!({"type": "verified", "id": id, "matches": verified,
                    "wallMs": started.elapsed().as_secs_f64() * 1000.0,
                    "usage": process_usage(0, guard.peak_bytes())}))?;
            }
            Command::Accept { id, overlay } => {
                require(&candidate, id)?;
                let published = candidate.take().expect("matching candidate");
                session.accept(published.pending, overlay)?;
                emit(
                    &json!({"type": "accepted", "id": id, "usage": process_usage(0, guard.peak_bytes())}),
                )?;
            }
            Command::Discard { id } => {
                require(&candidate, id)?;
                candidate = None;
                emit(
                    &json!({"type": "discarded", "id": id, "usage": process_usage(0, guard.peak_bytes())}),
                )?;
            }
            Command::Close => return Ok(()),
        }
    }
    Ok(())
}

fn record_timings(path: Option<&Path>, mode: &str) {
    if let (Some(path), Some(totals)) = (path, timing::take()) {
        append_timings(path, mode, totals);
    }
    if path.is_some() {
        timing::enable();
    }
}

fn require(candidate: &Option<Candidate>, id: u64) -> Result<&Candidate, JobError> {
    candidate
        .as_ref()
        .filter(|candidate| candidate.id == id)
        .ok_or_else(|| JobError::request("The edit id does not match the pending candidate"))
}

fn read_frame(stdin: &mut impl BufRead) -> Result<Option<String>, JobError> {
    let mut line = String::new();
    let bytes = stdin
        .take(MAX_FRAME_BYTES + 1)
        .read_line(&mut line)
        .map_err(JobError::request_io)?;
    if bytes == 0 {
        return Ok(None);
    }
    if bytes as u64 > MAX_FRAME_BYTES || !line.ends_with('\n') {
        return Err(JobError::request("Unterminated or oversized serve frame"));
    }
    Ok(Some(line))
}

fn next_frame(
    frames: &mpsc::Receiver<Result<Option<String>, JobError>>,
) -> Result<Option<String>, JobError> {
    frames.recv().unwrap_or(Ok(None))
}

fn verify(root: &Path, pending: &Pending, stamps: &[Stamp]) -> bool {
    let files = pending.files();
    // Metadata reads are independent. Split the large, stable part of the
    // corpus into a few disjoint batches; no source text is opened here.
    std::thread::scope(|scope| {
        let workers: Vec<_> = files
            .chunks(files.len().div_ceil(8).max(1))
            .map(|files| {
                scope.spawn(move || {
                    files.iter().all(|file| {
                        file.source_identity
                            .as_deref()
                            .is_some_and(|stamp| stamp_matches(root, &file.path, stamp, false))
                    })
                })
            })
            .collect();
        let matches = stamps.iter().all(|entry| {
            (entry.path == "." && entry.directory || repository_path(&entry.path))
                && match &entry.identity {
                    Some(identity) => stamp_matches(root, &entry.path, identity, entry.directory),
                    None => std::fs::symlink_metadata(root.join(&entry.path)).is_err_and(|error| {
                        matches!(
                            error.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                        )
                    }),
                }
        });
        workers
            .into_iter()
            .all(|worker| worker.join().unwrap_or(false))
            && matches
    })
}

#[cfg(unix)]
fn stamp_matches(root: &Path, path: &str, stamp: &str, directory: bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::symlink_metadata(root.join(path)) else {
        return false;
    };
    if (if directory {
        !meta.is_dir()
    } else {
        !meta.is_file()
    }) || meta.ino() == 0
    {
        return false;
    }
    let mut parts = stamp.split(':');
    let mtime = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    let ctime = i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec());
    ctime % 1_000_000 != 0
        && [
            i128::from(meta.dev()),
            i128::from(meta.ino()),
            i128::from(meta.size()),
            mtime,
            ctime,
        ]
        .iter()
        .all(|value| parts.next().and_then(|part| part.parse::<i128>().ok()) == Some(*value))
        && parts.next().is_none()
}

#[cfg(not(unix))]
fn stamp_matches(_root: &Path, _path: &str, _stamp: &str, _directory: bool) -> bool {
    false
}
