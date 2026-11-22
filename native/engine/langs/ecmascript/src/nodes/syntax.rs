//! Translate grammar nodes into the declaration shapes used by compiler.ts.
use std::borrow::Cow;

use mex_graph_core::facts::{Kind, bounds};
use mex_graph_core::id::is_js_whitespace;
use mex_graph_core::text::{js_slice, js_trim};
use tree_sitter::Node;

use super::source::{Source, Span};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Form {
    Function,
    Class,
    Interface,
    Enum,
    EnumMember,
    TypeAlias,
    Namespace,
    Method,
    MethodSignature,
    Getter,
    Setter,
    Constructor,
    Property,
    PropertySignature,
    Variable,
    Callback,
    Assignment,
    /// A declaration that participates in binding but never starts a graph node.
    Other,
}

impl Form {
    pub fn compatible(self, kind: Kind) -> bool {
        match kind {
            Kind::Function => matches!(self, Self::Function | Self::Variable | Self::Callback),
            Kind::Method => matches!(
                self,
                Self::Method | Self::MethodSignature | Self::Getter | Self::Setter | Self::Property
            ),
            Kind::Property => matches!(self, Self::Property | Self::PropertySignature),
            _ => true,
        }
    }

    pub fn is_scope_member(self) -> bool {
        matches!(
            self,
            Self::Method
                | Self::MethodSignature
                | Self::Getter
                | Self::Setter
                | Self::Property
                | Self::PropertySignature
                | Self::EnumMember
        )
    }
}

pub(super) fn field<'tree>(node: Node<'tree>, name: &str) -> Option<Node<'tree>> {
    node.child_by_field_name(name)
}

pub(super) fn first_named(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| !child.is_extra())
}

pub(super) fn token<'tree>(node: Node<'tree>, kind: &str) -> Option<Node<'tree>> {
    let mut cursor = node.walk();
    node.children(&mut cursor)
        .find(|child| child.kind() == kind)
}

pub(super) fn outer<'a>(mut node: Node<'a>, source: &Source<'a>) -> Node<'a> {
    while let Some(parent) = source.parent(node) {
        match parent.kind() {
            "ambient_declaration" => node = parent,
            "export_statement"
                if field(parent, "declaration") == Some(node)
                    || matches!(
                        node.kind(),
                        "class" | "function_expression" | "generator_function"
                    ) && token(parent, "default").is_some() =>
            {
                node = parent;
            }
            _ => break,
        }
    }
    node
}

pub(super) fn has_modifier(node: Node, kind: &str) -> bool {
    let mut cursor = node.walk();
    node.children(&mut cursor).any(|child| {
        child.kind() == kind
            || child.kind() == "accessibility_modifier" && token(child, kind).is_some()
    })
}

pub(super) fn span(
    node: Node,
    form: Form,
    decorators: &[Node],
    terminator: Option<Node>,
    source: &Source<'_>,
) -> Span {
    let outer = if form == Form::Variable {
        node
    } else {
        outer(node, source)
    };
    let mut span = Span {
        start: source.start_of(outer),
        end: source.significant_end(node),
    };
    if let Some(first) = decorators.first() {
        span.start = span.start.min(source.start_of(*first));
    }
    let take_terminator = matches!(
        form,
        Form::Property | Form::PropertySignature | Form::MethodSignature
    ) || matches!(form, Form::Getter | Form::Setter | Form::Constructor)
        && node.kind() != "method_definition";
    if take_terminator && let Some(terminator) = terminator {
        span.end = source.end_of(terminator);
    }
    span
}

pub(super) fn is_function_value(node: Node) -> bool {
    matches!(
        node.kind(),
        "arrow_function" | "function_expression" | "generator_function"
    )
}

pub(super) fn is_function_like(node: Node) -> bool {
    is_function_value(node)
        || matches!(
            node.kind(),
            "function_declaration"
                | "generator_function_declaration"
                | "function_signature"
                | "method_definition"
                | "method_signature"
                | "abstract_method_signature"
                | "function_type"
                | "constructor_type"
                | "call_signature"
                | "construct_signature"
                | "index_signature"
        )
}

pub(super) fn initializer(node: Node<'_>) -> Option<Node<'_>> {
    field(node, "value").filter(|n| !n.is_missing())
}

pub(super) fn is_module_body(node: Node, source: &Source<'_>) -> bool {
    node.kind() == "program"
        || node.kind() == "statement_block" && source.parent(node).is_some_and(is_namespace)
}

pub(super) fn is_namespace(node: Node) -> bool {
    matches!(node.kind(), "internal_module" | "module") || global_name(node).is_some()
}

pub(super) fn global_name(node: Node<'_>) -> Option<Node<'_>> {
    (node.kind() == "ambient_declaration")
        .then(|| token(node, "global"))
        .flatten()
}

pub(super) fn variable_statement<'a>(node: Node<'a>, source: &Source<'a>) -> Option<Node<'a>> {
    let list = source.parent(node)?;
    matches!(list.kind(), "lexical_declaration" | "variable_declaration")
        .then(|| outer(list, source))
        .filter(|statement| {
            !source
                .parent(*statement)
                .is_some_and(|parent| matches!(parent.kind(), "for_statement" | "for_in_statement"))
        })
}

pub(super) fn is_const(node: Node) -> bool {
    token(node, "const").is_some()
}

pub(super) fn is_identifier(node: Node) -> bool {
    matches!(
        node.kind(),
        "identifier"
            | "type_identifier"
            | "property_identifier"
            | "private_property_identifier"
            | "shorthand_property_identifier"
            | "shorthand_property_identifier_pattern"
            | "statement_identifier"
    )
}

pub(super) fn declaration_name<'a>(node: Node, source: &Source<'a>) -> Cow<'a, str> {
    let raw = source.of(node);
    if matches!(node.kind(), "string" | "template_string") && raw.len() >= 2 {
        unescape(&raw[1..raw.len() - 1])
    } else if is_identifier(node) {
        unescape(raw)
    } else if node.kind() == "number" {
        let digits = raw.replace('_', "");
        let normalized = if digits.ends_with('n') {
            return Cow::Borrowed(raw);
        } else if let Some(hex) = digits
            .strip_prefix("0x")
            .or_else(|| digits.strip_prefix("0X"))
        {
            u128::from_str_radix(hex, 16).ok().map(|n| n as f64)
        } else if let Some(octal) = digits
            .strip_prefix("0o")
            .or_else(|| digits.strip_prefix("0O"))
        {
            u128::from_str_radix(octal, 8).ok().map(|n| n as f64)
        } else if let Some(binary) = digits
            .strip_prefix("0b")
            .or_else(|| digits.strip_prefix("0B"))
        {
            u128::from_str_radix(binary, 2).ok().map(|n| n as f64)
        } else if digits.len() > 1
            && digits.starts_with('0')
            && digits.bytes().all(|b| matches!(b, b'0'..=b'7'))
        {
            u128::from_str_radix(&digits, 8).ok().map(|n| n as f64)
        } else {
            digits.parse::<f64>().ok()
        };
        normalized.map_or(Cow::Borrowed(raw), |n| {
            if n.abs() >= 1e21 {
                Cow::Owned(format!("{n:e}").replace('e', "e+"))
            } else if n != 0.0 && n.abs() < 1e-6 {
                Cow::Owned(format!("{n:e}"))
            } else {
                Cow::Owned(n.to_string())
            }
        })
    } else {
        Cow::Borrowed(raw)
    }
}

fn unescape(text: &str) -> Cow<'_, str> {
    if !text.contains('\\') {
        return Cow::Borrowed(text);
    }
    let mut value = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let decoded = if c == '\\' {
            match chars.next() {
                Some(kind @ ('u' | 'x')) => {
                    if kind == 'u' && chars.next_if_eq(&'{').is_some() {
                        let mut n = 0u32;
                        while let Some(digit) = chars.next_if(|c| c.is_ascii_hexdigit()) {
                            n = n
                                .saturating_mul(16)
                                .saturating_add(digit.to_digit(16).unwrap_or(0));
                        }
                        chars.next_if_eq(&'}');
                        char::from_u32(n).unwrap_or(char::REPLACEMENT_CHARACTER)
                    } else {
                        let mut n = 0u16;
                        for _ in 0..if kind == 'u' { 4 } else { 2 } {
                            let Some(digit) = chars.next_if(|c| c.is_ascii_hexdigit()) else {
                                break;
                            };
                            n = n * 16 + digit.to_digit(16).unwrap_or(0) as u16;
                        }
                        value.push(n);
                        continue;
                    }
                }
                Some('\n' | '\u{2028}' | '\u{2029}') => continue,
                Some('\r') => {
                    chars.next_if_eq(&'\n');
                    continue;
                }
                Some('n') => '\n',
                Some('r') => '\r',
                Some('t') => '\t',
                Some('v') => '\u{000b}',
                Some('b') => '\u{0008}',
                Some('f') => '\u{000c}',
                Some(first @ '0'..='7') => {
                    let mut n = first.to_digit(8).unwrap_or(0);
                    for _ in 0..if n <= 3 { 2 } else { 1 } {
                        let Some(digit) = chars.next_if(|c| matches!(c, '0'..='7')) else {
                            break;
                        };
                        n = n * 8 + digit.to_digit(8).unwrap_or(0);
                    }
                    char::from_u32(n).unwrap_or(char::REPLACEMENT_CHARACTER)
                }
                Some(c) => c,
                None => c,
            }
        } else {
            c
        };
        value.extend_from_slice(decoded.encode_utf16(&mut [0; 2]));
    }
    Cow::Owned(String::from_utf16_lossy(&value))
}

pub(super) fn is_string_literal(node: Node) -> bool {
    matches!(node.kind(), "string" | "template_string")
        && token(node, "template_substitution").is_none()
}

pub(super) fn member_name<'a>(name: Node, source: &Source<'a>) -> Option<Cow<'a, str>> {
    if name.kind() != "computed_property_name" {
        return Some(declaration_name(name, source));
    }
    let expression = first_named(name)?;
    if is_string_literal(expression) || expression.kind() == "number" {
        Some(declaration_name(expression, source))
    } else if expression.kind() == "unary_expression"
        && let Some(operator) = field(expression, "operator")
        && matches!(operator.kind(), "+" | "-")
        && let Some(number) = field(expression, "argument").filter(|n| n.kind() == "number")
    {
        Some(Cow::Owned(format!(
            "{}{}",
            operator.kind(),
            declaration_name(number, source)
        )))
    } else {
        None
    }
}

pub(super) fn access<'tree>(node: Node<'tree>) -> Option<(Node<'tree>, Node<'tree>)> {
    match node.kind() {
        "member_expression" => Some((field(node, "object")?, field(node, "property")?)),
        "subscript_expression" => Some((field(node, "object")?, field(node, "index")?)),
        _ => None,
    }
}

pub(super) fn assigned_function_name(mut node: Node, source: &Source<'_>) -> Option<String> {
    let mut components = Vec::new();
    while let Some((receiver, member)) = access(node) {
        let name = declaration_name(member, source);
        if node.kind() == "subscript_expression"
            && (!is_string_literal(member) || !is_ascii_name(&name))
        {
            return None;
        }
        components.push(name);
        node = receiver;
    }
    if node.kind() != "identifier" || components.is_empty() {
        return None;
    }
    let mut name = declaration_name(node, source).into_owned();
    for component in components.into_iter().rev() {
        name.push('.');
        name.push_str(&component);
    }
    Some(name)
}

fn is_ascii_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'_' | b'$'))
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$'))
}

/// The compiler removes JavaScript whitespace and truncates the callee to 80
/// UTF-16 units. Stop normalizing once the bounded prefix is known.
pub(super) fn callback_name(
    node: Node,
    source: &Source<'_>,
    index: Option<u32>,
) -> (String, String) {
    let parent = source
        .parent(node)
        .expect("function expression has a parent");
    let call = if parent.kind() == "arguments" {
        source.parent(parent)
    } else {
        Some(parent)
    };
    if let Some(call) = call
        && let Some((callee, role)) = match call.kind() {
            "call_expression" => {
                field(call, "function").map(|callee| (callee, "callback-argument"))
            }
            "new_expression" => {
                field(call, "constructor").map(|callee| (callee, "constructor-callback"))
            }
            _ => None,
        }
    {
        let index = index.map_or(-1_i64, i64::from);
        if source.of(callee).is_empty()
            && source.parent(call).is_some_and(|p| p.kind() == "decorator")
        {
            return anonymous_callback("ParenthesizedExpression");
        }
        let callee = js_slice(&normalize(callee_text(callee, source), 80 * 4), 80);
        return (
            format!("<callback:{callee}[{index}]>"),
            format!("{role}:{callee}:{index}"),
        );
    }

    // SyntaxKind names (including aliases such as TypeAssertionExpression)
    // come from TypeScript 5.9, even when today's checker is tsrs.
    let parent_kind = match parent.kind() {
        "return_statement" => "ReturnStatement",
        "throw_statement" => "ThrowStatement",
        "ternary_expression" => "ConditionalExpression",
        "array" => "ArrayLiteralExpression",
        "export_statement" => "ExportAssignment",
        "jsx_expression" => "JsxExpression",
        "jsx_attribute" => "JsxAttribute",
        "required_parameter" | "optional_parameter" => "Parameter",
        "assignment_pattern"
            if source
                .parent(parent)
                .is_some_and(|p| p.kind() == "formal_parameters") =>
        {
            "Parameter"
        }
        "assignment_pattern" | "object_assignment_pattern" => "BindingElement",
        "await_expression" => "AwaitExpression",
        "yield_expression" => "YieldExpression",
        "parenthesized_expression" => {
            let outer = source.parent(parent);
            if let Some(statement) = outer
                && field(statement, "condition") == Some(parent)
                && matches!(
                    statement.kind(),
                    "if_statement" | "while_statement" | "do_statement"
                )
            {
                match statement.kind() {
                    "if_statement" => "IfStatement",
                    "while_statement" => "WhileStatement",
                    _ => "DoStatement",
                }
            } else if outer.is_some_and(|p| {
                field(p, "value") == Some(parent) && p.kind() == "switch_statement"
            }) {
                "SwitchStatement"
            } else {
                "ParenthesizedExpression"
            }
        }
        "expression_statement" => "ExpressionStatement",
        "binary_expression"
        | "assignment_expression"
        | "augmented_assignment_expression"
        | "sequence_expression" => "BinaryExpression",
        "arrow_function" => "ArrowFunction",
        "member_expression" => "PropertyAccessExpression",
        "subscript_expression" => "ElementAccessExpression",
        "computed_property_name" => "ComputedPropertyName",
        "enum_assignment" => "EnumMember",
        "as_expression" => "AsExpression",
        "satisfies_expression" => "SatisfiesExpression",
        "type_assertion" => "TypeAssertionExpression",
        "non_null_expression" => "NonNullExpression",
        "instantiation_expression" => "ExpressionWithTypeArguments",
        "template_substitution" => "TemplateSpan",
        "spread_element" if source.parent(parent).is_some_and(|p| p.kind() == "object") => {
            "SpreadAssignment"
        }
        "spread_element" => "SpreadElement",
        "unary_expression" => match field(parent, "operator").map(|operator| operator.kind()) {
            Some("typeof") => "TypeOfExpression",
            Some("void") => "VoidExpression",
            Some("delete") => "DeleteExpression",
            _ => "PrefixUnaryExpression",
        },
        "for_statement" => "ForStatement",
        "for_in_statement" if token(parent, "of").is_some() => "ForOfStatement",
        "for_in_statement" => "ForInStatement",
        "switch_case" => "CaseClause",
        "with_statement" => "WithStatement",
        "extends_clause" => "ExpressionWithTypeArguments",
        _ => "expression",
    };
    anonymous_callback(parent_kind)
}

fn anonymous_callback(parent_kind: &str) -> (String, String) {
    (
        format!("<callback:{parent_kind}>"),
        format!("anonymous-callback:{parent_kind}"),
    )
}

fn callee_text<'a>(callee: Node, source: &Source<'a>) -> &'a str {
    // In an unparenthesized chain the grammar can attach the postfix `!`
    // to an entire unary/binary expression. It binds only to the operand
    // at the right of those operators in the compiler AST.
    let mut receiver = callee;
    let mut postfix = false;
    loop {
        let next = match receiver.kind() {
            "member_expression" | "subscript_expression" => field(receiver, "object"),
            "call_expression" => field(receiver, "function"),
            "non_null_expression" => {
                postfix = true;
                first_named(receiver)
            }
            _ => break,
        };
        let Some(next) = next else { break };
        receiver = next;
    }
    let mut start = source.start_of(callee);
    if postfix {
        while let Some(next) = match receiver.kind() {
            "binary_expression" => field(receiver, "right"),
            "unary_expression" => field(receiver, "argument"),
            _ => None,
        } {
            receiver = next;
            start = source.start_of(receiver);
        }
    }
    source.slice(Span {
        start,
        end: source.end_of(callee),
    })
}

/// Whitespace-normalized display text, cut on a UTF-8 boundary.
pub(super) fn normalize(text: &str, max_bytes: usize) -> String {
    let mut output = String::new();
    let mut space = false;
    for c in text.chars() {
        if is_js_whitespace(c) {
            space = !output.is_empty();
        } else {
            if output.len() + usize::from(space) + c.len_utf8() > max_bytes {
                break;
            }
            if space {
                output.push(' ');
                space = false;
            }
            output.push(c);
        }
    }
    output
}

pub(super) fn header(node: Node, form: Form, span: Span, source: &Source<'_>) -> String {
    let end =
        if is_function_like(node) || matches!(form, Form::Class | Form::Interface | Form::Enum) {
            field(node, "body")
        } else if matches!(form, Form::Variable | Form::Property) {
            initializer(node)
        } else {
            None
        };
    let end = end.map_or(span.end, |n| source.start_of(n));
    let text = source.slice(Span {
        start: span.start,
        end,
    });
    let text = js_trim(text);
    let text = text.strip_suffix(['=', '{', ':']).unwrap_or(text);
    normalize(text, bounds::MAX_SIGNATURE_BYTES)
}

pub(super) fn return_annotation<'a>(node: Node, source: &Source<'a>) -> Option<&'a str> {
    let annotation = field(node, "return_type")?;
    let type_node = if matches!(
        annotation.kind(),
        "type_annotation" | "type_predicate_annotation" | "asserts_annotation"
    ) {
        first_named(annotation)?
    } else {
        annotation
    };
    Some(source.slice(Span {
        start: source.start_of(type_node),
        end: source.significant_end(type_node),
    }))
}
