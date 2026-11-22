//! Shared source, health and identity machinery for the tree-sitter adapters.

use std::collections::HashMap;

use mex_graph_core::facts::{
    Def, Diagnostic, FACTS_VERSION, FileFacts, Health, Import, Kind, NONE, ParseStatus, Range,
    ReferenceKind, SketchFacts, SyntaxReference, bounds,
};
use mex_graph_core::fingerprint::{SketchBuilder, body_hash};
use mex_graph_core::id::signature_identity;
use mex_graph_core::text::utf16_column;
use tree_sitter::{Language, Node, Parser, Tree};

pub mod resolve;

/// The flag on a definition that today's parse-health rule drops.
pub const EXCLUDED: &str = "excluded";

/// Lines of the normalized source, with UTF-16 conversions.
pub struct Text<'a> {
    source: &'a str,
    lines: Vec<&'a str>,
    /// UTF-16 offset at which each line starts.
    line_starts: Vec<u32>,
}

impl<'a> Text<'a> {
    pub fn new(source: &'a str) -> Text<'a> {
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

    pub fn field<'tree>(&self, node: Node<'tree>, field: &str) -> &'a str {
        node.child_by_field_name(field)
            .map_or("", |child| self.of(child))
    }

    pub fn of(&self, node: Node) -> &'a str {
        &self.source[node.byte_range()]
    }

    pub fn range(&self, node: Node) -> Range {
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

pub fn children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

pub fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

/// `treeHealth` in `extraction/index.ts`, including its unit quirk: covered
/// length is in UTF-16 units, divided by the source's UTF-8 byte length.
/// Returns the health and the 1-based line spans of the first 100 issues.
pub fn tree_health(tree: &Tree, text: &Text) -> (Health, Vec<(u32, u32)>) {
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

pub fn empty_def(name_range: Range) -> Def {
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
        visibility: None,
        decorators: Vec::new(),
        type_parameters: Vec::new(),
        heritage: Vec::new(),
        return_type: None,
        body_hash: None,
        sketch: None,
        docstring: None,
    }
}

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
            | Kind::Property
            | Kind::Field
    )
}

/// Today's tree-sitter sketches include any leaf wholly inside the body lines,
/// even outside the declaration's columns (and including comment leaves).
pub fn hash_and_sketch(defs: &mut [Def], raw: &str, tree: &Tree, builder: &mut SketchBuilder) {
    let lines: Vec<_> = raw.split('\n').collect();
    let leaves = leaf_types(tree);
    for def in defs.iter_mut().filter(|def| has_body(def.kind)) {
        let start = def.range.start_line as usize;
        let end = def.range.end_line as usize;
        def.body_hash = Some(body_hash(&lines, start + 1, end + 1));
        let tokens: Vec<_> = leaves[leaves.partition_point(|&(row, _, _)| row < start)..]
            .iter()
            .take_while(|&&(row, _, _)| row <= end)
            .filter_map(|&(_, last, kind)| (last <= end).then_some(kind))
            .collect();
        let sketch = builder.sketch(&tokens);
        def.sketch = Some(SketchFacts {
            minhash: sketch.minhash.to_vec(),
            token_count: sketch.token_count as u32,
        });
    }
}

/// Parser and trigram cache reused across files by one extraction thread.
pub struct Extractor {
    language: &'static str,
    separator: &'static str,
    parser: Parser,
    sketches: SketchBuilder,
}

impl Extractor {
    pub fn new(language: &'static str, separator: &'static str, grammar: Language) -> Self {
        let mut parser = Parser::new();
        parser
            .set_language(&grammar)
            .expect("the pinned grammar loads");
        Self {
            language,
            separator,
            parser,
            sketches: SketchBuilder::default(),
        }
    }

    pub fn extract(
        &mut self,
        path: &str,
        raw: &str,
        content_hash: [u8; 32],
        visit: impl FnOnce(Node, &mut Declarations),
    ) -> FileFacts {
        let mut facts = FileFacts {
            facts_version: FACTS_VERSION,
            path: path.into(),
            language: self.language.into(),
            content_hash,
            ..FileFacts::default()
        };
        let source = raw.replace("\r\n", "\n");
        let Some(tree) = self.parser.parse(&source, None) else {
            facts.health.status = ParseStatus::Failed;
            return facts;
        };
        let text = Text::new(&source);
        let (health, issues) = tree_health(&tree, &text);
        facts.health = health;
        if facts.health.status == ParseStatus::Failed {
            return facts;
        }

        let root = tree.root_node();
        let mut file = empty_def(Range::default());
        file.kind = Kind::File;
        file.name = path.rsplit(['/', '\\']).next().unwrap_or(path).into();
        file.qualified_name = path.into();
        file.declaration_role = Some("source-file".into());
        file.range.end_byte = root.end_byte() as u32;
        file.range.end_line = root.end_position().row as u32;
        let mut declarations = Declarations {
            text,
            path,
            separator: self.separator,
            stack: vec![0],
            defs: vec![file],
            refs: Vec::new(),
            imports: Vec::new(),
            occurrences: HashMap::new(),
            limit_reached: false,
        };
        visit(root, &mut declarations);
        if facts.health.status == ParseStatus::Partial && declarations.defs.len() == 1 {
            facts.health.status = ParseStatus::Failed;
            return facts;
        }
        for def in declarations.defs.iter_mut().skip(1) {
            if issues
                .iter()
                .any(|&(start, end)| start <= def.range.end_line + 1 && end > def.range.start_line)
            {
                def.flags.push(EXCLUDED.into());
            }
        }
        if declarations.limit_reached {
            facts.health.status = ParseStatus::Partial;
            facts.health.error_count += 1;
            if facts.health.diagnostics.len() < bounds::MAX_DIAGNOSTICS {
                facts.health.diagnostics.push(Diagnostic {
                    code: "FACT_LIMIT".into(),
                    range: Range::default(),
                });
            }
        }
        hash_and_sketch(&mut declarations.defs, raw, &tree, &mut self.sketches);
        facts.defs = declarations.defs;
        facts.syntax_references = declarations.refs;
        facts.imports = declarations.imports;
        facts
    }
}

pub struct Declarations<'a> {
    pub text: Text<'a>,
    pub stack: Vec<usize>,
    pub defs: Vec<Def>,
    path: &'a str,
    separator: &'static str,
    refs: Vec<SyntaxReference>,
    imports: Vec<Import>,
    occurrences: HashMap<String, u32>,
    limit_reached: bool,
}

impl Declarations<'_> {
    /// Reserve the same signature-based identity and duplicate role as the WASM walk.
    pub fn create(&mut self, kind: Kind, name: &str, node: Node, mut def: Def) -> Option<usize> {
        if name.is_empty() {
            return None;
        }
        if self.defs.len() >= bounds::MAX_DEFS {
            self.limit_reached = true;
            return None;
        }
        let mut names: Vec<_> = self
            .stack
            .iter()
            .skip(1)
            .map(|&i| self.defs[i].name.as_str())
            .collect();
        names.push(name);
        let qualified = names.join(self.separator);
        let identity =
            signature_identity(self.path, kind.as_str(), &qualified, None, &def.signature);
        let occurrence = self.occurrences.entry(identity).or_default();
        if *occurrence > 0 {
            def.declaration_role = Some(format!("{}:ordinal:{occurrence}", kind.as_str()));
        }
        *occurrence += 1;
        def.kind = kind;
        def.name = name.into();
        def.qualified_name = qualified;
        def.range = self.text.range(node);
        def.parent = self.stack.last().map_or(NONE, |&i| i as i32);
        def.scope = def.parent;
        let index = self.defs.len();
        self.defs.push(def);
        Some(index)
    }

    pub fn add_reference(&mut self, from: usize, kind: ReferenceKind, name: &str, node: Node) {
        self.add_reference_with_receiver(from, kind, name, node, None);
    }

    pub fn add_reference_with_receiver(
        &mut self,
        from: usize,
        kind: ReferenceKind,
        name: &str,
        node: Node,
        receiver_call: Option<String>,
    ) {
        if name.is_empty() {
            return;
        }
        if self.refs.len() >= bounds::MAX_CALLS {
            self.limit_reached = true;
            return;
        }
        self.refs.push(SyntaxReference {
            from,
            kind,
            name: name.into(),
            range: self.text.range(node),
            receiver_call,
        });
    }

    pub fn add_import(&mut self, import: Import) {
        if self.imports.len() >= bounds::MAX_CALLS {
            self.limit_reached = true;
            return;
        }
        self.imports.push(import);
    }
}
