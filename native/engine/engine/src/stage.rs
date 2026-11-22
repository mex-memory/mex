//! Project language facts and resolution for both graph writers.

use std::path::Path;

use mex_graph_core::facts::{Def, FileFacts, Health, Kind, ParseStatus};
use mex_graph_core::id::node_id as public_id;
use mex_graph_core::timing::Timer;
use mex_graph_python::resolve::{Resolution, call_source};
use mex_graph_python::{EXCLUDED, LANGUAGE};
use serde::Serialize;
use serde_json::{Number, Value, json};

use crate::frameworks::{self, Enabled};
use crate::job::{ConfigSource, ExtractedFile, ExtractedFiles, JobCounts, JobError, emit};
use crate::syntax_language::SyntaxLanguage;
use crate::{hex, is_compiler_language};

pub(super) mod build;
mod ecmascript;
mod framework;
pub(super) mod refresh;
mod syntax;

pub(super) fn write(
    extracted: &ExtractedFiles<'_>,
    root: &Path,
    configs: &[ConfigSource<'_>],
    frameworks: Option<&Enabled>,
) -> Result<JobCounts, JobError> {
    let mut counts = JobCounts::default();
    project(
        extracted,
        root,
        configs,
        frameworks,
        true,
        |file| file.emit(&mut counts, frameworks.is_some()),
        |path, reason| {
            emit(&serde_json::json!({
                "type": "file", "path": path, "status": "skipped", "reason": reason,
            }))
        },
    )?;
    counts.coverage_gaps += extracted
        .files
        .iter()
        .filter(|file| matches!(file, ExtractedFile::Skipped { .. }))
        .count();
    Ok(counts)
}

/// Both storage formats consume the same resolved facts and site locations.
/// Only one file's projected records are assembled at a time.
fn project(
    extracted: &ExtractedFiles<'_>,
    root: &Path,
    configs: &[ConfigSource<'_>],
    frameworks: Option<&Enabled>,
    include_nodes: bool,
    mut file_ready: impl FnMut(StagedFile<'_>) -> Result<(), JobError>,
    mut skipped: impl FnMut(&str, &str) -> Result<(), JobError>,
) -> Result<(), JobError> {
    let _timer = Timer::start("project");
    let Resolution {
        edges,
        unresolved_calls,
        call_candidates,
        ..
    } = extracted.resolve();
    let mut edges = edges.into_iter().peekable();
    let mut unresolved = unresolved_calls.into_iter().peekable();

    // Cross-file edge targets can be written later in the stream. Keep an id
    // per written definition, but only assemble one file's rows at a time.
    let ids: Vec<_> = extracted.facts.iter().map(node_ids).collect();
    let ecmascript = (!extracted.ecmascript.is_empty()).then(|| {
        ecmascript::Stage::new(
            &extracted.ecmascript,
            &extracted.modules(root, configs),
            frameworks,
        )
    });
    let python_frameworks = frameworks.map(|registry| registry.links(&extracted.facts, None));
    let syntax = SyntaxLanguage::ALL
        .map(|language| syntax::Stage::new(&extracted.syntax[language as usize], language));
    for entry in &extracted.files {
        let (index, size) = match *entry {
            ExtractedFile::Python { index, size } => (index, size),
            ExtractedFile::EcmaScript { index, size } => {
                file_ready(ecmascript.as_ref().expect("ECMAScript stage").file(
                    index,
                    size,
                    include_nodes,
                ))?;
                continue;
            }
            ExtractedFile::Syntax {
                language,
                index,
                size,
            } => {
                file_ready(syntax[language as usize].file(index, size, include_nodes))?;
                continue;
            }
            ExtractedFile::Skipped { path, reason } => {
                skipped(path, reason)?;
                continue;
            }
        };
        let facts = &extracted.facts[index];
        let mut file = StagedFile::new(facts, size, &ids[index], include_nodes);
        while let Some(edge) = edges.next_if(|edge| edge.from.0 == index) {
            let source = node_id(&ids[index], edge.from.1);
            let target = node_id(&ids[edge.to.0], edge.to.1);
            if let (Some(source), Some(target)) = (source, target) {
                file.edges.push(StagedEdge {
                    source,
                    target,
                    kind: edge.kind,
                    line: edge.line,
                    column: Some(edge.col),
                    provenance: "tree-sitter",
                    confidence: 1.into(),
                    resolution_method: "engine-python",
                    metadata: None,
                    evidence: None,
                });
            }
        }
        while let Some((_, call_index, reason)) = unresolved.next_if(|call| call.0 == index) {
            let call = &facts.calls[call_index];
            let source = call_source(facts, call.caller);
            if let Some(id) = node_id(&ids[index], source) {
                file.unresolved.push(StagedRef {
                    from_node_id: id,
                    reference_name: &call.name,
                    called_name: Some(&call.name),
                    reference_kind: "calls",
                    file_path: &facts.path,
                    language: LANGUAGE,
                    line: call.name_range.start_line + 1,
                    column: call.name_range.start_col,
                    status: "unresolved",
                    resolver: "engine-python",
                    metadata: json!({ "reason": reason }),
                    confidence: None,
                    candidates: None,
                    candidate_id: call_candidates
                        .get(&(index, call_index))
                        .and_then(|&(file, def)| node_id(&ids[file], def)),
                    receiver: None,
                    qualifier: None,
                });
            }
        }
        if let Some(links) = &python_frameworks {
            framework::add_links(&mut file, &links[index], index, |(f, d)| {
                node_id(&ids[f], d)
            });
        }
        file_ready(file)?;
    }
    debug_assert!(edges.next().is_none() && unresolved.next().is_none());
    Ok(())
}

fn node_ids(facts: &FileFacts) -> Vec<Option<String>> {
    if facts.health.status == ParseStatus::Failed {
        return Vec::new();
    }
    facts
        .defs
        .iter()
        .map(|def| {
            (!def.flags.iter().any(|flag| flag == EXCLUDED))
                .then(|| public_id(def.kind.as_str(), &identity_key(facts, def)))
        })
        .collect()
}

fn identity_key(facts: &FileFacts, def: &Def) -> String {
    if is_compiler_language(&facts.language) && frameworks::route_framework(def).is_none() {
        def.ordinal_identity(&facts.path)
    } else {
        def.signature_identity(&facts.path)
    }
}

fn node_id(ids: &[Option<String>], index: usize) -> Option<&str> {
    ids.get(index).and_then(Option::as_deref)
}

fn declared_nodes<'a>(
    facts: &'a FileFacts,
    ids: &'a [Option<String>],
) -> impl Iterator<Item = (&'a Def, &'a str, Option<&'a str>)> {
    facts.defs.iter().zip(ids).filter_map(move |(def, id)| {
        let parent = usize::try_from(def.parent)
            .ok()
            .and_then(|index| node_id(ids, index));
        Some((def, id.as_deref()?, parent))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedFile<'a> {
    #[serde(rename = "type")]
    event_type: &'static str,
    path: &'a str,
    content_hash: String,
    size: u64,
    language: &'a str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    frameworks_resolved: bool,
    parse_status: ParseStatus,
    health: StagedHealth<'a>,
    nodes: Vec<StagedNode<'a>>,
    edges: Vec<StagedEdge<'a>>,
    unresolved: Vec<StagedRef<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    imports: Vec<StagedImport<'a>>,
}

impl<'a> StagedFile<'a> {
    fn new(
        facts: &'a FileFacts,
        size: u64,
        ids: &'a [Option<String>],
        include_nodes: bool,
    ) -> Self {
        let mut file = Self {
            event_type: "staged",
            path: &facts.path,
            content_hash: hex(&facts.content_hash),
            size,
            language: &facts.language,
            frameworks_resolved: false,
            parse_status: facts.health.status,
            health: StagedHealth::from(&facts.health),
            nodes: Vec::new(),
            edges: Vec::new(),
            unresolved: Vec::new(),
            imports: Vec::new(),
        };
        let compiler_language = is_compiler_language(&facts.language);
        for (def, id, parent) in declared_nodes(facts, ids) {
            let framework = frameworks::route_framework(def);
            if let Some((resolver, source)) = framework.zip(node_id(ids, 0)) {
                file.edges.push(framework::contains(
                    source,
                    id,
                    &facts.path,
                    def.range.start_line + 1,
                    resolver,
                ));
            } else if let Some(parent) = parent {
                let compiler = compiler_language && framework.is_none();
                file.edges.push(StagedEdge {
                    source: parent,
                    target: id,
                    kind: "contains",
                    line: def.range.start_line + 1,
                    column: compiler.then_some(def.range.start_col),
                    provenance: if compiler {
                        "typescript-compiler"
                    } else {
                        "tree-sitter"
                    },
                    confidence: 1.into(),
                    resolution_method: "lexical-containment",
                    metadata: compiler.then_some(StagedEdgeMetadata {
                        target_name: &def.name,
                        target_qualified_name: &def.qualified_name,
                    }),
                    evidence: compiler
                        .then(|| [json!({ "declarationRole": def.declaration_role })]),
                });
            }
            if include_nodes {
                file.nodes.push(StagedNode::new(facts, def, id, parent));
            }
        }
        file
    }

    fn emit(mut self, counts: &mut JobCounts, frameworks_resolved: bool) -> Result<(), JobError> {
        self.frameworks_resolved = frameworks_resolved;
        counts.files += 1;
        counts.nodes += self.nodes.len();
        counts.edges += self.edges.len();
        counts.coverage_gaps += usize::from(self.parse_status == ParseStatus::Failed);
        emit(&self)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedHealth<'a> {
    status: ParseStatus,
    diagnostic_count: u32,
    missing_count: u32,
    error_coverage: f32,
    diagnostics: Vec<StagedDiagnostic<'a>>,
}

impl<'a> From<&'a Health> for StagedHealth<'a> {
    fn from(health: &'a Health) -> Self {
        Self {
            status: health.status,
            diagnostic_count: health.error_count,
            missing_count: health.missing_count,
            error_coverage: health.error_coverage,
            diagnostics: health
                .diagnostics
                .iter()
                .map(|diagnostic| StagedDiagnostic {
                    kind: &diagnostic.code,
                    start_line: diagnostic.range.start_line + 1,
                    end_line: diagnostic.range.end_line + 1,
                })
                .collect(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedDiagnostic<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    start_line: u32,
    end_line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedNode<'a> {
    id: &'a str,
    kind: Kind,
    name: &'a str,
    qualified_name: &'a str,
    file_path: &'a str,
    language: &'a str,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
    identity_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    container_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    docstring: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    return_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_async: Option<bool>,
    is_exported: bool,
    #[serde(skip)]
    is_default_export: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    visibility: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_static: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_abstract: Option<bool>,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    decorators: &'a [String],
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    type_parameters: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    body_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minhash: Option<&'a [u32]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_count: Option<u32>,
}

impl<'a> StagedNode<'a> {
    fn new(facts: &'a FileFacts, def: &'a Def, id: &'a str, parent: Option<&'a str>) -> Self {
        let compiler = is_compiler_language(&facts.language);
        let csharp = facts.language == mex_graph_csharp::LANGUAGE;
        let writes_visibility = compiler || csharp || facts.language == mex_graph_rust::LANGUAGE;
        let writes_modifiers = compiler || csharp;
        let has_flag = |name: &str| def.flags.iter().any(|flag| flag == name);
        Self {
            id,
            kind: def.kind,
            name: &def.name,
            qualified_name: &def.qualified_name,
            file_path: &facts.path,
            language: &facts.language,
            start_line: def.range.start_line + 1,
            end_line: def.range.end_line + 1,
            start_column: def.range.start_col,
            end_column: def.range.end_col,
            identity_key: identity_key(facts, def),
            container_id: parent,
            signature: (!def.signature.is_empty()).then_some(def.signature.as_str()),
            docstring: def.docstring.as_deref(),
            return_type: def.return_type.as_deref(),
            is_async: if facts.language == LANGUAGE {
                matches!(def.kind, Kind::Function | Kind::Method).then(|| has_flag("async"))
            } else {
                has_flag("async").then_some(true)
            },
            is_exported: def.exported,
            is_default_export: def.is_default_export,
            visibility: def.visibility.as_deref().filter(|_| writes_visibility),
            is_static: (writes_modifiers && has_flag("static")).then_some(true),
            is_abstract: (writes_modifiers && has_flag("abstract")).then_some(true),
            decorators: if compiler { &def.decorators } else { &[] },
            type_parameters: &def.type_parameters,
            body_hash: def.body_hash.as_ref().map(|hash| hex(hash)),
            minhash: def.sketch.as_ref().map(|sketch| sketch.minhash.as_slice()),
            token_count: def.sketch.as_ref().map(|sketch| sketch.token_count),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedEdge<'a> {
    source: &'a str,
    target: &'a str,
    kind: &'static str,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
    provenance: &'static str,
    confidence: Number,
    resolution_method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<StagedEdgeMetadata<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence: Option<[Value; 1]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedEdgeMetadata<'a> {
    target_name: &'a str,
    target_qualified_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedRef<'a> {
    from_node_id: &'a str,
    reference_name: &'a str,
    #[serde(skip)]
    called_name: Option<&'a str>,
    reference_kind: &'static str,
    file_path: &'a str,
    language: &'a str,
    line: u32,
    column: u32,
    status: &'static str,
    resolver: &'static str,
    metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidates: Option<[(); 0]>,
    #[serde(skip)]
    candidate_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qualifier: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedImport<'a> {
    binding_key: String,
    file_path: &'a str,
    local_name: &'a str,
    imported_name: &'a str,
    module_specifier: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_file_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_id: Option<&'a str>,
    is_type_only: bool,
    metadata: Value,
}
