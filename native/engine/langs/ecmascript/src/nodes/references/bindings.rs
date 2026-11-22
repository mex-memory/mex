use std::collections::HashMap;

use mex_graph_core::facts::ecmascript::{
    ExprId, Expression, FormalType, LexicalBinding, Owner, Parameter, Space,
};
use mex_graph_core::facts::{NONE, ScopeKind};
use tree_sitter::Node;

use super::{Collector, Context, class_side, named, static_access};
use crate::nodes::syntax::{
    self, access, field, first_named, has_modifier, initializer, is_function_value, token,
};

impl<'a> Collector<'a, '_> {
    pub(super) fn add_binding(
        &mut self,
        name: String,
        scope: i32,
        def: i32,
        space: Space,
        value: Option<ExprId>,
        declared: bool,
    ) -> usize {
        let index = self.extra.bindings.len();
        self.extra.bindings.push(LexicalBinding {
            name,
            scope,
            def,
            space,
            value,
            parameter: None,
        });
        if declared {
            self.declared.insert(index);
        }
        index
    }

    pub(super) fn declaration(&mut self, node: Node<'a>, context: Context) {
        let space = match node.kind() {
            "class_declaration"
            | "abstract_class_declaration"
            | "enum_declaration"
            | "module"
            | "internal_module" => Space::Both,
            "interface_declaration" | "type_alias_declaration" => Space::Type,
            "function_declaration" | "function_signature" | "generator_function_declaration" => {
                Space::Value
            }
            _ => return,
        };
        let Some(name) = field(node, "name").filter(|name| syntax::is_identifier(*name)) else {
            return;
        };
        let def = self.draft(node);
        let name = self.name(name);
        self.add_binding(name.clone(), context.scope, def, space, None, true);
        self.named_export(node, context, &name, def, space == Space::Type);
    }

    pub(super) fn type_parameter(&mut self, node: Node<'a>, context: Context) {
        if let Some(name) = field(node, "name") {
            let value = field(node, "constraint")
                .and_then(|constraint| self.type_expression(constraint, context));
            self.add_binding(
                self.name(name),
                context.scope,
                NONE,
                Space::Type,
                value,
                true,
            );
        }
    }

    pub(super) fn variable(&mut self, node: Node<'a>, context: Context) {
        let Some(pattern) = field(node, "name") else {
            return;
        };
        let is_var = self
            .source
            .parent(node)
            .is_some_and(|p| p.kind() == "variable_declaration");
        let scope = if is_var {
            context.var_scope
        } else {
            context.scope
        };
        let (value, declared) = self.evidence(node, context);
        let def = self.draft(node);
        let shape_context = Pattern {
            scope,
            declared,
            parameter: None,
            at: context.scope,
        };
        if def != NONE && pattern.kind() == "identifier" {
            let name = self.name(pattern);
            self.add_binding(name.clone(), scope, def, Space::Value, value, declared);
            self.named_export(node, context, &name, def, false);
        } else {
            let first = self.extra.bindings.len();
            self.bind_pattern(pattern, value, shape_context, 0);
            if self
                .source
                .parent(node)
                .and_then(|n| self.source.parent(n))
                .is_some_and(|outer| outer.kind() == "export_statement")
            {
                for i in first..self.extra.bindings.len() {
                    let name = self.extra.bindings[i].name.clone();
                    self.named_export(node, context, &name, NONE, false);
                }
            }
        }
    }

    pub(super) fn parameters(&mut self, node: Node<'a>, context: Context, owner: Option<Owner>) {
        if let Some(parameters) = field(node, "parameters") {
            for (position, parameter) in named(parameters).enumerate() {
                let pattern = field(parameter, "pattern")
                    .or_else(|| field(parameter, "left"))
                    .unwrap_or(parameter);
                let rest = pattern.kind() == "rest_pattern";
                let (mut value, mut declared) =
                    if parameter == pattern && parameter.kind() == "identifier" {
                        (None, false)
                    } else {
                        self.evidence(parameter, context)
                    };
                if !declared
                    && pattern.kind() == "identifier"
                    && let Some(annotation) =
                        self.jsdoc_annotation(node, "param", Some(&self.name(pattern)))
                {
                    declared = true;
                    value = self.jsdoc_type(annotation, 0);
                }
                if pattern.kind() == "this" {
                    if let Some(value) = value {
                        self.extra.explicit_this.push((context.scope, value));
                    }
                    continue;
                }
                if declared
                    && context.function != NONE
                    && let Some(expression) = value
                {
                    self.extra.formal_types.push(FormalType {
                        def: context.function,
                        scope: context.scope,
                        position: position as u32,
                        expression,
                    });
                }
                let shape_context = Pattern {
                    scope: context.scope,
                    declared,
                    parameter: Some(Parameter {
                        position: position as u32,
                        rest,
                    }),
                    at: context.scope,
                };
                self.bind_pattern(pattern, value, shape_context, 0);
                if let Some(owner) = owner
                    && pattern.kind() == "identifier"
                    && ["public", "private", "protected", "readonly", "override"]
                        .iter()
                        .any(|modifier| has_modifier(parameter, modifier))
                {
                    let index = self.add_member(
                        owner,
                        self.name(pattern),
                        context.scope,
                        NONE,
                        value,
                        false,
                    );
                    if declared {
                        self.annotated_fields.insert(index);
                    }
                }
            }
        } else if let Some(parameter) = field(node, "parameter") {
            let shape_context = Pattern {
                scope: context.scope,
                declared: false,
                parameter: Some(Parameter {
                    position: 0,
                    rest: false,
                }),
                at: context.scope,
            };
            self.bind_pattern(parameter, None, shape_context, 0);
        }
    }

    pub(super) fn catch_binding(&mut self, node: Node<'a>, context: Context) {
        if let Some(pattern) = field(node, "parameter") {
            self.bind_pattern(pattern, None, Pattern::local(context.scope), 0);
        }
    }

    pub(super) fn loop_binding(&mut self, node: Node<'a>, context: Context) {
        let Some(kind) = field(node, "kind") else {
            return;
        };
        let Some(left) = field(node, "left") else {
            return;
        };
        let scope = if kind.kind() == "var" {
            context.var_scope
        } else {
            context.scope
        };
        let value = token(node, "of")
            .and_then(|_| field(node, "right"))
            .and_then(|right| self.expression(right, context))
            .and_then(|object| self.push_expression(Expression::Index { object }));
        self.bind_pattern(
            left,
            value,
            Pattern {
                scope,
                ..Pattern::local(context.scope)
            },
            0,
        );
    }

    pub(super) fn evidence(&mut self, node: Node<'a>, context: Context) -> (Option<ExprId>, bool) {
        if let Some(annotation) = field(node, "type") {
            (self.type_expression(annotation, context), true)
        } else if let Some(annotation) = self.jsdoc_annotation(node, "type", None) {
            (self.jsdoc_type(annotation, 0), true)
        } else {
            let value = initializer(node)
                .or_else(|| field(node, "right"))
                .and_then(|value| self.expression(value, context));
            (value, false)
        }
    }

    pub(super) fn class_member(&mut self, node: Node<'a>, context: Context) {
        let Some(class) = context.class else { return };
        let Some(name) = field(node, "name")
            .or_else(|| field(node, "property"))
            .and_then(|name| self.member_name(name))
        else {
            return;
        };
        let owner = class_side(class, has_modifier(node, "static"));
        let def = self.draft(node);
        let (mut value, declared) = self.evidence(node, context);
        if initializer(node).is_some_and(is_function_value) && def != NONE {
            value = None;
        }
        let index = self.add_member(
            owner,
            name,
            context.scope,
            def,
            value,
            token(node, "get").is_some(),
        );
        if declared {
            self.annotated_fields.insert(index);
        }
    }

    pub(super) fn assign(&mut self, node: Node<'a>, context: Context) {
        let Some(left) = field(node, "left").or_else(|| field(node, "argument")) else {
            return;
        };
        if let Some(right) = field(node, "right")
            && node.kind() == "assignment_expression"
            && self.commonjs_export(node, context, left, right)
        {
            return;
        }
        if let Some((object, property)) = access(left)
            && object.kind() == "this"
            && static_access(left, property)
            && let Some(owner) = self.class_receiver(context.scope)
        {
            let value = if self.constructor_assignment(node) {
                field(node, "right").and_then(|right| self.expression(right, context))
            } else {
                None
            };
            self.field_writes.push(FieldWrite {
                owner,
                name: self.name(property),
                scope: context.scope,
                value,
            });
        }
        self.mark_written(left, context.scope, 0);
    }

    fn class_receiver(&self, mut scope: i32) -> Option<Owner> {
        while scope != NONE {
            if let Ok(i) = self
                .extra
                .this_bindings
                .binary_search_by_key(&scope, |binding| binding.scope)
            {
                return match self.extra.this_bindings[i].owner {
                    Owner::Object { .. } => None,
                    owner => Some(owner),
                };
            }
            let current = &self.facts.scopes[scope as usize];
            if matches!(
                current.kind,
                ScopeKind::Function | ScopeKind::Class | ScopeKind::Module
            ) {
                break;
            }
            scope = current.parent;
        }
        None
    }

    fn constructor_assignment(&self, node: Node<'a>) -> bool {
        node.kind() == "assignment_expression"
            && self
                .source
                .parent(node)
                .filter(|p| p.kind() == "expression_statement")
                .and_then(|statement| self.source.parent(statement))
                .filter(|body| body.kind() == "statement_block")
                .and_then(|body| self.source.parent(body))
                .and_then(|method| field(method, "name"))
                .is_some_and(|name| self.name(name) == "constructor")
    }

    pub(super) fn finish_fields(&mut self) {
        if self.field_writes.is_empty() {
            return;
        }
        let mut prior: HashMap<_, _> = self
            .extra
            .members
            .iter()
            .enumerate()
            .filter(|(_, member)| {
                matches!(
                    member.owner,
                    Owner::Definition { .. } | Owner::ClassExpression { .. }
                )
            })
            .map(|(i, member)| ((member.owner, member.name.clone()), i))
            .collect();
        for write in std::mem::take(&mut self.field_writes) {
            if let Some(&member) = prior.get(&(write.owner, write.name.clone())) {
                if !self.annotated_fields.contains(&member)
                    && (self.extra.members[member].def == NONE
                        || self.facts.defs[self.extra.members[member].def as usize].kind
                            == mex_graph_core::facts::Kind::Property)
                {
                    self.extra.members[member].value = None;
                }
            } else {
                // A prior dynamic write still makes a later assignment
                // insufficient evidence for one stable receiver type.
                let index = self.add_member(
                    write.owner,
                    write.name.clone(),
                    write.scope,
                    NONE,
                    write.value,
                    false,
                );
                prior.insert((write.owner, write.name), index);
            }
        }
    }

    pub(super) fn finish_bindings(&mut self) {
        let mut by_scope: HashMap<i32, HashMap<&str, Vec<usize>>> = HashMap::new();
        for (index, binding) in self
            .extra
            .bindings
            .iter()
            .enumerate()
            .filter(|(_, binding)| binding.space != Space::Type)
        {
            by_scope
                .entry(binding.scope)
                .or_default()
                .entry(&binding.name)
                .or_default()
                .push(index);
        }
        let mut invalidated = Vec::new();
        for (mut scope, name) in self.writes.drain(..) {
            loop {
                if let Some(indices) = by_scope
                    .get(&scope)
                    .and_then(|names| names.get(name.as_str()))
                {
                    invalidated.extend(
                        indices
                            .iter()
                            .copied()
                            .filter(|i| !self.declared.contains(i)),
                    );
                    break;
                }
                if scope == NONE {
                    break;
                }
                scope = self.facts.scopes[scope as usize].parent;
            }
        }
        for index in invalidated {
            self.extra.bindings[index].value = None;
        }
    }

    fn mark_written(&mut self, node: Node<'a>, scope: i32, depth: usize) {
        if depth == MAX_PATTERN_DEPTH {
            return;
        }
        match node.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => {
                self.writes.push((scope, self.name(node)))
            }
            "array_pattern" | "object_pattern" | "rest_pattern" | "parenthesized_expression" => {
                for part in named(node) {
                    self.mark_written(part, scope, depth + 1);
                }
            }
            "assignment_pattern" | "object_assignment_pattern" | "pair_pattern" => {
                if let Some(value) = field(node, "left").or_else(|| field(node, "value")) {
                    self.mark_written(value, scope, depth + 1);
                }
            }
            _ => {}
        }
    }

    fn bind_pattern(
        &mut self,
        node: Node<'a>,
        value: Option<ExprId>,
        context: Pattern,
        depth: usize,
    ) {
        if depth == MAX_PATTERN_DEPTH {
            return;
        }
        let inner = Pattern {
            parameter: None,
            ..context
        };
        match node.kind() {
            "identifier" | "shorthand_property_identifier_pattern" => {
                let index = self.add_binding(
                    self.name(node),
                    context.scope,
                    NONE,
                    Space::Value,
                    value,
                    context.declared,
                );
                self.extra.bindings[index].parameter = context.parameter;
                // An initializer in a block may see a different name than the
                // function-scoped `var` it initializes.
                if value.is_some() && context.at != context.scope {
                    self.extra.initializer_scopes.push((index, context.at));
                }
            }
            "assignment_pattern" | "object_assignment_pattern" => {
                if let Some(left) = field(node, "left") {
                    self.bind_pattern(left, None, context, depth + 1);
                }
            }
            "rest_pattern" => {
                if let Some(name) = first_named(node) {
                    self.bind_pattern(name, value, context, depth + 1);
                }
            }
            "object_pattern" => {
                for part in named(node) {
                    let (key, target) = match part.kind() {
                        "pair_pattern" => (field(part, "key"), field(part, "value")),
                        "shorthand_property_identifier_pattern" => (Some(part), Some(part)),
                        _ => (None, Some(part)),
                    };
                    let member = value.and_then(|object| {
                        let name = self.member_name(key?)?;
                        self.push_expression(Expression::Member { object, name })
                    });
                    if let Some(target) = target {
                        self.bind_pattern(target, member, inner, depth + 1);
                    }
                }
            }
            "array_pattern" => {
                let mut position = 0;
                let mut cursor = node.walk();
                for part in node.children(&mut cursor).filter(|part| !part.is_extra()) {
                    if part.kind() == "," {
                        position += 1;
                    } else if part.is_named() {
                        let element =
                            value
                                .filter(|_| part.kind() != "rest_pattern")
                                .and_then(|object| {
                                    self.push_expression(Expression::Member {
                                        object,
                                        name: position.to_string(),
                                    })
                                });
                        self.bind_pattern(part, element, inner, depth + 1);
                    }
                }
            }
            _ => {}
        }
    }
}

pub(super) struct FieldWrite {
    owner: Owner,
    name: String,
    scope: i32,
    value: Option<ExprId>,
}

const MAX_PATTERN_DEPTH: usize = 40;

#[derive(Clone, Copy)]
struct Pattern {
    scope: i32,
    declared: bool,
    parameter: Option<Parameter>,
    at: i32,
}

impl Pattern {
    fn local(scope: i32) -> Self {
        Self {
            scope,
            declared: false,
            parameter: None,
            at: scope,
        }
    }
}
