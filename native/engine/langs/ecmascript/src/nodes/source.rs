use std::borrow::Cow;
use std::collections::HashMap;

use mex_graph_core::facts::{Diagnostic, Health, ParseStatus, Range, bounds};
use tree_sitter::Node;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) struct Span {
    pub start: usize,
    pub end: usize,
}

use super::grammar::Offsets;

#[derive(Default)]
struct DocSlots {
    leading: Option<Span>,
    trailing_or_leading: Option<Span>,
}

/// Source offsets for the compiler AST and JSDoc attachment. The compiler
/// recognizes CR, LF, LS and PS as line endings, but its fingerprint stage
/// reconstructs byte ranges from UTF-16 offsets using LF-only line starts.
pub(super) struct Source<'a> {
    pub text: &'a str,
    pub start: usize,
    pub lines: Vec<&'a str>,
    starts: Vec<usize>,
    lf_starts: Vec<usize>,
    // Cumulative difference between UTF-8 bytes and UTF-16 units.
    multibyte: Vec<(usize, usize, usize)>,
    docs: HashMap<usize, DocSlots>,
    trivia_ends: HashMap<usize, usize>,
    parents: HashMap<usize, Node<'a>>,
    errors: Vec<Span>,
    health: Health,
    offsets: Offsets,
}

impl<'a> Source<'a> {
    pub fn new(text: &'a str, root: Node<'a>, offsets: Offsets) -> Self {
        let mut source = Self {
            text,
            start: text.len(),
            lines: text.split('\n').collect(),
            starts: vec![0],
            lf_starts: vec![0],
            multibyte: Vec::new(),
            docs: HashMap::new(),
            trivia_ends: HashMap::new(),
            parents: HashMap::new(),
            errors: Vec::new(),
            health: Health::default(),
            offsets,
        };
        let mut extra_bytes = 0;
        for (byte, c) in text.char_indices() {
            let end = byte + c.len_utf8();
            if !c.is_ascii() {
                extra_bytes += c.len_utf8() - c.len_utf16();
                source.multibyte.push((end, end - extra_bytes, extra_bytes));
            }
            if c == '\n' {
                source.lf_starts.push(end - extra_bytes);
            }
            if c == '\n'
                || matches!(c, '\u{2028}' | '\u{2029}')
                || c == '\r' && text.as_bytes().get(end) != Some(&b'\n')
            {
                source.starts.push(end);
            }
        }
        source.read_tokens(root);
        let covered: usize = source.errors.iter().map(|span| span.end - span.start).sum();
        source.health.error_coverage = covered as f32 / text.len().max(1) as f32;
        source.health.status = if root.is_error() || source.health.error_coverage > 0.25 {
            ParseStatus::Failed
        } else if root.has_error() {
            ParseStatus::Partial
        } else {
            ParseStatus::Ok
        };
        source
    }

    fn read_tokens(&mut self, root: Node<'a>) {
        let mut cursor = root.walk();
        let mut ancestry = Vec::new();
        let mut docs = DocSlots::default();
        let mut prior_end = 0;
        let mut prior_token_end = 0;
        let mut leading = true;
        loop {
            let node = cursor.node();
            if node.is_named()
                && let Some(&parent) = ancestry.last()
            {
                self.parents.insert(node.id(), parent);
            }
            if node.is_error() || node.is_missing() {
                self.record_error(node);
            }
            if node.kind() == "comment" {
                leading |= self.text[prior_end..self.start_of(node)].contains(['\n', '\r']);
                let text = self.of(node);
                if text.starts_with("/**") && !text.starts_with("/**/") {
                    let span = self.span(node);
                    docs.trailing_or_leading = Some(span);
                    if leading {
                        docs.leading = Some(span);
                    }
                }
                prior_end = self.end_of(node);
                self.trivia_ends.insert(prior_end, prior_token_end);
            } else if cursor.goto_first_child() {
                ancestry.push(node);
                continue;
            } else if !node.is_missing() && self.start_of(node) < self.end_of(node) {
                if !matches!(node.kind(), "hash_bang_line" | "html_comment") {
                    self.start = self.start.min(self.start_of(node));
                    if docs.trailing_or_leading.is_some() {
                        self.docs.insert(self.start_of(node), docs);
                        docs = DocSlots::default();
                    }
                    leading = false;
                }
                prior_end = self.end_of(node);
                prior_token_end = prior_end;
            }
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return;
                }
                ancestry.pop();
            }
        }
    }

    fn record_error(&mut self, node: Node) {
        let mut span = self.span(node);
        if node.is_missing() {
            self.health.missing_count += 1;
            span.end = (span.start + 1).min(self.text.len());
        } else {
            self.health.error_count += 1;
        }
        if self.health.diagnostics.len() < bounds::MAX_DIAGNOSTICS {
            let range = self.range(self.span(node));
            self.health.diagnostics.push(Diagnostic {
                code: if node.is_missing() {
                    format!("missing:{}", node.kind())
                } else {
                    "ERROR".into()
                },
                range,
            });
        }
        if let Some(last) = self.errors.last_mut()
            && last.end >= span.start
        {
            last.end = last.end.max(span.end);
        } else {
            self.errors.push(span);
        }
    }

    pub fn health(&self) -> Health {
        self.health.clone()
    }

    pub fn has_error(&self, span: Span) -> bool {
        let i = self.errors.partition_point(|error| error.end <= span.start);
        self.errors
            .get(i)
            .is_some_and(|error| error.start < span.end)
    }

    pub fn start_of(&self, node: Node) -> usize {
        self.offsets.original(node.start_byte())
    }

    /// Lookup through the cursor's ancestry captured in the source pass.
    /// Tree-sitter's Node::parent walks down from the root on every call.
    pub fn parent(&self, node: Node) -> Option<Node<'a>> {
        self.parents.get(&node.id()).copied()
    }

    pub fn end_of(&self, node: Node) -> usize {
        self.offsets.original(node.end_byte())
    }

    /// Automatic semicolon insertion can leave trailing trivia inside a
    /// grammar node. Compiler declarations end at the last token.
    pub fn significant_end(&self, node: Node) -> usize {
        let end = self.end_of(node);
        self.trivia_ends.get(&end).copied().unwrap_or(end)
    }

    pub fn span(&self, node: Node) -> Span {
        Span {
            start: self.start_of(node),
            end: self.end_of(node),
        }
    }

    pub fn of(&self, node: Node) -> &'a str {
        self.slice(self.span(node))
    }

    pub fn slice(&self, span: Span) -> &'a str {
        &self.text[span.start..span.end]
    }

    pub fn docs_at(&self, byte: usize, allow_trailing: bool) -> Option<(Span, &'a str)> {
        let slots = self.docs.get(&byte)?;
        let span = if allow_trailing {
            slots.trailing_or_leading
        } else {
            slots.leading
        }?;
        Some((span, self.slice(span)))
    }

    fn utf16(&self, byte: usize) -> usize {
        let i = self.multibyte.partition_point(|&(end, ..)| end <= byte);
        byte - i.checked_sub(1).map_or(0, |i| self.multibyte[i].2)
    }

    fn point(&self, byte: usize) -> (u32, u32) {
        let line = self.starts.partition_point(|&start| start <= byte) - 1;
        (
            line as u32,
            (self.utf16(byte) - self.utf16(self.starts[line])) as u32,
        )
    }

    pub fn range(&self, span: Span) -> Range {
        let (start_line, start_col) = self.point(span.start);
        let (end_line, end_col) = self.point(span.end);
        Range {
            start_byte: span.start as u32,
            end_byte: span.end as u32,
            start_line,
            end_line,
            start_col,
            end_col,
        }
    }

    pub fn fingerprint_text(&self, span: Span) -> Cow<'a, str> {
        if self.starts.len() == self.lf_starts.len() {
            return Cow::Borrowed(self.slice(span));
        }
        let range = self.range(span);
        let len = self.utf16(self.text.len());
        let offset = |line: u32, col: u32| {
            self.lf_starts
                .get(line as usize)
                .map_or(len, |start| (start + col as usize).min(len))
        };
        let start = offset(range.start_line, range.start_col);
        let end = offset(range.end_line, range.end_col).max(start);
        let byte_offset = |units| {
            let i = self.multibyte.partition_point(|&(_, end, _)| end <= units);
            units + i.checked_sub(1).map_or(0, |i| self.multibyte[i].2)
        };
        if let Some(text) = self.text.get(byte_offset(start)..byte_offset(end)) {
            return Cow::Borrowed(text);
        }
        let units: Vec<u16> = self
            .text
            .encode_utf16()
            .skip(start)
            .take(end - start)
            .collect();
        Cow::Owned(String::from_utf16_lossy(&units))
    }
}
