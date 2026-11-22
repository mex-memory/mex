//! Project ECMAScript resolution into the compiler route's schema v4 rows.

use mex_graph_core::facts::{Call, CallForm, FileFacts, Range, ecmascript::Expression};
use mex_graph_core::id::id_bytes;
use mex_graph_core::resolve::Files;
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_ecmascript::resolve::{
    DefRef, Edge, EdgeSite, ImportResolution, Resolution, Resolver, UnresolvedHeritage,
};
use serde_json::{Number, Value, json};

use super::{
    Identities, StagedEdge, StagedEdgeMetadata, StagedFile, StagedImport, StagedRef, framework,
};
use crate::frameworks::Enabled;
use crate::hex;

const RESOLVER: &str = "engine-ecmascript";

pub(super) struct Stage<'a> {
    facts: Files<'a>,
    ids: Identities<'a>,
    edges: Vec<Vec<Edge>>,
    calls: Vec<Vec<(usize, &'static str, Option<DefRef>)>>,
    heritage: Vec<Vec<UnresolvedHeritage>>,
    imports: Vec<Vec<ImportResolution>>,
    frameworks: Option<Enabled>,
}

impl<'a> Stage<'a> {
    pub(super) fn new(
        facts: &'a [FileFacts],
        modules: &ModuleResolver,
        frameworks: Option<&Enabled>,
    ) -> Self {
        Self::resolve(
            Files::Dense(facts),
            modules,
            frameworks,
            &(0..facts.len()).collect::<Vec<_>>(),
            |_| Vec::new(),
            false,
        )
        .0
    }

    pub(super) fn resolve(
        facts: Files<'a>,
        modules: &ModuleResolver,
        frameworks: Option<&Enabled>,
        origins: &[usize],
        descendants: impl Fn(DefRef) -> Vec<DefRef>,
        by_site: bool,
    ) -> (Self, Vec<(DefRef, DefRef)>) {
        let mut resolver = Resolver::new(facts, modules);
        let resolution = resolver.resolve(origins.iter().copied(), descendants);
        let mut imports = (0..facts.len()).map(|_| Vec::new()).collect::<Vec<_>>();
        for &file in origins {
            facts.origin(file);
            let need_targets = !by_site
                || facts
                    .get(file)
                    .frameworks
                    .iter()
                    .any(|marker| marker.def >= 0);
            imports[file] = resolver.resolve_import_bindings(file, need_targets);
        }
        Self::group(facts, frameworks, resolution, imports, by_site)
    }

    fn group(
        facts: Files<'a>,
        frameworks: Option<&Enabled>,
        resolution: Resolution,
        imports: Vec<Vec<ImportResolution>>,
        by_site: bool,
    ) -> (Self, Vec<(DefRef, DefRef)>) {
        let mut edges = vec![Vec::new(); facts.len()];
        let mut inheritance = Vec::new();
        for edge in resolution.edges {
            if by_site && matches!(edge.kind, "extends" | "implements") {
                inheritance.push((edge.from, edge.to));
            }
            let owner = if by_site { edge.site_file } else { edge.from.0 };
            edges[owner].push(edge);
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
        (
            Self {
                facts,
                ids: Identities::new(facts),
                edges,
                calls,
                heritage,
                frameworks: frameworks.cloned(),
                imports,
            },
            inheritance,
        )
    }

    pub(super) fn file(&self, index: usize, size: u64, include_nodes: bool) -> StagedFile<'_> {
        let facts = self.facts.get(index);
        let mut file = StagedFile::new(facts, size, self.ids.file(index), include_nodes);
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
                reference.called_name = Some(&call.name);
                reference.candidate_id = candidate.and_then(|node| self.id(node));
            }
            file.unresolved.extend(reference);
        }
        if let Some(registry) = &self.frameworks {
            let links = registry.file_links(index, facts, &self.imports[index]);
            framework::add_links(&mut file, &links, index, |id| self.id(id));
        }
        file
    }

    fn id(&self, id: DefRef) -> Option<&str> {
        self.ids.id(id)
    }

    fn edge(&self, edge: &Edge) -> Option<StagedEdge<'_>> {
        let source = self.id(edge.from)?;
        let target = self.id(edge.to)?;
        let target_def = &self.facts.get(edge.to.0).defs[edge.to.1];
        let facts = self.facts.get(edge.site_file);
        let (name, evidence) = match edge.site {
            EdgeSite::Import(index) => (
                facts.imports[index].specifier.as_str(),
                json!({ "resolvedFilePath": self.facts.get(edge.to.0).path }),
            ),
            EdgeSite::Heritage(index) => (
                self.facts.get(edge.from.0).defs[edge.from.1].heritage[index]
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
                    "callee": self.facts.get(edge.from.0).defs[edge.from.1].qualified_name,
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
            owner: (edge.site_file != edge.from.0).then(|| self.facts.path(edge.from.0)),
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
        let facts = self.facts.get(source.0);
        Some(StagedRef {
            from_node_id: self.id(source)?,
            reference_name: name,
            called_name: None,
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
        let facts = self.facts.get(file);
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
                .map(|target| self.facts.get(target).path.as_str()),
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

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use mex_graph_core::resolve::Access;
    use mex_graph_ecmascript::EcmaScript;

    use super::*;

    #[test]
    fn import_projection_does_not_record_unrelated_origins() {
        let paths = ["a.ts", "b.ts"];
        let mut parser = EcmaScript::new();
        let files = paths.map(|path| parser.extract(path, "export const answer = 42;", [0; 32]));
        let origin = Cell::new(None);
        let foreign_reads = RefCell::new(Vec::new());
        let observe = |event: Access<'_>| match event {
            Access::Origin(index) => origin.set(Some(index)),
            Access::File(index) if origin.get() != Some(index) => {
                foreign_reads.borrow_mut().push((origin.get(), index));
            }
            _ => {}
        };
        let facts = Files::Lazy {
            paths: &paths,
            load: &|index| &files[index],
            observe: &observe,
        };
        let modules = ModuleResolver::new(paths, []);
        Stage::resolve(facts, &modules, None, &[0, 1], |_| Vec::new(), true);
        assert!(foreign_reads.into_inner().is_empty());
    }
}
