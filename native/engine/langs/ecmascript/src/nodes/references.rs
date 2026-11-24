//! Extract reference evidence from the same tree that supplied the node IDs.

use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::ecmascript::{
    Argument, Base, ConstructSignature, ContextualCall, ExprId, Expression, Member, Owner,
    ParameterCall, Reference, ReferenceFacts, Return, Space, ThisBinding, TypeAlias,
};
use mex_graph_core::facts::{
    Call, CallForm, Diagnostic, FileFacts, Heritage, NONE, ParseStatus, Range, Receiver, Scope,
    ScopeKind, bounds,
};
use tree_sitter::Node;

use super::declarations::Drafts;
use super::source::Source;
use super::syntax::{
    self, access, field, first_named, has_modifier, initializer, is_function_like,
    is_function_value,
};

mod bindings;
mod expression;
mod jsdoc;
mod modules;
use modules::static_access;

const MAX_EXPRESSIONS: usize = 250_000;
const MAX_REFERENCE_NODES: usize = 500_000;

#[derive(Clone, Copy)]
struct Context {
    scope: i32,
    var_scope: i32,
    caller: i32,
    function: i32,
    class: Option<Owner>,
    namespace: i32,
    in_type: bool,
    binding_pattern: bool,
}

impl Default for Context {
    fn default() -> Self {
        Self {
            scope: NONE,
            var_scope: NONE,
            caller: 0,
            function: NONE,
            class: None,
            namespace: NONE,
            in_type: false,
            binding_pattern: false,
        }
    }
}

struct Collector<'a, 'facts> {
    source: &'a Source<'a>,
    facts: &'facts mut FileFacts,
    drafts: &'facts Drafts,
    extra: ReferenceFacts,
    expressions: HashMap<usize, ExprId>,
    require_calls: HashMap<usize, usize>,
    declared: HashSet<usize>,
    writes: Vec<(i32, String)>,
    field_writes: Vec<bindings::FieldWrite>,
    annotated_fields: HashSet<usize>,
}

pub(super) fn extract<'a>(
    root: Node<'a>,
    source: &'a Source<'a>,
    facts: &mut FileFacts,
    drafts: &Drafts,
) {
    let mut collector = Collector {
        source,
        facts,
        drafts,
        extra: ReferenceFacts::default(),
        expressions: HashMap::new(),
        require_calls: HashMap::new(),
        declared: HashSet::new(),
        writes: Vec::new(),
        field_writes: Vec::new(),
        annotated_fields: HashSet::new(),
    };
    collector.walk(root);
    collector.finish_bindings();
    collector.finish_fields();
    collector.facts.ecmascript = Some(collector.extra);
}

impl<'a> Collector<'a, '_> {
    fn walk(&mut self, root: Node<'a>) {
        let mut stack = vec![(root, Context::default())];
        let mut visited = 0;
        while let Some((node, mut context)) = stack.pop() {
            visited += 1;
            if visited > MAX_REFERENCE_NODES
                || self.extra.expressions.len() == MAX_EXPRESSIONS
                || self.facts.calls.len() == bounds::MAX_CALLS
            {
                self.facts.health.status = ParseStatus::Partial;
                if self.facts.health.diagnostics.len() < bounds::MAX_DIAGNOSTICS {
                    let range = self.range(node);
                    self.facts.health.diagnostics.push(Diagnostic {
                        code: "reference-limit".into(),
                        range,
                    });
                }
                break;
            }
            if node.is_extra() || node.is_error() || node.is_missing() {
                continue;
            }
            let parent = self.source.parent(node);
            let draft = self.draft(node);
            if draft != NONE {
                self.facts.defs[draft as usize].scope = context.scope;
                context.caller = draft;
            }
            context = self.visit(node, parent, context);
            let start = stack.len();
            for child in named(node) {
                let in_type = context.in_type
                    || matches!(
                        child.kind(),
                        "type_annotation"
                            | "type_arguments"
                            | "type_parameters"
                            | "implements_clause"
                    )
                    || node.kind() == "type_alias_declaration"
                        && field(node, "value") == Some(child)
                    || node.kind() == "as_expression" && first_named(node) != Some(child);
                let binding_pattern = match node.kind() {
                    "variable_declarator" => field(node, "name") == Some(child),
                    "required_parameter" | "optional_parameter" => {
                        field(node, "pattern") == Some(child)
                    }
                    "assignment_pattern" | "object_assignment_pattern" => {
                        context.binding_pattern && field(node, "left") == Some(child)
                    }
                    "computed_property_name" => false,
                    _ => context.binding_pattern,
                };
                stack.push((
                    child,
                    Context {
                        in_type,
                        binding_pattern,
                        ..context
                    },
                ));
            }
            stack[start..].reverse();
        }
    }

    fn visit(&mut self, node: Node<'a>, parent: Option<Node<'a>>, mut context: Context) -> Context {
        use ScopeKind::{Arrow, Block, Class, Function, Module};
        let kind = node.kind();
        let draft = self.draft(node);
        let class_member = parent.is_some_and(|p| p.kind() == "class_body");
        match kind {
            "import_statement" => self.import_statement(node, context),
            "export_statement" => self.export_statement(node, context),
            "variable_declarator" => self.variable(node, context),
            "type_parameter" => self.type_parameter(node, context),
            "function_declaration" | "function_signature" | "generator_function_declaration" => {
                self.declaration(node, context);
            }
            "class"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration" => {
                self.declaration(node, context);
                context.scope = self.scope(Class, context.scope, draft, None);
                context.namespace = NONE;
                context.class = if draft != NONE {
                    self.heritage(node, context, draft);
                    Some(Owner::Definition {
                        def: draft,
                        is_static: false,
                    })
                } else if kind == "class" {
                    let shape = self.shape(node, Expression::Class);
                    if let Some(expression) = shape {
                        if let Some(base) = named(node)
                            .find(|p| p.kind() == "class_heritage")
                            .and_then(first_named)
                            .and_then(|base| {
                                if base.kind() == "extends_clause" {
                                    field(base, "value").or_else(|| first_named(base))
                                } else {
                                    Some(base)
                                }
                            })
                            .and_then(|base| self.expression(base, context))
                        {
                            self.extra
                                .class_bases
                                .push((expression, context.scope, base));
                        }
                        if let Some(name) = field(node, "name") {
                            self.add_binding(
                                self.name(name),
                                context.scope,
                                NONE,
                                Space::Both,
                                Some(expression),
                                true,
                            );
                        }
                    }
                    shape.map(|expression| Owner::ClassExpression {
                        expression,
                        is_static: false,
                    })
                } else {
                    None
                };
            }
            "type_alias_declaration" => {
                self.declaration(node, context);
                context.scope = self.scope(Block, context.scope, draft, None);
                if draft != NONE
                    && let Some(value) =
                        field(node, "value").and_then(|n| self.type_expression(n, context))
                {
                    self.extra.type_aliases.push(TypeAlias {
                        def: draft,
                        scope: context.scope,
                        value,
                    });
                }
            }
            "internal_module" | "module" => {
                self.declaration(node, context);
                context.scope = self.scope(Module, context.scope, draft, None);
                context.namespace = draft;
                context.var_scope = context.scope;
            }
            "enum_declaration" => {
                self.declaration(node, context);
                context.scope = self.scope(Class, context.scope, draft, None);
                context.class = (draft != NONE).then_some(Owner::Definition {
                    def: draft,
                    is_static: true,
                });
            }
            "class_static_block" => {
                let owner = context.class.map(|owner| class_side(owner, true));
                context.scope = self.scope(Function, context.scope, NONE, owner);
                context.var_scope = context.scope;
            }
            "public_field_definition" | "field_definition" if class_member => {
                let owner = context
                    .class
                    .map(|owner| class_side(owner, has_modifier(node, "static")));
                context.scope = self.scope(Block, context.scope, draft, owner);
                self.class_member(node, context);
            }
            "method_definition"
            | "abstract_method_signature"
            | "method_signature"
            | "property_signature"
                if class_member || parent.is_some_and(|p| p.kind() == "interface_body") =>
            {
                self.class_member(node, context);
            }
            "statement_block"
                if parent.is_some_and(|p| {
                    is_function_like(p)
                        || syntax::is_namespace(p)
                        || matches!(p.kind(), "catch_clause" | "class_static_block")
                }) => {}
            "statement_block" | "switch_body" | "for_statement" | "for_in_statement"
            | "catch_clause" => {
                context.scope = self.scope(Block, context.scope, NONE, None);
                if kind == "for_in_statement" {
                    self.loop_binding(node, context);
                } else if kind == "catch_clause" {
                    self.catch_binding(node, context);
                }
            }
            "call_expression" | "new_expression" if !context.in_type => self.call(node, context),
            "assignment_expression" | "augmented_assignment_expression" | "update_expression"
                if !context.in_type =>
            {
                self.assign(node, context)
            }
            "return_statement" if context.function != NONE => {
                let value = first_named(node).and_then(|n| self.expression(n, context));
                self.extra.returns.push(Return {
                    def: context.function,
                    scope: context.scope,
                    value,
                    declared: false,
                });
            }
            "identifier"
            | "property_identifier"
            | "private_property_identifier"
            | "shorthand_property_identifier"
                if !context.in_type && !context.binding_pattern =>
            {
                if let Some(parent) = parent {
                    self.identifier(node, parent, context);
                }
            }
            _ => {}
        }
        self.object_member(node, context);
        if !is_function_like(node) {
            return context;
        }

        let owner = if class_member || parent.is_some_and(|p| p.kind() == "interface_body") {
            context
                .class
                .map(|owner| class_side(owner, has_modifier(node, "static")))
        } else if kind == "method_definition" {
            parent
                .filter(|p| p.kind() == "object")
                .and_then(|p| self.object(p))
                .map(|expression| Owner::Object { expression })
        } else {
            None
        };
        let def = if draft != NONE {
            draft
        } else if is_function_value(node) {
            parent
                .filter(|p| initializer(*p) == Some(node) || field(*p, "right") == Some(node))
                .map_or(NONE, |p| self.draft(p))
        } else {
            NONE
        };
        let scope = self.scope(
            if kind == "arrow_function" {
                Arrow
            } else {
                Function
            },
            context.scope,
            def,
            owner,
        );
        context.scope = scope;
        context.var_scope = scope;
        context.function = def;
        if is_function_value(node)
            && let Some(name) = field(node, "name")
        {
            self.add_binding(self.name(name), scope, def, Space::Value, None, true);
        }
        let param_owner =
            owner.filter(|_| field(node, "name").is_some_and(|n| self.name(n) == "constructor"));
        self.parameters(node, context, param_owner);
        if kind == "construct_signature"
            && let Some(parent) = parent
        {
            let owner = match parent.kind() {
                "interface_body" => context.class,
                "object_type" => self
                    .object(parent)
                    .map(|expression| Owner::Object { expression }),
                _ => None,
            };
            if let Some(owner) = owner {
                let value = field(node, "type").and_then(|ty| self.type_expression(ty, context));
                self.extra.construct_signatures.push(ConstructSignature {
                    owner,
                    scope,
                    value,
                });
            }
        }
        if def != NONE {
            if matches!(
                kind,
                "function_signature" | "method_signature" | "abstract_method_signature"
            ) {
                self.extra.signature_defs.push(def);
            }
            if matches!(
                kind,
                "function_declaration" | "function_signature" | "generator_function_declaration"
            ) {
                self.extra.callable_defs.push(def);
            }
            if let Some(annotation) = field(node, "return_type") {
                let value = self.type_expression(annotation, context);
                self.extra.returns.push(Return {
                    def,
                    scope,
                    value,
                    declared: true,
                });
            } else if self.javascript()
                && let Some(annotation) = self.facts.defs[def as usize].return_type.as_deref()
            {
                let annotation = annotation.to_owned();
                let value = self.jsdoc_type(&annotation, 0);
                self.extra.returns.push(Return {
                    def,
                    scope,
                    value,
                    declared: true,
                });
            } else if kind == "arrow_function"
                && let Some(body) =
                    field(node, "body").filter(|body| body.kind() != "statement_block")
            {
                let value = self.expression(body, context);
                self.extra.returns.push(Return {
                    def,
                    scope,
                    value,
                    declared: false,
                });
            }
        }
        context
    }

    fn call(&mut self, node: Node<'a>, context: Context) {
        if self.source.has_error(self.source.span(node)) {
            return;
        }
        let new = node.kind() == "new_expression";
        let Some(callee) = field(node, if new { "constructor" } else { "function" }) else {
            return;
        };
        let arguments = field(node, "arguments");
        if arguments.is_some_and(|args| args.kind() == "template_string") {
            return;
        }
        self.require_import(node, context.scope);
        let mut receiver = None;
        let mut target = callee;
        while matches!(
            target.kind(),
            "parenthesized_expression" | "non_null_expression"
        ) {
            let Some(child) = first_named(target) else {
                break;
            };
            target = child;
        }
        let (form, name, name_node) = match target.kind() {
            "identifier" => (CallForm::Ident, self.name(target), callee),
            "super" => (CallForm::SuperConstructor, "super".into(), callee),
            "import" if !new => {
                let form = self
                    .dynamic_import(node, context.scope)
                    .map_or(CallForm::Other, |import| CallForm::DynamicImport { import });
                (form, "import".into(), callee)
            }
            _ => {
                if let Some((object, property)) =
                    access(target).filter(|(_, property)| static_access(target, *property))
                {
                    receiver = Some(match object.kind() {
                        "this" => Receiver::This,
                        "super" => Receiver::Super,
                        "identifier" => Receiver::Name {
                            name: self.name(object),
                        },
                        _ => self
                            .expression(object, context)
                            .map_or(Receiver::Other, |index| Receiver::Expression { index }),
                    });
                    let name_node = if callee.kind() == "member_expression" {
                        property
                    } else {
                        callee
                    };
                    (CallForm::Member, self.name(property), name_node)
                } else {
                    receiver = self
                        .expression(callee, context)
                        .map(|index| Receiver::Expression { index });
                    (CallForm::Other, self.callee_text(callee), callee)
                }
            }
        };
        let form = if new { CallForm::New } else { form };
        let call = self.facts.calls.len();
        self.facts.calls.push(Call {
            form,
            name,
            receiver,
            scope: context.scope,
            caller: context.caller,
            range: self.range(node),
            name_range: self.range(name_node),
            text: self.callee_text(callee),
        });
        if !new && context.scope != NONE {
            let candidate = if callee.kind() == "member_expression"
                && let Some((object, property)) = access(callee)
                && matches!(self.source.of(property), "call" | "apply")
            {
                object
            } else {
                callee
            };
            if (candidate.kind() == "identifier"
                || candidate.kind() == "subscript_expression"
                    && field(candidate, "index").is_some_and(|index| index.kind() == "number"))
                && let Some(expression) = self.expression(candidate, context)
            {
                self.extra.parameter_calls.push(ParameterCall {
                    scope: context.scope,
                    expression,
                });
            }
        }
        if !new && let Some(arguments) = arguments {
            let mut objects = Vec::new();
            let type_arguments = field(node, "type_arguments");
            for (position, argument) in named(arguments).enumerate() {
                if argument.kind() == "spread_element" {
                    break;
                }
                if type_arguments.is_some()
                    && argument.kind() == "object"
                    && let Some(expression) = self.object(argument)
                {
                    objects.push((position as u32, expression));
                }
                if let Some(expression) = self.callable_expression(argument, context) {
                    self.extra.arguments.push(Argument {
                        call,
                        position: position as u32,
                        expression,
                        range: self.range(argument),
                    });
                }
            }
            if !objects.is_empty()
                && let Some(type_arguments) = type_arguments
            {
                let types = named(type_arguments)
                    .map(|ty| self.type_expression(ty, context))
                    .collect();
                self.extra.contextual_calls.push(ContextualCall {
                    call,
                    types,
                    objects,
                });
            }
        }
    }

    fn identifier(&mut self, node: Node<'a>, parent: Node<'a>, context: Context) {
        if field(parent, "name") == Some(node)
            || field(parent, "label") == Some(node)
            || matches!(
                parent.kind(),
                "formal_parameters"
                    | "import_clause"
                    | "import_specifier"
                    | "import_require_clause"
                    | "namespace_import"
                    | "namespace_export"
                    | "export_specifier"
                    | "jsx_opening_element"
                    | "jsx_closing_element"
                    | "jsx_self_closing_element"
                    | "extends_clause"
                    | "extends_type_clause"
            )
            || field(parent, "key") == Some(node)
            || field(parent, "parameter") == Some(node)
            || matches!(parent.kind(), "call_expression" | "new_expression")
                && (field(parent, "function") == Some(node)
                    || field(parent, "constructor") == Some(node))
        {
            return;
        }
        let expression =
            if parent.kind() == "member_expression" && field(parent, "property") == Some(node) {
                if self.source.parent(parent).is_some_and(|p| {
                    matches!(p.kind(), "call_expression" | "new_expression")
                        && (field(p, "function") == Some(parent)
                            || field(p, "constructor") == Some(parent))
                }) {
                    return;
                }
                self.expression(parent, context)
            } else if matches!(node.kind(), "identifier" | "shorthand_property_identifier") {
                self.expression(node, context)
            } else {
                None
            };
        if let Some(expression) = expression {
            self.extra.references.push(Reference {
                expression,
                caller: context.caller,
                scope: context.scope,
                range: self.range(node),
            });
        }
    }

    fn heritage(&mut self, node: Node<'a>, context: Context, def: i32) {
        if def == NONE {
            return;
        }
        for clause in
            named(node).filter(|n| matches!(n.kind(), "class_heritage" | "extends_type_clause"))
        {
            for part in named(clause) {
                match part.kind() {
                    "extends_clause" => {
                        if let Some(base) = field(part, "value").or_else(|| first_named(part)) {
                            self.base(def, base, context, false, false);
                        }
                    }
                    "implements_clause" => {
                        for base in named(part) {
                            self.base(def, base, context, true, true);
                        }
                    }
                    _ => self.base(
                        def,
                        part,
                        context,
                        false,
                        clause.kind() == "extends_type_clause",
                    ),
                }
            }
        }
    }

    fn base(
        &mut self,
        def: i32,
        node: Node<'a>,
        context: Context,
        implements: bool,
        type_only: bool,
    ) {
        let expression = if type_only {
            self.type_expression(node, context)
        } else {
            self.expression(node, context)
        };
        if let Some(expression) = expression {
            let range = self.range(node);
            let name = self
                .type_name(node)
                .unwrap_or_else(|| self.callee_text(node));
            let heritage = &mut self.facts.defs[def as usize].heritage;
            self.extra.bases.push(Base {
                def,
                expression,
                scope: context.scope,
                heritage: heritage.len(),
            });
            heritage.push(Heritage {
                implements,
                name,
                range,
            });
        }
    }

    fn scope(&mut self, kind: ScopeKind, parent: i32, def: i32, owner: Option<Owner>) -> i32 {
        let scope = self.facts.scopes.len() as i32;
        let this_static = owner.and_then(|owner| match owner {
            Owner::Definition { is_static, .. } | Owner::ClassExpression { is_static, .. } => {
                Some(is_static)
            }
            Owner::Object { .. } => None,
        });
        self.facts.scopes.push(Scope {
            kind,
            parent,
            def,
            this_static,
        });
        if let Some(owner) = owner {
            self.extra.this_bindings.push(ThisBinding { scope, owner });
        }
        scope
    }

    fn add_member(
        &mut self,
        owner: Owner,
        name: String,
        scope: i32,
        def: i32,
        value: Option<ExprId>,
        getter: bool,
    ) -> usize {
        let index = self.extra.members.len();
        self.extra.members.push(Member {
            owner,
            name,
            scope,
            def,
            value,
            getter,
        });
        index
    }

    fn push_expression(&mut self, expression: Expression) -> Option<ExprId> {
        if self.extra.expressions.len() == MAX_EXPRESSIONS {
            return None;
        }
        let id = self.extra.expressions.len() as ExprId;
        self.extra.expressions.push(expression);
        Some(id)
    }

    fn draft(&self, node: Node) -> i32 {
        self.drafts.get(&node.id()).copied().unwrap_or(NONE)
    }

    fn range(&self, node: Node) -> Range {
        self.source.range(self.source.span(node))
    }

    fn name(&self, node: Node) -> String {
        syntax::declaration_name(node, self.source).into_owned()
    }

    fn member_name(&self, node: Node) -> Option<String> {
        syntax::member_name(node, self.source).map(std::borrow::Cow::into_owned)
    }

    fn string(&self, node: Node) -> Option<String> {
        syntax::is_string_literal(node).then(|| self.name(node))
    }

    fn callee_text(&self, node: Node) -> String {
        syntax::normalize(self.source.of(node), bounds::MAX_CALLEE_TEXT_BYTES)
    }
}

fn named(node: Node<'_>) -> impl Iterator<Item = Node<'_>> {
    let mut cursor = node.walk();
    let mut has_child = cursor.goto_first_child();
    std::iter::from_fn(move || {
        while has_child {
            let child = cursor.node();
            has_child = cursor.goto_next_sibling();
            if child.is_named() && !child.is_extra() {
                return Some(child);
            }
        }
        None
    })
}

fn class_side(owner: Owner, is_static: bool) -> Owner {
    match owner {
        Owner::Definition { def, .. } => Owner::Definition { def, is_static },
        Owner::ClassExpression { expression, .. } => Owner::ClassExpression {
            expression,
            is_static,
        },
        Owner::Object { .. } => owner,
    }
}
