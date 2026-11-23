//! Project language facts and resolution for both graph writers.

use std::cell::OnceCell;
use std::path::Path;

use mex_graph_core::facts::{Def, FileFacts, Health, Kind, ParseStatus};
use mex_graph_core::id::node_id as public_id;
use mex_graph_core::resolve::Files;
use mex_graph_core::timing::Timer;
use mex_graph_python::resolve::{Resolution, call_source};
use mex_graph_python::{EXCLUDED, LANGUAGE};
use serde::Serialize;
use serde_json::{Number, Value, json};

use crate::adapters::{BASIC, registry};
use crate::basic;
use crate::frameworks::{self, Enabled, Link};
use crate::job::{ConfigSource, ExtractedFile, ExtractedFiles, JobCounts, JobError, emit};
use crate::syntax_language::SyntaxLanguage;
use crate::{hex, is_compiler_language};

pub(super) mod build;
mod ecmascript;
mod edit_facts;
mod framework;
mod incremental;
pub(super) mod refresh;
mod relations;
pub(super) mod serve;
mod syntax;
#[cfg(test)]
mod tests;

pub(super) fn write(
    extracted: &ExtractedFiles<'_>,
    root: &Path,
    configs: &[ConfigSource<'_>],
    frameworks: Option<&Enabled>,
) -> Result<JobCounts, JobError> {
    let mut counts = JobCounts::default();
    Projection::new(extracted, root, configs, frameworks).write(
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
struct Projection<'a> {
    extracted: &'a ExtractedFiles<'a>,
    resolution: Resolution,
    python_ids: Identities<'a>,
    python_frameworks: Option<Vec<Vec<Link<'a>>>>,
    ecmascript: Option<ecmascript::Stage<'a>>,
    syntax: [syntax::Stage<'a>; 2],
    basic: syntax::Stage<'a>,
}

impl<'a> Projection<'a> {
    fn new(
        extracted: &'a ExtractedFiles<'a>,
        root: &Path,
        configs: &[ConfigSource<'_>],
        frameworks: Option<&Enabled>,
    ) -> Self {
        let _timer = Timer::start("resolve");
        let resolution = extracted.resolve();
        let ecmascript = (!extracted.ecmascript.is_empty()).then(|| {
            ecmascript::Stage::new(
                &extracted.ecmascript,
                &extracted.modules(root, configs),
                frameworks,
            )
        });
        Self {
            extracted,
            resolution,
            python_ids: Identities::new(Files::Dense(&extracted.facts)),
            python_frameworks: frameworks.map(|registry| registry.links(&extracted.facts, None)),
            ecmascript,
            syntax: SyntaxLanguage::ALL
                .map(|language| syntax::Stage::new(&extracted.syntax[language as usize], language)),
            basic: {
                let facts = Files::Dense(&extracted.basic);
                syntax::Stage::resolved(Identities::new(facts), BASIC, basic::resolve(facts))
            },
        }
    }

    fn write(
        &self,
        include_nodes: bool,
        mut file_ready: impl FnMut(StagedFile<'_>) -> Result<(), JobError>,
        mut skipped: impl FnMut(&str, &str) -> Result<(), JobError>,
    ) -> Result<(), JobError> {
        let _timer = Timer::start("project");
        let Projection {
            extracted,
            resolution,
            python_ids: ids,
            python_frameworks,
            ecmascript,
            syntax,
            basic,
        } = self;
        let Resolution {
            edges,
            unresolved_calls,
            call_candidates,
            ..
        } = resolution;
        let mut edges = edges.iter().peekable();
        let mut unresolved = unresolved_calls.iter().peekable();
        // Cross-file edge targets can appear later in the stream. Keep their
        // ids, and assemble only one file's projected rows at a time.
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
                ExtractedFile::Basic { index, size } => {
                    file_ready(basic.file(index, size, include_nodes))?;
                    continue;
                }
                ExtractedFile::Skipped { path, reason } => {
                    skipped(path, reason)?;
                    continue;
                }
            };
            let file = python_file(
                Files::Dense(&extracted.facts),
                ids,
                index,
                size,
                include_nodes,
                std::iter::from_fn(|| edges.next_if(|edge| edge.from.0 == index)),
                std::iter::from_fn(|| unresolved.next_if(|call| call.0 == index)),
                call_candidates,
                python_frameworks
                    .as_ref()
                    .map(|links| links[index].as_slice()),
            );
            file_ready(file)?;
        }
        debug_assert!(edges.next().is_none() && unresolved.next().is_none());
        Ok(())
    }
}

type PythonCandidateMap = std::collections::HashMap<(usize, usize), (usize, usize)>;

#[expect(
    clippy::too_many_arguments,
    reason = "shared Python resolution projection"
)]
fn python_file<'a, 'facts: 'a>(
    facts: Files<'facts>,
    ids: &'a Identities<'facts>,
    index: usize,
    size: u64,
    include_nodes: bool,
    edges: impl IntoIterator<Item = &'a mex_graph_python::resolve::Edge>,
    unresolved: impl IntoIterator<Item = &'a (usize, usize, &'static str)>,
    call_candidates: &PythonCandidateMap,
    links: Option<&[Link<'a>]>,
) -> StagedFile<'a> {
    let facts = facts.get(index);
    let mut file = StagedFile::new(facts, size, ids.file(index), include_nodes);
    for edge in edges {
        let source = node_id(ids.file(index), edge.from.1);
        let target = ids.id(edge.to);
        if let (Some(source), Some(target)) = (source, target) {
            file.edges.push(StagedEdge {
                owner: None,
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
    for &(_, call_index, reason) in unresolved {
        let call = &facts.calls[call_index];
        let source = call_source(facts, call.caller);
        if let Some(id) = node_id(ids.file(index), source) {
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
                    .and_then(|&id| ids.id(id)),
                receiver: None,
                qualifier: None,
            });
        }
    }
    if let Some(links) = links {
        framework::add_links(&mut file, links, index, |id| ids.id(id));
    }
    file
}

struct Identities<'a> {
    facts: Files<'a>,
    ids: FileIds<'a>,
}

enum FileIds<'a> {
    Lazy(Vec<OnceCell<Vec<Option<String>>>>),
    Known(Vec<&'a [Option<String>]>),
}

impl<'a> Identities<'a> {
    fn new(facts: Files<'a>) -> Self {
        Self::with_known(facts, None)
    }

    fn with_known(facts: Files<'a>, ids: Option<Vec<&'a [Option<String>]>>) -> Self {
        Self {
            facts,
            ids: match ids {
                Some(ids) => FileIds::Known(ids),
                None => FileIds::Lazy((0..facts.len()).map(|_| OnceCell::new()).collect()),
            },
        }
    }

    fn file(&self, file: usize) -> &[Option<String>] {
        match &self.ids {
            FileIds::Known(ids) => ids[file],
            FileIds::Lazy(ids) => ids[file].get_or_init(|| node_ids(self.facts.get(file))),
        }
    }

    fn id(&self, (file, def): (usize, usize)) -> Option<&str> {
        node_id(self.file(file), def)
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    coverage: Option<&'static str>,
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
            coverage: coverage_reason(facts).filter(|reason| *reason == BASIC),
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
                    owner: None,
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
                    evidence: compiler.then_some([StagedEvidence::Declaration {
                        declaration_role: def.declaration_role.as_deref(),
                    }]),
                });
            }
            if include_nodes {
                file.nodes.push(StagedNode::new(
                    facts,
                    def,
                    id,
                    parent,
                    identity_key(facts, def),
                ));
            }
        }
        file
    }

    fn emit(mut self, counts: &mut JobCounts, frameworks_resolved: bool) -> Result<(), JobError> {
        self.frameworks_resolved = frameworks_resolved;
        counts.files += 1;
        counts.nodes += self.nodes.len();
        counts.edges += self.edges.len();
        counts.coverage_gaps +=
            usize::from(self.coverage.is_some() || self.parse_status == ParseStatus::Failed);
        emit(&self)
    }
}

fn coverage_reason(facts: &FileFacts) -> Option<&'static str> {
    if facts.health.status == ParseStatus::Failed {
        Some("parse failed")
    } else if registry().is_basic(&facts.language) {
        Some(BASIC)
    } else {
        None
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
    body_hash: Option<StagedHash<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minhash: Option<&'a [u32]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_count: Option<u32>,
}

impl<'a> StagedNode<'a> {
    fn new(
        facts: &'a FileFacts,
        def: &'a Def,
        id: &'a str,
        parent: Option<&'a str>,
        identity_key: String,
    ) -> Self {
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
            identity_key,
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
            body_hash: def.body_hash.as_ref().map(StagedHash),
            minhash: def.sketch.as_ref().map(|sketch| sketch.minhash.as_slice()),
            token_count: def.sketch.as_ref().map(|sketch| sketch.token_count),
        }
    }
}

#[derive(Clone, Copy)]
struct StagedHash<'a>(&'a [u8; 32]);

impl Serialize for StagedHash<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex(self.0))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedEdge<'a> {
    #[serde(skip)]
    owner: Option<&'a str>,
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
    evidence: Option<[StagedEvidence<'a>; 1]>,
}

#[derive(Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
enum StagedEvidence<'a> {
    Declaration {
        declaration_role: Option<&'a str>,
    },
    Import {
        resolved_file_path: &'a str,
    },
    Heritage {
        heritage: &'static str,
    },
    Expression {
        expression: &'a str,
    },
    Callback {
        argument_index: u32,
        wiring_site: WiringSite<'a>,
        callee: &'a str,
    },
    Framework {
        #[serde(skip_serializing_if = "Option::is_none")]
        resolver: Option<&'static str>,
        wiring_site: WiringSite<'a>,
        #[serde(skip_serializing_if = "Option::is_none")]
        import_binding: Option<&'a str>,
    },
    SyntaxImport {
        module_specifier: &'a str,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct WiringSite<'a> {
    file_path: &'a str,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
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
