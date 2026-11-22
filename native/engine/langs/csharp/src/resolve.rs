//! C# type lookup through enclosing namespaces and using directives.

use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::{FileFacts, Kind, ParseStatus, ReferenceKind, SyntaxReference};
use mex_graph_core::resolve::Files;
use mex_graph_core::text::js_trim;
use mex_graph_syntax::resolve::{
    DefRef, FileResolution, Index, Site, Target, accepts, last_segment, unique, visible,
};

pub fn resolve(files: &[FileFacts]) -> Vec<FileResolution<'_>> {
    let mut types: HashMap<&str, Vec<DefRef>> = HashMap::new();
    for (file, facts) in files.iter().enumerate() {
        if facts.health.status != ParseStatus::Failed {
            for (def, node) in facts.defs.iter().enumerate() {
                if visible(node) && is_type(node.kind) {
                    types.entry(&node.name).or_default().push((file, def));
                }
            }
        }
    }
    let lookup = |name: &str| types.get(name).cloned().unwrap_or_default();
    let scope = Resolver::new(Files::Dense(files), &lookup);
    (0..files.len())
        .map(|file| scope.resolve_file(file))
        .collect()
}

pub struct Resolver<'a, 'index> {
    index: Index<'a>,
    types: &'index dyn Fn(&str) -> Vec<DefRef>,
}

impl<'a, 'index> Resolver<'a, 'index> {
    pub fn new(files: Files<'a>, types: &'index dyn Fn(&str) -> Vec<DefRef>) -> Self {
        Self {
            index: Index::new(files),
            types,
        }
    }

    pub fn resolve_file(&self, file: usize) -> FileResolution<'a> {
        self.index.facts.origin(file);
        let facts = self.index.facts.get(file);
        let mut result = FileResolution::default();
        let usings: HashSet<_> = facts
            .imports
            .iter()
            .filter_map(|import| {
                let name = js_trim(
                    import
                        .specifier
                        .strip_prefix("global::")
                        .unwrap_or(&import.specifier),
                );
                (!name.starts_with("static ") && !name.contains('=')).then_some(name)
            })
            .collect();
        for import in &facts.imports {
            result.push(
                (file, 0),
                Site::Import(import),
                Err("namespace_import"),
                "explicit-import",
            );
        }
        for reference in &facts.syntax_references {
            let from = (file, reference.from);
            if !visible(self.index.def(from)) {
                continue;
            }
            let target = self.bind(from, reference, &usings);
            let method = if target.is_ok_and(|to| to.0 != file) {
                "namespace-scope"
            } else {
                "lexical-scope"
            };
            result.push(from, Site::Symbol(reference), target, method);
        }
        result
    }

    fn bind(&self, from: DefRef, reference: &SyntaxReference, usings: &HashSet<&str>) -> Target {
        let name = reference.name.as_str();
        let type_reference = matches!(
            reference.kind,
            ReferenceKind::Extends | ReferenceKind::Implements | ReferenceKind::Instantiates
        );
        if type_reference {
            match self.resolve_type(name, from, usings) {
                Ok(ty) if ty != from => return Ok(ty),
                Err("ambiguous_target") => return Err("ambiguous_target"),
                _ => {}
            }
        }

        let receiver = name.rsplit_once('.').map_or("", |(receiver, _)| receiver);
        let this_call = reference.kind == ReferenceKind::Calls && js_trim(receiver) == "this";
        if reference.kind == ReferenceKind::Calls && !receiver.is_empty() && !this_call {
            if receiver == "base" {
                return Err("unproven_base_receiver");
            }
            // A typed static receiver has one visible type and one static member.
            if self.index.children(from).iter().any(|&id| {
                let def = self.index.def(id);
                def.kind == Kind::Parameter && def.name == receiver
            }) {
                return Err("untyped_receiver");
            }
            let ty = self
                .resolve_type(receiver, from, usings)
                .map_err(|reason| {
                    if reason == "ambiguous_target" {
                        reason
                    } else {
                        "untyped_receiver"
                    }
                })?;
            let method = last_segment(name);
            return unique(self.index.children(ty).iter().copied().filter(|&child| {
                let node = self.index.def(child);
                node.kind == Kind::Method
                    && node.name == method
                    && node.flags.iter().any(|flag| flag == "static")
            }));
        }
        if (!receiver.is_empty() && !this_call) || name.contains("::") {
            return Err("unproven_qualifier");
        }

        let index = &self.index;
        let container = index.parent(from);
        let candidates = index
            .facts
            .get(from.0)
            .defs
            .iter()
            .enumerate()
            .skip(1)
            .filter_map(|(def, node)| {
                let id = (from.0, def);
                (node.name == last_segment(name)
                    && visible(node)
                    && (reference.kind == ReferenceKind::Calls || id != from)
                    && accepts(reference.kind, node))
                .then_some(id)
            });
        let target = unique(candidates.clone().filter(|&id| {
            let parent = index.parent(id);
            if this_call {
                parent == container && index.def(id).kind == Kind::Method
            } else {
                parent == container || parent == Some(from)
            }
        }));
        if target != Err("no_visible_declaration") {
            return target;
        }
        unique(candidates.filter(|&id| receiver.is_empty() && index.parent(id).is_none()))
    }

    fn resolve_type(&self, raw: &str, from: DefRef, usings: &HashSet<&str>) -> Target {
        let index = &self.index;
        let trimmed = js_trim(raw);
        let global = trimmed.starts_with("global::");
        let name = trimmed.strip_prefix("global::").unwrap_or(trimmed);
        let name = name.split_once('<').map_or(name, |(head, _)| head);
        let name = js_trim(name.strip_suffix('?').unwrap_or(name));
        if !valid_type_name(name) {
            return Err("unproven_type_path");
        }
        let (qualifier, simple) = name.rsplit_once('.').unwrap_or(("", name));
        self.index.facts.lookup("csharp-type", simple);
        let candidates = (self.types)(simple);
        let types = candidates.iter().copied();
        let global_types = types.clone().filter(|&id| {
            index
                .parent(id)
                .is_none_or(|parent| !is_type(index.def(parent).kind))
        });
        let within = |ns: &str| unique(global_types.clone().filter(|&id| self.namespace(id) == ns));
        if global {
            return within(qualifier);
        }
        if qualifier.is_empty() {
            for owner in std::iter::once(from)
                .chain(index.ancestors(from))
                .filter(|&owner| is_type(index.def(owner).kind))
            {
                let nested = unique(types.clone().filter(|&id| index.parent(id) == Some(owner)));
                if nested != Err("no_visible_declaration") {
                    return nested;
                }
            }
        }
        let mut namespace = self.namespace(from);
        while !namespace.is_empty() {
            let found = if qualifier.is_empty() {
                within(namespace)
            } else {
                within(&format!("{namespace}.{qualifier}"))
            };
            if found != Err("no_visible_declaration") {
                return found;
            }
            namespace = namespace.rsplit_once('.').map_or("", |(prefix, _)| prefix);
        }
        if !qualifier.is_empty() {
            return within(qualifier);
        }
        unique(global_types.filter(|&id| {
            let ns = self.namespace(id);
            ns.is_empty() || usings.contains(ns)
        }))
    }

    fn namespace(&self, id: DefRef) -> &'a str {
        self.index
            .ancestors(id)
            .find_map(|owner| {
                let def = self.index.def(owner);
                (def.kind == Kind::Namespace).then_some(def.qualified_name.as_str())
            })
            .unwrap_or("")
    }
}

pub fn is_type(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::Class | Kind::Struct | Kind::Interface | Kind::Enum
    )
}

fn valid_type_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
        && bytes.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.'))
}
