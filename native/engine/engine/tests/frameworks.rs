//! Framework nodes and bound handlers survive both writer projections.

use std::collections::BTreeSet;
use std::path::PathBuf;

use mex_graph_core::CONTRACT_VERSION;
use rusqlite::Connection;
use serde_json::{Value, json};

mod common;
use common::{last_event, run_job};

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn framework_routes_have_stable_ids_in_v4_and_v5() {
    let dir =
        TempDir(std::env::temp_dir().join(format!("mex-graph-frameworks-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let sources = [
        (
            "app.js",
            r#"
import { handler } from "./handler.js";
app.get("/imported", handler);
app.get("/unbound", missing);
"#,
        ),
        ("handler.js", "export function handler() {}"),
        (
            "controller.ts",
            r#"
@Controller("first")
class First {
    @Get(":id") find() {}
}
@Controller("second")
class Second {
    @Get() find() {}
}
"#,
        ),
        (
            "src/app/(group)/api/[id]/route.ts",
            "export async function GET() {}
",
        ),
        (
            "flask_app.py",
            r#"
from flask import Blueprint
bp = Blueprint("admin", __name__, url_prefix="/admin")
@bp.route("/settings", methods=["GET", "POST"])
def settings():
    pass
"#,
        ),
        (
            "fast_app.py",
            r#"
from fastapi import APIRouter
router = APIRouter(prefix="/api")
@router.get("/{id}")
def user():
    pass
"#,
        ),
    ];
    for (path, source) in sources {
        let path = dir.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, source).unwrap();
    }
    let graph = dir.0.join("graph.db");
    let mut request = json!({
        "contract": CONTRACT_VERSION,
        "mode": "stage",
        "root": dir.0,
        "files": sources.map(|(path, source)| json!({"path": path, "size": source.len()})),
        "configs": [{"path":"package.json", "source":r#"{"dependencies":{"express":"1","@nestjs/common":"1"}}"#}],
        "languages": ["python", "javascript", "typescript"],
        "limits": {"memoryMb": 4096, "deadlineMs": 60000, "threads": 2}
    });
    let request_path = dir.0.join("request.json");
    std::fs::write(&request_path, request.to_string()).unwrap();
    let legacy = run_job("stage", &request_path, "start\n");
    assert!(legacy.status.success(), "{legacy:?}");
    assert!(!String::from_utf8_lossy(&legacy.stdout).contains(r#""kind":"route""#));

    request["frameworks"] = json!(true);
    std::fs::write(&request_path, request.to_string()).unwrap();
    let stage = run_job("stage", &request_path, "start\n");
    assert!(stage.status.success(), "{stage:?}");
    assert_eq!(last_event(&stage)["type"], "result");
    let files: Vec<Value> = String::from_utf8_lossy(&stage.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|event: &Value| event["type"] == "staged")
        .collect();
    let mut routes = BTreeSet::new();
    let mut stage_edges = BTreeSet::new();
    for file in &files {
        assert_eq!(file["frameworksResolved"], true);
        for node in file["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| node["kind"] == "route")
        {
            assert!(node.get("containerId").is_none());
            routes.insert((string(node, "id"), string(node, "name")));
        }
        for edge in file["edges"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|edge| edge["provenance"] == "framework")
        {
            stage_edges.insert((
                string(edge, "source"),
                string(edge, "kind"),
                string(edge, "target"),
            ));
        }
    }
    let names: BTreeSet<_> = routes.iter().map(|(_, name)| name.as_str()).collect();
    assert_eq!(
        names,
        BTreeSet::from([
            "GET /imported",
            "GET /unbound",
            "GET /first/:id",
            "GET /second",
            "GET /api/[id]",
            "GET /admin/settings",
            "POST /admin/settings",
            "GET /api/{id}",
        ])
    );
    assert_eq!(stage_edges.len(), 15);
    let app = &files[0];
    assert!(app["edges"].as_array().unwrap().iter().any(|edge| {
        edge["resolutionMethod"] == "express-route-handler"
            && edge["evidence"][0]["importBinding"] == "handler"
    }));
    assert!(
        app["unresolved"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| {
                reference["referenceName"] == "missing"
                    && reference["metadata"]["reason"] == "framework_handler_not_found"
            })
    );

    request["mode"] = json!("build");
    request["output"] = json!(graph);
    request.as_object_mut().unwrap().remove("frameworks");
    std::fs::write(&request_path, request.to_string()).unwrap();
    let build = run_job("build", &request_path, "start\n");
    assert!(build.status.success(), "{build:?}");
    let db = Connection::open(&graph).unwrap();
    let build_routes = db
        .prepare(
            "
        SELECT kind.name || ':' || lower(hex(n.public_id)), n.name
        FROM nodes n JOIN node_kinds kind ON kind.id = n.kind WHERE kind.name = 'route'
    ",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<BTreeSet<(String, String)>, _>>()
        .unwrap();
    assert_eq!(build_routes, routes);
    let build_edges = db.prepare("
        SELECT sk.name || ':' || lower(hex(s.public_id)), ek.name, tk.name || ':' || lower(hex(t.public_id))
        FROM edges e
        JOIN nodes s ON e.source = s.id JOIN nodes t ON e.target = t.id
        JOIN node_kinds sk ON sk.id = s.kind JOIN node_kinds tk ON tk.id = t.kind
        JOIN edge_kinds ek ON ek.id = e.kind JOIN provenances p ON p.id = e.provenance
        WHERE p.name = 'framework' AND e.confidence = 0.8 AND e.detail_kind = 6
    ").unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap().collect::<Result<BTreeSet<(String, String, String)>, _>>().unwrap();
    assert_eq!(build_edges, stage_edges);
    let imported_binding: (String, String) = db
        .query_row(
            "SELECT m.name, e.detail FROM edges e JOIN resolution_methods m ON m.id = e.method
             WHERE e.detail_kind = 6 AND e.detail IS NOT NULL",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        imported_binding,
        ("express-route-handler".into(), "handler".into())
    );
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().into()
}
