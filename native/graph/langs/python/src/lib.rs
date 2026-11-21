//! The Python adapter: one file's source in, its facts out.
//!
//! Two passes over one syntax tree:
//!
//! 1. **Definitions**, rule for rule as today's `PythonWalker`
//!    (`src/graph/extraction/languages/python.ts`) and `extractFile`
//!    (`src/graph/extraction/index.ts`): the same declarations, qualified
//!    names, identity roles, signatures, spans, docstrings and parse-health
//!    exclusions, so every node id, span, body hash and fingerprint equals
//!    today's. Today's quirks are kept on purpose and named where they occur.
//! 2. **Everything the resolver needs**, which today's walker never recorded:
//!    every call in the file (module level and decorators too) with a typed
//!    receiver, every import at every level (imports inside functions were
//!    ignored before), parameters, assignments, and `self.x = ...` fields.
//!
//! The grammar is `tree-sitter-python` 0.21.0, the version today's WASM build
//! comes from, so syntax trees and fingerprint tokens are the same.

use std::collections::HashMap;

use mex_graph_core::facts::{
    Binding, Call, CallForm, Def, Diagnostic, FACTS_VERSION, FileFacts, Health, Heritage, Import,
    ImportBinding, ImportForm, Kind, NONE, ParseStatus, Range, Receiver, Scope, ScopeKind,
    SketchFacts, TypeBasis, bounds,
};
use mex_graph_core::fingerprint::{SketchBuilder, body_hash};
use mex_graph_core::id::signature_identity;
use mex_graph_core::text::{js_slice, js_trim, utf16_column};
use tree_sitter::{Node, Parser, Tree};

pub mod resolve;

/// Bumped whenever this adapter's output changes; part of the facts cache key.
pub const ADAPTER_VERSION: u32 = 1;
pub const LANGUAGE: &str = "python";

/// Kinds that carry a body hash and a fingerprint (`BODY_KINDS` today).
fn has_body(kind: Kind) -> bool {
    matches!(
        kind,
        Kind::Function
            | Kind::Method
            | Kind::Class
            | Kind::Interface
            | Kind::Enum
            | Kind::TypeAlias
            | Kind::Struct
            | Kind::Trait
            | Kind::Protocol
            | Kind::Constant
            | Kind::Variable
            | Kind::Component
    )
}

/// A reusable extractor: one per thread, since parsers aren't shared.
pub struct Python {
    parser: Parser,
    sketches: SketchBuilder,
}

impl Default for Python {
    fn default() -> Self {
        Self::new()
    }
}

impl Python {
    pub fn new() -> Python {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::language())
            .expect("the pinned Python grammar loads");
        Python {
            parser,
            sketches: SketchBuilder::default(),
        }
    }

    /// Extract one file. `raw` is the file's text as read; CRLF is normalized
    /// before parsing, as today's `extractFile` does.
    pub fn extract(&mut self, path: &str, raw: &str, content_hash: [u8; 32]) -> FileFacts {
        let source = raw.replace("\r\n", "\n");
        let mut facts = FileFacts {
            facts_version: FACTS_VERSION,
            path: path.to_owned(),
            language: LANGUAGE.to_owned(),
            content_hash,
            ..FileFacts::default()
        };
        let Some(tree) = self.parser.parse(&source, None) else {
            facts.health.status = ParseStatus::Failed;
            return facts;
        };
        let text = Text::new(&source);
        let (health, issue_lines) = tree_health(&tree, &text);
        facts.health = health;
        if facts.health.status == ParseStatus::Failed {
            return facts;
        }

        let mut walker = Walker {
            path,
            text: &text,
            defs: Vec::new(),
            stack: Vec::new(),
            occurrences: HashMap::new(),
            def_nodes: HashMap::new(),
        };
        walker.run(tree.root_node());
        let mut defs = walker.defs;
        let def_nodes = walker.def_nodes;

        if facts.health.status == ParseStatus::Partial && defs.iter().all(|d| d.kind == Kind::File)
        {
            facts.health.status = ParseStatus::Failed;
            return facts;
        }

        // Body hashes and sketches come from the original lines and this
        // tree's leaves, as `stageTreeFile` and `normalizedAstTokens` do.
        let raw_lines: Vec<&str> = raw.split('\n').collect();
        let leaves = leaf_types(&tree);
        for def in &mut defs {
            if !has_body(def.kind) {
                continue;
            }
            let (start, end) = (
                def.range.start_line as usize + 1,
                def.range.end_line as usize + 1,
            );
            def.body_hash = Some(body_hash(&raw_lines, start, end));
            let tokens: Vec<&str> = leaves
                .iter()
                .filter(|(s, e, _)| *s + 1 >= start && *e < end)
                .map(|(_, _, t)| *t)
                .collect();
            let sketch = self.sketches.sketch(&tokens);
            def.sketch = Some(SketchFacts {
                minhash: sketch.minhash.to_vec(),
                token_count: sketch.token_count as u32,
            });
        }

        // Today drops every declaration whose lines meet one of the first 100
        // parse issues; its children stay, without their parent. The engine
        // keeps the definition as a scope for resolution and flags it, so it
        // never becomes a node.
        for def in &mut defs {
            let excluded = def.kind != Kind::File
                && issue_lines
                    .iter()
                    .any(|(s, e)| *s <= def.range.end_line + 1 && *e > def.range.start_line);
            if excluded {
                def.flags.push(EXCLUDED.into());
            }
        }

        let mut extra = Extras::new(&text, &defs, &def_nodes);
        extra.visit(tree.root_node());
        facts.calls = extra.calls;
        facts.imports = extra.imports;
        facts.bindings = extra.bindings;
        facts.scopes = defs
            .iter()
            .enumerate()
            .map(|(i, d)| Scope {
                kind: match d.kind {
                    Kind::File => ScopeKind::Module,
                    Kind::Class => ScopeKind::Class,
                    Kind::Function | Kind::Method => ScopeKind::Function,
                    _ => ScopeKind::Block,
                },
                parent: d.parent,
                def: i as i32,
                this_static: None,
            })
            .collect();
        facts.defs = defs;
        facts
    }
}

/// The flag on a definition that today's parse-health rule drops.
pub const EXCLUDED: &str = "excluded";

/// Lines of the normalized source, with UTF-16 conversions.
struct Text<'a> {
    source: &'a str,
    lines: Vec<&'a str>,
    /// UTF-16 offset at which each line starts.
    line_starts: Vec<u32>,
}

impl<'a> Text<'a> {
    fn new(source: &'a str) -> Text<'a> {
        let lines: Vec<&str> = source.split('\n').collect();
        let mut line_starts = Vec::with_capacity(lines.len());
        let mut offset = 0u32;
        for line in &lines {
            line_starts.push(offset);
            offset += line.encode_utf16().count() as u32 + 1;
        }
        Text {
            source,
            lines,
            line_starts,
        }
    }

    fn col(&self, row: usize, byte_col: usize) -> u32 {
        self.lines
            .get(row)
            .map_or(byte_col as u32, |l| utf16_column(l, byte_col))
    }

    /// The UTF-16 index of a point: web-tree-sitter's `startIndex`.
    fn index(&self, row: usize, byte_col: usize) -> u32 {
        self.line_starts.get(row).copied().unwrap_or(0) + self.col(row, byte_col)
    }

    fn of(&self, node: Node) -> &'a str {
        &self.source[node.byte_range()]
    }

    fn range(&self, node: Node) -> Range {
        let (s, e) = (node.start_position(), node.end_position());
        Range {
            start_byte: node.start_byte() as u32,
            end_byte: node.end_byte() as u32,
            start_line: s.row as u32,
            start_col: self.col(s.row, s.column),
            end_line: e.row as u32,
            end_col: self.col(e.row, e.column),
        }
    }
}

fn children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

/// `treeHealth` in `extraction/index.ts`, including its unit quirk: covered
/// length is in UTF-16 units, divided by the source's UTF-8 byte length.
/// Returns the health and the 1-based line spans of the first 100 issues.
fn tree_health(tree: &Tree, text: &Text) -> (Health, Vec<(u32, u32)>) {
    let mut errors = Vec::new();
    let mut missing = Vec::new();
    let mut stack = vec![tree.root_node()];
    // Pre-order, children left to right, like the recursive visit.
    while let Some(node) = stack.pop() {
        if node.kind() == "ERROR" || node.is_error() {
            errors.push(node);
        }
        if node.is_missing() {
            missing.push(node);
        }
        let mut kids = children(node);
        kids.reverse();
        stack.extend(kids);
    }
    let issues: Vec<Node> = errors.iter().chain(missing.iter()).copied().collect();
    let mut ranges: Vec<(u32, u32)> = issues
        .iter()
        .map(|n| {
            let (s, e) = (n.start_position(), n.end_position());
            let start = text.index(s.row, s.column);
            (start, text.index(e.row, e.column).max(start + 1))
        })
        .collect();
    ranges.sort();
    let mut merged: Vec<(u32, u32)> = Vec::new();
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(prior) if start <= prior.1 => prior.1 = prior.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    let covered: u32 = merged.iter().map(|(s, e)| e.saturating_sub(*s)).sum();
    let coverage = (covered as f64 / text.source.len().max(1) as f64).min(1.0);
    let root = tree.root_node();
    let failed = root.kind() == "ERROR" || root.is_error() || coverage > 0.25;
    let status = if failed {
        ParseStatus::Failed
    } else if !errors.is_empty() || !missing.is_empty() {
        ParseStatus::Partial
    } else {
        ParseStatus::Ok
    };
    let lines = issues
        .iter()
        .take(100)
        .map(|n| {
            (
                n.start_position().row as u32 + 1,
                n.end_position().row as u32 + 1,
            )
        })
        .collect();
    let health = Health {
        status,
        error_count: errors.len() as u32,
        missing_count: missing.len() as u32,
        error_coverage: coverage as f32,
        diagnostics: issues
            .iter()
            .take(bounds::MAX_DIAGNOSTICS)
            .map(|n| Diagnostic {
                code: if n.is_missing() {
                    format!("MISSING:{}", n.kind())
                } else {
                    n.kind().to_owned()
                },
                range: text.range(*n),
            })
            .collect(),
    };
    (health, lines)
}

/// Every leaf's (start row, end row, type), in document order: the tokens
/// `normalizedAstTokens` sketches. Extras such as comments are leaves too.
fn leaf_types(tree: &Tree) -> Vec<(usize, usize, &'static str)> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.child_count() == 0 {
            out.push((
                node.start_position().row,
                node.end_position().row,
                node.kind(),
            ));
            continue;
        }
        let mut kids = children(node);
        kids.reverse();
        stack.extend(kids);
    }
    out
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_exported(name: &str) -> bool {
    !name.starts_with('_') || (name.starts_with("__") && name.ends_with("__"))
}

/// The declarations pass: today's `PythonWalker`.
struct Walker<'a> {
    path: &'a str,
    text: &'a Text<'a>,
    defs: Vec<Def>,
    /// Indices into `defs`: today's `scopeStack` of node ids.
    stack: Vec<usize>,
    occurrences: HashMap<String, u32>,
    /// Syntax node id -> definition index, for the second pass.
    def_nodes: HashMap<usize, usize>,
}

impl<'a> Walker<'a> {
    fn run(&mut self, root: Node) {
        let mut file = empty_def(Range::default());
        file.kind = Kind::File;
        file.name = base_name(self.path).to_owned();
        file.qualified_name = self.path.to_owned();
        file.declaration_role = Some("source-file".into());
        file.range = Range {
            start_byte: 0,
            end_byte: root.end_byte() as u32,
            start_line: 0,
            start_col: 0,
            end_line: root.end_position().row as u32,
            end_col: 0,
        };
        self.defs.push(file);
        self.stack.push(0);
        for child in named_children(root) {
            self.visit(child);
        }
        self.stack.pop();
    }

    fn visit(&mut self, node: Node) {
        match node.kind() {
            "decorated_definition" => {
                if let Some(def) = named_children(node)
                    .into_iter()
                    .find(|c| matches!(c.kind(), "function_definition" | "class_definition"))
                {
                    self.visit(def);
                }
            }
            "function_definition" => self.function(node),
            "class_definition" => self.class(node),
            "assignment" if self.at_module_or_class() => self.variable(node),
            // Imports are facts, not nodes; the second pass records them.
            "import_statement" | "import_from_statement" => {}
            _ => {
                for child in named_children(node) {
                    self.visit(child);
                }
            }
        }
    }

    fn top(&self) -> Option<&Def> {
        self.stack.last().map(|&i| &self.defs[i])
    }

    fn at_module_or_class(&self) -> bool {
        self.top()
            .is_some_and(|d| matches!(d.kind, Kind::File | Kind::Class))
    }

    fn qualify(&self, name: &str) -> String {
        let mut parts: Vec<&str> = self
            .stack
            .iter()
            .map(|&i| &self.defs[i])
            .filter(|d| d.kind != Kind::File)
            .map(|d| d.name.as_str())
            .collect();
        parts.push(name);
        parts.join("::")
    }

    /// `createNode`: identity role, span, docstring, contains parent.
    fn create(&mut self, kind: Kind, name: &str, node: Node, mut def: Def) -> Option<usize> {
        if name.is_empty() {
            return None;
        }
        let qualified = self.qualify(name);
        let base = signature_identity(self.path, kind.as_str(), &qualified, None, &def.signature);
        let ordinal = *self.occurrences.get(&base).unwrap_or(&0);
        self.occurrences.insert(base, ordinal + 1);
        def.declaration_role =
            (ordinal > 0).then(|| format!("{}:ordinal:{ordinal}", kind.as_str()));
        def.kind = kind;
        def.name = name.to_owned();
        def.qualified_name = qualified;
        def.range = self.text.range(node);
        def.docstring = docstring(node, self.text);
        def.exported = is_exported(name);
        def.parent = self.stack.last().map_or(NONE, |&i| i as i32);
        def.scope = def.parent;
        self.defs.push(def);
        let index = self.defs.len() - 1;
        self.def_nodes.insert(node.id(), index);
        Some(index)
    }

    fn function(&mut self, node: Node) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text.of(name_node).to_owned();
        let is_method = self.top().is_some_and(|d| d.kind == Kind::Class);
        let params = node.child_by_field_name("parameters");
        let ret = node.child_by_field_name("return_type");
        let mut def = empty_def(self.text.range(name_node));
        def.signature = params
            .map(|p| {
                let mut sig = self.text.of(p).to_owned();
                if let Some(r) = ret {
                    sig.push_str(" -> ");
                    sig.push_str(self.text.of(r));
                }
                sig
            })
            .unwrap_or_default();
        def.return_type = ret.map(|r| self.text.of(r).to_owned());
        if children(node).iter().any(|c| c.kind() == "async") {
            def.flags.push("async".into());
        }
        let kind = if is_method {
            Kind::Method
        } else {
            Kind::Function
        };
        let Some(id) = self.create(kind, &name, node, def) else {
            return;
        };
        if let Some(body) = node.child_by_field_name("body") {
            self.walk_body(body, id);
        }
    }

    fn class(&mut self, node: Node) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let name = self.text.of(name_node).to_owned();
        let mut def = empty_def(self.text.range(name_node));
        if let Some(supers) = node.child_by_field_name("superclasses") {
            for base in named_children(supers) {
                // `metaclass=Meta` configures the class; it isn't a base.
                if base.kind() == "keyword_argument" {
                    continue;
                }
                def.heritage.push(Heritage {
                    implements: false,
                    name: self.text.of(base).to_owned(),
                    range: self.text.range(base),
                });
            }
        }
        let Some(id) = self.create(Kind::Class, &name, node, def) else {
            return;
        };
        if let Some(body) = node.child_by_field_name("body") {
            self.stack.push(id);
            for member in named_children(body) {
                self.visit(member);
            }
            self.stack.pop();
        }
    }

    fn variable(&mut self, node: Node) {
        let Some(left) = node
            .child_by_field_name("left")
            .or_else(|| node.named_child(0))
        else {
            return;
        };
        // Tuple and attribute targets are skipped, as today.
        if left.kind() != "identifier" {
            return;
        }
        let name = self.text.of(left).to_owned();
        let top_level = self.top().is_some_and(|d| d.kind == Kind::File);
        let constant = top_level
            && name
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        let right = node.child_by_field_name("right");
        let mut def = empty_def(self.text.range(left));
        // Today: the right-hand side's first 200 UTF-16 units, part of the id.
        def.signature = right
            .map(|r| js_slice(self.text.of(r), 200))
            .unwrap_or_default();
        let kind = if constant {
            Kind::Constant
        } else {
            Kind::Variable
        };
        let Some(id) = self.create(kind, &name, node, def) else {
            return;
        };
        if let Some(r) = right {
            self.walk_body(r, id);
        }
    }

    /// `walkBody`: inside a body only nested definitions become nodes.
    fn walk_body(&mut self, body: Node, owner: usize) {
        match body.kind() {
            "function_definition" | "decorated_definition" | "class_definition" => {
                self.stack.push(owner);
                self.visit(body);
                self.stack.pop();
            }
            _ => {
                for child in named_children(body) {
                    self.walk_body(child, owner);
                }
            }
        }
    }
}

fn empty_def(name_range: Range) -> Def {
    Def {
        kind: Kind::Variable,
        name: String::new(),
        qualified_name: String::new(),
        declaration_role: None,
        signature: String::new(),
        ordinal: None,
        parent: NONE,
        scope: NONE,
        range: Range::default(),
        name_range,
        exported: false,
        is_default_export: false,
        flags: Vec::new(),
        heritage: Vec::new(),
        return_type: None,
        body_hash: None,
        sketch: None,
        docstring: None,
    }
}

/// `getPythonDocstring`: a first-statement string, its `r`/`u` prefix and one
/// matched delimiter pair stripped, escapes left alone, trimmed.
fn docstring(node: Node, text: &Text) -> Option<String> {
    let body = node.child_by_field_name("body")?;
    if body.kind() != "block" {
        return None;
    }
    let first = body.named_child(0)?;
    if first.kind() != "expression_statement" {
        return None;
    }
    let expr = first.named_child(0)?;
    if expr.kind() != "string" {
        return None;
    }
    let raw = text.of(expr);
    // `^[rRuU]{1,2}(?=["'])`: strip the prefix only when a quote follows it.
    let prefix = raw
        .chars()
        .take(2)
        .take_while(|c| matches!(c, 'r' | 'R' | 'u' | 'U'))
        .count();
    let unprefixed = (1..=prefix)
        .rev()
        .find(|&n| raw[n..].starts_with(['"', '\'']))
        .map_or(raw, |n| &raw[n..]);
    for quote in ["\"\"\"", "'''", "\"", "'"] {
        if unprefixed.starts_with(quote) && unprefixed.ends_with(quote) {
            let inner = unprefixed
                .get(quote.len()..unprefixed.len().saturating_sub(quote.len()))
                .unwrap_or("");
            return Some(js_trim(inner).to_owned());
        }
    }
    None
}

fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    (0..=max)
        .rev()
        .find(|&i| s.is_char_boundary(i))
        .unwrap_or(0)
}

/// The second pass: calls, imports and bindings everywhere in the file.
struct Extras<'a> {
    text: &'a Text<'a>,
    defs: &'a [Def],
    def_nodes: &'a HashMap<usize, usize>,
    /// Enclosing definitions: the owner of a call is the innermost one.
    owners: Vec<usize>,
    /// Enclosing functions and classes: where names are looked up.
    scopes: Vec<usize>,
    /// For each method, the name its first parameter binds (`self`, `cls`).
    self_names: HashMap<usize, String>,
    calls: Vec<Call>,
    imports: Vec<Import>,
    bindings: Vec<Binding>,
}

impl<'a> Extras<'a> {
    fn new(text: &'a Text<'a>, defs: &'a [Def], def_nodes: &'a HashMap<usize, usize>) -> Self {
        Extras {
            text,
            defs,
            def_nodes,
            owners: vec![0],
            scopes: vec![0],
            self_names: HashMap::new(),
            calls: Vec::new(),
            imports: Vec::new(),
            bindings: Vec::new(),
        }
    }

    fn scope(&self) -> usize {
        *self.scopes.last().unwrap_or(&0)
    }

    fn visit(&mut self, node: Node) {
        let def = self.def_nodes.get(&node.id()).copied();
        let scope_def = def.filter(|&d| {
            matches!(
                self.defs[d].kind,
                Kind::Function | Kind::Method | Kind::Class
            )
        });
        if let Some(d) = def {
            self.owners.push(d);
        }
        match node.kind() {
            "call" => self.call(node),
            "import_statement" | "import_from_statement" => self.import(node),
            "assignment" => self.assignment(node),
            "for_statement" => {
                if let Some(left) = node.child_by_field_name("left") {
                    self.untyped_targets(left);
                }
            }
            _ => {}
        }
        if let Some(d) = scope_def {
            if let Some(params) = node.child_by_field_name("parameters") {
                self.parameters(params, d);
            }
            self.scopes.push(d);
        }
        for child in named_children(node) {
            self.visit(child);
        }
        if scope_def.is_some() {
            self.scopes.pop();
        }
        if def.is_some() {
            self.owners.pop();
        }
    }

    fn parameters(&mut self, params: Node, function: usize) {
        let is_method = self.defs[function].kind == Kind::Method;
        let mut first = true;
        for param in named_children(params) {
            let (name, annotation) = match param.kind() {
                "identifier" => (Some(param), None),
                "typed_parameter" => (
                    named_children(param)
                        .into_iter()
                        .find(|c| c.kind() == "identifier"),
                    param.child_by_field_name("type"),
                ),
                "default_parameter" | "typed_default_parameter" => (
                    param.child_by_field_name("name"),
                    param.child_by_field_name("type"),
                ),
                "list_splat_pattern" | "dictionary_splat_pattern" => (
                    named_children(param)
                        .into_iter()
                        .find(|c| c.kind() == "identifier"),
                    None,
                ),
                _ => (None, None),
            };
            let Some(name) = name else { continue };
            let name = self.text.of(name).to_owned();
            if first && is_method {
                self.self_names.insert(function, name.clone());
            }
            first = false;
            self.bindings.push(Binding {
                name,
                scope: function as i32,
                param: true,
                type_name: annotation.map(|a| self.text.of(a).to_owned()),
                type_basis: annotation.map(|_| TypeBasis::Annotation),
                field_of: None,
            });
        }
    }

    /// The class a method's `self` names, when the current scope is a method.
    fn self_class(&self, name: &str) -> Option<usize> {
        let scope = self.scope();
        (self.self_names.get(&scope)? == name).then(|| self.defs[scope].parent as usize)
    }

    fn assignment(&mut self, node: Node) {
        let Some(left) = node.child_by_field_name("left") else {
            return;
        };
        let annotation = node.child_by_field_name("type");
        let right = node.child_by_field_name("right");
        let (type_name, basis) = match (annotation, right) {
            (Some(a), _) => (
                Some(self.text.of(a).to_owned()),
                Some(TypeBasis::Annotation),
            ),
            (None, Some(r)) if r.kind() == "call" => (
                r.child_by_field_name("function")
                    .map(|f| self.text.of(f).to_owned()),
                Some(TypeBasis::Call),
            ),
            _ => (None, None),
        };
        match left.kind() {
            "identifier" => self.bindings.push(Binding {
                name: self.text.of(left).to_owned(),
                scope: self.scope() as i32,
                param: false,
                type_name,
                type_basis: basis,
                field_of: None,
            }),
            "attribute" => {
                let object = left.child_by_field_name("object");
                let attr = left.child_by_field_name("attribute");
                if let (Some(object), Some(attr)) = (object, attr)
                    && object.kind() == "identifier"
                    && let Some(class) = self.self_class(self.text.of(object))
                {
                    self.bindings.push(Binding {
                        name: self.text.of(attr).to_owned(),
                        scope: class as i32,
                        param: false,
                        type_name,
                        type_basis: basis,
                        field_of: Some(class as i32),
                    });
                }
            }
            _ => self.untyped_targets(left),
        }
    }

    /// Names a tuple or loop target binds: they shadow outer names, untyped.
    fn untyped_targets(&mut self, target: Node) {
        if target.kind() == "identifier" {
            self.bindings.push(Binding {
                name: self.text.of(target).to_owned(),
                scope: self.scope() as i32,
                param: false,
                type_name: None,
                type_basis: None,
                field_of: None,
            });
            return;
        }
        if matches!(
            target.kind(),
            "pattern_list" | "tuple_pattern" | "list_pattern" | "tuple"
        ) {
            for child in named_children(target) {
                self.untyped_targets(child);
            }
        }
    }

    fn receiver(&self, node: Node) -> Receiver {
        match node.kind() {
            "identifier" => {
                let name = self.text.of(node);
                if self.self_class(name).is_some() {
                    Receiver::This
                } else {
                    Receiver::Name {
                        name: name.to_owned(),
                    }
                }
            }
            "attribute" => {
                let mut path = Vec::new();
                let mut cur = Some(node);
                while let Some(n) = cur {
                    match n.kind() {
                        "attribute" => {
                            if let Some(a) = n.child_by_field_name("attribute") {
                                path.push(self.text.of(a).to_owned());
                            }
                            cur = n.child_by_field_name("object");
                        }
                        "identifier" => {
                            path.push(self.text.of(n).to_owned());
                            cur = None;
                        }
                        _ => return Receiver::Other,
                    }
                }
                path.reverse();
                Receiver::Path { path }
            }
            "call" => match node.child_by_field_name("function") {
                Some(f) if f.kind() == "identifier" && self.text.of(f) == "super" => {
                    Receiver::Super
                }
                Some(f) if f.kind() == "identifier" => Receiver::CallResult {
                    name: self.text.of(f).to_owned(),
                    receiver: None,
                },
                Some(f) if f.kind() == "attribute" => Receiver::CallResult {
                    name: f
                        .child_by_field_name("attribute")
                        .map(|a| self.text.of(a).to_owned())
                        .unwrap_or_default(),
                    receiver: f
                        .child_by_field_name("object")
                        .map(|o| Box::new(self.receiver(o))),
                },
                _ => Receiver::Other,
            },
            "string" | "concatenated_string" => Receiver::Builtin { name: "str".into() },
            "list" | "list_comprehension" => Receiver::Builtin {
                name: "list".into(),
            },
            "dictionary" | "dictionary_comprehension" => Receiver::Builtin {
                name: "dict".into(),
            },
            "set" | "set_comprehension" => Receiver::Builtin { name: "set".into() },
            "tuple" => Receiver::Builtin {
                name: "tuple".into(),
            },
            _ => Receiver::Other,
        }
    }

    fn call(&mut self, node: Node) {
        let Some(function) = node.child_by_field_name("function") else {
            return;
        };
        let (form, name_node, receiver) = match function.kind() {
            "identifier" => (CallForm::Ident, function, None),
            "attribute" => {
                let Some(attr) = function.child_by_field_name("attribute") else {
                    return;
                };
                let receiver = function
                    .child_by_field_name("object")
                    .map(|o| self.receiver(o));
                (CallForm::Member, attr, receiver)
            }
            _ => return,
        };
        let name = self.text.of(name_node);
        if name.is_empty() {
            return;
        }
        let mut callee = self.text.of(function).to_owned();
        callee.truncate(floor_char_boundary(&callee, bounds::MAX_CALLEE_TEXT_BYTES));
        self.calls.push(Call {
            form,
            name: name.to_owned(),
            receiver,
            scope: self.scope() as i32,
            caller: *self.owners.last().unwrap_or(&0) as i32,
            range: self.text.range(node),
            name_range: self.text.range(name_node),
            text: callee,
        });
    }

    fn import(&mut self, node: Node) {
        let scope = self.scope() as i32;
        let range = self.text.range(node);
        if node.kind() == "import_statement" {
            // `import a.b as c` binds c to a.b; `import a.b` binds a to a.
            for item in named_children(node) {
                let (module, alias) = match item.kind() {
                    "dotted_name" => (item, None),
                    "aliased_import" => match item.child_by_field_name("name") {
                        Some(n) => (n, item.child_by_field_name("alias")),
                        None => continue,
                    },
                    _ => continue,
                };
                let specifier = self.text.of(module).to_owned();
                let alias = alias.map(|a| self.text.of(a).to_owned());
                let local = alias
                    .clone()
                    .unwrap_or_else(|| specifier.split('.').next().unwrap_or_default().to_owned());
                self.imports.push(Import {
                    form: ImportForm::Python,
                    specifier: specifier.clone(),
                    level: 0,
                    bindings: vec![ImportBinding {
                        imported: "*".into(),
                        local: Some(local),
                        // An aliased import binds the whole path, not its head.
                        exported: alias.map(|_| specifier),
                    }],
                    scope,
                    range,
                });
            }
            return;
        }
        let (mut level, mut specifier) = (0u32, String::new());
        if let Some(module) = node.child_by_field_name("module_name") {
            if module.kind() == "relative_import" {
                for part in named_children(module) {
                    match part.kind() {
                        "import_prefix" => {
                            level = self.text.of(part).chars().filter(|c| *c == '.').count() as u32
                        }
                        "dotted_name" => specifier = self.text.of(part).to_owned(),
                        _ => {}
                    }
                }
            } else {
                specifier = self.text.of(module).to_owned();
            }
        }
        let mut bindings = Vec::new();
        let mut cursor = node.walk();
        for item in node.children_by_field_name("name", &mut cursor) {
            let (name, alias) = match item.kind() {
                "dotted_name" => (item, None),
                "aliased_import" => match item.child_by_field_name("name") {
                    Some(n) => (n, item.child_by_field_name("alias")),
                    None => continue,
                },
                _ => continue,
            };
            let imported = self.text.of(name).to_owned();
            bindings.push(ImportBinding {
                local: Some(alias.map_or_else(|| imported.clone(), |a| self.text.of(a).to_owned())),
                imported,
                exported: None,
            });
        }
        if named_children(node)
            .iter()
            .any(|c| c.kind() == "wildcard_import")
        {
            bindings.push(ImportBinding {
                imported: "*".into(),
                local: None,
                exported: None,
            });
        }
        self.imports.push(Import {
            form: ImportForm::Python,
            specifier,
            level,
            bindings,
            scope,
            range,
        });
    }
}
