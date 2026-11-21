//! The job lifecycle from docs/design/graph-engine-contract.md, against the
//! real binary: the start barrier, every exit code, and the rule that a job
//! that fails leaves no candidate behind.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use mex_graph_core::CONTRACT_VERSION;
use rusqlite::{Connection, types::Value as SqlValue};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod common;
use common::{ENGINE, last_event, run_job};

const PYTHON_FILES: [&str; 3] = ["src/nested.py", "src/app.py", "src/bad.py"];
const APP_SOURCE: &[u8] = b"LIMIT = 5\r\nLABEL = '\xf0\x9f\x9a\x80'\r\n# \xff\r\n";

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

    fn python(name: &str) -> Fixture {
        let fixture = Fixture::new(name);
        let src = fixture.dir.join("repo/src");
        std::fs::write(src.join("app.py"), APP_SOURCE).unwrap();
        std::fs::write(
            src.join("nested.py"),
            r#"class Outer:
    class Inner:
        """Inner documentation."""
        async def _calculate(self, amount: int) -> int:
            """Compute a total."""
            total = amount + 1
            for value in range(3):
                total += value
            return total

    def invalid(self):
        return )
"#,
        )
        .unwrap();
        std::fs::write(src.join("bad.py"), "def (\n").unwrap();
        std::fs::write(src.join("ignored.txt"), "def ignored():\n    pass\n").unwrap();
        fixture
    }

    fn output(&self) -> PathBuf {
        self.dir.join("index/graph-tmp-1-test.db")
    }

    fn request(&self, edit: impl FnOnce(&mut serde_json::Value)) -> PathBuf {
        let mut request = serde_json::json!({
            "contract": CONTRACT_VERSION,
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

    fn build_python(&self, output: &Path, threads: usize) -> Output {
        let request = self.request(|r| {
            r["languages"] = json!(["python"]);
            r["files"] = PYTHON_FILES
                .into_iter()
                .chain(["src/ignored.txt"])
                .map(|path| json!({ "path": path, "size": 1 }))
                .collect::<Vec<_>>()
                .into();
            r["output"] = json!(output);
            r["limits"]["threads"] = threads.into();
        });
        let out = run(&request, "start\n");
        assert!(out.status.success(), "{out:?}");
        out
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn run(request: &Path, stdin_text: &str) -> Output {
    run_job("build", request, stdin_text)
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
        &f.request(|r| {
            r["files"] = json!([{ "path": "../secret.py" }]);
            r["languages"] = json!(["python"]);
        }),
        "start\n",
    );
    assert_eq!(out.status.code(), Some(0));
    let db = rusqlite::Connection::open(f.output()).unwrap();
    let reason: String = db
        .query_row("SELECT reason FROM coverage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(reason, "outside the repository");
}

#[test]
fn python_build_matches_facts_ids_and_spans() {
    let fixture = Fixture::python("python-parity");
    let build = fixture.build_python(&fixture.output(), 4);
    let facts_output = Command::new(ENGINE)
        .args(["facts", "--root"])
        .arg(fixture.dir.join("repo"))
        .args(PYTHON_FILES)
        .output()
        .unwrap();
    assert!(facts_output.status.success(), "{facts_output:?}");
    let facts: Vec<Value> = String::from_utf8(facts_output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|fact| fact.get("summary").is_none())
        .collect();
    let expected: Vec<_> = facts
        .iter()
        .map(|fact| {
            let span = ["startLine", "startColumn", "endLine", "endColumn"]
                .map(|key| fact[key].as_u64().unwrap() as u32);
            (fact["id"].as_str().unwrap().to_owned(), span)
        })
        .collect();

    let db = Connection::open(fixture.output()).unwrap();
    let actual = db
        .prepare(
            "SELECT k.name || ':' || lower(hex(n.public_id)),
                    n.start_line, n.start_col, n.end_line, n.end_col
             FROM nodes n JOIN node_kinds k ON k.id = n.kind
             ORDER BY n.id",
        )
        .unwrap()
        .query_map([], |row| {
            let span: [u32; 4] = [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?];
            Ok((row.get::<_, String>(0)?, span))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(actual, expected);
    let result = last_event(&build);
    assert_eq!(result["files"], 3);
    assert_eq!(result["nodes"], expected.len());
    assert_eq!(result["edges"], 3);
    assert_eq!(result["coverageGaps"], 2);

    let files = db
        .prepare("SELECT path, parse_status FROM files ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u8>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let expected_files: Vec<_> = PYTHON_FILES
        .into_iter()
        .map(str::to_owned)
        .zip([1, 0, 2])
        .collect();
    assert_eq!(files, expected_files);
    let (hash, size, language): (Vec<u8>, i64, String) = db
        .query_row(
            "SELECT f.content_hash, f.size, l.name FROM files f
             JOIN languages l ON l.id = f.language WHERE f.path = 'src/app.py'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(hash, Sha256::digest(APP_SOURCE).to_vec());
    assert_eq!(size, APP_SOURCE.len() as i64);
    assert_eq!(language, "python");
    let ignored: String = db
        .query_row(
            "SELECT reason FROM coverage WHERE path = 'src/ignored.txt'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(ignored, "no adapter yet");

    let inner_parent: Option<i64> = db
        .query_row(
            "SELECT parent FROM nodes WHERE qualified_name = 'Outer::Inner'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(inner_parent, None);
    let contains: (String, String, u32, u32, String, f64) = db
        .query_row(
            "SELECT parent.qualified_name, k.name, e.line, e.col, p.name, e.confidence
             FROM edges e JOIN nodes child ON child.id = e.target
             JOIN nodes parent ON parent.id = child.parent AND parent.id = e.source
             JOIN edge_kinds k ON k.id = e.kind JOIN provenances p ON p.id = e.provenance
             WHERE child.qualified_name = 'Outer::Inner::_calculate'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        contains,
        (
            "Outer::Inner".into(),
            "contains".into(),
            4,
            0,
            "tree-sitter".into(),
            1.0
        )
    );

    let method = facts
        .iter()
        .find(|fact| fact["qualifiedName"] == "Outer::Inner::_calculate")
        .unwrap();
    let minhash: Vec<u8> = method["minhash"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|word| (word.as_u64().unwrap() as u32).to_be_bytes())
        .collect();
    db.query_row(
        "SELECT n.signature, n.flags, lower(hex(n.body_hash)), n.docstring,
                f.minhash, f.neighbours, f.token_count
         FROM nodes n JOIN fingerprints f ON f.node = n.id WHERE n.qualified_name = ?1",
        [method["qualifiedName"].as_str().unwrap()],
        |row| {
            assert_eq!(
                row.get::<_, String>(0)?,
                method["signature"].as_str().unwrap()
            );
            assert_eq!(row.get::<_, u32>(1)?, 2);
            assert_eq!(
                row.get::<_, String>(2)?,
                method["bodyHash"].as_str().unwrap()
            );
            assert_eq!(
                row.get::<_, String>(3)?,
                method["docstring"].as_str().unwrap()
            );
            assert_eq!(row.get::<_, Vec<u8>>(4)?, minhash);
            assert!(row.get::<_, Vec<u8>>(5)?.is_empty());
            assert_eq!(
                u64::from(row.get::<_, u32>(6)?),
                method["tokenCount"].as_u64().unwrap()
            );
            Ok(())
        },
    )
    .unwrap();
}

#[test]
fn python_build_tables_are_identical_across_thread_counts() {
    let fixture = Fixture::python("python-threads");
    let one_path = fixture.output();
    let four_path = one_path.with_file_name("graph-tmp-1-four.db");
    fixture.build_python(&one_path, 1);
    fixture.build_python(&four_path, 4);
    let one = Connection::open(one_path).unwrap();
    let four = Connection::open(four_path).unwrap();
    for (table, order) in [
        ("meta", "key"),
        ("languages", "id"),
        ("node_kinds", "id"),
        ("edge_kinds", "id"),
        ("provenances", "id"),
        ("unresolved_reasons", "id"),
        ("files", "id"),
        ("nodes", "id"),
        ("edges", "source, kind, target, line, col"),
        ("unresolved", "file, reason"),
        ("fingerprints", "node"),
        ("aliases", "old_public_id"),
        ("coverage", "path"),
    ] {
        let sql = format!("SELECT * FROM {table} ORDER BY {order}");
        let dump = |db: &Connection| {
            let mut statement = db.prepare(&sql).unwrap();
            let columns = statement.column_count();
            statement
                .query_map([], |row| {
                    (0..columns)
                        .map(|i| row.get::<_, SqlValue>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(dump(&one), dump(&four), "{table}");
    }
}

#[test]
fn a_failed_python_parse_writes_coverage_and_no_nodes() {
    let fixture = Fixture::new("python-failed");
    std::fs::write(fixture.dir.join("repo/src/app.py"), "def (\n").unwrap();
    let request = fixture.request(|r| {
        r["languages"] = json!(["python"]);
        r["files"] = json!([{ "path": "src/app.py" }]);
    });
    let build = run(&request, "start\n");
    assert!(build.status.success(), "{build:?}");
    let result = last_event(&build);
    assert_eq!(result["files"], 1);
    assert_eq!(result["nodes"], 0);
    assert_eq!(result["edges"], 0);
    assert_eq!(result["coverageGaps"], 1);
    let db = Connection::open(fixture.output()).unwrap();
    let (status, errors, missing, reason): (u8, u32, u32, String) = db
        .query_row(
            "SELECT parse_status, error_count, missing_count, reason
             FROM files JOIN coverage USING (path) WHERE path = 'src/app.py'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(status, 2);
    assert_eq!(errors, 1);
    assert_eq!(missing, 0);
    assert_eq!(reason, "parse failed");
    let nodes: i64 = db
        .query_row("SELECT count(*) FROM nodes", [], |row| row.get(0))
        .unwrap();
    assert_eq!(nodes, 0);
}
