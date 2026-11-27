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
                "overlay": overlay, "output": base, "files": files, "languages": ["typescript", "javascript"],
                "configs": ["tsconfig.json"],
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
        (self.build(&files), files)
    }

    fn build(&self, files: &[Value]) -> PathBuf {
        let path = self.0.join("base.db");
        let mut child = spawn("build", &self.request("build", &path, files, None));
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"start\n").unwrap();
        assert!(child.wait_with_output().unwrap().status.success());
        path
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

#[test]
fn keeps_captured_config_until_an_edit_replaces_it() {
    let checkout = Checkout::new("config");
    let configuration = checkout.0.join("tsconfig.json");
    std::fs::write(
        &configuration,
        r#"{"compilerOptions":{"baseUrl":".","paths":{"@leaf":["./leaf.ts"]}}}"#,
    )
    .unwrap();
    let (base, files) = checkout.base();
    let mut server = Server::start(&checkout.request("serve", &base, &files, None));
    std::fs::write(&configuration, "{}").unwrap();
    let caller = checkout.write(
        "use.ts",
        "import {leaf} from '@leaf'; export function use() { return leaf(); }\n",
    );
    let output = checkout.0.join("candidate.db");
    assert_eq!(
        server.send(json!({"type":"edit","id":1,"output":output,"files":[caller]}))["type"],
        "result"
    );
    let call_kind: i64 = Connection::open(&base)
        .unwrap()
        .query_row(
            "SELECT id FROM edge_kinds WHERE name = 'calls'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let has_call = || {
        Connection::open(&output)
            .unwrap()
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM edges WHERE kind = ?1 AND target_name = 'leaf')",
                [call_kind],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
    };
    assert!(has_call());
    assert_eq!(
        server.send(json!({"type":"discard","id":1}))["type"],
        "discarded"
    );
    assert_eq!(server.send(json!({"type":"edit","id":2,"output":output,"files":[caller],"configs":["tsconfig.json"]}))["type"], "result");
    assert!(!has_call());
    assert_eq!(server.eof(), Some(0));
}

#[test]
fn package_type_changes_reresolve_unchanged_importers_in_refresh_and_serve() {
    let checkout = Checkout::new("package-type");
    std::fs::write(
        checkout.0.join("tsconfig.json"),
        r#"{"compilerOptions":{"module":"nodenext"}}"#,
    )
    .unwrap();
    let (base, files) = checkout.base();
    let mut server = Server::start(&checkout.request("serve", &base, &files, None));
    let call_kind: i64 = Connection::open(&base)
        .unwrap()
        .query_row(
            "SELECT id FROM edge_kinds WHERE name = 'calls'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let has_call = |path: &Path| {
        let db = Connection::open(path).unwrap();
        if path != base {
            assert!(
                db.query_row(
                    "SELECT EXISTS (SELECT 1 FROM shadow_files WHERE path = 'use.ts')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap()
            );
        }
        db.query_row(
            "SELECT EXISTS (SELECT 1 FROM edges WHERE kind = ?1 AND target_name = 'leaf')",
            [call_kind],
            |row| row.get::<_, bool>(0),
        )
        .unwrap()
    };
    assert!(has_call(&base));

    let package = checkout.0.join("package.json");
    let mut previous_refresh = None;
    for (step, (manifest, expected_call)) in [
        (Some(r#"{"type":"module"}"#), false),
        (Some("{}"), true),
        (Some(r#"{"type":"module"}"#), false),
        (None, true),
    ]
    .into_iter()
    .enumerate()
    {
        let mut configs = vec!["tsconfig.json"];
        if let Some(manifest) = manifest {
            std::fs::write(&package, manifest).unwrap();
            configs.push("package.json");
        } else {
            std::fs::remove_file(&package).unwrap();
        }

        let refresh = checkout.0.join(format!("refresh-{step}.db"));
        let request = checkout.request("refresh", &base, &files, previous_refresh.as_deref());
        let mut options: Value = serde_json::from_slice(&std::fs::read(&request).unwrap()).unwrap();
        options["configs"] = json!(configs);
        options["output"] = json!(refresh);
        std::fs::write(&request, options.to_string()).unwrap();
        let mut child = spawn("refresh", &request);
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(b"start\n").unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(has_call(&refresh), expected_call, "refresh step {step}");
        previous_refresh = Some(refresh);

        let candidate = checkout.0.join(format!("serve-{step}.db"));
        let result = server.send(json!({
            "type": "edit", "id": step, "output": candidate, "files": [], "configs": configs
        }));
        assert_eq!(result["type"], "result", "{result}");
        assert_eq!(has_call(&candidate), expected_call, "serve step {step}");
        let published = checkout.0.join(format!("published-{step}.db"));
        std::fs::rename(&candidate, &published).unwrap();
        assert_eq!(
            server.send(json!({"type":"accept","id":step,"overlay":published}))["type"],
            "accepted"
        );
    }
    assert_eq!(server.eof(), Some(0));
}
