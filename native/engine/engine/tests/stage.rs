//! Schema v4 staging through the real engine job protocol.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use mex_graph_core::CONTRACT_VERSION;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod common;
use common::{ENGINE, last_event, run_job, spawn_job};

const FILES: [&str; 6] = [
    "src/nested.py",
    "notes.txt",
    "src/target.py",
    "src/missing.py",
    "src/bad.py",
    "src/partial.py",
];
const TARGET_SOURCE: &[u8] = b"def add(value: int) -> int:\r\n    return value + 1\r\n# \xff\r\n";
const CALL_LINE: &str = r#"            return "🐍", self.step(), add(2), loose.missing()"#;

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("mex-graph-stage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("src/nested.py"),
            format!(
                r#"from target import add
class Outer:
    class Inner:
        def step(self) -> int:
            """Return a value."""
            return 1

        async def _run(self, loose):
{CALL_LINE}
"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), "notes\n").unwrap();
        std::fs::write(dir.join("src/target.py"), TARGET_SOURCE).unwrap();
        std::fs::write(dir.join("src/bad.py"), "def (\n").unwrap();
        std::fs::write(
            dir.join("src/partial.py"),
            "class Outer:
    class Inner:
        def kept(self):
            return 23
        def bad(self, loose):
            loose.missing()
            return )
",
        )
        .unwrap();
        Self { dir }
    }

    fn request(&self, threads: usize, edit: impl FnOnce(&mut Value)) -> PathBuf {
        let mut request = json!({
            "contract": CONTRACT_VERSION,
            "mode": "stage",
            "root": self.dir,
            "files": FILES.map(|path| json!({ "path": path, "size": 1 })),
            "languages": ["python"],
            "limits": { "memoryMb": 4096, "deadlineMs": 60000, "threads": threads },
        });
        edit(&mut request);
        let path = self.dir.join("request.json");
        std::fs::write(&path, request.to_string()).unwrap();
        path
    }

    fn stage(&self, threads: usize) -> Output {
        let output = run_job("stage", &self.request(threads, |_| {}), "start\n");
        assert!(output.status.success(), "{output:?}");
        output
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn events(output: &Output) -> Vec<Value> {
    std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn rows<'a>(file: &'a Value, key: &str) -> &'a [Value] {
    file[key].as_array().unwrap()
}

fn node<'a>(file: &'a Value, qualified_name: &str) -> &'a Value {
    rows(file, "nodes")
        .iter()
        .find(|node| node["qualifiedName"] == qualified_name)
        .unwrap()
}

fn column(name: &str) -> usize {
    CALL_LINE.split_once(name).unwrap().0.encode_utf16().count()
}

#[test]
fn stages_python_rows_in_request_order() {
    let fixture = Fixture::new("rows");
    let output = fixture.stage(4);
    let records = events(&output);
    let [nested, notes, target, missing, bad, partial, result] = records.as_slice() else {
        panic!("expected one event per file and a result: {records:?}");
    };
    for (event, path) in records.iter().zip(FILES) {
        assert_eq!(event["path"], path);
    }
    assert_eq!(
        *notes,
        json!({ "type": "file", "path": "notes.txt", "status": "skipped", "reason": "no adapter yet" })
    );
    assert_eq!(
        *missing,
        json!({ "type": "file", "path": "src/missing.py", "status": "skipped", "reason": "missing" })
    );

    let staged = [nested, target, bad, partial];
    for file in staged {
        assert_eq!(file["type"], "staged");
        assert_eq!(file["language"], "python");
        assert_eq!(file["parseStatus"], file["health"]["status"]);
    }
    assert_eq!(target["size"], TARGET_SOURCE.len());
    assert_eq!(
        target["contentHash"],
        format!("{:x}", Sha256::digest(TARGET_SOURCE))
    );
    assert_eq!(
        nested["health"],
        json!({"status": "ok", "diagnosticCount": 0, "missingCount": 0,
            "errorCoverage": 0.0, "diagnostics": []})
    );
    assert_eq!(bad["parseStatus"], "failed");
    assert_eq!(bad["health"]["diagnosticCount"], 1);
    assert_eq!(
        bad["health"]["diagnostics"],
        json!([
            { "type": "ERROR", "startLine": 1, "endLine": 1 },
        ])
    );
    for key in ["nodes", "edges", "unresolved"] {
        assert!(rows(bad, key).is_empty());
    }

    let facts = Command::new(ENGINE)
        .args(["facts", "--root"])
        .arg(&fixture.dir)
        .args(staged.map(|file| file["path"].as_str().unwrap()))
        .output()
        .unwrap();
    assert!(facts.status.success(), "{facts:?}");
    let mut expected_nodes = events(&facts)
        .into_iter()
        .filter(|fact| fact.get("summary").is_none());
    for file in staged {
        for node in rows(file, "nodes") {
            let expected = expected_nodes.next().expect("a corresponding facts node");
            assert_eq!(node["filePath"], expected["path"]);
            for key in [
                "id",
                "kind",
                "name",
                "qualifiedName",
                "startLine",
                "endLine",
                "startColumn",
                "endColumn",
                "signature",
                "docstring",
                "returnType",
                "bodyHash",
                "minhash",
                "tokenCount",
            ] {
                assert_eq!(node[key], expected[key], "{key} for {}", node["id"]);
            }
        }
    }
    assert!(expected_nodes.next().is_none());

    let caller = node(nested, "Outer::Inner::_run");
    let inner = node(nested, "Outer::Inner");
    let step = node(nested, "Outer::Inner::step");
    let add = node(target, "add");
    assert_eq!(caller["containerId"], inner["id"]);
    assert_eq!(caller["isAsync"], true);
    assert_eq!(caller["isExported"], false);
    assert_eq!(
        caller["identityKey"],
        "src/nested.py\0method\0Outer::Inner::_run\0method\0(self, loose)"
    );
    assert_eq!(rows(caller, "minhash").len(), 64);
    assert_eq!(step["docstring"], "Return a value.");
    assert_eq!(step["returnType"], "int");
    assert!(inner.get("signature").is_none());
    assert!(node(nested, "src/nested.py").get("bodyHash").is_none());

    assert!(rows(nested, "edges").contains(&json!({
        "source": inner["id"], "target": caller["id"], "kind": "contains",
        "line": caller["startLine"], "provenance": "tree-sitter", "confidence": 1,
        "resolutionMethod": "lexical-containment",
    })));
    for (callee, name) in [(step, "step()"), (add, "add(2)")] {
        assert!(rows(nested, "edges").contains(&json!({
            "source": caller["id"], "target": callee["id"], "kind": "calls",
            "line": 9, "column": column(name), "provenance": "tree-sitter", "confidence": 1,
            "resolutionMethod": "engine-python",
        })));
    }
    assert!(
        rows(target, "edges")
            .iter()
            .all(|edge| edge["kind"] == "contains")
    );
    assert_eq!(
        nested["unresolved"],
        json!([{
            "fromNodeId": caller["id"], "referenceName": "missing", "referenceKind": "calls",
            "filePath": nested["path"], "language": "python", "line": 9,
            "column": column("missing()"), "status": "unresolved", "resolver": "engine-python",
            "metadata": { "reason": "untyped_receiver" },
        }])
    );

    assert_eq!(partial["parseStatus"], "partial");
    assert_eq!(rows(partial, "nodes").len(), 2);
    assert!(
        node(partial, "Outer::Inner::kept")
            .get("containerId")
            .is_none()
    );
    assert!(rows(partial, "edges").is_empty());
    assert_eq!(
        partial["unresolved"][0]["fromNodeId"],
        node(partial, "src/partial.py")["id"]
    );
    assert_eq!(
        partial["unresolved"][0]["metadata"]["reason"],
        "untyped_receiver"
    );

    assert_eq!(result["type"], "result");
    assert_eq!(result["files"], staged.len());
    assert_eq!(
        result["nodes"],
        staged
            .iter()
            .map(|file| rows(file, "nodes").len())
            .sum::<usize>()
    );
    assert_eq!(
        result["edges"],
        staged
            .iter()
            .map(|file| rows(file, "edges").len())
            .sum::<usize>()
    );
    assert_eq!(result["coverageGaps"], 3);
    assert!(result["usage"]["wallMs"].is_u64());
    assert!(result["usage"]["peakRssMb"].is_u64());
}

#[test]
fn staging_is_byte_identical_across_thread_counts() {
    fn without_usage(output: &Output) -> (&str, &str) {
        let stdout = std::str::from_utf8(&output.stdout).unwrap();
        let (prefix, usage_and_suffix) = stdout.rsplit_once(",\"usage\":").unwrap();
        let (usage, suffix) = usage_and_suffix.split_once('}').unwrap();
        assert!(usage.starts_with('{'));
        (prefix, suffix)
    }

    let fixture = Fixture::new("threads");
    let one = fixture.stage(1);
    let four = fixture.stage(4);
    assert_eq!(without_usage(&one), without_usage(&four));
}

#[test]
fn stage_refuses_contract_one_before_start() {
    let fixture = Fixture::new("contract");
    let request = fixture.request(1, |r| r["contract"] = 1.into());
    let output = run_job("stage", &request, "");
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(last_event(&output)["code"], "graph_contract_mismatch");
}

#[test]
fn stage_waits_for_start_and_ignores_the_output_path() {
    let fixture = Fixture::new("barrier");
    let sentinel = fixture.dir.join("existing.db");
    std::fs::write(&sentinel, "keep me").unwrap();
    let request = fixture.request(1, |r| r["output"] = json!(sentinel));
    let waiting = run_job("stage", &request, "");
    assert_eq!(waiting.status.code(), Some(5));
    assert_eq!(events(&waiting).len(), 1);
    assert_eq!(last_event(&waiting)["code"], "graph_parent_gone");
    let started = run_job("stage", &request, "start\n");
    assert!(started.status.success(), "{started:?}");
    assert_eq!(last_event(&started)["type"], "result");
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "keep me");
}

#[test]
fn guard_exits_with_stage_stdout_backpressured() {
    let fixture = Fixture::new("backpressure");
    let source = format!(
        "def run(receiver):\n{}",
        "    receiver.missing()\n".repeat(8192)
    );
    std::fs::write(fixture.dir.join("src/large.py"), source).unwrap();
    let request = fixture.request(1, |r| {
        r["files"] = json!([{ "path": "src/large.py" }]);
        r["limits"]["deadlineMs"] = 5000.into();
    });
    let mut child = spawn_job("stage", &request);
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"start\n").unwrap();
    // Let the engine start a line larger than the stdout pipe, then stop
    // reading and close stdin. Draining stdout in wait would hide the stall.
    const STAGED_PREFIX: &[u8] = b"{\"type\":\"staged\"";
    let mut prefix = [0; STAGED_PREFIX.len()];
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut prefix)
        .unwrap();
    assert_eq!(&prefix, STAGED_PREFIX);
    drop(stdin);

    let timeout = Instant::now() + Duration::from_secs(3);
    while Instant::now() < timeout {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(5));
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    child.wait().unwrap();
    panic!("stage did not exit with a closed parent pipe");
}
