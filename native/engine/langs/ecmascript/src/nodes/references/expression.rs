use mex_graph_core::facts::NONE;
use mex_graph_core::facts::ecmascript::{ExprId, Expression, Owner};
use tree_sitter::Node;

use super::{Collector, Context, named, static_access};
use crate::nodes::syntax::{access, field, first_named, is_function_value, token};

const MAX_EXPRESSION_DEPTH: usize = 40;

impl<'a> Collector<'a, '_> {
    pub(super) fn expression(&mut self, node: Node<'a>, context: Context) -> Option<ExprId> {
        self.read_expression(node, context, 0)
    }

    fn read_expression(
        &mut self,
        node: Node<'a>,
        context: Context,
        depth: usize,
    ) -> Option<ExprId> {
        if depth == MAX_EXPRESSION_DEPTH || node.is_missing() {
            return None;
        }
        if let Some(&id) = self.expressions.get(&node.id()) {
            return Some(id);
        }
        let child =
            |this: &mut Self, node: Node<'a>| this.read_expression(node, context, depth + 1);
        let expression = match node.kind() {
            "identifier" | "shorthand_property_identifier" => Expression::Name {
                name: self.name(node),
            },
            "this" => Expression::This,
            "super" => Expression::Super,
            "member_expression" | "subscript_expression" => {
                let object = child(self, field(node, "object")?)?;
                if let Some((_, property)) =
                    access(node).filter(|(_, property)| static_access(node, *property))
                {
                    Expression::Member {
                        object,
                        name: self.name(property),
                    }
                } else {
                    Expression::Index { object }
                }
            }
            "call_expression" => {
                if let Some(import) = self.require_import(node, context.scope) {
                    Expression::Module { import }
                } else {
                    Expression::Call {
                        callee: child(self, field(node, "function")?)?,
                    }
                }
            }
            "new_expression" => Expression::New {
                callee: child(self, field(node, "constructor")?)?,
            },
            "await_expression" => Expression::Await {
                operand: child(self, first_named(node)?)?,
            },
            "parenthesized_expression"
            | "non_null_expression"
            | "satisfies_expression"
            | "instantiation_expression" => return child(self, first_named(node)?),
            "as_expression" => return self.annotation(named(node).nth(1)?, context, depth + 1),
            "type_assertion" => {
                return self.annotation(first_named(first_named(node)?)?, context, depth + 1);
            }
            "ternary_expression" => Expression::Alternatives {
                values: vec![
                    child(self, field(node, "consequence")?)?,
                    child(self, field(node, "alternative")?)?,
                ],
            },
            "binary_expression"
                if field(node, "operator").is_some_and(|op| matches!(op.kind(), "||" | "??")) =>
            {
                Expression::Alternatives {
                    values: vec![
                        child(self, field(node, "left")?)?,
                        child(self, field(node, "right")?)?,
                    ],
                }
            }
            "object" => return self.object(node),
            "array" => {
                let mut elements = Vec::new();
                let mut expect_element = true;
                let mut cursor = node.walk();
                for item in node.children(&mut cursor).filter(|item| !item.is_extra()) {
                    match item.kind() {
                        "[" | "]" => {}
                        "," => {
                            if expect_element {
                                elements.push(None);
                            }
                            expect_element = true;
                        }
                        "spread_element" => return None,
                        _ => {
                            elements.push(child(self, item));
                            expect_element = false;
                        }
                    }
                }
                Expression::Tuple { elements }
            }
            "class" => return self.shape(node, Expression::Class),
            _ if is_function_value(node) => self
                .drafts
                .get(&node.id())
                .map_or(Expression::Callable, |&def| Expression::Definition { def }),
            _ => return None,
        };
        let id = self.push_expression(expression)?;
        self.expressions.insert(node.id(), id);
        Some(id)
    }

    pub(super) fn type_expression(&mut self, node: Node<'a>, context: Context) -> Option<ExprId> {
        self.annotation(node, context, 0)
    }

    fn annotation(&mut self, node: Node<'a>, context: Context, depth: usize) -> Option<ExprId> {
        if depth == MAX_EXPRESSION_DEPTH || node.is_missing() {
            return None;
        }
        let ty = |this: &mut Self, node: Node<'a>| this.annotation(node, context, depth + 1);
        let expression = match node.kind() {
            "type_annotation" | "parenthesized_type" | "constraint" | "readonly_type"
            | "optional_type" | "rest_type" => return ty(self, first_named(node)?),
            "type_identifier" | "identifier" | "nested_type_identifier" => Expression::TypeName {
                name: self.type_name(node)?,
            },
            "generic_type" => {
                let name = field(node, "name").or_else(|| first_named(node))?;
                if matches!(
                    self.source.of(name),
                    "Array" | "ReadonlyArray" | "Promise" | "PromiseLike"
                ) && let Some(arguments) = field(node, "type_arguments")
                    && let Some(item) = first_named(arguments)
                    && let Some(element) = ty(self, item)
                {
                    match self.source.of(name) {
                        "Array" | "ReadonlyArray" => Expression::Array {
                            element: Some(element),
                        },
                        _ => Expression::Promise { element },
                    }
                } else {
                    let name = self.type_name(name)?;
                    let arguments = field(node, "type_arguments").map_or_else(Vec::new, |args| {
                        named(args).map(|arg| ty(self, arg)).collect()
                    });
                    Expression::GenericType { name, arguments }
                }
            }
            "intersection_type" => Expression::Intersection {
                parts: named(node).filter_map(|part| ty(self, part)).collect(),
            },
            "type_query" => return self.read_expression(first_named(node)?, context, depth + 1),
            "array_type" => Expression::Array {
                element: ty(self, first_named(node)?),
            },
            "tuple_type" => Expression::Tuple {
                elements: named(node)
                    .map(|part| ty(self, field(part, "type").unwrap_or(part)))
                    .collect(),
            },
            "this_type" | "this" => Expression::This,
            "function_type" | "constructor_type" => Expression::Signature {
                construct: node.kind() == "constructor_type",
                returns: field(node, "return_type")
                    .or_else(|| field(node, "type"))
                    .and_then(|result| ty(self, result)),
            },
            "object_type" => return self.object(node),
            "union_type" => {
                let mut values = Vec::new();
                for part in named(node) {
                    if !matches!(self.source.of(part), "undefined" | "null" | "void") {
                        values.push(ty(self, part)?);
                    }
                }
                match values.as_slice() {
                    [] => return None,
                    [id] => return Some(*id),
                    _ => Expression::Alternatives { values },
                }
            }
            _ => return None,
        };
        self.push_expression(expression)
    }

    pub(super) fn type_name(&self, mut node: Node) -> Option<String> {
        let mut parts = Vec::new();
        for _ in 0..MAX_EXPRESSION_DEPTH {
            match node.kind() {
                "generic_type" => node = first_named(node)?,
                "nested_type_identifier" | "nested_identifier" | "member_expression" => {
                    let name = field(node, "name").or_else(|| field(node, "property"))?;
                    parts.push(self.name(name));
                    node = field(node, "module").or_else(|| field(node, "object"))?;
                }
                "identifier" | "type_identifier" | "property_identifier" => {
                    parts.push(self.name(node));
                    parts.reverse();
                    return Some(parts.join("."));
                }
                _ => return None,
            }
        }
        None
    }

    pub(super) fn object(&mut self, node: Node) -> Option<ExprId> {
        self.shape(node, Expression::Object)
    }

    pub(super) fn shape(&mut self, node: Node, shape: Expression) -> Option<ExprId> {
        if let Some(&expression) = self.expressions.get(&node.id()) {
            return Some(expression);
        }
        let expression = self.push_expression(shape)?;
        self.expressions.insert(node.id(), expression);
        Some(expression)
    }

    pub(super) fn object_member(&mut self, node: Node<'a>, context: Context) {
        let Some(parent) = self.source.parent(node) else {
            return;
        };
        if !matches!(parent.kind(), "object" | "object_type") {
            return;
        }
        let Some(expression) = self.object(parent) else {
            return;
        };
        let (key, value) = match node.kind() {
            "pair" => (
                field(node, "key"),
                field(node, "value").and_then(|n| self.expression(n, context)),
            ),
            "shorthand_property_identifier" => (Some(node), self.expression(node, context)),
            "method_definition" | "method_signature" | "property_signature" => (
                field(node, "name"),
                field(node, "type").and_then(|n| self.type_expression(n, context)),
            ),
            _ => return,
        };
        if let Some(name) = key.and_then(|key| self.member_name(key)) {
            self.add_member(
                Owner::Object { expression },
                name,
                context.scope,
                self.draft(node),
                value,
                token(node, "get").is_some(),
            );
        }
    }

    pub(super) fn require_import(&mut self, node: Node, scope: i32) -> Option<usize> {
        if node.kind() != "call_expression" {
            return None;
        }
        if let Some(index) = self.require_calls.get(&node.id()) {
            return Some(*index);
        }
        let function = field(node, "function")?;
        if function.kind() != "identifier" || self.name(function) != "require" {
            return None;
        }
        let arguments = field(node, "arguments")?;
        let mut items = named(arguments);
        let specifier = self.string(items.next()?)?;
        if items.next().is_some() {
            return None;
        }
        let index = self.add_import(
            mex_graph_core::facts::ImportForm::CommonJs,
            specifier,
            node,
            scope,
        );
        self.require_calls.insert(node.id(), index);
        Some(index)
    }

    pub(super) fn callable_expression(
        &mut self,
        node: Node<'a>,
        context: Context,
    ) -> Option<ExprId> {
        match node.kind() {
            "identifier" | "member_expression" | "subscript_expression" => {
                self.expression(node, context)
            }
            _ if is_function_value(node) => {
                let def = self.draft(node);
                (def != NONE)
                    .then(|| self.push_expression(Expression::Definition { def }))
                    .flatten()
            }
            _ => None,
        }
    }
}
