//! Routing for the two native signature-profile adapters added in M4.

use mex_graph_core::facts::FileFacts;
use mex_graph_syntax::resolve::FileResolution;

#[derive(Clone, Copy)]
pub(crate) enum SyntaxLanguage {
    Rust,
    CSharp,
}

impl SyntaxLanguage {
    pub(crate) const ALL: [Self; 2] = [Self::Rust, Self::CSharp];

    pub(crate) fn for_path(path: &str) -> Option<Self> {
        let (_, ext) = path.rsplit_once('.')?;
        if ext.eq_ignore_ascii_case("rs") {
            Some(Self::Rust)
        } else if ext.eq_ignore_ascii_case("cs") {
            Some(Self::CSharp)
        } else {
            None
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Rust => mex_graph_rust::LANGUAGE,
            Self::CSharp => mex_graph_csharp::LANGUAGE,
        }
    }

    pub(crate) fn resolve(self, files: &[FileFacts]) -> Vec<FileResolution<'_>> {
        match self {
            Self::Rust => mex_graph_rust::resolve::resolve(files),
            Self::CSharp => mex_graph_csharp::resolve::resolve(files),
        }
    }
}
