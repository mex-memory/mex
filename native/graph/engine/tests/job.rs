//! The job lifecycle from docs/design/graph-engine-contract.md, against the
//! real binary: the start barrier, every exit code, and the rule that a job
//! that fails leaves no candidate behind.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const ENGINE: &str = env!("CARGO_BIN_EXE_mex-graph");

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("mex-graph-job-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo/src")).unwrap();
        std::fs::create_dir_all(dir.join("index")).unwrap();
        std::fs::write(dir.join("repo/src/app.py"), "def main():\n    pass\n").unwrap();
        Fixture { dir }
    }

    fn output(&self) -> PathBuf {
        self.dir.join("index/graph-tmp-1-test.db")
    }

    fn request(&self, edit: impl FnOnce(&mut serde_json::Value)) -> PathBuf {
        let mut request = serde_json::json!({
            "contract": 1,
            "mode": "build",
            "root": self.dir.join("repo"),
            "files": [{ "path": "src/app.py", "size": 21 }, { "path": "src/gone.py" }],
            "languages": [],
            "output": self.output(),
            "limits": { "memoryMb": 4096, "deadlineMs": 60000 }
        });
        edit(&mut request);
        let path = self.dir.join("index/request.json");
        std::fs::write(&path, request.to_string()).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn run(request: &Path, stdin_text: &str) -> Output {
    let mut child = Command::new(ENGINE)
        .args(["build", "--request"])
        .arg(request)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(stdin_text.as_bytes()).unwrap();
    // Keep the parent pipe open for started jobs until the child exits.
    let _parent_stdin = (!stdin_text.is_empty()).then_some(stdin);
    child.wait_with_output().unwrap()
}

fn last_event(output: &Output) -> serde_json::Value {
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(text.lines().last().expect("an event")).unwrap()
}

#[test]
fn builds_a_schema_v5_candidate_after_start() {
    let f = Fixture::new("ok");
    let out = run(&f.request(|_| {}), "start\n");
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let result = last_event(&out);
    assert_eq!(result["type"], "result");
    assert_eq!(result["coverageGaps"], 2);
    assert!(result["usage"]["peakRssMb"].as_u64().is_some());
    let db = rusqlite::Connection::open(f.output()).unwrap();
    let version: String = db
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(version, "5");
    let missing: String = db
        .query_row(
            "SELECT reason FROM coverage WHERE path = 'src/gone.py'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(missing, "missing");
}

#[test]
fn does_nothing_without_start() {
    let f = Fixture::new("no-start");
    let out = run(&f.request(|_| {}), "");
    assert_eq!(out.status.code(), Some(5));
    assert_eq!(last_event(&out)["code"], "graph_parent_gone");
    assert!(!f.output().exists());
}

#[test]
fn refuses_another_contract() {
    let f = Fixture::new("contract");
    let out = run(&f.request(|r| r["contract"] = 99.into()), "start\n");
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(last_event(&out)["code"], "graph_contract_mismatch");
    assert!(!f.output().exists());
}

#[test]
fn stops_over_the_memory_cap_and_leaves_nothing() {
    let f = Fixture::new("memory");
    // 1 MB is below any process's resident memory: the guard trips at once.
    let out = run(
        &f.request(|r| r["limits"]["memoryMb"] = 1.into()),
        "start\n",
    );
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(last_event(&out)["code"], "graph_memory_limit");
    assert!(!f.output().exists());
}

#[test]
fn never_writes_over_an_existing_file() {
    let f = Fixture::new("exists");
    std::fs::write(f.output(), "keep me").unwrap();
    let out = run(&f.request(|_| {}), "start\n");
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(std::fs::read_to_string(f.output()).unwrap(), "keep me");
}

#[test]
fn keeps_files_outside_the_root_out() {
    let f = Fixture::new("escape");
    std::fs::write(f.dir.join("secret.py"), "x = 1\n").unwrap();
    let out = run(
        &f.request(|r| r["files"] = serde_json::json!([{ "path": "../secret.py" }])),
        "start\n",
    );
    assert_eq!(out.status.code(), Some(0));
    let db = rusqlite::Connection::open(f.output()).unwrap();
    let reason: String = db
        .query_row("SELECT reason FROM coverage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(reason, "outside the repository");
}
