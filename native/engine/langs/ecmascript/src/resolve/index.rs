use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::ecmascript::{
    Base, ConstructSignature, ExportKind, ExportValue, ExprId, Expression, FormalType, Owner,
    ReferenceFacts, Return, Space, TypeAlias,
};
use mex_graph_core::facts::{FileFacts, NONE, Scope};

use super::{Lane, Reason};

pub(super) struct FileIndex<'a> {
    pub facts: &'a ReferenceFacts,
    scopes: &'a [Scope],
    names: HashMap<(i32, &'a str), Vec<usize>>,
    members: HashMap<(Owner, &'a str), Vec<usize>>,
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
        let facts = file.ecmascript.as_ref()?;
        let mut index = Self {
            facts,
            scopes: &file.scopes,
            names: HashMap::new(),
            members: HashMap::new(),
            explicit_this: facts.explicit_this.iter().copied().collect(),
            this_bindings: facts
                .this_bindings
                .iter()
                .map(|binding| (binding.scope, binding.owner))
                .collect(),
            bases: HashMap::new(),
            class_bases: facts
                .class_bases
                .iter()
                .map(|&(class, scope, base)| (class, (scope, base)))
                .collect(),
            callable_defs: facts.callable_defs.iter().copied().collect(),
            formal_types: HashMap::new(),
            constructs: HashMap::new(),
            aliases: facts
                .type_aliases
                .iter()
                .map(|ty| (ty.def as usize, *ty))
                .collect(),
            returns: HashMap::new(),
            initializers: facts.initializer_scopes.iter().copied().collect(),
            invokes: HashMap::new(),
            exports: HashMap::new(),
            stars: Vec::new(),
            commonjs: None,
            commonjs_members: HashMap::new(),
        };
        for (i, binding) in facts.bindings.iter().enumerate() {
            index
                .names
                .entry((binding.scope, &binding.name))
                .or_default()
                .push(i);
        }
        for (i, member) in facts.members.iter().enumerate() {
            index
                .members
                .entry((member.owner, &member.name))
                .or_default()
                .push(i);
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
        index.index_exports(file);
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
            .into_iter()
            .flatten()
            .copied()
            .filter(move |&i| lane.admits(self.facts.bindings[i].space))
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
        let indices = self.members.get(&(owner, name)).ok_or("member_missing")?;
        let first = indices[0];
        let member = &self.facts.members[first];
        for &i in &indices[1..] {
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
