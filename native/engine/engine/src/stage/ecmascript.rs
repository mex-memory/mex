//! Project ECMAScript resolution into the compiler route's schema v4 rows.

use mex_graph_core::facts::{Call, CallForm, FileFacts, Range, ecmascript::Expression};
use mex_graph_core::id::id_bytes;
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_ecmascript::resolve::{
    DefRef, Edge, EdgeSite, ImportResolution, UnresolvedHeritage, resolve_for_stage,
};
use serde::Serialize;
use serde_json::{Number, Value, json};

use super::{StagedEdge, StagedEdgeMetadata, StagedFile, StagedRef, node_id, node_ids};
use crate::hex;

const RESOLVER: &str = "engine-ecmascript";

pub(super) struct Stage<'a> {
    facts: &'a [FileFacts],
    ids: Vec<Vec<Option<String>>>,
    edges: Vec<Vec<Edge>>,
    calls: Vec<Vec<(usize, &'static str, Option<DefRef>)>>,
    heritage: Vec<Vec<UnresolvedHeritage>>,
    imports: Vec<Vec<ImportResolution>>,
}

impl<'a> Stage<'a> {
    pub(super) fn new(facts: &'a [FileFacts], modules: &ModuleResolver) -> Self {
        let (resolution, imports) = resolve_for_stage(facts, modules);
        // The resolver visits sites in file order. A callback's edge belongs
        // to the callee's file even when the argument is in a different file.
        let mut edges = vec![Vec::new(); facts.len()];
        for edge in resolution.edges {
            edges[edge.from.0].push(edge);
        }
        let mut calls = vec![Vec::new(); facts.len()];
        for (file, index, reason) in resolution.unresolved_calls {
            calls[file].push((
                index,
                reason,
                resolution.call_candidates.get(&(file, index)).copied(),
            ));
        }
        let mut heritage = vec![Vec::new(); facts.len()];
        for base in resolution.unresolved_heritage {
            heritage[base.from.0].push(base);
        }
        Self {
            facts,
            ids: facts.iter().map(node_ids).collect(),
            edges,
            calls,
            heritage,
            imports,
        }
    }

    pub(super) fn file(&self, index: usize, size: u64) -> StagedFile<'_> {
        let facts = &self.facts[index];
        let mut file = StagedFile::new(facts, size, &self.ids[index]);
        file.edges
            .extend(self.edges[index].iter().filter_map(|edge| self.edge(edge)));
        for resolution in &self.imports[index] {
            let binding = self.import(index, resolution);
            if let Err(reason) = resolution.module {
                file.unresolved.extend(self.unresolved(
                    (index, 0),
                    "imports",
                    binding.module_specifier,
                    resolution.site.range,
                    None,
                    json!({ "reason": reason, "importBindingId": binding.binding_key }),
                ));
            }
            file.imports.push(binding);
        }
        for base in &self.heritage[index] {
            let base_fact = &facts.defs[base.from.1].heritage[base.heritage];
            let kind = if base_fact.implements {
                "implements"
            } else {
                "extends"
            };
            file.unresolved.extend(self.unresolved(
                base.from,
                kind,
                &base_fact.name,
                base_fact.range,
                None,
                json!({ "reason": base.reason, "heritage": kind }),
            ));
        }
        for &(call_index, reason, candidate) in &self.calls[index] {
            let call = &facts.calls[call_index];
            let caller = usize::try_from(call.caller).unwrap_or(0);
            let mut reference = self.unresolved(
                (index, caller),
                if call.form == CallForm::New {
                    "instantiates"
                } else {
                    "calls"
                },
                call_name(call),
                call.name_range,
                call_receiver(call),
                json!({ "reason": reason, "expression": call.text }),
            );
            if let Some(reference) = &mut reference {
                reference.candidate_id = candidate.and_then(|node| self.id(node));
            }
            file.unresolved.extend(reference);
        }
        file
    }

    fn id(&self, (file, index): DefRef) -> Option<&str> {
        node_id(&self.ids[file], index)
    }

    fn edge(&self, edge: &Edge) -> Option<StagedEdge<'_>> {
        let source = self.id(edge.from)?;
        let target = self.id(edge.to)?;
        let target_def = &self.facts[edge.to.0].defs[edge.to.1];
        let facts = &self.facts[edge.site_file];
        let (name, evidence) = match edge.site {
            EdgeSite::Import(index) => (
                facts.imports[index].specifier.as_str(),
                json!({ "resolvedFilePath": self.facts[edge.to.0].path }),
            ),
            EdgeSite::Heritage(index) => (
                self.facts[edge.from.0].defs[edge.from.1].heritage[index]
                    .name
                    .as_str(),
                json!({ "heritage": edge.kind }),
            ),
            EdgeSite::Call(index) => {
                let call = &facts.calls[index];
                (call_name(call), json!({ "expression": call.text }))
            }
            EdgeSite::Callback { argument } => (
                target_def.name.as_str(),
                json!({
                    "argumentIndex": argument,
                    "wiringSite": { "filePath": facts.path, "line": edge.line, "column": edge.col },
                    "callee": self.facts[edge.from.0].defs[edge.from.1].qualified_name,
                }),
            ),
            EdgeSite::Identifier(index) => {
                let expressions = &facts
                    .ecmascript
                    .as_ref()
                    .expect("ECMAScript facts")
                    .expressions;
                let name = match &expressions[index as usize] {
                    Expression::Name { name } | Expression::Member { name, .. } => name,
                    _ => &target_def.name,
                };
                (name.as_str(), json!({ "expression": name }))
            }
        };
        let callback = edge.is_callback();
        Some(StagedEdge {
            source,
            target,
            kind: edge.kind,
            line: edge.line,
            column: Some(edge.col),
            provenance: if callback {
                "callback-synthesis"
            } else {
                "typescript-compiler"
            },
            confidence: if callback {
                Number::from_f64(0.85).expect("finite confidence")
            } else {
                1.into()
            },
            resolution_method: RESOLVER,
            metadata: Some(StagedEdgeMetadata {
                target_name: name,
                target_qualified_name: &target_def.qualified_name,
            }),
            evidence: Some([evidence]),
        })
    }

    fn unresolved<'b>(
        &'b self,
        source: DefRef,
        kind: &'static str,
        name: &'b str,
        range: Range,
        receiver: Option<&'b str>,
        metadata: Value,
    ) -> Option<StagedRef<'b>> {
        let facts = &self.facts[source.0];
        Some(StagedRef {
            from_node_id: self.id(source)?,
            reference_name: name,
            reference_kind: kind,
            file_path: &facts.path,
            language: &facts.language,
            line: range.start_line + 1,
            column: range.start_col,
            status: "unresolved",
            resolver: RESOLVER,
            metadata,
            confidence: Some(0),
            candidates: Some([]),
            candidate_id: None,
            receiver,
            qualifier: receiver,
        })
    }

    fn import(&self, file: usize, resolved: &ImportResolution) -> StagedImport<'_> {
        let facts = &self.facts[file];
        let import = &facts.imports[resolved.site.import];
        let binding = &import.bindings[resolved.site.binding];
        let local = binding
            .local
            .as_deref()
            .expect("an import site binds a name");
        let identity = [
            facts.path.as_str(),
            local,
            &import.specifier,
            &binding.imported,
        ]
        .join("\0");
        StagedImport {
            binding_key: format!("import:{}", hex(&id_bytes(&identity))),
            file_path: &facts.path,
            local_name: local,
            imported_name: &binding.imported,
            module_specifier: &import.specifier,
            resolved_file_path: resolved
                .module
                .ok()
                .map(|target| self.facts[target].path.as_str()),
            target_id: resolved.target.and_then(|target| self.id(target)),
            is_type_only: binding.type_only,
            metadata: json!({
                "isNamespace": binding.imported == "*",
                "isDefault": binding.imported == "default",
                "line": resolved.site.range.start_line + 1,
                "column": resolved.site.range.start_col,
                "confidence": 1,
                "resolutionMethod": RESOLVER,
            }),
        }
    }
}

fn call_receiver(call: &Call) -> Option<&str> {
    // A dotted access reports its member token and receiver separately, as
    // the compiler does. Other callee expressions report their written text.
    let (prefix, member) = call.text.rsplit_once('.')?;
    (call.receiver.is_some() && call.name == member.trim())
        .then_some(prefix.trim_end_matches('?').trim_end())
}

fn call_name(call: &Call) -> &str {
    if call_receiver(call).is_some() {
        &call.name
    } else {
        &call.text
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StagedImport<'a> {
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
