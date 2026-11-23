use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use mex_graph_core::facts::ecmascript::{
    Base, ConstructSignature, ExportKind, ExportValue, ExprId, Expression, FormalType, Owner,
    ReferenceFacts, Return, Space, TypeAlias,
};
use mex_graph_core::facts::{FileFacts, NONE, Scope};

use super::{Lane, Reason};

// The extracted facts remain available by file. Bound the derived lexical
// maps separately so a cold job does not keep every model resident.
const MODEL_CAPACITY: usize = 3072;

struct CachedModel<'a> {
    model: Rc<FileIndex<'a>>,
    recent: bool,
}

pub(super) struct FileIndexes<'a> {
    entries: Vec<Option<CachedModel<'a>>>,
    slots: Vec<usize>,
    cursor: usize,
}

impl<'a> FileIndexes<'a> {
    pub(super) fn new(files: usize) -> Self {
        Self {
            entries: (0..files).map(|_| None).collect(),
            slots: Vec::new(),
            cursor: 0,
        }
    }

    pub(super) fn get(&mut self, file: usize, facts: &'a FileFacts) -> Option<Rc<FileIndex<'a>>> {
        if let Some(entry) = &mut self.entries[file] {
            entry.recent = true;
            return Some(Rc::clone(&entry.model));
        }
        let model = Rc::new(FileIndex::new(facts)?);
        if self.slots.len() == MODEL_CAPACITY {
            // Give recently used files a second pass before eviction.
            loop {
                let slot = self.cursor;
                self.cursor = (slot + 1) % MODEL_CAPACITY;
                let old = self.slots[slot];
                let entry = self.entries[old].as_mut().expect("occupied model");
                if !std::mem::replace(&mut entry.recent, false) {
                    self.entries[old] = None;
                    self.slots[slot] = file;
                    break;
                }
            }
        } else {
            self.slots.push(file);
        }
        self.entries[file] = Some(CachedModel {
            model: Rc::clone(&model),
            recent: true,
        });
        Some(model)
    }
}

// A binding or member usually has one declaration. Keep its ordinal inline
// and allocate links only for the duplicate keys that need a chain.
struct OrdinalBuckets<K> {
    first: HashMap<K, u32>,
    next: HashMap<u32, u32>,
}

impl<K: Eq + std::hash::Hash> OrdinalBuckets<K> {
    fn new() -> Self {
        Self {
            first: HashMap::new(),
            next: HashMap::new(),
        }
    }

    fn prepend(&mut self, key: K, index: usize) {
        let index = u32::try_from(index).expect("fact ordinal fits in 32 bits");
        if let Some(old) = self.first.insert(key, index) {
            self.next.insert(index, old);
        }
    }

    fn get<'a>(&'a self, key: &K) -> impl Iterator<Item = usize> + use<'a, K> {
        std::iter::successors(self.first.get(key).copied(), |index| {
            self.next.get(index).copied()
        })
        .map(|index| index as usize)
    }
}

pub(super) struct FileIndex<'a> {
    pub facts: &'a ReferenceFacts,
    scopes: &'a [Scope],
    names: OrdinalBuckets<(i32, &'a str)>,
    members: OrdinalBuckets<(Owner, &'a str)>,
    pub this_bindings: HashMap<i32, Owner>,
    pub explicit_this: HashMap<i32, ExprId>,
    pub bases: HashMap<usize, Vec<Base>>,
    pub class_bases: HashMap<ExprId, (i32, ExprId)>,
    pub callable_defs: HashSet<i32>,
    pub constructs: HashMap<Owner, Vec<ConstructSignature>>,
    pub formal_types: HashMap<(i32, u32), Vec<FormalType>>,
    pub aliases: HashMap<usize, TypeAlias>,
    pub returns: HashMap<usize, Vec<Return>>,
    pub initializers: HashMap<usize, i32>,
    invokes: HashMap<usize, HashSet<u32>>,
    pub exports: HashMap<&'a str, Vec<(ExportEntry<'a>, bool)>>,
    pub stars: Vec<(usize, bool)>,
    pub commonjs: Option<&'a ExportValue>,
    pub commonjs_members: HashMap<&'a str, &'a ExportValue>,
}

#[derive(Clone, Copy)]
pub(super) enum ExportEntry<'a> {
    Def(i32),
    Local(&'a str),
    Reexport { import: usize, name: &'a str },
    Value(&'a ExportValue),
}

impl<'a> FileIndex<'a> {
    pub(super) fn new(file: &'a FileFacts) -> Option<Self> {
        let mut index = Self::with_invocations(file)?;
        let facts = index.facts;
        index.explicit_this = facts.explicit_this.iter().copied().collect();
        index.this_bindings = facts
            .this_bindings
            .iter()
            .map(|binding| (binding.scope, binding.owner))
            .collect();
        index.class_bases = facts
            .class_bases
            .iter()
            .map(|&(class, scope, base)| (class, (scope, base)))
            .collect();
        index.callable_defs = facts.callable_defs.iter().copied().collect();
        index.aliases = facts
            .type_aliases
            .iter()
            .map(|ty| (ty.def as usize, *ty))
            .collect();
        index.initializers = facts.initializer_scopes.iter().copied().collect();
        for (i, member) in facts.members.iter().enumerate().rev() {
            index.members.prepend((member.owner, &member.name), i);
        }
        for base in &facts.bases {
            index
                .bases
                .entry(base.def as usize)
                .or_default()
                .push(*base);
        }
        for argument in &facts.formal_types {
            index
                .formal_types
                .entry((argument.def, argument.position))
                .or_default()
                .push(*argument);
        }
        for signature in &facts.construct_signatures {
            index
                .constructs
                .entry(signature.owner)
                .or_default()
                .push(*signature);
        }
        for ret in &facts.returns {
            index
                .returns
                .entry(ret.def as usize)
                .or_default()
                .push(*ret);
        }
        index.index_exports(file);
        Some(index)
    }

    // Edit signatures only use the lexical binding proof for parameter calls.
    pub(super) fn with_invocations(file: &'a FileFacts) -> Option<Self> {
        let facts = file.ecmascript.as_ref()?;
        let mut index = Self {
            facts,
            scopes: &file.scopes,
            names: OrdinalBuckets::new(),
            members: OrdinalBuckets::new(),
            explicit_this: HashMap::new(),
            this_bindings: HashMap::new(),
            bases: HashMap::new(),
            class_bases: HashMap::new(),
            callable_defs: HashSet::new(),
            formal_types: HashMap::new(),
            constructs: HashMap::new(),
            aliases: HashMap::new(),
            returns: HashMap::new(),
            initializers: HashMap::new(),
            invokes: HashMap::new(),
            exports: HashMap::new(),
            stars: Vec::new(),
            commonjs: None,
            commonjs_members: HashMap::new(),
        };
        for (i, binding) in facts.bindings.iter().enumerate().rev() {
            index.names.prepend((binding.scope, &binding.name), i);
        }
        if !facts.parameter_calls.is_empty() {
            let signatures: HashSet<_> = facts.signature_defs.iter().copied().collect();
            for &call in &facts.parameter_calls {
                if let Some((function, argument)) =
                    index.parameter_invocation(call.scope, call.expression)
                    // The compiler's selected overload signature has no body.
                    && !signatures.contains(&(function as i32))
                {
                    index.invokes.entry(function).or_default().insert(argument);
                }
            }
        }
        Some(index)
    }

    fn index_exports(&mut self, file: &'a FileFacts) {
        for export in &file.exports {
            let entry = if let Some(local) = &export.local {
                ExportEntry::Local(local)
            } else if export.def != NONE {
                ExportEntry::Def(export.def)
            } else {
                continue;
            };
            self.exports
                .entry(&export.exported)
                .or_default()
                .push((entry, export.type_only));
        }
        for (i, import) in file.imports.iter().enumerate() {
            for binding in &import.bindings {
                if let Some(exported) = &binding.exported {
                    if exported == "*" && binding.imported == "*" {
                        self.stars.push((i, binding.type_only));
                    } else {
                        self.exports.entry(exported).or_default().push((
                            ExportEntry::Reexport {
                                import: i,
                                name: &binding.imported,
                            },
                            binding.type_only,
                        ));
                    }
                }
            }
        }
        let mut aliases_module = !self.has_binding(NONE, "exports");
        for export in &self.facts.export_values {
            match export.kind {
                ExportKind::Default => {
                    self.exports
                        .entry("default")
                        .or_default()
                        .push((ExportEntry::Value(export), false));
                    continue;
                }
                ExportKind::DropExportsAlias => {
                    aliases_module = false;
                    continue;
                }
                ExportKind::RestoreExportsAlias => {
                    aliases_module =
                        !self.has_binding(NONE, "exports") && !self.has_binding(NONE, "module");
                    continue;
                }
                ExportKind::CommonJsAlias if !aliases_module => continue,
                ExportKind::CommonJs if self.has_binding(export.scope, "module") => continue,
                _ => {}
            }
            if let Some(name) = &export.name {
                self.commonjs_members.insert(name, export);
            } else {
                self.commonjs_members.clear();
                self.commonjs = Some(export);
                aliases_module = false;
            }
        }
    }

    fn names_at<'b>(
        &'b self,
        scope: i32,
        name: &'b str,
        lane: Lane,
    ) -> impl Iterator<Item = usize> + 'b {
        self.names
            .get(&(scope, name))
            .filter(move |&i| lane.admits(self.facts.bindings[i].space))
    }

    pub(super) fn parameter_invocations(&self) -> impl Iterator<Item = (usize, u32)> + '_ {
        self.invokes
            .iter()
            .flat_map(|(&def, positions)| positions.iter().map(move |&arg| (def, arg)))
    }

    pub(super) fn binding(&self, mut scope: i32, name: &str, lane: Lane) -> Result<usize, Reason> {
        loop {
            let mut entries = self.names_at(scope, name, lane);
            if let Some(first) = entries.next() {
                let def = self.facts.bindings[first].def;
                if entries.any(|i| def == NONE || self.facts.bindings[i].def != def) {
                    return Err("ambiguous_binding");
                }
                return Ok(first);
            }
            if scope == NONE {
                return Err("unknown_binding");
            }
            scope = self.scopes[scope as usize].parent;
        }
    }

    pub(super) fn has_binding(&self, scope: i32, name: &str) -> bool {
        self.binding(scope, name, Lane::Value) != Err("unknown_binding")
    }

    pub(super) fn is_import(&self, binding: usize) -> bool {
        self.facts.bindings[binding].space != Space::Value && self.is_module_binding(binding)
    }

    pub(super) fn is_module_binding(&self, binding: usize) -> bool {
        let Some(mut expression) = self.facts.bindings[binding].value else {
            return false;
        };
        loop {
            match self.expression(expression) {
                Expression::Module { .. } => return true,
                Expression::Member { object, .. } => expression = *object,
                _ => return false,
            }
        }
    }

    pub(super) fn member(&self, owner: Owner, name: &str) -> Result<usize, Reason> {
        let mut indices = self.members.get(&(owner, name));
        let first = indices.next().ok_or("member_missing")?;
        let member = &self.facts.members[first];
        for i in indices {
            let other = &self.facts.members[i];
            if member.def == NONE || member.def != other.def || member.getter != other.getter {
                return Err("ambiguous_member");
            }
        }
        Ok(first)
    }

    pub(super) fn expression(&self, index: ExprId) -> &'a Expression {
        &self.facts.expressions[index as usize]
    }

    pub(super) fn invokes(&self, def: usize, position: u32) -> bool {
        self.invokes
            .get(&def)
            .is_some_and(|positions| positions.contains(&position))
    }

    fn parameter_invocation(&self, scope: i32, expression: ExprId) -> Option<(usize, u32)> {
        let (expression, offset) = match self.expression(expression) {
            Expression::Member { object, name } => (*object, Some(name.parse::<u32>().ok()?)),
            _ => (expression, None),
        };
        let Expression::Name { name } = self.expression(expression) else {
            return None;
        };
        let binding = &self.facts.bindings[self.binding(scope, name, Lane::Value).ok()?];
        let parameter = binding.parameter?;
        if parameter.rest != offset.is_some() {
            return None;
        }
        let def = usize::try_from(self.scopes.get(binding.scope as usize)?.def).ok()?;
        Some((def, parameter.position.checked_add(offset.unwrap_or(0))?))
    }
}
