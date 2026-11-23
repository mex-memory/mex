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

    pub(crate) fn resolver(self) -> &'static str {
        match self {
            Self::Rust => "engine-rust",
            Self::CSharp => "engine-csharp",
        }
    }

    pub(crate) fn resolve(self, files: &[FileFacts]) -> Vec<FileResolution<'_>> {
        match self {
            Self::Rust => mex_graph_rust::resolve::resolve(files),
            Self::CSharp => mex_graph_csharp::resolve::resolve(files),
        }
    }
}
