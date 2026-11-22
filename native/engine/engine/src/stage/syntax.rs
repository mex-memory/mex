//! Stage Rust and C# references with the fallback route's sites and bindings.

use mex_graph_core::facts::FileFacts;
use mex_graph_core::id::id_bytes;
use mex_graph_core::resolve::Files;
use mex_graph_syntax::resolve::{DefRef, FileResolution, ImportTarget, Site};
use serde_json::json;

use super::{Identities, StagedEdge, StagedFile, StagedImport, StagedRef};
use crate::hex;
use crate::syntax_language::SyntaxLanguage;

pub(super) struct Stage<'a> {
    facts: Files<'a>,
    ids: Identities<'a>,
    resolution: Vec<FileResolution<'a>>,
    resolver: &'static str,
}

impl<'a> Stage<'a> {
    pub(super) fn new(facts: &'a [FileFacts], language: SyntaxLanguage) -> Self {
        Self::resolved(Files::Dense(facts), language, language.resolve(facts))
    }

    pub(super) fn resolved(
        facts: Files<'a>,
        language: SyntaxLanguage,
        resolution: Vec<FileResolution<'a>>,
    ) -> Self {
        Self {
            facts,
            ids: Identities::new(facts),
            resolution,
            resolver: match language {
                SyntaxLanguage::Rust => "engine-rust",
                SyntaxLanguage::CSharp => "engine-csharp",
            },
        }
    }

    fn id(&self, id: DefRef) -> Option<&str> {
        self.ids.id(id)
    }

    pub(super) fn file(&self, index: usize, size: u64, include_nodes: bool) -> StagedFile<'_> {
        let facts = self.facts.get(index);
        let mut file = StagedFile::new(facts, size, self.ids.file(index), include_nodes);
        let resolution = &self.resolution[index];
        file.edges
            .extend(resolution.edges.iter().filter_map(|edge| {
                let range = edge.site.range();
                Some(StagedEdge {
                    owner: None,
                    source: self.id(edge.from)?,
                    target: self.id(edge.to)?,
                    kind: edge.site.kind(),
                    line: range.start_line + 1,
                    column: Some(range.start_col),
                    provenance: "lexical",
                    confidence: 1.into(),
                    resolution_method: edge.method,
                    metadata: None,
                    evidence: match edge.site {
                        Site::Import(import) => {
                            Some([json!({ "moduleSpecifier": import.specifier })])
                        }
                        Site::Symbol(_) => None,
                    },
                })
            }));
        file.unresolved
            .extend(resolution.unresolved.iter().filter_map(|reference| {
                let range = reference.site.range();
                let name = reference.site.name();
                let receiver = name
                    .rsplit_once('.')
                    .and_then(|(prefix, _)| (!prefix.is_empty()).then_some(prefix));
                let mut metadata = json!({ "reason": reference.reason });
                if let Site::Import(import) = reference.site
                    && !import.bindings.is_empty()
                {
                    metadata["bindings"] = json!(import.bindings.iter().map(|binding| {
                        json!({ "importedName": binding.imported, "localName": binding.local })
                    }).collect::<Vec<_>>());
                }
                Some(StagedRef {
                    from_node_id: self.id(reference.from)?,
                    reference_name: name,
                    called_name: None,
                    reference_kind: reference.site.kind(),
                    file_path: &facts.path,
                    language: &facts.language,
                    line: range.start_line + 1,
                    column: range.start_col,
                    status: "unresolved",
                    resolver: self.resolver,
                    metadata,
                    confidence: Some(0),
                    candidates: None,
                    candidate_id: None,
                    receiver,
                    qualifier: receiver,
                })
            }));
        file.imports.extend(
            resolution
                .imports
                .iter()
                .filter_map(|import| self.import(index, import)),
        );
        file
    }

    fn import<'b>(&'b self, file: usize, target: &'b ImportTarget<'a>) -> Option<StagedImport<'b>> {
        let facts = self.facts.get(file);
        let import = target.import;
        let binding = import.bindings.first()?;
        let local_name = binding.local.as_deref()?;
        let identity = [
            facts.path.as_str(),
            local_name,
            &binding.imported,
            &import.specifier,
        ]
        .join("\0");
        Some(StagedImport {
            binding_key: format!("import:{}", hex(&id_bytes(&identity))),
            file_path: &facts.path,
            local_name,
            imported_name: &binding.imported,
            module_specifier: &import.specifier,
            resolved_file_path: target.module.map(|file| self.facts.path(file)),
            target_id: target.target.and_then(|id| self.id(id)),
            is_type_only: false,
            metadata: json!({
                "line": import.range.start_line + 1,
                "column": import.range.start_col,
                "confidence": 1,
                "resolutionMethod": "explicit-import",
            }),
        })
    }
}
