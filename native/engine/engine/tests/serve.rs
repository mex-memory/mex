//! Exercise the resident pipe with the real v5 writer and resolver.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use mex_graph_core::CONTRACT_VERSION;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ENGINE: &str = env!("CARGO_BIN_EXE_mex-graph");

struct Checkout(PathBuf);

impl Checkout {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("mex-graph-serve-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }

    fn write(&self, path: &str, bytes: &str) -> Value {
        std::fs::write(self.0.join(path), bytes).unwrap();
        json!({"path": path, "size": bytes.len(), "contentHash": format!("{:x}", Sha256::digest(bytes))})
    }

    fn request(&self, mode: &str, base: &Path, files: &[Value], overlay: Option<&Path>) -> PathBuf {
        let path = self.0.join("request.json");
        std::fs::write(
            &path,
            json!({
                "contract": CONTRACT_VERSION, "mode": mode, "root": self.0, "base": base,
                "overlay": overlay, "output": base, "files": files, "languages": ["typescript"],
                "factsCache": self.0.join("facts"),
                "limits": {"memoryMb": 1024, "deadlineMs": 60000}
            })
            .to_string(),
        )
        .unwrap();
        path
    }

    fn base(&self) -> (PathBuf, Vec<Value>) {
        let files = vec![
            self.write("leaf.ts", "export function leaf() { return 1; }\n"),
            self.write(
                "use.ts",
                "import {leaf} from './leaf'; export function use() { return leaf(); }\n",
            ),
        ];
        let path = self.0.join("base.db");
        let mut child = spawn("build", &self.request("build", &path, &files, None));
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"start\n").unwrap();
        assert!(child.wait_with_output().unwrap().status.success());
        (path, files)
    }
}

impl Drop for Checkout {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn spawn(mode: &str, request: &Path) -> Child {
    Command::new(ENGINE)
        .args([mode, "--request"])
        .arg(request)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Server {
    fn start(request: &Path) -> Self {
        let mut child = spawn("serve", request);
        let mut stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        stdin.write_all(b"start\n").unwrap();
        let mut server = Self {
            child,
            stdin,
            stdout,
        };
        assert_eq!(server.read()["type"], "ready");
        server
    }

    fn send(&mut self, command: Value) -> Value {
        writeln!(self.stdin, "{command}").unwrap();
        self.read()
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|error| panic!("{error}: {line}"))
    }

    fn eof(self) -> Option<i32> {
        drop(self.stdin);
        self.child.wait_with_output().unwrap().status.code()
    }
}

#[test]
fn publishes_only_after_accept_and_reuses_the_structural_overlay() {
    let checkout = Checkout::new("edit");
    let (base, mut files) = checkout.base();
    let mut server = Server::start(&checkout.request("serve", &base, &files, None));
    let discarded = checkout.0.join("discarded.db");
    let result = server.send(
        json!({"type": "edit", "id": 1, "output": discarded, "files": [
            checkout.write("leaf.ts", "export function leaf() { return 1; }\n// one\n")
        ]}),
    );
    assert_eq!(result["filesReextracted"], 1, "{result}");
    assert!(discarded.is_file());
    assert_eq!(
        server.send(json!({"type":"discard","id":1}))["type"],
        "discarded"
    );
    assert!(!discarded.exists());

    std::fs::remove_file(checkout.0.join("leaf.ts")).unwrap();
    let moved = checkout.write("moved.ts", "export function renamed() { return 2; }\n");
    files[1] = checkout.write(
        "use.ts",
        "import {renamed} from './moved'; export function use() { return renamed(); }\n",
    );
    files[0] = moved;
    let candidate = checkout.0.join("candidate.db");
    let result = server
        .send(json!({"type":"edit","id":2,"output":candidate,"files":files,"deleted":["leaf.ts"]}));
    assert_eq!(result["type"], "result", "{result}");
    assert_eq!(result["filesReextracted"], 2);
    assert_eq!(result["shadowedFiles"], 3);
    let published = checkout.0.join("published.db");
    std::fs::rename(&candidate, &published).unwrap();
    assert_eq!(
        server.send(json!({"type":"accept","id":2,"overlay":published}))["type"],
        "accepted"
    );

    files[0] = checkout.write("moved.ts", "export function renamed() { return 3; }\n");
    let result = server.send(json!({"type":"edit","id":3,"output":candidate,"files":[files[0]]}));
    assert_eq!(result["type"], "result", "{result}");
    assert_eq!(result["filesReextracted"], 1);
    assert_eq!(result["shadowedFiles"], 3);
    let before = Connection::open(&published).unwrap();
    let after = Connection::open(&candidate).unwrap();
    let digest = |db: &Connection| {
        db.query_row(
        "SELECT hex(r.digest) FROM file_resolution r JOIN files f ON f.id = r.file WHERE f.path = 'use.ts'",
        [], |row| row.get::<_, String>(0),
    ).unwrap()
    };
    assert_eq!(digest(&before), digest(&after));
    let body = |db: &Connection| {
        db.query_row(
            "SELECT hex(body_hash) FROM nodes WHERE name = 'renamed'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    };
    assert_ne!(body(&before), body(&after));
    drop((before, after));
    assert_eq!(server.eof(), Some(0));
    assert!(!candidate.exists());
    assert!(published.exists());
}

#[test]
fn starts_on_a_published_overlay_and_rejects_an_unsafe_edit() {
    let checkout = Checkout::new("reopen");
    let (base, mut files) = checkout.base();
    let mut server = Server::start(&checkout.request("serve", &base, &files, None));
    let output = checkout.0.join("overlay.db");
    files[0] = checkout.write(
        "leaf.ts",
        "export function leaf() { return 1; }\n// reopen\n",
    );
    assert_eq!(
        server.send(json!({"type":"edit","id":1,"output":output,"files":[files[0]]}))["type"],
        "result"
    );
    let live = checkout.0.join("live.db");
    std::fs::rename(&output, &live).unwrap();
    assert_eq!(
        server.send(json!({"type":"accept","id":1,"overlay":live}))["type"],
        "accepted"
    );
    assert_eq!(server.eof(), Some(0));

    let mut reopened = Server::start(&checkout.request("serve", &base, &files, Some(&live)));
    let event = reopened
        .send(json!({"type":"edit","id":1,"output":output,"files":[],"deleted":["../leaf.ts"]}));
    assert_eq!(event["code"], "graph_request_invalid");
    drop(reopened.stdin);
    assert_eq!(
        reopened.child.wait_with_output().unwrap().status.code(),
        Some(2)
    );
    assert!(!output.exists());
    assert!(live.exists());
}
