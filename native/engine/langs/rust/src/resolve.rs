//! Resolve only through lexical scopes, written module paths, and named uses.

use std::cell::{Cell, OnceCell};
use std::collections::HashMap;

use mex_graph_core::facts::{
    Def, FileFacts, Import, ImportBinding, Kind, ReferenceKind, SyntaxReference,
};
use mex_graph_core::resolve::{Files, LookupKind};
use mex_graph_core::text::js_trim;
use mex_graph_syntax::resolve::{
    DefRef, FileResolution, ImportTarget, Index, Site, Target, accepts, unique, visible,
};

const MAX_LOOKUP_STEPS: u16 = 128;
const MISSING: &str = "no_visible_declaration";

pub fn resolve(files: &[FileFacts]) -> Vec<FileResolution<'_>> {
    let scope = Resolver::new(Files::Dense(files));
    (0..files.len())
        .map(|file| scope.resolve_file(file))
        .collect()
}

type Imports<'a> = HashMap<usize, Vec<(&'a Import, &'a ImportBinding)>>;

pub struct Resolver<'a> {
    index: Index<'a>,
    imports: Vec<OnceCell<Imports<'a>>>,
    members: HashMap<String, Vec<usize>>,
}

impl<'a> Resolver<'a> {
    pub fn new(facts: Files<'a>) -> Self {
        let mut members: HashMap<String, Vec<usize>> = HashMap::new();
        for (file, path) in facts.paths().enumerate() {
            if let Some(member) = path.strip_suffix("/src/lib.rs") {
                let name = member
                    .rsplit('/')
                    .next()
                    .unwrap_or(member)
                    .replace('-', "_");
                members.entry(name).or_default().push(file);
            }
        }
        Self {
            index: Index::new(facts),
            imports: (0..facts.len()).map(|_| OnceCell::new()).collect(),
            members,
        }
    }

    pub fn resolve_file(&self, file: usize) -> FileResolution<'a> {
        self.index.facts.origin(file);
        let facts = self.index.facts.get(file);
        let mut result = FileResolution::default();
        for import in &facts.imports {
            let owner = (file, self.import_owner(file, import));
            let binding = import.bindings.first().expect("a Rust use binds a name");
            let target = self.import(owner, import, &any, &Cell::new(MAX_LOOKUP_STEPS));
            // An import edge names the written module. The binding can
            // separately point through a re-export to its definition.
            let module = self
                .module_prefix(owner, &import.specifier)
                .or_else(|| target.ok().map(|(module, _)| module));
            let edge = module
                .filter(|&module| module != file)
                .map(|module| (module, 0));
            if let Some(edge) = edge {
                result.push((file, 0), Site::Import(import), Ok(edge), "explicit-import");
            } else if target.is_err() {
                result.push((file, 0), Site::Import(import), target, "explicit-import");
            }
            result.imports.push(ImportTarget {
                import,
                module,
                target: target
                    .ok()
                    .filter(|&id| binding.imported != "*" || self.index.def(id).kind == Kind::File),
            });
        }
        for reference in &facts.syntax_references {
            let from = (file, reference.from);
            if !visible(self.index.def(from)) {
                continue;
            }
            let target = self.bind(from, reference);
            let method = if target.is_ok_and(|to| to.0 != file) {
                "explicit-import"
            } else {
                "lexical-scope"
            };
            result.push(from, Site::Symbol(reference), target, method);
        }
        result
    }

    fn imports(&self, (file, def): DefRef) -> &[(&'a Import, &'a ImportBinding)] {
        let facts = self.index.facts.get(file);
        self.imports[file]
            .get_or_init(|| {
                let mut imports: Imports<'_> = HashMap::new();
                for import in &facts.imports {
                    imports
                        .entry(self.import_owner(file, import))
                        .or_default()
                        .extend(import.bindings.iter().map(|binding| (import, binding)));
                }
                imports
            })
            .get(&def)
            .map_or(&[], Vec::as_slice)
    }

    fn import_owner(&self, file: usize, import: &Import) -> usize {
        usize::try_from(import.scope)
            .ok()
            .filter(|&scope| visible(self.index.def((file, scope))))
            .unwrap_or(0)
    }

    fn bind(&self, from: DefRef, reference: &SyntaxReference) -> Target {
        let name = reference.name.as_str();
        let matches_kind = |def: &Def| match reference.kind {
            ReferenceKind::TypeOf | ReferenceKind::Returns => is_type(def),
            _ => accepts(reference.kind, def),
        };
        if let Some((receiver, name)) = name.rsplit_once('.') {
            if reference.kind != ReferenceKind::Calls {
                return Err("untyped_receiver");
            }
            let ty = if receiver == "self" {
                self.impl_owner(from).ok_or("untyped_receiver")?
            } else if let Some(callee) = &reference.receiver_call {
                self.call_return_type(from, callee)?
            } else {
                // A qualified enum variant is an instance of its written enum.
                let path = split_path(receiver)
                    .filter(|path| path.len() > 1)
                    .ok_or("untyped_receiver")?;
                let variant = self.bind_path(from, &path, &|def| def.kind == Kind::EnumMember)?;
                self.index.parent(variant).ok_or("untyped_receiver")?
            };
            return self.child(ty, name, &|def| def.kind == Kind::Method);
        }
        let path = split_path(name).ok_or("unsupported_reference_path")?;
        self.bind_path(from, &path, &|def| {
            matches_kind(def)
                && (reference.kind != ReferenceKind::Calls
                    || path.len() > 1
                    || def.kind == Kind::Function)
        })
    }

    fn call_return_type(&self, from: DefRef, callee: &str) -> Target {
        let path = split_path(callee).ok_or("untyped_receiver")?;
        let target = self.bind_path(from, &path, &|def| {
            def.kind == Kind::Function || path.len() > 1 && def.kind == Kind::Method
        })?;
        let returned = self
            .index
            .facts
            .get(target.0)
            .syntax_references
            .iter()
            .rev()
            .find(|reference| {
                reference.from == target.1 && reference.kind == ReferenceKind::Returns
            })
            .map(|reference| reference.name.as_str())
            .ok_or("untyped_receiver")?;
        let path = split_path(returned).ok_or("untyped_receiver")?;
        self.bind_path(target, &path, &is_type)
    }

    fn bind_path(&self, from: DefRef, path: &[&str], accept: &impl Fn(&Def) -> bool) -> Target {
        let fuel = Cell::new(MAX_LOOKUP_STEPS);
        if path[0] == "Self" {
            let ty = self.impl_owner(from).ok_or("unproven_self_type")?;
            return self.follow(ty, &path[1..], accept, &fuel);
        }
        if anchored_name(path[0]) {
            let (start, rest) = self.anchored(from, path).ok_or("module_not_found")?;
            return self.follow(start, rest, accept, &fuel);
        }

        for owner in std::iter::once(from).chain(self.index.ancestors(from)) {
            // Unqualified calls cannot refer to a sibling associated item.
            if is_impl_scope(self.index.def(owner)) {
                continue;
            }
            let result = self.follow(owner, path, accept, &fuel);
            if result != Err(MISSING) {
                return result;
            }
            if is_module(self.index.def(owner)) {
                // An inline Rust module needs an explicit use to see its parent.
                break;
            }
        }
        let (start, rest) = self.anchored(from, path).ok_or(MISSING)?;
        self.follow(start, rest, accept, &fuel)
    }

    fn impl_owner(&self, from: DefRef) -> Option<DefRef> {
        self.index
            .ancestors(from)
            .find(|&owner| is_impl_scope(self.index.def(owner)))
    }

    fn enclosing_module(&self, from: DefRef) -> DefRef {
        std::iter::once(from)
            .chain(self.index.ancestors(from))
            .find(|&owner| is_module(self.index.def(owner)))
            .unwrap_or((from.0, 0))
    }

    fn module_parent(&self, module: DefRef) -> Option<DefRef> {
        if module.1 != 0 {
            return self
                .index
                .ancestors(module)
                .find(|&owner| is_module(self.index.def(owner)));
        }
        let path = self.index.facts.path(module.0);
        let (dir, file) = path.rsplit_once('/').unwrap_or(("", path));
        if let Some(entry) = self.integration_root(module.0) {
            return (entry != module.0).then_some((entry, 0));
        }
        if matches!(file, "lib.rs" | "main.rs") {
            return None;
        }
        if file != "mod.rs" {
            for stem in ["mod", "lib", "main"] {
                if let Some(candidate) = self.index.file(join(dir, &format!("{stem}.rs")).as_str())
                    && candidate != module.0
                {
                    return Some((candidate, 0));
                }
            }
        }
        if dir.is_empty() {
            return None;
        }
        if let Some(parent) = self.index.file(format!("{dir}.rs").as_str()) {
            return Some((parent, 0));
        }
        let parent = dirname(dir);
        ["mod", "lib", "main"].into_iter().find_map(|stem| {
            self.index
                .file(&join(parent, &format!("{stem}.rs")))
                .map(|file| (file, 0))
        })
    }

    fn crate_root(&self, from: usize) -> DefRef {
        if let Some(entry) = self.integration_root(from) {
            return (entry, 0);
        }
        let path = self.index.facts.path(from);
        if matches!(path.rsplit('/').next(), Some("lib.rs" | "main.rs")) {
            return (from, 0);
        }
        let mut dir = dirname(path);
        loop {
            for root in ["lib.rs", "main.rs"] {
                if let Some(file) = self.index.file(join(dir, root).as_str()) {
                    return (file, 0);
                }
            }
            if dir.is_empty() {
                return (from, 0);
            }
            dir = dirname(dir);
        }
    }

    /// Cargo's top-level integration tests, examples, benches and bin targets
    /// are roots. An adjacent aggregate entry can explicitly own a sibling.
    fn integration_root(&self, file: usize) -> Option<usize> {
        let path = self.index.facts.path(file);
        let (directory, filename) = path.rsplit_once('/')?;
        let kind = directory.rsplit('/').next()?;
        if !matches!(kind, "tests" | "examples" | "benches" | "bin") || filename == "mod.rs" {
            return None;
        }
        if let Some(root) = self
            .index
            .file(join(directory, &format!("{kind}.rs")).as_str())
            && self.index.children((root, 0)).iter().any(|&child| {
                let def = self.index.def(child);
                is_module(def) && filename.strip_suffix(".rs") == Some(def.name.as_str())
            })
        {
            return Some(root);
        }
        Some(file)
    }

    /// `crate`, `self`, `super`, and unique indexed workspace libraries
    /// are roots that can be followed without any symbol-name search.
    fn anchored<'p>(&self, from: DefRef, path: &'p [&str]) -> Option<(DefRef, &'p [&'p str])> {
        let (first, rest) = path.split_first()?;
        let start = match *first {
            "crate" => self.crate_root(from.0),
            "self" => self.enclosing_module(from),
            "super" => {
                let mut module = self.module_parent(self.enclosing_module(from))?;
                let mut rest = rest;
                while let Some(("super", tail)) =
                    rest.split_first().map(|(head, tail)| (*head, tail))
                {
                    module = self.module_parent(module)?;
                    rest = tail;
                }
                return Some((module, rest));
            }
            member if !rest.is_empty() => {
                self.index.facts.lookup(LookupKind::RustCrate, member);
                let mut candidates = self
                    .members
                    .get(member)?
                    .iter()
                    .filter_map(|&file| self.index.file(self.index.facts.path(file)));
                let file = candidates.next()?;
                if candidates.next().is_some() {
                    return None;
                }
                (file, 0)
            }
            _ => return None,
        };
        Some((start, rest))
    }

    fn import(
        &self,
        owner: DefRef,
        import: &Import,
        accept: &impl Fn(&Def) -> bool,
        fuel: &Cell<u16>,
    ) -> Target {
        let path = split_path(
            import
                .specifier
                .strip_suffix("::*")
                .unwrap_or(&import.specifier),
        )
        .ok_or("unsupported_import_path")?;
        if let Some((start, rest)) = self.anchored(owner, &path) {
            return self.follow(start, rest, accept, fuel);
        }
        if anchored_name(path[0]) {
            return Err("module_not_found");
        }
        // A use path without an anchor must name a written module or
        // declaration in this file, proved by walking the path's segments.
        self.walk(self.enclosing_module(owner), &path, accept, fuel)
    }

    fn module_prefix(&self, owner: DefRef, written: &str) -> Option<usize> {
        let path = split_path(written.strip_suffix("::*").unwrap_or(written))?;
        let (root, parts) = self.anchored(owner, &path)?;
        if parts.is_empty() {
            return Some(root.0);
        }
        for end in (1..=parts.len()).rev() {
            if let Ok(module) = self.walk(
                root,
                &parts[..end],
                &is_module,
                &Cell::new(MAX_LOOKUP_STEPS),
            ) {
                return Some(module.0);
            }
        }
        None
    }

    fn follow(
        &self,
        owner: DefRef,
        path: &[&str],
        accept: &impl Fn(&Def) -> bool,
        fuel: &Cell<u16>,
    ) -> Target {
        let remaining = fuel.get().checked_sub(1).ok_or("rust_lookup_limit")?;
        fuel.set(remaining);
        let target = self.walk(owner, path, accept, fuel);
        if target != Err(MISSING) || path.is_empty() {
            return target;
        }
        let mut matches = Vec::new();
        for &(import, binding) in self.imports(owner) {
            // The imported name must equal the first written segment. A glob
            // can supply names from its explicitly named module.
            let glob = binding.imported == "*";
            if !glob && binding.local.as_deref() != Some(path[0]) {
                continue;
            }
            let imported = self.import(owner, import, &any, fuel);
            let rest = if glob { path } else { &path[1..] };
            if let Ok(imported) = imported
                && (imported != owner || !glob)
            {
                match self.follow(imported, rest, accept, fuel) {
                    Ok(id) if !matches.contains(&id) => matches.push(id),
                    Err("ambiguous_target") => return Err("ambiguous_target"),
                    _ => {}
                }
            }
        }
        if fuel.get() == 0 {
            return Err("rust_lookup_limit");
        }
        unique(matches.into_iter())
    }

    fn walk(
        &self,
        owner: DefRef,
        path: &[&str],
        accept: &impl Fn(&Def) -> bool,
        fuel: &Cell<u16>,
    ) -> Target {
        let Some((name, rest)) = path.split_first() else {
            return accept(self.index.def(owner))
                .then_some(owner)
                .ok_or(MISSING);
        };
        if !rest.is_empty() {
            let part = self.child(owner, name, &|def| {
                is_type(def) || is_module(def) || def.kind == Kind::Namespace
            })?;
            return self.follow(part, rest, accept, fuel);
        }
        self.child(owner, name, accept)
    }

    fn child(&self, owner: DefRef, name: &str, accept: &impl Fn(&Def) -> bool) -> Target {
        unique(
            self.index
                .children(owner)
                .iter()
                .copied()
                .filter_map(|child| {
                    let def = self.index.def(child);
                    if def.name != name {
                        return None;
                    }
                    let target = if def.flags.iter().any(|flag| flag == "rust_external_module") {
                        let mut directory = if self.crate_root(owner.0).0 == owner.0 {
                            dirname(self.index.facts.path(owner.0)).into()
                        } else {
                            module_directory(self.index.facts.path(owner.0))
                        };
                        if let Some(inline) = (owner.1 != 0).then(|| self.index.def(owner)) {
                            directory = join(&directory, &inline.qualified_name.replace("::", "/"));
                        }
                        let path = join(&directory, name);
                        [format!("{path}.rs"), format!("{path}/mod.rs")]
                            .iter()
                            .find_map(|path| self.index.file(path))
                            .map_or(child, |file| (file, 0))
                    } else {
                        child
                    };
                    accept(self.index.def(target)).then_some(target)
                }),
        )
    }
}

fn any(_: &Def) -> bool {
    true
}

fn is_type(def: &Def) -> bool {
    matches!(
        def.kind,
        Kind::Class | Kind::Enum | Kind::Interface | Kind::TypeAlias
    )
}

fn is_module(def: &Def) -> bool {
    def.kind == Kind::File || def.flags.iter().any(|flag| flag == "rust_module")
}

fn is_impl_scope(def: &Def) -> bool {
    is_type(def) || def.kind == Kind::Namespace && !is_module(def)
}

fn anchored_name(name: &str) -> bool {
    matches!(name, "crate" | "self" | "super")
}

fn split_path(name: &str) -> Option<Vec<&str>> {
    let parts: Vec<_> = name
        .trim_start_matches("::")
        .split("::")
        .map(js_trim)
        .collect();
    parts
        .iter()
        .all(|part| {
            let mut chars = part.strip_prefix("r#").unwrap_or(part).chars();
            chars
                .next()
                .is_some_and(|ch| ch == '_' || ch.is_alphabetic())
                && chars.all(|ch| ch == '_' || ch.is_alphanumeric())
        })
        .then_some(parts)
}

fn module_directory(file: &str) -> String {
    let (dir, name) = file.rsplit_once('/').unwrap_or(("", file));
    if matches!(name, "mod.rs" | "lib.rs" | "main.rs") {
        dir.into()
    } else {
        join(dir, name.strip_suffix(".rs").unwrap_or(name))
    }
}

fn dirname(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.into()
    } else {
        format!("{dir}/{name}")
    }
}
