//! Compatibility for TypeScript syntax the pinned grammar misparses.
//! Every edit is private to parsing. Spans, names and evidence always use the
//! original text, including variance modifiers and automatic semicolons.
use tree_sitter::{Node, Parser, Tree};

use super::syntax::{field, first_named, token};

#[derive(Default)]
pub(super) struct Offsets {
    insertions: Vec<Insertion>,
}

struct Insertion {
    original: usize,
    projected_end: usize,
    added: usize,
}

impl Offsets {
    pub fn original(&self, byte: usize) -> usize {
        let i = self
            .insertions
            .partition_point(|insert| insert.projected_end <= byte);
        let added = i.checked_sub(1).map_or(0, |i| self.insertions[i].added);
        let original = byte - added;
        self.insertions
            .get(i)
            .map_or(original, |next| original.min(next.original))
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Edit {
    start: usize,
    end: usize,
    text: &'static str,
}

impl Edit {
    fn insert(at: usize, text: &'static str) -> Self {
        Self {
            start: at,
            end: at,
            text,
        }
    }

    fn mask(node: Node, text: &'static str) -> Self {
        Self {
            start: node.start_byte(),
            end: node.end_byte(),
            text,
        }
    }
}

pub(super) fn parse(
    parser: &mut Parser,
    source: &str,
    typescript: bool,
) -> Option<(Tree, Offsets)> {
    let original = parser.parse(source, None)?;
    if typescript {
        let mut edits = edits(original.root_node(), source);
        if !edits.is_empty() {
            let (projected, offsets) = project(source, &mut edits);
            if let Some(tree) = parser.parse(&projected, None)
                && (!tree.root_node().has_error()
                    || error_extent(tree.root_node()) < error_extent(original.root_node()))
            {
                return Some((tree, offsets));
            }
        }
    }
    Some((original, Offsets::default()))
}

fn project(source: &str, edits: &mut Vec<Edit>) -> (String, Offsets) {
    edits.sort_unstable();
    edits.dedup();
    let mut output = String::with_capacity(source.len());
    let mut offsets = Offsets::default();
    let mut prior_end = 0;
    for edit in edits {
        if edit.start < prior_end {
            continue;
        }
        output.push_str(&source[prior_end..edit.start]);
        output.push_str(edit.text);
        prior_end = edit.end;
        if edit.start == edit.end {
            offsets.insertions.push(Insertion {
                original: edit.start,
                projected_end: output.len(),
                added: output.len() - edit.start,
            });
        }
    }
    output.push_str(&source[prior_end..]);
    (output, offsets)
}

fn error_extent(root: Node) -> usize {
    let mut total = 0;
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.is_error() || node.is_missing() {
            total += node.byte_range().len().max(1);
        } else if node.has_error() {
            let mut cursor = node.walk();
            stack.extend(
                node.children(&mut cursor)
                    .filter(|child| child.has_error() || child.is_missing()),
            );
        }
    }
    total
}

fn edits(root: Node, source: &str) -> Vec<Edit> {
    let mut edits = Vec::new();
    let mut cursor = root.walk();
    let mut overloaded = Overloads::default();
    let has_errors = root.has_error();
    loop {
        let node = cursor.node();
        if node.kind() == "type_assertion"
            && let Some(arguments) = arrow_type_arguments(node)
        {
            edits.push(Edit::insert(arguments.end_byte() - 1, ","));
        }
        if has_errors {
            match node.kind() {
                "ERROR" => {
                    if let Some(edit) = compatibility_edit(node, source) {
                        edits.push(edit);
                    }
                }
                "decorator" if node.has_error() => {
                    let expression = source[node.start_byte() + 1..node.end_byte()].trim_start();
                    if expression.starts_with('(') {
                        // Model `@(expression)` as a decorator call to give the
                        // grammar a legal callee. It has zero original width.
                        let at = node.end_byte() - expression.len();
                        edits.push(Edit::insert(at, "d"));
                    }
                }
                _ => {}
            }
        }
        if cursor.goto_first_child() {
            continue;
        }
        if has_errors
            && !node.is_extra()
            && !node.is_missing()
            && node.start_byte() < node.end_byte()
        {
            overloaded.token(node, source, &mut edits);
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return edits;
            }
        }
    }
}

fn arrow_type_arguments(node: Node<'_>) -> Option<Node<'_>> {
    let arguments = token(node, "type_arguments")?;
    let arrow = arguments
        .next_named_sibling()
        .filter(|n| n.kind() == "arrow_function")?;
    let mut cursor = arguments.walk();
    (token(arrow, "async").is_none()
        && arguments
            .named_children(&mut cursor)
            .filter(|n| !n.is_extra())
            .all(|n| n.kind() == "type_identifier")
        && token(arguments, ">")
            .and_then(|close| close.prev_sibling())
            .is_some_and(|n| n.kind() != ","))
    .then_some(arguments)
}

fn compatibility_edit(node: Node, source: &str) -> Option<Edit> {
    let parent = node.parent()?;
    if parent.kind() == "export_statement"
        && &source[node.byte_range()] == "type"
        && token(parent, "*").is_some()
    {
        return Some(Edit::mask(node, "    "));
    }

    // The old grammar either reports the variance keyword as an error or
    // mistakes it for the parameter name and reports the real name.
    let modifier = match parent.kind() {
        "type_parameters" if first_named(node).is_some_and(|n| n.kind() == "identifier") => node
            .prev_named_sibling()
            .filter(|prior| prior.kind() == "type_parameter")
            .filter(|prior| {
                source[prior.end_byte()..node.start_byte()]
                    .trim()
                    .is_empty()
            })
            .and_then(|prior| field(prior, "name"))
            .filter(|name| matches!(&source[name.byte_range()], "in" | "out"))
            .unwrap_or(node),
        "type_parameters" => node,
        "type_parameter" if first_named(node).is_some_and(|n| n.kind() == "identifier") => {
            field(parent, "name")?
        }
        _ => return None,
    };
    match &source[modifier.byte_range()] {
        "in" => Some(Edit::mask(modifier, "  ")),
        "out" => Some(Edit::mask(modifier, "   ")),
        "in out" => Some(Edit::mask(modifier, "      ")),
        _ => None,
    }
}

#[derive(Default)]
struct Overloads {
    prior_end: usize,
    prior_can_end_type: bool,
    brackets: Vec<Option<usize>>,
    after_parameters: Option<usize>,
}

impl Overloads {
    fn token(&mut self, node: Node, source: &str, edits: &mut Vec<Edit>) {
        let text = &source[node.byte_range()];
        if let Some(at) = self.after_parameters.take()
            && text == "("
        {
            edits.push(Edit::insert(at, ";"));
        }
        if text == "<" {
            let gap = &source[self.prior_end..node.start_byte()];
            let starts_line = gap
                .rsplit_once('\n')
                .is_some_and(|(_, indentation)| indentation.trim().is_empty());
            let candidate = self.prior_can_end_type && starts_line && in_type_recovery(node);
            self.brackets.push(candidate.then_some(self.prior_end));
        } else if text.bytes().all(|c| c == b'>') {
            for _ in text.bytes() {
                self.after_parameters = self.brackets.pop().flatten();
            }
        }
        self.prior_end = node.end_byte();
        self.prior_can_end_type = matches!(
            text.as_bytes().last(),
            Some(b'>' | b')' | b']' | b'}' | b'\'' | b'"')
        ) || matches!(
            node.kind(),
            "identifier" | "type_identifier" | "property_identifier" | "number"
        ) || matches!(
            text,
            "void"
                | "unknown"
                | "any"
                | "never"
                | "string"
                | "number"
                | "boolean"
                | "null"
                | "undefined"
        );
        // A type ending in the opening brace is the first member. A closing
        // brace on a preceding line may belong to another declaration.
        if text == "}"
            && node.parent().is_some_and(|p| {
                first_named(p).is_some_and(|first| first.start_byte() < node.start_byte())
                    && !matches!(p.kind(), "object_type" | "mapped_type_clause")
            })
        {
            self.prior_can_end_type = false;
        }
    }
}

fn in_type_recovery(mut node: Node) -> bool {
    while let Some(parent) = node.parent() {
        match parent.kind() {
            "interface_body" | "object_type" | "ERROR" => return true,
            "program" | "class_body" | "statement_block" => return false,
            _ => node = parent,
        }
    }
    false
}
