//! Python resolution: every file's facts in, call, inheritance and import
//! edges out.
//!
//! Built so the answer never depends on the order files are visited: the
//! module index and every file's symbol tables are built first and frozen,
//! and every lookup after that is a pure function of those tables.
//!
//! What a call resolves through, and only through:
//! * Python's scoping: locals, enclosing functions (class bodies are not
//!   visible to the functions inside them), the module, then builtins.
//!   Imports inside functions count; they were ignored before.
//! * Imports, followed through re-exports and `__init__.py` packages.
//! * Receivers typed by evidence: `self` and `cls`, `super()`, annotations,
//!   `x = Cls(...)`, and calls whose declared return type names a class.
//! * Inheritance, depth-first through bases in order.
//!
//! A call nothing proves stays unresolved, counted under a named reason. A
//! name that only matches somewhere in the repository is never a target.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::{CallForm, FileFacts, Kind, NONE, Receiver, TypeBasis};

use mex_graph_core::resolve::Files;

use crate::EXCLUDED;

/// A definition: (file index, definition index).
pub type DefRef = (usize, usize);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edge {
    pub from: DefRef,
    pub to: DefRef,
    pub kind: &'static str,
    /// 1-based line and UTF-16 column of the called name (or the base, or
    /// the import statement).
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Default)]
pub struct Resolution {
    /// Grouped by source file, in input file order.
    pub edges: Vec<Edge>,
    /// (file index, reason, count), sorted.
    pub unresolved: Vec<(usize, &'static str, u32)>,
    /// Every call left unresolved, in file and call order, so a reader can
    /// answer "no callers" per symbol: (file index, call index, reason).
    pub unresolved_calls: Vec<(usize, usize, &'static str)>,
    pub call_candidates: HashMap<(usize, usize), DefRef>,
}

const MAX_DEPTH: usize = 12;

/// Names Python provides without an import. A module-level definition with
/// the same name shadows them, because lookup reaches builtins last.
const BUILTINS: &[&str] = &[
    "abs",
    "aiter",
    "all",
    "anext",
    "any",
    "ascii",
    "bin",
    "bool",
    "breakpoint",
    "bytearray",
    "bytes",
    "callable",
    "chr",
    "classmethod",
    "compile",
    "complex",
    "delattr",
    "dict",
    "dir",
    "divmod",
    "enumerate",
    "eval",
    "exec",
    "filter",
    "float",
    "format",
    "frozenset",
    "getattr",
    "globals",
    "hasattr",
    "hash",
    "help",
    "hex",
    "id",
    "input",
    "int",
    "isinstance",
    "issubclass",
    "iter",
    "len",
    "list",
    "locals",
    "map",
    "max",
    "memoryview",
    "min",
    "next",
    "object",
    "oct",
    "open",
    "ord",
    "pow",
    "print",
    "property",
    "range",
    "repr",
    "reversed",
    "round",
    "set",
    "setattr",
    "slice",
    "sorted",
    "staticmethod",
    "str",
    "sum",
    "super",
    "tuple",
    "type",
    "vars",
    "zip",
    "__import__",
    "BaseException",
    "Exception",
    "ArithmeticError",
    "AssertionError",
    "AttributeError",
    "EOFError",
    "ImportError",
    "IndexError",
    "KeyError",
    "KeyboardInterrupt",
    "LookupError",
    "MemoryError",
    "NameError",
    "NotImplementedError",
    "OSError",
    "OverflowError",
    "RecursionError",
    "RuntimeError",
    "StopIteration",
    "StopAsyncIteration",
    "SyntaxError",
    "SystemExit",
    "TypeError",
    "UnicodeError",
    "UnicodeDecodeError",
    "UnicodeEncodeError",
    "ValueError",
    "ZeroDivisionError",
    "FileNotFoundError",
    "FileExistsError",
    "PermissionError",
    "TimeoutError",
    "ConnectionError",
    "Warning",
    "UserWarning",
    "DeprecationWarning",
    "PendingDeprecationWarning",
    "RuntimeWarning",
    "FutureWarning",
    "ResourceWarning",
    "ExceptionGroup",
    "BaseExceptionGroup",
];

/// A `self.x` field's type evidence, by field name.
type Fields = HashMap<String, (Option<String>, Option<TypeBasis>)>;

/// What a name stands for in one scope, before it is resolved further.
#[derive(Clone, Debug)]
enum Sym {
    /// A definition in the same file.
    Def(usize),
    /// A parameter or assignment, with the evidence for its type.
    Binding {
        type_name: Option<String>,
        basis: Option<TypeBasis>,
    },
    /// `from <module> import <name>`: (import index, binding index).
    From(usize, usize),
    /// `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
    ModulePath(String),
    /// Bound two different ways in one scope: no single answer.
    Ambiguous,
}

/// What a resolved name or expression is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Value {
    Def(DefRef),
    Module(usize),
    Instance(DefRef),
    Unknown(&'static str),
}

struct FileTables {
    /// Names bound in each scope, indexed by the scope's definition.
    scopes: HashMap<usize, HashMap<String, Sym>>,
    /// Class members (methods, nested classes, class variables) by class.
    members: HashMap<usize, HashMap<String, usize>>,
    /// `self.x = ...` fields by class, with their type evidence.
    fields: HashMap<usize, Fields>,
    /// The name a method's first parameter binds.
    self_names: HashMap<usize, String>,
    /// Modules a file imports with `*`, by (import index).
    star_imports: Vec<usize>,
    /// The module file each import statement names, when it is in the repository.
    import_targets: Vec<Option<usize>>,
}

pub struct Resolver<'a> {
    files: Files<'a>,
    /// Dotted module name -> file index. Names claimed twice are left out.
    modules: HashMap<String, usize>,
    /// Repository path -> file index.
    paths: HashMap<&'a str, usize>,
    tables: Vec<OnceCell<FileTables>>,
}

fn is_node(facts: &FileFacts, def: usize) -> bool {
    facts
        .defs
        .get(def)
        .is_some_and(|d| !d.flags.iter().any(|f| f == EXCLUDED))
}

/// The nearest enclosing definition that is a node, defaulting to the file node.
pub fn call_source(facts: &FileFacts, mut caller: i32) -> usize {
    while caller > 0 && !is_node(facts, caller as usize) {
        caller = facts.defs[caller as usize].parent;
    }
    caller.max(0) as usize
}

fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

fn join(dir: &str, rest: &str) -> String {
    if dir.is_empty() {
        rest.to_owned()
    } else {
        format!("{dir}/{rest}")
    }
}

/// The dotted name a file is imported as: from the top of its chain of
/// `__init__.py` packages (`src/flask/app.py` -> `flask.app`).
fn module_name(path: &str, packages: &HashSet<String>) -> String {
    let stem = path.strip_suffix(".py").unwrap_or(path);
    let stem = stem.strip_suffix("/__init__").unwrap_or(stem);
    let mut parts: Vec<&str> = stem.split('/').collect();
    // Keep the leading directories that are packages, from the file upward.
    let mut keep = 1;
    let mut dir = dir_of(path).to_owned();
    if path.ends_with("/__init__.py") {
        dir = dir_of(&dir).to_owned();
    }
    while !dir.is_empty() && packages.contains(&dir) {
        keep += 1;
        dir = dir_of(&dir).to_owned();
    }
    let start = parts.len().saturating_sub(keep);
    parts.drain(..start);
    parts.join(".")
}

/// The same path-only index is used when comparing checkout topologies.
pub fn module_index<'a>(paths: impl Iterator<Item = &'a str> + Clone) -> HashMap<String, usize> {
    let packages: HashSet<String> = paths
        .clone()
        .filter_map(|path| path.strip_suffix("/__init__.py").map(str::to_owned))
        .collect();
    let mut claimed: HashMap<String, Option<usize>> = HashMap::new();
    for (i, path) in paths.enumerate() {
        claimed
            .entry(module_name(path, &packages))
            .and_modify(|entry| *entry = None)
            .or_insert(Some(i));
    }
    claimed
        .into_iter()
        .filter_map(|(name, file)| Some((name, file?)))
        .collect()
}

/// Strip an annotation to the class it names: quotes, `Optional[...]`,
/// generic arguments and `| None` removed.
fn annotation_class(text: &str) -> Option<String> {
    let t = text.trim().trim_matches(|c| c == '"' || c == '\'');
    let t = t
        .strip_prefix("Optional[")
        .or_else(|| t.strip_prefix("typing.Optional["))
        .map_or(t, |s| s.strip_suffix(']').unwrap_or(s));
    let first = t.split('|').map(str::trim).find(|p| *p != "None")?;
    let head = first.split('[').next()?.trim();
    let valid = !head.is_empty()
        && head
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphanumeric() || c == '_'));
    valid.then(|| head.to_owned())
}

impl<'a> Resolver<'a> {
    pub fn new(files: &'a [FileFacts]) -> Self {
        Self::with_files(Files::Dense(files))
    }

    pub fn with_files(files: Files<'a>) -> Self {
        let paths = files
            .paths()
            .enumerate()
            .map(|(i, path)| (path, i))
            .collect();
        Self {
            files,
            modules: module_index(files.paths()),
            paths,
            tables: (0..files.len()).map(|_| OnceCell::new()).collect(),
        }
    }

    fn tables(&self, file: usize) -> &FileTables {
        // A cached table represents a read of the file as well.
        self.files.get(file);
        self.tables[file].get_or_init(|| self.files.within(file, || self.build_tables(file)))
    }

    /// The file a module path names: a module or a package's `__init__.py`.
    fn file_at(&self, dir_path: &str) -> Option<usize> {
        self.path_at(&format!("{dir_path}.py"))
            .or_else(|| self.path_at(&format!("{dir_path}/__init__.py")))
    }

    fn path_at(&self, path: &str) -> Option<usize> {
        self.files.lookup("path", path);
        self.paths.get(path).copied()
    }

    fn module_at(&self, name: &str) -> Option<usize> {
        self.files.lookup("python-module", name);
        self.modules.get(name).copied()
    }

    /// The module an import statement names, from the importing file.
    fn import_target(&self, file: usize, specifier: &str, level: u32) -> Option<usize> {
        if level == 0 {
            return self.module_at(specifier);
        }
        let path = self.files.path(file);
        let mut dir = dir_of(path).to_owned();
        for _ in 1..level {
            dir = dir_of(&dir).to_owned();
        }
        if specifier.is_empty() {
            return self.path_at(&join(&dir, "__init__.py"));
        }
        self.file_at(&join(&dir, &specifier.replace('.', "/")))
    }

    fn build_tables(&self, file: usize) -> FileTables {
        let facts = self.files.get(file);
        let mut scopes: HashMap<usize, HashMap<String, Sym>> = HashMap::new();
        let mut members: HashMap<usize, HashMap<String, usize>> = HashMap::new();
        let mut fields: HashMap<usize, Fields> = HashMap::new();
        let mut self_names = HashMap::new();
        // Bindings first, so a definition or import of the same name wins:
        // within a scope a `def` is the stronger evidence of what a name is.
        for b in &facts.bindings {
            if b.scope == NONE {
                continue;
            }
            let scope = b.scope as usize;
            if let Some(class) = b.field_of {
                fields
                    .entry(class as usize)
                    .or_default()
                    .entry(b.name.clone())
                    .or_insert((b.type_name.clone(), b.type_basis));
                continue;
            }
            if b.param
                && facts
                    .defs
                    .get(scope)
                    .is_some_and(|d| d.kind == Kind::Method)
                && !self_names.contains_key(&scope)
            {
                self_names.insert(scope, b.name.clone());
            }
            let entry = scopes.entry(scope).or_default();
            // A typed binding beats an untyped one for the same name.
            let typed = b.type_name.is_some();
            match entry.get(&b.name) {
                Some(Sym::Binding {
                    type_name: Some(_), ..
                }) if !typed => {}
                _ => {
                    entry.insert(
                        b.name.clone(),
                        Sym::Binding {
                            type_name: b.type_name.clone(),
                            basis: b.type_basis,
                        },
                    );
                }
            }
        }
        let mut star_imports = Vec::new();
        let mut import_targets = Vec::new();
        for (ii, import) in facts.imports.iter().enumerate() {
            let target = self.import_target(file, &import.specifier, import.level);
            import_targets.push(target);
            let scope = import.scope.max(0) as usize;
            for (bi, b) in import.bindings.iter().enumerate() {
                let Some(local) = &b.local else {
                    if b.imported == "*"
                        && scope == 0
                        && let Some(t) = target
                    {
                        star_imports.push(t);
                    }
                    continue;
                };
                let sym = if import.level == 0 && b.imported == "*" {
                    // `import a.b`: `a` names package `a`; with an alias, the whole path.
                    match &b.exported {
                        Some(path) => Sym::ModulePath(path.clone()),
                        None => Sym::ModulePath(local.clone()),
                    }
                } else {
                    Sym::From(ii, bi)
                };
                scopes.entry(scope).or_default().insert(local.clone(), sym);
            }
        }
        for (i, d) in facts.defs.iter().enumerate().skip(1) {
            if d.parent == NONE {
                continue;
            }
            let parent = d.parent as usize;
            if facts.defs[parent].kind == Kind::Class {
                members.entry(parent).or_default().insert(d.name.clone(), i);
            }
            scopes
                .entry(parent)
                .or_default()
                .insert(d.name.clone(), Sym::Def(i));
        }
        // A name bound two different ways in one scope could be either one
        // at a given call: two imports (a try/except fallback), an import
        // beside an assignment or definition, or a function or class rebound
        // by assignment (`f = wrap(f)`). Those stay unresolved. A variable
        // definition and its own assignment are one binding, not two.
        let mut imports: HashMap<(usize, &str), u32> = HashMap::new();
        for import in &facts.imports {
            for b in &import.bindings {
                if let Some(local) = &b.local {
                    *imports
                        .entry((import.scope.max(0) as usize, local))
                        .or_default() += 1;
                }
            }
        }
        let assigned: HashSet<(usize, &str)> = facts
            .bindings
            .iter()
            .filter(|b| !b.param && b.field_of.is_none() && b.scope != NONE)
            .map(|b| (b.scope as usize, b.name.as_str()))
            .collect();
        let mut defined: HashMap<(usize, &str), bool> = HashMap::new();
        for d in facts.defs.iter().skip(1).filter(|d| d.parent != NONE) {
            let callable = matches!(d.kind, Kind::Function | Kind::Method | Kind::Class);
            let slot = defined
                .entry((d.parent as usize, d.name.as_str()))
                .or_default();
            *slot |= callable;
        }
        for (scope, names) in &mut scopes {
            for (name, sym) in names.iter_mut() {
                let key = (*scope, name.as_str());
                let imported = imports.get(&key).copied().unwrap_or(0);
                let assigns = assigned.contains(&key);
                let def = defined.get(&key).copied();
                let ambiguous = imported >= 2
                    || (imported == 1 && (assigns || def.is_some()))
                    || (def == Some(true) && assigns);
                if ambiguous {
                    *sym = Sym::Ambiguous;
                }
            }
        }
        FileTables {
            scopes,
            members,
            fields,
            self_names,
            star_imports,
            import_targets,
        }
    }

    /// The definitions whose scopes a lookup from `scope` walks: the scope,
    /// then enclosing functions (skipping classes), then the module.
    fn scope_chain(&self, file: usize, scope: usize) -> Vec<usize> {
        let defs = &self.files.get(file).defs;
        let mut chain = vec![scope];
        let mut cur = defs.get(scope).map_or(NONE, |d| d.parent);
        while cur != NONE {
            let c = cur as usize;
            if defs[c].kind != Kind::Class {
                chain.push(c);
            }
            cur = defs[c].parent;
        }
        if *chain.last().unwrap_or(&0) != 0 {
            chain.push(0);
        }
        chain
    }

    /// Resolve a bare name from a scope.
    fn lookup(&self, file: usize, scope: usize, name: &str, depth: usize) -> Value {
        if depth > MAX_DEPTH {
            return Value::Unknown("depth_limit");
        }
        for s in self.scope_chain(file, scope) {
            if let Some(sym) = self.tables(file).scopes.get(&s).and_then(|m| m.get(name)) {
                return self.sym_value(file, s, sym, depth);
            }
        }
        for &star in &self.tables(file).star_imports {
            let v = self.module_member(star, name, depth + 1);
            if !matches!(v, Value::Unknown(_)) {
                return v;
            }
        }
        if BUILTINS.contains(&name) {
            Value::Unknown("builtin")
        } else {
            Value::Unknown("unknown_name")
        }
    }

    fn sym_value(&self, file: usize, scope: usize, sym: &Sym, depth: usize) -> Value {
        match sym {
            Sym::Def(d) => self.def_value(file, *d, depth),
            Sym::Ambiguous => Value::Unknown("rebound_name"),
            Sym::Binding { type_name, basis } => {
                self.typed_value(file, scope, type_name.as_deref(), *basis, depth)
            }
            Sym::ModulePath(path) => match self.module_at(path) {
                Some(m) => Value::Module(m),
                None => Value::Unknown("external_module"),
            },
            Sym::From(ii, bi) => {
                let import = &self.files.get(file).imports[*ii];
                let binding = &import.bindings[*bi];
                match self.tables(file).import_targets[*ii] {
                    Some(module) => self.module_member(module, &binding.imported, depth + 1),
                    None => Value::Unknown("external_module"),
                }
            }
        }
    }

    /// A definition as a value: a variable that only aliases another name
    /// (`handler = other_function`) stands for that name.
    fn def_value(&self, file: usize, def: usize, depth: usize) -> Value {
        let d = &self.files.get(file).defs[def];
        if matches!(d.kind, Kind::Variable | Kind::Constant) {
            let alias = d.signature.trim();
            let is_name = !alias.is_empty()
                && alias
                    .split('.')
                    .all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphanumeric() || c == '_'));
            if is_name && alias != d.name {
                return self.dotted(file, d.parent.max(0) as usize, alias, depth + 1);
            }
        }
        if !is_node(self.files.get(file), def) {
            return Value::Unknown("excluded_target");
        }
        Value::Def((file, def))
    }

    /// The value a typed binding holds: an instance of the class its
    /// annotation names, or of what its initializing call returns.
    fn typed_value(
        &self,
        file: usize,
        scope: usize,
        type_name: Option<&str>,
        basis: Option<TypeBasis>,
        depth: usize,
    ) -> Value {
        let Some(type_name) = type_name else {
            return Value::Unknown("untyped_binding");
        };
        match basis {
            Some(TypeBasis::Annotation) => match annotation_class(type_name) {
                Some(class) => self.instance_of(self.dotted(file, scope, &class, depth + 1)),
                None => Value::Unknown("unreadable_annotation"),
            },
            Some(TypeBasis::Call) => {
                let callee = self.dotted(file, scope, type_name, depth + 1);
                self.call_result(callee, depth + 1)
            }
            _ => Value::Unknown("untyped_binding"),
        }
    }

    fn instance_of(&self, v: Value) -> Value {
        match v {
            Value::Def(d) if self.files.get(d.0).defs[d.1].kind == Kind::Class => {
                Value::Instance(d)
            }
            Value::Unknown(r) => Value::Unknown(r),
            _ => Value::Unknown("not_a_class"),
        }
    }

    /// What calling `callee` returns: an instance of a class, or of the class
    /// a function's declared return type names.
    fn call_result(&self, callee: Value, depth: usize) -> Value {
        match callee {
            Value::Def(d) => {
                let def = &self.files.get(d.0).defs[d.1];
                match def.kind {
                    Kind::Class => Value::Instance(d),
                    Kind::Function | Kind::Method => {
                        match def.return_type.as_deref().and_then(annotation_class) {
                            Some(ret) => {
                                let scope = def.parent.max(0) as usize;
                                self.instance_of(self.dotted(d.0, scope, &ret, depth + 1))
                            }
                            None => Value::Unknown("return_type_unknown"),
                        }
                    }
                    _ => Value::Unknown("called_value"),
                }
            }
            Value::Unknown(r) => Value::Unknown(r),
            _ => Value::Unknown("called_value"),
        }
    }

    /// `a.b.c` from a scope.
    fn dotted(&self, file: usize, scope: usize, path: &str, depth: usize) -> Value {
        let mut parts = path.split('.');
        let Some(first) = parts.next() else {
            return Value::Unknown("unknown_name");
        };
        let mut v = self.lookup(file, scope, first, depth + 1);
        for part in parts {
            v = self.attribute(v, part, depth + 1);
        }
        v
    }

    /// A name inside a module: its definitions and imports, then a submodule.
    fn module_member(&self, module: usize, name: &str, depth: usize) -> Value {
        if depth > MAX_DEPTH {
            return Value::Unknown("depth_limit");
        }
        if let Some(sym) = self.tables(module).scopes.get(&0).and_then(|m| m.get(name)) {
            let v = self.sym_value(module, 0, sym, depth);
            if !matches!(v, Value::Unknown("external_module")) {
                return v;
            }
        }
        let path = &self.files.get(module).path;
        if let Some(pkg) = path.strip_suffix("/__init__.py")
            && let Some(sub) = self.file_at(&join(pkg, name))
        {
            return Value::Module(sub);
        }
        for &star in &self.tables(module).star_imports {
            let v = self.module_member(star, name, depth + 1);
            if !matches!(v, Value::Unknown(_)) {
                return v;
            }
        }
        Value::Unknown("not_in_module")
    }

    /// `value.name`.
    fn attribute(&self, v: Value, name: &str, depth: usize) -> Value {
        match v {
            Value::Module(m) => self.module_member(m, name, depth),
            Value::Def(d) if self.files.get(d.0).defs[d.1].kind == Kind::Class => {
                match self.member(d, name, depth) {
                    Some(m) => self.def_value(m.0, m.1, depth),
                    None => Value::Unknown("unknown_member"),
                }
            }
            Value::Instance(class) => self.instance_attribute(class, name, depth),
            Value::Unknown(r) => Value::Unknown(r),
            Value::Def(_) => Value::Unknown("attribute_of_value"),
        }
    }

    /// An attribute of an instance: a method or class member through the
    /// bases, or a `self.x` field with a known type.
    fn instance_attribute(&self, class: DefRef, name: &str, depth: usize) -> Value {
        if let Some(m) = self.member(class, name, depth) {
            let def = &self.files.get(m.0).defs[m.1];
            return if matches!(def.kind, Kind::Variable | Kind::Constant) {
                Value::Unknown("attribute_value")
            } else {
                self.def_value(m.0, m.1, depth)
            };
        }
        for c in self.mro(class, depth) {
            if let Some((type_name, basis)) =
                self.tables(c.0).fields.get(&c.1).and_then(|f| f.get(name))
            {
                // A field's evidence is read in the scope of its class's methods.
                return self.typed_value(c.0, c.1, type_name.as_deref(), *basis, depth + 1);
            }
        }
        Value::Unknown("unknown_member")
    }

    /// The class and its bases, depth-first left to right, each once.
    fn mro(&self, class: DefRef, depth: usize) -> Vec<DefRef> {
        let mut out = Vec::new();
        let mut stack = vec![(class, 0usize)];
        while let Some((c, level)) = stack.pop() {
            if out.contains(&c) || level > 24 || out.len() >= 256 {
                continue;
            }
            out.push(c);
            let def = &self.files.get(c.0).defs[c.1];
            let scope = def.parent.max(0) as usize;
            let mut bases = Vec::new();
            for h in &def.heritage {
                if let Value::Def(b) = self.dotted(c.0, scope, &h.name, depth + 1)
                    && self.files.get(b.0).defs[b.1].kind == Kind::Class
                {
                    bases.push(b);
                }
            }
            for b in bases.into_iter().rev() {
                stack.push((b, level + 1));
            }
        }
        out
    }

    fn member(&self, class: DefRef, name: &str, depth: usize) -> Option<DefRef> {
        self.mro(class, depth).into_iter().find_map(|c| {
            self.tables(c.0)
                .members
                .get(&c.1)
                .and_then(|m| m.get(name))
                .map(|&d| (c.0, d))
        })
    }

    /// The class `self` (or `cls`) names in a method scope.
    fn self_class(&self, file: usize, scope: usize) -> Option<DefRef> {
        let def = self.files.get(file).defs.get(scope)?;
        (def.kind == Kind::Method).then_some((file, def.parent as usize))
    }

    fn receiver_value(&self, file: usize, scope: usize, receiver: &Receiver) -> Value {
        match receiver {
            Receiver::This => match self.self_class(file, scope) {
                Some(c) => Value::Instance(c),
                None => Value::Unknown("unknown_self"),
            },
            Receiver::Name { name } => self.lookup(file, scope, name, 0),
            Receiver::Path { path } => {
                let Some((first, rest)) = path.split_first() else {
                    return Value::Unknown("dynamic_receiver");
                };
                let mut v = match self.tables(file).self_names.get(&scope) {
                    Some(s) if s == first => match self.self_class(file, scope) {
                        Some(c) => Value::Instance(c),
                        None => Value::Unknown("unknown_self"),
                    },
                    _ => self.lookup(file, scope, first, 0),
                };
                for part in rest {
                    v = self.attribute(v, part, 0);
                }
                v
            }
            Receiver::CallResult { name, receiver } => {
                let callee = match receiver {
                    None => self.lookup(file, scope, name, 0),
                    Some(r) => self.attribute(self.receiver_value(file, scope, r), name, 0),
                };
                self.call_result(callee, 0)
            }
            Receiver::Super => Value::Unknown("super"),
            Receiver::Builtin { .. } => Value::Unknown("builtin_receiver"),
            Receiver::ThisMember { .. } | Receiver::Expression { .. } | Receiver::Other => {
                Value::Unknown("dynamic_receiver")
            }
        }
    }

    pub fn resolve_file(&self, file: usize, out: &mut Resolution) {
        self.files.origin(file);
        let facts = self.files.get(file);
        if facts.defs.is_empty() {
            return;
        }
        let mut reasons: HashMap<&'static str, u32> = HashMap::new();
        for (call_index, call) in facts.calls.iter().enumerate() {
            let scope = call.scope.max(0) as usize;
            let target = match (&call.form, &call.receiver) {
                (CallForm::Ident, _) => self.lookup(file, scope, &call.name, 0),
                (CallForm::Member, Some(Receiver::Super)) => match self.self_class(file, scope) {
                    Some(c) => self
                        .mro(c, 0)
                        .into_iter()
                        .skip(1)
                        .find_map(|b| {
                            self.tables(b.0)
                                .members
                                .get(&b.1)
                                .and_then(|m| m.get(&call.name))
                                .map(|&d| (b.0, d))
                        })
                        .map_or(Value::Unknown("unknown_member"), |m| {
                            self.def_value(m.0, m.1, 0)
                        }),
                    None => Value::Unknown("unknown_self"),
                },
                (CallForm::Member, Some(receiver)) => {
                    let base = self.receiver_value(file, scope, receiver);
                    match base {
                        Value::Unknown(r) => Value::Unknown(if r == "builtin" {
                            "builtin_receiver"
                        } else if r == "untyped_binding" || r == "unknown_name" {
                            "untyped_receiver"
                        } else {
                            r
                        }),
                        v => self.attribute(v, &call.name, 0),
                    }
                }
                _ => Value::Unknown("dynamic_receiver"),
            };
            let resolved = match target {
                Value::Def(d) => {
                    let kind = self.files.get(d.0).defs[d.1].kind;
                    match kind {
                        Kind::Class => Some((d, "instantiates")),
                        Kind::Function | Kind::Method => Some((d, "calls")),
                        _ => None,
                    }
                }
                _ => None,
            };
            match resolved {
                Some((to, kind)) => out.edges.push(Edge {
                    from: (file, call_source(facts, call.caller)),
                    to,
                    kind,
                    line: call.name_range.start_line + 1,
                    col: call.name_range.start_col,
                }),
                None => {
                    let reason = match target {
                        Value::Unknown(r) => r,
                        Value::Module(_) => "called_module",
                        Value::Instance(_) => "called_instance",
                        Value::Def(_) => "called_value",
                    };
                    *reasons.entry(reason).or_default() += 1;
                    out.unresolved_calls.push((file, call_index, reason));
                    let candidate = match target {
                        Value::Def(def) => Some(def),
                        Value::Instance(class) => {
                            self.member(class, "__call__", 0).filter(|&(f, d)| {
                                matches!(
                                    self.files.get(f).defs[d].kind,
                                    Kind::Function | Kind::Method
                                )
                            })
                        }
                        _ => None,
                    };
                    if let Some(candidate) = candidate {
                        out.call_candidates.insert((file, call_index), candidate);
                    }
                }
            }
        }
        // Inheritance.
        for (i, def) in facts.defs.iter().enumerate() {
            if def.kind != Kind::Class || !is_node(facts, i) {
                continue;
            }
            let scope = def.parent.max(0) as usize;
            for h in &def.heritage {
                if let Value::Def(b) = self.dotted(file, scope, &h.name, 0)
                    && self.files.get(b.0).defs[b.1].kind == Kind::Class
                {
                    out.edges.push(Edge {
                        from: (file, i),
                        to: b,
                        kind: "extends",
                        line: h.range.start_line + 1,
                        col: h.range.start_col,
                    });
                }
            }
        }
        // Imports: file to module file, once per pair.
        let mut seen = HashSet::new();
        for (ii, import) in facts.imports.iter().enumerate() {
            let mut targets = Vec::new();
            if let Some(t) = self.tables(file).import_targets[ii] {
                targets.push(t);
            }
            // `from pkg import sub` imports the submodule file too.
            if let Some(t) = self.tables(file).import_targets[ii]
                && let Some(pkg) = self.files.get(t).path.strip_suffix("/__init__.py")
            {
                for b in &import.bindings {
                    if let Some(sub) = self.file_at(&join(pkg, &b.imported)) {
                        targets.push(sub);
                    }
                }
            }
            for t in targets {
                if t != file && seen.insert(t) && is_node(self.files.get(t), 0) {
                    out.edges.push(Edge {
                        from: (file, 0),
                        to: (t, 0),
                        kind: "imports",
                        line: import.range.start_line + 1,
                        col: 0,
                    });
                }
            }
        }
        let mut reasons: Vec<_> = reasons.into_iter().collect();
        reasons.sort();
        out.unresolved
            .extend(reasons.into_iter().map(|(r, n)| (file, r, n)));
    }
}

/// Resolve every Python file's calls, bases and imports. Failed files take
/// part only as empty modules.
pub fn resolve(files: &[FileFacts]) -> Resolution {
    let resolver = Resolver::new(files);
    let mut out = Resolution::default();
    for (file, facts) in files.iter().enumerate() {
        if !facts.defs.is_empty() {
            resolver.resolve_file(file, &mut out);
        }
    }
    out
}
