use std::fs;
use std::path::{Path, PathBuf};

use mex_graph_core::CONTRACT_VERSION;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use super::*;
use crate::job::{Request, extract_files, load};

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn request(root: &Path, mode: &str, files: &[&str], base: Option<&Path>) -> Request {
    let paths: Vec<_> = files.iter().map(|path| {
        let source = fs::read(root.join(path)).unwrap();
        json!({ "path": path, "size": source.len(), "contentHash": hex(&Sha256::digest(source)) })
    }).collect();
    let file = root.join("request.json");
    fs::write(
        &file,
        json!({
            "contract": CONTRACT_VERSION,
            "mode": mode,
            "root": root,
            "files": paths,
            "sourceDirectory": root,
            "languages": ["sample", "broken"],
            "output": root.join(format!("{mode}.db")),
            "base": base,
            "limits": { "memoryMb": 512, "deadlineMs": 30_000, "threads": 2 }
        })
        .to_string(),
    )
    .unwrap();
    load(&file, mode).unwrap()
}

fn basic_gap_count(db: &Connection) -> i64 {
    db.query_row(
        "SELECT count(*) FROM coverage WHERE reason = 'basic'",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn config_only_adapter_projects_outlines_and_labelled_hints_in_stage_base_and_overlay() {
    let scratch =
        Scratch(std::env::temp_dir().join(format!("mex-basic-adapter-{}", std::process::id())));
    fs::create_dir(&scratch.0).unwrap();
    let root = scratch.0.canonicalize().unwrap();
    fs::write(
        root.join("main.sample"),
        include_bytes!("../../tests/fixtures/basic/sample/main.sample"),
    )
    .unwrap();
    fs::write(
        root.join("library.sample"),
        include_bytes!("../../tests/fixtures/basic/sample/library.sample"),
    )
    .unwrap();
    fs::write(root.join("skip.broken"), "").unwrap();

    let input = request(
        &root,
        "build",
        &["main.sample", "library.sample", "skip.broken"],
        None,
    );
    let paths: Vec<_> = input.files.iter().collect();
    let extracted = extract_files(&root, &input, &paths, None);
    let mut rows = Vec::new();
    let mut skipped = Vec::new();
    Projection::new(&extracted, &root, &[], None)
        .write(
            true,
            |file| {
                rows.push(serde_json::to_value(file).unwrap());
                Ok(())
            },
            |path, reason| {
                skipped.push((path.to_owned(), reason.to_owned()));
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(skipped, [("skip.broken".into(), "no adapter yet".into())]);
    let main = &rows[0];
    assert_eq!(main["coverage"], BASIC);
    let nodes = main["nodes"].as_array().unwrap();
    assert_eq!(nodes[1]["qualifiedName"], "Runner");
    assert_eq!(nodes[2]["qualifiedName"], "Runner.start");
    assert_eq!(nodes[2]["containerId"], nodes[1]["id"]);
    let edges = main["edges"].as_array().unwrap();
    let call = edges.iter().find(|edge| edge["kind"] == "calls").unwrap();
    assert_eq!(call["source"], nodes[2]["id"]);
    assert_eq!(call["target"], rows[1]["nodes"][1]["id"]);
    assert_eq!(call["resolutionMethod"], BASIC);
    assert_eq!(call["confidence"], 0);
    assert!(edges.iter().any(|edge| edge["kind"] == "imports"
        && edge["target"] == rows[1]["nodes"][0]["id"]
        && edge["resolutionMethod"] == BASIC));
    let unresolved = &main["unresolved"][0];
    assert_eq!(unresolved["referenceName"], "missing");
    assert_eq!(unresolved["resolver"], BASIC);

    let base = input.candidate_path();
    let counts = build::write(base, extracted, &root, &input, &[], &Enabled::default()).unwrap();
    assert_eq!(
        (counts.files, counts.nodes, counts.coverage_gaps),
        (2, 5, 3)
    );
    let db = Connection::open(base).unwrap();
    assert_eq!(basic_gap_count(&db), 2);
    let relationships: Vec<_> = db
        .prepare(
            "SELECT k.name, m.name, e.confidence FROM edges e
         JOIN edge_kinds k ON k.id=e.kind JOIN resolution_methods m ON m.id=e.method
         WHERE k.name IN ('calls','imports') ORDER BY k.name",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        relationships,
        [
            ("calls".into(), BASIC.into(), 0.0),
            ("imports".into(), BASIC.into(), 0.0)
        ]
    );
    drop(db);

    // Adding a duplicate changes the unchanged caller's unique name match.
    fs::copy(root.join("library.sample"), root.join("duplicate.sample")).unwrap();
    let edit = request(
        &root,
        "refresh",
        &["main.sample", "library.sample", "duplicate.sample"],
        Some(base),
    );
    let counts = refresh::write(&root, &edit, &[], None).unwrap();
    assert_eq!(counts.coverage_gaps, 3);
    let overlay = Connection::open(edit.candidate_path()).unwrap();
    assert_eq!(basic_gap_count(&overlay), 3);
    let shadowed: bool = overlay
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM shadow_files WHERE path='main.sample')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(shadowed);
    let calls: i64 = overlay
        .query_row(
            "SELECT count(*) FROM edges WHERE kind=(SELECT id FROM edge_kinds WHERE name='calls')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(calls, 0);
}
