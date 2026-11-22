//! Bind the whole file before choosing drafts. A later declaration can supply
//! the representative, the end of the span, or a container for descendants.
use std::collections::HashMap;

use mex_graph_core::facts::{Def, Health, Kind};
use mex_graph_core::fingerprint::SketchBuilder;
use tree_sitter::Node;

use super::binder::{Binder, ExportModifier, Meaning, Scope, SymbolId};
use super::source::{Source, Span};
use super::syntax::{
    self, Form, field, first_named, has_modifier, initializer, is_function_like, is_function_value,
    outer, token,
};
mod materialize;

use materialize::Materializer;

pub(super) struct Declaration<'tree> {
    pub node: Node<'tree>,
    pub form: Form,
    pub span: Span,
    name: Node<'tree>,
    owner: Option<usize>,
    symbol: Option<SymbolId>,
    descriptor: Option<Descriptor>,
    modifier: ExportModifier,
    decorators: Vec<Node<'tree>>,
}

struct Descriptor {
    kind: Kind,
    name: String,
    role: String,
}

impl Descriptor {
    fn new(kind: Kind, name: String, role: &str) -> Self {
        Self {
            kind,
            name,
            role: role.into(),
        }
    }
}

#[derive(Clone, Copy)]
struct Context {
    scope: Scope,
    owner: Option<usize>,
    argument: Option<u32>,
    binding: Option<PatternBinding>,
}

#[derive(Clone, Copy)]
struct PatternBinding {
    meaning: Meaning,
    modifier: ExportModifier,
}

struct Entry<'tree> {
    node: Node<'tree>,
    context: Context,
    decorators: Vec<Node<'tree>>,
    terminator: Option<Node<'tree>>,
}

struct Collector<'a> {
    source: &'a Source<'a>,
    binder: Binder<'a>,
    declarations: Vec<Declaration<'a>>,
    namespaces: HashMap<usize, bool>,
    javascript: bool,
}

pub(super) fn extract<'a>(
    root: Node<'a>,
    source: &'a Source<'a>,
    path: &str,
    javascript: bool,
    jsx: bool,
    sketches: &mut SketchBuilder,
    health: &mut Health,
) -> Vec<Def> {
    let mut collector = Collector::new(root, source, path, javascript);
    collector.collect(root, path);
    for (declaration, symbol) in collector.binder.finish(source) {
        collector.declarations[declaration].symbol = Some(symbol);
    }
    let mut materializer = Materializer::new(source, sketches, jsx, javascript);
    materializer.finish(path, &collector.declarations, &collector.binder, health)
}

impl<'a> Collector<'a> {
    fn new(root: Node, source: &'a Source<'a>, path: &str, javascript: bool) -> Self {
        let mut cursor = root.walk();
        let esm = root.named_children(&mut cursor).any(|node| {
            matches!(
                node.kind(),
                "import_statement" | "import_alias" | "export_statement"
            )
        }) || ["mts", "cts", "mjs", "cjs"]
            .iter()
            .any(|ext| super::extension(path).eq_ignore_ascii_case(ext))
            && !javascript;
        Self {
            source,
            binder: Binder::new(esm, javascript),
            declarations: Vec::new(),
            namespaces: HashMap::new(),
            javascript,
        }
    }

    fn collect(&mut self, root: Node<'a>, path: &str) {
        let ambient = [".d.ts", ".d.mts", ".d.cts"].iter().any(|ext| {
            path.get(path.len().saturating_sub(ext.len())..)
                .is_some_and(|end| end.eq_ignore_ascii_case(ext))
        });
        let scope = self.binder.source_scope(
            ambient,
            strict_directive(root, self.source),
            ambient && !has_export_declarations(root),
        );
        let mut stack = vec![Entry {
            node: root,
            context: Context {
                scope,
                owner: None,
                argument: None,
                binding: None,
            },
            decorators: Vec::new(),
            terminator: None,
        }];
        while let Some(Entry {
            node,
            mut context,
            decorators,
            terminator,
        }) = stack.pop()
        {
            let mut adopted = decorators;
            if syntax::is_namespace(node) {
                context = self.namespace(node, context);
            } else {
                let declaration = self.declaration(node, context, &adopted, terminator);
                if node.kind() == "assignment_expression" {
                    self.binder
                        .record_assignment(node, context.scope, declaration);
                } else if node.kind() == "export_statement" {
                    self.binder.record_export(node, context.scope);
                }
                let symbol = declaration.and_then(|i| self.declarations[i].symbol);
                context.owner = declaration.or(context.owner);
                context.scope = self.child_scope(node, context.scope, symbol);
            }

            let first_child = stack.len();
            let mut argument = (node.kind() == "arguments").then_some(0);
            let member_list =
                matches!(node.kind(), "class_body" | "interface_body" | "object_type");
            let mut sibling_decorators = Vec::new();
            let mut preceding = None;
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.is_missing() || child.is_extra() && !child.is_error() {
                    continue;
                }
                if child.kind() == "decorator"
                    && matches!(node.kind(), "export_statement" | "class_body")
                {
                    sibling_decorators.push(child);
                } else if member_list && matches!(child.kind(), ";" | ",") {
                    if let Some(i) = preceding.take() {
                        let entry: &mut Entry = &mut stack[i];
                        entry.terminator = Some(child);
                    }
                } else if child.is_named() {
                    let mut decorators = std::mem::take(&mut sibling_decorators);
                    if node.kind() == "ambient_declaration"
                        && outer(child, self.source) == outer(node, self.source)
                    {
                        decorators.append(&mut adopted);
                    }
                    preceding = Some(stack.len());
                    stack.push(Entry {
                        node: child,
                        context: Context {
                            argument,
                            binding: child_binding(node, child, context.binding, self.source),
                            ..context
                        },
                        decorators,
                        terminator: None,
                    });
                    if let Some(index) = &mut argument {
                        *index += 1;
                    }
                }
            }
            stack[first_child..].reverse();
            // The compiler visits these inside the decorated declaration,
            // before its other children. Direct tree children are already queued.
            for decorator in adopted.into_iter().rev() {
                stack.push(Entry {
                    node: decorator,
                    context: Context {
                        argument: None,
                        binding: None,
                        ..context
                    },
                    decorators: Vec::new(),
                    terminator: None,
                });
            }
        }
    }

    fn child_scope(&mut self, node: Node, mut scope: Scope, symbol: Option<SymbolId>) -> Scope {
        match node.kind() {
            "class_declaration" | "abstract_class_declaration" | "class" => {
                scope.strict = true;
                self.binder.member_scope(scope, symbol, true)
            }
            "enum_declaration" => self.binder.member_scope(scope, symbol, true),
            "interface_declaration" | "object" | "object_type" => {
                self.binder.member_scope(scope, symbol, false)
            }
            "type_alias_declaration" | "class_static_block" => self.binder.local_scope(scope),
            "statement_block"
                if self.source.parent(node).is_some_and(|p| {
                    is_function_like(p)
                        || p.kind() == "class_static_block"
                        || syntax::is_namespace(p)
                }) =>
            {
                scope
            }
            "statement_block" | "switch_body" | "for_statement" | "for_in_statement"
            | "catch_clause" => self.binder.block(scope),
            "ambient_declaration" => Scope {
                ambient: true,
                ..scope
            },
            _ if is_function_like(node) => {
                if let Some(body) =
                    field(node, "body").filter(|body| body.kind() == "statement_block")
                {
                    scope.strict |= strict_directive(body, self.source);
                }
                self.binder.local_scope(scope)
            }
            _ => scope,
        }
    }

    fn declaration(
        &mut self,
        node: Node<'a>,
        context: Context,
        siblings: &[Node<'a>],
        terminator: Option<Node>,
    ) -> Option<usize> {
        let parent = self.source.parent(node)?;
        if let Some(binding) = context.binding
            && let Some(name) = binding_element_name(node)
        {
            let symbol = self.binder.declaration(
                context.scope,
                &syntax::declaration_name(name, self.source),
                binding.meaning,
                self.declarations.len(),
                binding.modifier,
            );
            return Some(self.non_node(node, name, context.owner, symbol));
        }
        let form = match node.kind() {
            "function_declaration" | "generator_function_declaration" | "function_signature" => {
                Form::Function
            }
            "class_declaration" | "abstract_class_declaration" => Form::Class,
            "interface_declaration" => Form::Interface,
            "type_alias_declaration" => Form::TypeAlias,
            "enum_declaration" => Form::Enum,
            "enum_assignment" => Form::EnumMember,
            "method_definition" | "method_signature" | "abstract_method_signature" => {
                method_form(node, self.source)
            }
            "field_definition" | "public_field_definition" => Form::Property,
            "property_signature" => Form::PropertySignature,
            "variable_declarator" => Form::Variable,
            _ if parent.kind() == "enum_body" => Form::EnumMember,
            "assignment_expression" => return self.function_assignment(node, context),
            _ if is_function_value(node) => {
                if matches!(
                    parent.kind(),
                    "variable_declarator" | "public_field_definition" | "field_definition" | "pair"
                ) || field(node, "name").is_some()
                    || node.kind() != "arrow_function" && outer(node, self.source) != node
                    || parent.kind() == "assignment_expression"
                        && field(parent, "right") == Some(node)
                        && field(parent, "left")
                            .and_then(|left| syntax::assigned_function_name(left, self.source))
                            .is_some()
                {
                    return None;
                }
                let (name, role) = syntax::callback_name(node, self.source, context.argument);
                return Some(self.push(Declaration {
                    node,
                    form: Form::Callback,
                    span: Span {
                        start: self.source.start_of(node),
                        end: self.source.significant_end(node),
                    },
                    name: node,
                    owner: context.owner,
                    symbol: None,
                    modifier: ExportModifier::None,
                    decorators: Vec::new(),
                    descriptor: Some(Descriptor {
                        kind: Kind::Function,
                        name,
                        role,
                    }),
                }));
            }
            _ => return self.bind_non_node(node, parent, context),
        };

        let name = if parent.kind() == "enum_body" && node.kind() != "enum_assignment" {
            node
        } else {
            field(node, "name").or_else(|| field(node, "property"))?
        };
        if name.is_missing() || form == Form::Variable && !syntax::is_identifier(name) {
            return None;
        }
        let name_text = syntax::declaration_name(name, self.source);
        let descriptor = descriptor(node, form, &name_text, self.source);
        let mut decorators = siblings.to_vec();
        let mut cursor = node.walk();
        decorators.extend(node.children_by_field_name("decorator", &mut cursor));
        let span = syntax::span(node, form, &decorators, terminator, self.source);
        let modifier = export_modifier(if form == Form::Variable {
            outer(parent, self.source)
        } else {
            outer(node, self.source)
        });

        let declaration = self.declarations.len();
        let require_alias = self.javascript
            && form == Form::Variable
            && !modifier.is_export()
            && initializer(node).is_some_and(|init| require_initializer(init, self.source))
            && !self
                .source
                .docs_at(span.start, true)
                .or_else(|| {
                    syntax::variable_statement(node, self.source).and_then(|statement| {
                        self.source.docs_at(self.source.start_of(statement), false)
                    })
                })
                .is_some_and(|(_, comment)| comment.contains("@type "));
        let meaning = match form {
            Form::Function => Meaning::Function,
            Form::Class => Meaning::Class,
            Form::Interface => Meaning::Interface,
            Form::TypeAlias => Meaning::TypeAlias,
            Form::Enum if syntax::is_const(node) => Meaning::ConstEnum,
            Form::Enum => Meaning::Enum,
            Form::EnumMember => Meaning::EnumMember,
            Form::Method if parent.kind() == "object" => Meaning::ObjectMethod,
            Form::Method | Form::MethodSignature => Meaning::Method,
            Form::Getter => Meaning::Getter,
            Form::Setter => Meaning::Setter,
            Form::Property if token(node, "accessor").is_some() => Meaning::AutoAccessor,
            Form::Property | Form::PropertySignature => Meaning::Property,
            Form::Variable if require_alias => Meaning::Alias,
            Form::Variable if parent.kind() == "variable_declaration" => Meaning::Var,
            Form::Variable => Meaning::Lexical,
            _ => Meaning::Property,
        };
        let symbol = if form == Form::Constructor {
            None
        } else if form.is_scope_member() {
            syntax::member_name(name, self.source).and_then(|name| {
                self.binder.member(
                    context.scope,
                    form == Form::EnumMember || has_modifier(node, "static"),
                    &name,
                    meaning,
                    declaration,
                )
            })
        } else {
            Some(
                self.binder
                    .declaration(context.scope, &name_text, meaning, declaration, modifier),
            )
        };
        if form == Form::Variable
            && let Some(symbol) = symbol
        {
            let symbol = &mut self.binder.symbols[symbol];
            symbol.require_alias |= require_alias;
            symbol.expando_initializer |=
                self.javascript && initializer(node).is_some_and(expando_initializer);
        }
        Some(self.push(Declaration {
            node,
            form,
            span,
            name,
            owner: context.owner,
            symbol,
            descriptor,
            modifier,
            decorators,
        }))
    }

    fn bind_non_node(
        &mut self,
        node: Node<'a>,
        parent: Node<'a>,
        context: Context,
    ) -> Option<usize> {
        let index = self.declarations.len();
        let (name, symbol) = if parent.kind() == "object" {
            let name = match node.kind() {
                "pair" => field(node, "key")?,
                "shorthand_property_identifier" => node,
                _ => return None,
            };
            let spelling = syntax::member_name(name, self.source)?;
            (
                name,
                self.binder
                    .member(context.scope, false, &spelling, Meaning::Property, index)?,
            )
        } else {
            let name = match node.kind() {
                "required_parameter" | "optional_parameter" | "assignment_pattern"
                    if parent.kind() == "formal_parameters" =>
                {
                    field(node, "pattern").or_else(|| field(node, "left"))?
                }
                "identifier"
                    if parent.kind() == "formal_parameters"
                        || field(parent, "parameter") == Some(node) =>
                {
                    node
                }
                _ => return None,
            };
            if !syntax::is_identifier(name) {
                return None;
            }
            let spelling = syntax::declaration_name(name, self.source);
            (
                name,
                self.binder.local(
                    context.scope.locals,
                    &spelling,
                    Meaning::Parameter,
                    Some(index),
                ),
            )
        };
        Some(self.non_node(node, name, context.owner, symbol))
    }

    fn non_node(
        &mut self,
        node: Node<'a>,
        name: Node<'a>,
        owner: Option<usize>,
        symbol: SymbolId,
    ) -> usize {
        self.push(Declaration {
            node,
            form: Form::Other,
            span: Span {
                start: self.source.start_of(node),
                end: self.source.significant_end(node),
            },
            name,
            owner,
            symbol: Some(symbol),
            descriptor: None,
            modifier: ExportModifier::None,
            decorators: Vec::new(),
        })
    }

    fn function_assignment(&mut self, node: Node<'a>, context: Context) -> Option<usize> {
        let right = field(node, "right").filter(|right| is_function_value(*right))?;
        let left = field(node, "left")?;
        let name = syntax::assigned_function_name(left, self.source)?;
        let (_, member) = syntax::access(left)?;
        Some(self.push(Declaration {
            node,
            form: Form::Assignment,
            span: Span {
                start: self.source.start_of(node),
                end: self.source.significant_end(right),
            },
            name: member,
            owner: context.owner,
            symbol: None,
            descriptor: Some(Descriptor::new(Kind::Function, name, "function-assignment")),
            modifier: ExportModifier::None,
            decorators: Vec::new(),
        }))
    }

    fn namespace(&mut self, node: Node<'a>, mut context: Context) -> Context {
        let name = field(node, "name").or_else(|| syntax::global_name(node));
        let Some(mut name) = name else { return context };
        let mut parts = Vec::new();
        while matches!(name.kind(), "nested_identifier" | "member_expression") {
            let (Some(object), Some(property)) = (field(name, "object"), field(name, "property"))
            else {
                break;
            };
            parts.push(property);
            name = object;
        }
        parts.push(name);
        let wrapper = outer(node, self.source);
        let ambient = context.scope.ambient
            || wrapper.kind() == "ambient_declaration"
            || token(wrapper, "ambient_declaration").is_some();
        let body = field(node, "body").or_else(|| token(node, "statement_block"));
        let implicit = body.is_none_or(|body| !has_export_declarations(body));
        let meaning = if syntax::is_string_literal(name) || self.instantiated_namespace(node) {
            Meaning::ValueModule
        } else {
            Meaning::Namespace
        };
        for (i, part) in parts.into_iter().rev().enumerate() {
            let name = syntax::declaration_name(part, self.source);
            let modifier = if syntax::is_string_literal(part) || syntax::global_name(node).is_some()
            {
                ExportModifier::AmbientModule
            } else if i > 0 {
                ExportModifier::Export
            } else {
                export_modifier(wrapper)
            };
            let binder_name = if syntax::is_string_literal(part) {
                format!("\"{name}\"")
            } else {
                name.to_string()
            };
            let index = self.declarations.len();
            let symbol =
                self.binder
                    .declaration(context.scope, &binder_name, meaning, index, modifier);
            context.owner = Some(self.push(Declaration {
                node,
                form: Form::Namespace,
                span: Span {
                    start: if i == 0 {
                        self.source.start_of(wrapper)
                    } else {
                        self.source.start_of(part)
                    },
                    end: self.source.significant_end(node),
                },
                name: part,
                owner: context.owner,
                symbol: Some(symbol),
                descriptor: Some(Descriptor::new(
                    Kind::Namespace,
                    name.into_owned(),
                    "namespace",
                )),
                modifier,
                decorators: Vec::new(),
            }));
            context.scope =
                self.binder
                    .namespace(context.scope, symbol, ambient, ambient && implicit);
        }
        context
    }

    /// Type-only namespaces use NamespaceModule, whose excludes mask is zero.
    /// Cache nested results so a chain of namespaces only visits its syntax once.
    fn instantiated_namespace(&mut self, root: Node<'a>) -> bool {
        let mut work = vec![(root, false)];
        while let Some((node, visited)) = work.pop() {
            if self.namespaces.contains_key(&node.id()) {
                continue;
            }
            let Some(body) = field(node, "body").or_else(|| token(node, "statement_block")) else {
                self.namespaces.insert(node.id(), true);
                continue;
            };
            let mut cursor = body.walk();
            let statements = body.named_children(&mut cursor).filter(|n| !n.is_extra());
            if visited {
                let instantiated = statements.map(unwrap_statement).any(|n| {
                    self.namespaces.get(&n.id()).copied().unwrap_or_else(|| {
                        !matches!(
                            n.kind(),
                            "interface_declaration"
                                | "type_alias_declaration"
                                | "import_statement"
                                | "import_alias"
                        )
                    })
                });
                self.namespaces.insert(node.id(), instantiated);
            } else {
                work.push((node, true));
                work.extend(
                    statements
                        .map(unwrap_statement)
                        .filter(|n| syntax::is_namespace(*n))
                        .map(|n| (n, false)),
                );
            }
        }
        self.namespaces[&root.id()]
    }

    fn push(&mut self, declaration: Declaration<'a>) -> usize {
        let index = self.declarations.len();
        self.declarations.push(declaration);
        index
    }
}

fn child_binding(
    parent: Node,
    child: Node,
    binding: Option<PatternBinding>,
    source: &Source<'_>,
) -> Option<PatternBinding> {
    match parent.kind() {
        "variable_declarator"
            if matches!(child.kind(), "object_pattern" | "array_pattern")
                && field(parent, "name") == Some(child) =>
        {
            let list = source.parent(parent)?;
            Some(PatternBinding {
                meaning: if list.kind() == "variable_declaration" {
                    Meaning::Var
                } else {
                    Meaning::Lexical
                },
                modifier: export_modifier(outer(list, source)),
            })
        }
        "required_parameter" | "optional_parameter"
            if field(parent, "pattern") == Some(child)
                && matches!(child.kind(), "object_pattern" | "array_pattern") =>
        {
            Some(PatternBinding {
                meaning: Meaning::Parameter,
                modifier: ExportModifier::None,
            })
        }
        "array_pattern" | "object_pattern" => binding,
        "assignment_pattern" | "object_assignment_pattern"
            if field(parent, "left") == Some(child)
                && matches!(child.kind(), "object_pattern" | "array_pattern") =>
        {
            binding
        }
        "pair_pattern"
            if field(parent, "value") == Some(child) && binding_element_name(parent).is_none() =>
        {
            binding
        }
        "rest_pattern" if matches!(child.kind(), "object_pattern" | "array_pattern") => binding,
        _ => None,
    }
}

fn binding_element_name(node: Node<'_>) -> Option<Node<'_>> {
    let name = match node.kind() {
        "pair_pattern" => {
            let value = field(node, "value")?;
            if value.kind() == "assignment_pattern" {
                field(value, "left")?
            } else {
                value
            }
        }
        "assignment_pattern" | "object_assignment_pattern" => field(node, "left")?,
        "rest_pattern" => first_named(node)?,
        "identifier" | "shorthand_property_identifier_pattern" => node,
        _ => return None,
    };
    syntax::is_identifier(name).then_some(name)
}

fn require_initializer(mut node: Node, source: &Source<'_>) -> bool {
    while let Some((object, _)) = syntax::access(node) {
        node = object;
    }
    if node.kind() != "call_expression"
        || !field(node, "function")
            .is_some_and(|name| name.kind() == "identifier" && source.of(name) == "require")
    {
        return false;
    }
    let Some(args) = field(node, "arguments") else {
        return false;
    };
    let mut cursor = args.walk();
    let mut arguments = args.named_children(&mut cursor).filter(|n| !n.is_extra());
    arguments.next().is_some_and(syntax::is_string_literal) && arguments.next().is_none()
}

fn expando_initializer(mut node: Node) -> bool {
    while node.kind() == "assignment_expression"
        || node.kind() == "binary_expression"
            && field(node, "operator")
                .is_some_and(|operator| matches!(operator.kind(), "||" | "??"))
    {
        let Some(right) = field(node, "right") else {
            break;
        };
        node = right;
    }
    is_function_value(node)
        || node.kind() == "class"
        || node.kind() == "object" && first_named(node).is_none()
        || node.kind() == "call_expression"
            && field(node, "function").is_some_and(|mut function| {
                while function.kind() == "parenthesized_expression" {
                    let Some(inner) = first_named(function) else {
                        break;
                    };
                    function = inner;
                }
                is_function_value(function)
            })
}

fn unwrap_statement(node: Node<'_>) -> Node<'_> {
    match node.kind() {
        "export_statement" => field(node, "declaration").unwrap_or(node),
        "expression_statement" => first_named(node)
            .filter(|n| syntax::is_namespace(*n))
            .unwrap_or(node),
        "ambient_declaration" => first_named(node).unwrap_or(node),
        _ => node,
    }
}

fn strict_directive(node: Node, source: &Source<'_>) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter(|child| !child.is_extra() && child.kind() != "hash_bang_line")
        .map_while(|statement| {
            (statement.kind() == "expression_statement")
                .then(|| first_named(statement))
                .flatten()
                .filter(|expression| expression.kind() == "string")
        })
        .any(|string| matches!(source.of(string), "\"use strict\"" | "'use strict'"))
}

fn has_export_declarations(node: Node) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .any(|n| n.kind() == "export_statement" && field(n, "declaration").is_none())
}

fn export_modifier(node: Node) -> ExportModifier {
    if node.kind() != "export_statement" {
        ExportModifier::None
    } else if token(node, "default").is_some() {
        ExportModifier::Default
    } else {
        ExportModifier::Export
    }
}

fn method_form(node: Node, source: &Source<'_>) -> Form {
    if token(node, "get").is_some() {
        Form::Getter
    } else if token(node, "set").is_some() {
        Form::Setter
    } else if source
        .parent(node)
        .is_some_and(|p| p.kind() == "class_body")
        && field(node, "name")
            .is_some_and(|name| syntax::declaration_name(name, source) == "constructor")
    {
        Form::Constructor
    } else if node.kind() == "method_definition" {
        Form::Method
    } else {
        Form::MethodSignature
    }
}

fn descriptor(node: Node, form: Form, name: &str, source: &Source<'_>) -> Option<Descriptor> {
    let callable = initializer(node).is_some_and(is_function_value);
    let (kind, role) = match form {
        Form::Function => (Kind::Function, "function"),
        Form::Class => (Kind::Class, "class"),
        Form::Interface => (Kind::Interface, "interface"),
        Form::Enum => (Kind::Enum, "enum"),
        Form::EnumMember => (Kind::EnumMember, "enum-member"),
        Form::TypeAlias => (Kind::TypeAlias, "type-alias"),
        Form::Method | Form::MethodSignature => (Kind::Method, "method"),
        Form::Constructor => (Kind::Method, "constructor"),
        Form::Getter | Form::Setter => (Kind::Method, "accessor"),
        Form::Property if callable => (Kind::Method, "callable-property"),
        Form::Property | Form::PropertySignature => (Kind::Property, "property"),
        Form::Variable if callable => (Kind::Function, "function-variable"),
        Form::Variable
            if syntax::variable_statement(node, source)
                .and_then(|statement| source.parent(statement))
                .is_some_and(|body| syntax::is_module_body(body, source)) =>
        {
            let kind = if source.parent(node).is_some_and(syntax::is_const) {
                Kind::Constant
            } else {
                Kind::Variable
            };
            (kind, "variable")
        }
        _ => return None,
    };
    Some(Descriptor::new(kind, name.into(), role))
}
