//! `mex-graph facts`: print what the adapters extract, for people and tests.
//!
//! usage: mex-graph facts --root <dir> (<path>... | --files-from <list>) [--full]
//!
//! One JSON line per node a file contributes (id, kind, names, span,
//! signature, docstring, body hash, sketch), then one summary line per file.
//! Paths are repository-relative. `--full` prints each file's whole facts.

use std::io::Write;
use std::path::PathBuf;

use mex_graph_core::facts::{FileFacts, ReferenceKind};
use mex_graph_csharp::CSharp;
use mex_graph_ecmascript::{EcmaScript, language_for_path};
use mex_graph_python::{EXCLUDED, Python};
use mex_graph_rust::Rust;
use sha2::{Digest, Sha256};

use crate::syntax_language::SyntaxLanguage;
use crate::{hex, is_compiler_language};

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
    let mut rust = None;
    let mut csharp = None;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for path in &paths {
        let is_python = path
            .rsplit_once('.')
            .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("py"));
        let syntax = SyntaxLanguage::for_path(path);
        if !is_python && syntax.is_none() && language_for_path(path).is_none() {
            continue;
        }
        let bytes = std::fs::read(root.join(path)).map_err(|e| format!("{path}: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);
        let hash: [u8; 32] = Sha256::digest(&bytes).into();
        let facts = match syntax {
            Some(SyntaxLanguage::Rust) => rust
                .get_or_insert_with(Rust::new)
                .extract(path, &text, hash),
            Some(SyntaxLanguage::CSharp) => csharp
                .get_or_insert_with(CSharp::new)
                .extract(path, &text, hash),
            None if is_python => python.extract(path, &text, hash),
            None => ecmascript.extract(path, &text, hash),
        };
        print_facts(&mut out, &facts, full).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn print_facts(out: &mut impl Write, facts: &FileFacts, full: bool) -> std::io::Result<()> {
    if full {
        return writeln!(out, "{}", serde_json::to_string(facts).unwrap_or_default());
    }
    let compiler = is_compiler_language(&facts.language);
    let ids: Vec<_> = facts
        .defs
        .iter()
        .map(|def| {
            if def.flags.iter().any(|flag| flag == EXCLUDED) {
                None
            } else if compiler {
                Some(def.ordinal_id(&facts.path))
            } else {
                Some(def.signature_id(&facts.path))
            }
        })
        .collect();
    for (i, def) in facts.defs.iter().enumerate() {
        let Some(id) = ids[i].as_deref() else {
            continue;
        };
        let identity = if compiler {
            def.ordinal_identity(&facts.path)
        } else {
            def.signature_identity(&facts.path)
        };
        let line = serde_json::json!({
            "path": facts.path,
            "id": id,
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
            "identityKey": identity,
            "containerId": usize::try_from(def.parent).ok().and_then(|parent| ids.get(parent)?.as_deref()),
            "visibility": def.visibility,
            "decorators": def.decorators,
            "typeParameters": def.type_parameters,
            "static": def.flags.iter().any(|f| f == "static"),
            "abstract": def.flags.iter().any(|f| f == "abstract"),
        });
        writeln!(out, "{line}")?;
    }
    writeln!(
        out,
        "{}",
        serde_json::json!({
            "path": facts.path,
            "summary": true,
            "status": facts.health.status,
            "calls": facts.calls.len() + facts.syntax_references.iter()
                .filter(|reference| reference.kind == ReferenceKind::Calls).count(),
            "imports": facts.imports.len(),
            "bindings": facts.bindings.len(),
        })
    )
}
