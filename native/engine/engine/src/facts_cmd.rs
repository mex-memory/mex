//! `mex-graph facts`: print what the adapters extract, for people and tests.
//!
//! usage: mex-graph facts --root <dir> (<path>... | --files-from <list>) [--full]
//!
//! One JSON line per node a file contributes (id, kind, names, span,
//! signature, docstring, body hash, sketch), then one summary line per file.
//! Paths are repository-relative. `--full` prints each file's whole facts.

use std::io::Write;
use std::path::PathBuf;

use mex_graph_core::facts::FileFacts;
use mex_graph_ecmascript::{EcmaScript, language_for_path};
use mex_graph_python::{EXCLUDED, Python};
use sha2::{Digest, Sha256};

use crate::hex;

pub fn run(args: &[String]) -> Result<(), String> {
    let mut root = None;
    let mut paths = Vec::new();
    let mut full = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--root" => {
                root = args.get(i + 1).map(PathBuf::from);
                i += 1;
            }
            "--files-from" => {
                let list = args.get(i + 1).ok_or("--files-from needs a file")?;
                let text = std::fs::read_to_string(list).map_err(|e| e.to_string())?;
                paths.extend(text.lines().filter(|l| !l.is_empty()).map(str::to_owned));
                i += 1;
            }
            "--full" => full = true,
            other => paths.push(other.to_owned()),
        }
        i += 1;
    }
    let root = root.ok_or("--root is required")?;
    let mut python = Python::new();
    let mut ecmascript = EcmaScript::new();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for path in &paths {
        let is_python = path.ends_with(".py");
        if !is_python && language_for_path(path).is_none() {
            continue;
        }
        let bytes = std::fs::read(root.join(path)).map_err(|e| format!("{path}: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);
        let hash: [u8; 32] = Sha256::digest(&bytes).into();
        let facts = if is_python {
            python.extract(path, &text, hash)
        } else {
            ecmascript.extract(path, &text, hash)
        };
        print_facts(&mut out, &facts, full).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn print_facts(out: &mut impl Write, facts: &FileFacts, full: bool) -> std::io::Result<()> {
    if full {
        return writeln!(out, "{}", serde_json::to_string(facts).unwrap_or_default());
    }
    let compiler = facts.language != "python";
    let ids: Vec<_> = facts
        .defs
        .iter()
        .map(|def| {
            if compiler {
                def.ordinal_id(&facts.path)
            } else {
                def.signature_id(&facts.path)
            }
        })
        .collect();
    for (i, def) in facts.defs.iter().enumerate() {
        if def.flags.iter().any(|f| f == EXCLUDED) {
            continue;
        }
        let mut line = serde_json::json!({
            "path": facts.path,
            "id": ids[i],
            "kind": def.kind.as_str(),
            "name": def.name,
            "qualifiedName": def.qualified_name,
            "startLine": def.range.start_line + 1,
            "endLine": def.range.end_line + 1,
            "startColumn": def.range.start_col,
            "endColumn": def.range.end_col,
            "signature": (!def.signature.is_empty()).then_some(&def.signature),
            "docstring": def.docstring,
            "bodyHash": def.body_hash.map(|h| hex(&h)),
            "minhash": def.sketch.as_ref().map(|s| &s.minhash),
            "tokenCount": def.sketch.as_ref().map(|s| s.token_count),
            "returnType": def.return_type,
            "async": def.flags.iter().any(|f| f == "async"),
            "exported": def.exported,
        });
        if compiler {
            line["containerId"] = serde_json::json!(
                usize::try_from(def.parent)
                    .ok()
                    .and_then(|parent| ids.get(parent))
            );
            line["visibility"] = serde_json::json!(def.visibility);
            line["decorators"] = serde_json::json!(def.decorators);
            line["typeParameters"] = serde_json::json!(def.type_parameters);
            line["static"] = serde_json::json!(def.flags.iter().any(|f| f == "static"));
            line["abstract"] = serde_json::json!(def.flags.iter().any(|f| f == "abstract"));
        }
        writeln!(out, "{line}")?;
    }
    writeln!(
        out,
        "{}",
        serde_json::json!({
            "path": facts.path,
            "summary": true,
            "status": facts.health.status,
            "calls": facts.calls.len(),
            "imports": facts.imports.len(),
            "bindings": facts.bindings.len(),
        })
    )
}
