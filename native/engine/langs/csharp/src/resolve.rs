//! C# type lookup through enclosing namespaces and using directives.

use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::{FileFacts, Kind, ReferenceKind, SyntaxReference};
use mex_graph_core::text::js_trim;
use mex_graph_syntax::resolve::{
    DefRef, FileResolution, Index, Site, Target, accepts, last_segment, unique, visible,
};

pub fn resolve(files: &[FileFacts]) -> Vec<FileResolution<'_>> {
    let index = Index::new(files);
    let mut namespaces = HashMap::new();
    for (file, facts) in files.iter().enumerate() {
        for (def, node) in facts
            .defs
            .iter()
            .enumerate()
            .filter(|(_, def)| visible(def))
        {
            let enclosing = index.parent((file, def)).map_or("", |parent| {
                let parent_def = index.def(parent);
                if parent_def.kind == Kind::Namespace {
                    parent_def.qualified_name.as_str()
                } else {
                    namespaces.get(&parent).copied().unwrap_or("")
                }
            });
            if node.kind != Kind::File {
                namespaces.insert((file, def), enclosing);
            }
        }
    }
    let scope = Scope {
        index: &index,
        namespaces,
    };
    files
        .iter()
        .enumerate()
        .map(|(file, facts)| {
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
                if !visible(index.def(from)) {
                    continue;
                }
                let target = scope.bind(from, reference, &usings);
                let method = if target.is_ok_and(|to| to.0 != file) {
                    "namespace-scope"
                } else {
                    "lexical-scope"
                };
                result.push(from, Site::Symbol(reference), target, method);
            }
            result
        })
        .collect()
}

struct Scope<'a> {
    index: &'a Index<'a>,
    namespaces: HashMap<DefRef, &'a str>,
}

impl Scope<'_> {
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

        let index = self.index;
        let container = index.parent(from);
        let candidates = index
            .named(last_segment(name))
            .iter()
            .copied()
            .filter(|&id| {
                id.0 == from.0
                    && (reference.kind == ReferenceKind::Calls || id != from)
                    && accepts(reference.kind, index.def(id))
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
        let index = self.index;
        let trimmed = js_trim(raw);
        let global = trimmed.starts_with("global::");
        let name = trimmed.strip_prefix("global::").unwrap_or(trimmed);
        let name = name.split_once('<').map_or(name, |(head, _)| head);
        let name = js_trim(name.strip_suffix('?').unwrap_or(name));
        if !valid_type_name(name) {
            return Err("unproven_type_path");
        }
        let (qualifier, simple) = name.rsplit_once('.').unwrap_or(("", name));
        let types = index
            .named(simple)
            .iter()
            .copied()
            .filter(|&id| is_type(index.def(id).kind));
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

    fn namespace(&self, id: DefRef) -> &str {
        self.namespaces.get(&id).copied().unwrap_or("")
    }
}

fn is_type(kind: Kind) -> bool {
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
