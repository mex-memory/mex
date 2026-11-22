use std::collections::HashSet;

use mex_graph_core::facts::bounds;
use mex_graph_core::id::is_js_whitespace;
use mex_graph_core::text::js_trim;
use tree_sitter::Node;

use super::binder::Symbol;
use super::declarations::Declaration;
use super::source::{Source, Span};
use super::syntax::{Form, initializer, is_function_value, outer, variable_statement};

pub(super) fn documentation<'tree>(
    source: &Source<'_>,
    declarations: &[Declaration<'tree>],
    symbol: Option<&Symbol>,
    representative: &Declaration<'tree>,
) -> Option<String> {
    if symbol.is_some_and(|symbol| symbol.require_alias) {
        // The checker documents the required module or member, whose local
        // alias does not own that documentation.
        return None;
    }
    let mut parts = Vec::new();
    if let Some(symbol) = symbol {
        for &i in &symbol.declarations {
            comments(source, &declarations[i], &mut parts);
        }
    } else {
        comments(source, representative, &mut parts);
    }
    let mut output = String::new();
    let mut seen_spans = HashSet::new();
    let mut seen_prose = HashSet::new();
    for (span, raw) in parts {
        if !seen_spans.insert(span) {
            continue;
        }
        if let Some(prose) = prose(raw, source.range(span).start_col as usize) {
            if seen_prose.contains(&prose) {
                continue;
            }
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(&prose);
            if output.len() >= bounds::MAX_DOCSTRING_BYTES {
                output.truncate(output.floor_char_boundary(bounds::MAX_DOCSTRING_BYTES));
                break;
            }
            seen_prose.insert(prose);
        }
    }
    (!output.is_empty()).then_some(output)
}

fn comments<'src>(
    source: &Source<'src>,
    declaration: &Declaration<'_>,
    parts: &mut Vec<(Span, &'src str)>,
) {
    let node = declaration.node;
    if matches!(declaration.form, Form::Variable | Form::Property)
        && let Some(value) = initializer(node)
            .filter(|n| is_function_value(*n) || n.kind() == "parenthesized_expression")
    {
        parts.extend(source.docs_at(source.start_of(value), true));
    }
    if declaration.form == Form::Assignment {
        if let Some(value) = initializer(node).or_else(|| node.child_by_field_name("right")) {
            parts.extend(source.docs_at(source.start_of(value), true));
        }
        return;
    }
    parts.extend(source.docs_at(
        declaration.span.start,
        matches!(declaration.form, Form::Variable | Form::Callback),
    ));

    if declaration.form == Form::Variable
        && let Some(list) = source.parent(node)
        && single_variable(list)
        && let Some(statement) = variable_statement(node, source)
    {
        parts.extend(source.docs_at(source.start_of(statement), false));
    }
    if declaration.form == Form::Callback
        && let Some(parent) = source.parent(node).filter(|p| {
            matches!(
                p.kind(),
                "return_statement"
                    | "export_statement"
                    | "pair"
                    | "public_field_definition"
                    | "field_definition"
            )
        })
    {
        parts.extend(source.docs_at(source.start_of(outer(parent, source)), false));
    }
}

fn single_variable(list: Node) -> bool {
    let mut cursor = list.walk();
    list.named_children(&mut cursor)
        .filter(|n| n.kind() == "variable_declarator")
        .take(2)
        .count()
        == 1
}

/// Render the JSDoc prose the compiler stores in the graph. The margin is
/// set by the first line with content. Blank lines marked with a star are
/// preserved, including on either end of the prose.
fn prose(raw: &str, start_col: usize) -> Option<String> {
    let raw = raw
        .strip_prefix("/**")?
        .strip_suffix("*/")?
        .replace("\r\n", "\n");
    let mut margin = None;
    let mut lines = raw.split('\n').peekable();
    let mut output = Vec::new();
    let mut markup = Markup::default();
    let mut index = 0;
    while let Some(line) = lines.next() {
        let first = index == 0;
        index += 1;
        let content = line.trim_start_matches(is_js_whitespace);
        if (content.is_empty() && first)
            || (lines.peek().is_none() && matches!(js_trim(content), "" | "*"))
        {
            continue;
        }
        let indent = if first {
            start_col + 4
        } else {
            line[..line.len() - content.len()].encode_utf16().count()
        };
        let (content, indent) = if first {
            (content, indent)
        } else {
            content
                .strip_prefix('*')
                .map_or((content, indent), |s| (s, indent + 1))
        };
        let tail = content.trim_start_matches(is_js_whitespace);
        let white = &content[..content.len() - tail.len()];
        let start = indent + white.encode_utf16().count();
        if !tail.is_empty() {
            margin.get_or_insert(start);
        }
        let drop = margin.unwrap_or(start).saturating_sub(indent);
        let trim_bytes = white
            .char_indices()
            .nth(drop)
            .map_or(white.len(), |(at, _)| at);
        let (rendered, tags) = markup.line(&content[trim_bytes..]);
        output.push(rendered);
        if let Some(tags) = tags {
            let tags = tags
                .split_whitespace()
                .filter(|token| token.starts_with('@'));
            let later = lines
                .flat_map(str::split_whitespace)
                .filter(|token| token.starts_with('@'));
            let mut type_definition = false;
            let mut function_documentation = false;
            for tag in tags.chain(later) {
                type_definition |= matches!(tag, "@typedef" | "@callback");
                function_documentation |= matches!(tag, "@param" | "@return" | "@returns");
            }
            if type_definition && !function_documentation {
                return None;
            }
            while output.last().is_some_and(|line| js_trim(line).is_empty()) {
                output.pop();
            }
            break;
        }
    }
    // A blank starred line indicates a paragraph break, even at the end.
    if let Some(last) = output.last_mut() {
        last.truncate(last.trim_end_matches(is_js_whitespace).len());
    }
    let text = output.join("\n");
    (!js_trim(&text).is_empty()).then_some(text)
}

#[derive(Default)]
struct Markup {
    backticks: usize,
}

impl Markup {
    fn line<'a>(&mut self, line: &'a str) -> (String, Option<&'a str>) {
        if self.backticks < 3 {
            self.backticks = 0;
        }
        let mut output = String::new();
        let mut chars = line.char_indices().peekable();
        let mut previous_space = true;
        while let Some((offset, c)) = chars.next() {
            if c == '`' {
                let mut count = 1;
                while chars.next_if(|&(_, next)| next == '`').is_some() {
                    count += 1;
                }
                if self.backticks == 0 {
                    self.backticks = count;
                } else if self.backticks == count {
                    self.backticks = 0;
                }
                output.extend(std::iter::repeat_n('`', count));
            } else if self.backticks == 0
                && c == '{'
                && let Some((length, target)) = link(&line[offset..])
            {
                for _ in chars
                    .by_ref()
                    .take_while(|&(at, _)| at < offset + length - 1)
                {}
                output.push_str(&target);
            } else if self.backticks == 0
                && c == '@'
                && previous_space
                && chars
                    .peek()
                    .is_some_and(|&(_, next)| !is_js_whitespace(next))
            {
                output.truncate(output.trim_end_matches(is_js_whitespace).len());
                return (output, Some(&line[offset..]));
            } else {
                output.push(c);
            }
            previous_space = is_js_whitespace(c);
        }
        (output, None)
    }
}

fn link(text: &str) -> Option<(usize, String)> {
    let tail = text.strip_prefix("{@link")?;
    let tail = tail
        .strip_prefix("code")
        .or_else(|| tail.strip_prefix("plain"))
        .unwrap_or(tail);
    if !tail.starts_with(is_js_whitespace) {
        return None;
    }
    let (target, _) = tail.split_once('}')?;
    let consumed = text.len() - tail.len() + target.len() + 1;
    let target = js_trim(target);
    let split = target
        .find(|c| c == '|' || is_js_whitespace(c))
        .unwrap_or(target.len());
    let name = &target[..split];
    let label = js_trim(js_trim(&target[split..]).trim_start_matches('|'));
    let rendered = if name.contains("://") {
        if label.is_empty() {
            name.to_owned()
        } else {
            format!("{label} ({name})")
        }
    } else if label.is_empty() {
        name.replace('#', ".")
    } else {
        label.to_owned()
    };
    Some((consumed, rendered))
}

/// Object-shaped JSDoc parameters have source-backed property signatures in
/// the compiler AST. Dotted parameters become properties of the nearest
/// earlier object tag, using the tag range as their declaration span.
pub(super) struct ParameterProperty<'src> {
    pub name: &'src str,
    pub annotation: &'src str,
    pub docstring: Option<String>,
    pub span: Span,
    pub owner: Option<usize>,
}

pub(super) fn parameter_properties<'src>(
    source: &Source<'src>,
    declaration: &Declaration<'_>,
) -> Vec<ParameterProperty<'src>> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for (span, raw) in function_comments(source, declaration) {
        if seen.insert(span) && (raw.contains("@param") || raw.contains("@arg")) {
            read_parameter_properties(span.start, raw, &mut output);
        }
    }
    for i in (0..output.len()).rev() {
        if let Some(owner) = output[i].owner {
            output[owner].span.end = output[owner].span.end.max(output[i].span.end);
        }
    }
    output
}

pub(super) fn annotated_return<'src>(
    source: &Source<'src>,
    declaration: &Declaration<'_>,
) -> Option<&'src str> {
    function_comments(source, declaration)
        .into_iter()
        .filter(|(_, raw)| raw.contains("@return"))
        .flat_map(|(_, raw)| tags(raw))
        .filter(|(_, name, _)| matches!(*name, "return" | "returns"))
        .find_map(|(_, _, body)| tag_annotation(body).map(|(annotation, _)| annotation))
}

fn function_comments<'src>(
    source: &Source<'src>,
    declaration: &Declaration<'_>,
) -> Vec<(Span, &'src str)> {
    let mut result = Vec::new();
    comments(source, declaration, &mut result);
    if declaration.form == Form::Assignment {
        let mut assignment = declaration.node;
        while let Some(parent) = source
            .parent(assignment)
            .filter(|p| p.kind() == "assignment_expression")
        {
            assignment = parent;
        }
        if let Some(statement) = source
            .parent(assignment)
            .filter(|p| p.kind() == "expression_statement")
        {
            result.extend(source.docs_at(source.start_of(statement), false));
        }
    }
    result
}

fn tags(raw: &str) -> impl Iterator<Item = (usize, &str, &str)> {
    let contents = raw
        .strip_prefix("/**")
        .and_then(|s| s.strip_suffix("*/"))
        .unwrap_or("");
    let mut cursor = 3;
    contents.split_inclusive('\n').filter_map(move |line| {
        let start = cursor;
        cursor += line.len();
        let content = js_trim(line);
        let content = content.strip_prefix('*').map_or(content, js_trim);
        let label = content.strip_prefix('@')?.split_whitespace().next()?;
        let offset = start + line.find(content)?;
        Some((offset, label, js_trim(&content[label.len() + 1..])))
    })
}

fn tag_annotation(body: &str) -> Option<(&str, &str)> {
    let body = body.strip_prefix('{')?;
    let mut depth = 0;
    for (offset, c) in body.char_indices() {
        match c {
            '{' => depth += 1,
            '}' if depth == 0 => {
                return Some((js_trim(&body[..offset]), js_trim(&body[offset + 1..])));
            }
            '}' => depth -= 1,
            _ => {}
        }
    }
    None
}

fn read_parameter_properties<'src>(
    base: usize,
    raw: &'src str,
    properties: &mut Vec<ParameterProperty<'src>>,
) {
    use std::collections::HashMap;
    let tags: Vec<_> = tags(raw).collect();
    let mut objects = HashMap::new();
    for (i, &(start, label, body)) in tags.iter().enumerate() {
        if !matches!(label, "param" | "arg" | "argument") {
            continue;
        }
        let Some((annotation, tail)) = tag_annotation(body) else {
            continue;
        };
        let (name, description) = if let Some(optional) = tail.strip_prefix('[') {
            let Some((value, description)) = optional.split_once(']') else {
                continue;
            };
            (
                value.split_once('=').map_or(value, |(name, _)| name),
                description,
            )
        } else {
            let end = tail.find(is_js_whitespace).unwrap_or(tail.len());
            (&tail[..end], &tail[end..])
        };
        let is_object = matches!(annotation, "object" | "Object");
        if let Some((object, property)) = name.rsplit_once('.') {
            let Some(&owner) = objects.get(object) else {
                continue;
            };
            if is_object {
                objects.insert(name, Some(properties.len()));
            }
            let end = tags
                .get(i + 1)
                .map_or(raw.len() - 2, |&(offset, ..)| offset);
            let description = js_trim(description);
            let mut docstring =
                (!description.is_empty()).then(|| Markup::default().line(description).0);
            if let Some(docstring) = &mut docstring {
                docstring.truncate(docstring.floor_char_boundary(bounds::MAX_DOCSTRING_BYTES));
            }
            properties.push(ParameterProperty {
                name: property,
                annotation,
                docstring,
                span: Span {
                    start: base + start,
                    end: base + end,
                },
                owner,
            });
        } else if is_object {
            objects.insert(name, None);
        }
    }
}
