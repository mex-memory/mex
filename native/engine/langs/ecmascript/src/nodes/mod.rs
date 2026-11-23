//! Syntax-backed definitions for the compiler graph route.
use mex_graph_core::facts::{FACTS_VERSION, FileFacts, ParseStatus};
use mex_graph_core::fingerprint::SketchBuilder;
use tree_sitter::{Language, Parser};

mod binder;
mod declarations;
mod documentation;
mod grammar;
mod references;
mod source;
mod syntax;

use source::Source;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Grammar {
    TypeScript,
    Tsx,
    JavaScript,
}

impl Grammar {
    fn language(self) -> Language {
        match self {
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
        }
    }
}

pub fn linked_grammar(id: &str) -> Option<Language> {
    Some(
        match id {
            "typescript" => Grammar::TypeScript,
            "tsx" => Grammar::Tsx,
            "javascript" | "jsx" => Grammar::JavaScript,
            _ => return None,
        }
        .language(),
    )
}

fn extension(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map_or("", |(_, extension)| extension)
}

/// The graph language id, if this adapter handles the given path.
pub fn language_for_path(path: &str) -> Option<&'static str> {
    let extension = extension(path);
    if extension.eq_ignore_ascii_case("tsx") {
        Some("tsx")
    } else if extension.eq_ignore_ascii_case("jsx") {
        Some("jsx")
    } else if ["js", "mjs", "cjs"]
        .iter()
        .any(|ext| extension.eq_ignore_ascii_case(ext))
    {
        Some("javascript")
    } else if ["ts", "mts", "cts"]
        .iter()
        .any(|ext| extension.eq_ignore_ascii_case(ext))
    {
        Some("typescript")
    } else {
        None
    }
}

/// One parser and one trigram cache per extraction thread.
pub struct EcmaScript {
    parser: Parser,
    grammars: [Language; 3],
    active: Option<Grammar>,
    sketches: SketchBuilder,
}

impl Default for EcmaScript {
    fn default() -> Self {
        Self::new()
    }
}

impl EcmaScript {
    pub fn new() -> Self {
        Self {
            parser: Parser::new(),
            grammars: [Grammar::TypeScript, Grammar::Tsx, Grammar::JavaScript]
                .map(Grammar::language),
            active: None,
            sketches: SketchBuilder::default(),
        }
    }

    /// The exact file bytes supply the content hash and compiler evidence.
    pub fn extract(&mut self, path: &str, text: &str, content_hash: [u8; 32]) -> FileFacts {
        let language = language_for_path(path).unwrap_or("typescript");
        let grammar = match language {
            "tsx" => Grammar::Tsx,
            "jsx" | "javascript" => Grammar::JavaScript,
            _ => Grammar::TypeScript,
        };
        if self.active != Some(grammar) {
            self.parser
                .set_language(&self.grammars[grammar as usize])
                .expect("the pinned ECMAScript grammars load");
            self.active = Some(grammar);
        }

        let mut facts = FileFacts {
            facts_version: FACTS_VERSION,
            path: path.into(),
            language: language.into(),
            content_hash,
            ..FileFacts::default()
        };
        let Some((tree, offsets)) =
            grammar::parse(&mut self.parser, text, grammar != Grammar::JavaScript)
        else {
            facts.health.status = ParseStatus::Failed;
            return facts;
        };
        let root = tree.root_node();
        let source = Source::new(text, root, offsets);
        facts.health = source.health();
        if facts.health.status != ParseStatus::Failed {
            let (defs, drafts) = declarations::extract(
                root,
                &source,
                path,
                grammar == Grammar::JavaScript,
                matches!(language, "jsx" | "tsx"),
                &mut self.sketches,
                &mut facts.health,
            );
            facts.defs = defs;
            references::extract(root, &source, &mut facts, &drafts);
        }
        facts
    }
}
