//! Config-only extraction and exact-name hints within one adapter.

use std::collections::HashMap;

use mex_graph_core::facts::{FileFacts, Import, ImportForm, Kind, ReferenceKind, bounds};
use mex_graph_core::resolve::Files;
use mex_graph_syntax::resolve::{DefRef, FileResolution, Site, Target, visible};
use mex_graph_syntax::{Declarations, Extractor, empty_def, named_children};
use tree_sitter::Node;

use crate::adapters::{Adapter, BASIC, Implementation, Role, Rule};
use crate::syntax_language::SyntaxLanguage;

/// Each worker keeps its own parsers and fingerprint caches.
#[derive(Default)]
pub(crate) struct Extractors {
    python: Option<mex_graph_python::Python>,
    ecmascript: Option<mex_graph_ecmascript::EcmaScript>,
    rust: Option<mex_graph_rust::Rust>,
    csharp: Option<mex_graph_csharp::CSharp>,
    basic: HashMap<&'static str, Extractor>,
}

impl Extractors {
    pub(crate) fn extract(
        &mut self,
        adapter: &'static Adapter,
        path: &str,
        source: &str,
        hash: [u8; 32],
    ) -> FileFacts {
        match &adapter.implementation {
            Implementation::Python => self
                .python
                .get_or_insert_with(mex_graph_python::Python::new)
                .extract(path, source, hash),
            Implementation::EcmaScript => self
                .ecmascript
                .get_or_insert_with(mex_graph_ecmascript::EcmaScript::new)
                .extract(path, source, hash),
            Implementation::Syntax(SyntaxLanguage::Rust) => self
                .rust
                .get_or_insert_with(mex_graph_rust::Rust::new)
                .extract(path, source, hash),
            Implementation::Syntax(SyntaxLanguage::CSharp) => self
                .csharp
                .get_or_insert_with(mex_graph_csharp::CSharp::new)
                .extract(path, source, hash),
            Implementation::Basic(rules) => self
                .basic
                .entry(adapter.id())
                .or_insert_with(|| Extractor::new(adapter.id(), ".", adapter.grammar.language()))
                .extract(path, source, hash, |root, declarations| {
                    walk(root, declarations, rules, adapter.grammar.import_form());
                }),
        }
    }
}

fn walk(
    root: Node,
    declarations: &mut Declarations,
    rules: &HashMap<String, Rule>,
    import_form: ImportForm,
) {
    enum Visit<'tree> {
        Node(Node<'tree>),
        LeaveDefinition,
    }
    let mut work = vec![Visit::Node(root)];
    while let Some(visit) = work.pop() {
        let Visit::Node(node) = visit else {
            declarations.stack.pop();
            continue;
        };
        if let Some(rule) = rules.get(node.kind())
            && let Some(name_node) = rule.name_node(node)
        {
            let name = declarations.text.of(name_node).trim();
            if !name.is_empty() && name.len() <= bounds::MAX_CALLEE_TEXT_BYTES {
                let owner = *declarations.stack.last().expect("file definition");
                match rule.role {
                    Role::Function | Role::Class => {
                        let kind = match rule.role {
                            Role::Class => Kind::Class,
                            _ if declarations.defs[owner].kind == Kind::Class => Kind::Method,
                            _ => Kind::Function,
                        };
                        let def = empty_def(declarations.text.range(name_node));
                        if let Some(id) = declarations.create(kind, name, node, def) {
                            declarations.stack.push(id);
                            work.push(Visit::LeaveDefinition);
                        }
                    }
                    Role::Import => declarations.add_import(Import {
                        form: import_form,
                        specifier: unquote(name).to_owned(),
                        level: 0,
                        scope: owner as i32,
                        range: declarations.text.range(name_node),
                        bindings: Vec::new(),
                    }),
                    Role::Call => {
                        declarations.add_reference(owner, ReferenceKind::Calls, name, name_node)
                    }
                }
            }
        }
        work.extend(named_children(node).into_iter().rev().map(Visit::Node));
    }
}

fn unquote(name: &str) -> &str {
    for quote in ['\'', '"'] {
        if let Some(inner) = name
            .strip_prefix(quote)
            .and_then(|inner| inner.strip_suffix(quote))
        {
            return inner;
        }
    }
    name
}

/// A duplicate name has no target. Basic hints never bind across adapter ids.
pub(crate) fn resolve(files: Files<'_>) -> Vec<FileResolution<'_>> {
    type Names<'a> = HashMap<(&'a str, &'a str), Option<DefRef>>;
    fn add<'a>(names: &mut Names<'a>, language: &'a str, name: &'a str, target: DefRef) {
        names
            .entry((language, name))
            .and_modify(|prior| *prior = None)
            .or_insert(Some(target));
    }
    fn target(names: &Names<'_>, language: &str, name: &str) -> Target {
        match names.get(&(language, name)) {
            Some(Some(id)) => Ok(*id),
            Some(None) => Err("ambiguous_name"),
            None => Err("unknown_name"),
        }
    }

    let mut calls = Names::new();
    let mut imports = Names::new();
    for file in 0..files.len() {
        let facts = files.get(file);
        for (index, def) in facts
            .defs
            .iter()
            .enumerate()
            .filter(|(_, def)| visible(def))
        {
            match def.kind {
                Kind::File => {
                    if let Some((stem, _)) = def.name.rsplit_once('.') {
                        add(&mut imports, &facts.language, stem, (file, index));
                    }
                }
                Kind::Function | Kind::Method | Kind::Class => {
                    add(&mut calls, &facts.language, &def.name, (file, index));
                    add(&mut imports, &facts.language, &def.name, (file, index));
                }
                _ => {}
            }
        }
    }
    (0..files.len())
        .map(|file| {
            let facts = files.get(file);
            let mut resolution = FileResolution::default();
            for call in &facts.syntax_references {
                resolution.push(
                    (file, call.from),
                    Site::Symbol(call),
                    target(&calls, &facts.language, &call.name),
                    BASIC,
                );
            }
            for import in &facts.imports {
                let from = usize::try_from(import.scope).unwrap_or(0);
                resolution.push(
                    (file, from),
                    Site::Import(import),
                    target(&imports, &facts.language, &import.specifier),
                    BASIC,
                );
            }
            resolution
        })
        .collect()
}
