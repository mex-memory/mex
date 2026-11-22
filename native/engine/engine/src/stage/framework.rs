//! Framework edges use the same v4 provenance and wiring evidence as Node.

use mex_graph_ecmascript::resolve::DefRef;
use serde_json::{Number, json};

use super::{StagedEdge, StagedFile, StagedRef};
use crate::frameworks::{CONFIDENCE, Link};

pub(super) fn contains<'a>(
    source: &'a str,
    target: &'a str,
    path: &'a str,
    line: u32,
    resolver: &'static str,
) -> StagedEdge<'a> {
    StagedEdge {
        source,
        target,
        kind: "contains",
        line,
        column: None,
        provenance: "framework",
        confidence: Number::from_f64(CONFIDENCE).unwrap(),
        resolution_method: resolver,
        metadata: None,
        evidence: Some([json!({ "wiringSite": { "filePath": path, "line": line } })]),
    }
}

pub(super) fn add_links<'a>(
    file: &mut StagedFile<'a>,
    links: &[Link<'a>],
    index: usize,
    id: impl Fn(DefRef) -> Option<&'a str>,
) {
    for link in links {
        let Some(source) = id((index, link.from)) else {
            continue;
        };
        let site = json!({ "filePath": file.path, "line": link.line, "column": 0 });
        let target = link.target.and_then(|(target, resolver, imported)| {
            id(target)
                .map(|target| (target, resolver, imported))
                .ok_or("framework_handler_not_found")
        });
        match target {
            Ok((target, resolver, imported)) => {
                let mut evidence = json!({ "resolver": resolver, "wiringSite": site });
                if imported {
                    evidence["importBinding"] = json!(link.name);
                }
                file.edges.push(StagedEdge {
                    source,
                    target,
                    kind: "references",
                    line: link.line,
                    column: Some(0),
                    provenance: "framework",
                    confidence: Number::from_f64(CONFIDENCE).unwrap(),
                    resolution_method: resolver,
                    metadata: None,
                    evidence: Some([evidence]),
                });
            }
            Err(reason) => file.unresolved.push(StagedRef {
                from_node_id: source,
                reference_name: link.name,
                called_name: None,
                reference_kind: "function_ref",
                file_path: file.path,
                language: file.language,
                line: link.line,
                column: 0,
                status: "unresolved",
                resolver: "engine-framework",
                metadata: json!({ "wiringSite": site, "reason": reason, "framework": link.framework }),
                confidence: Some(0),
                candidates: None,
                candidate_id: None,
                receiver: None,
                qualifier: None,
            }),
        }
    }
}
