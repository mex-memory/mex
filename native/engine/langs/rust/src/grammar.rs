#![allow(
    unsafe_code,
    reason = "the pinned grammar exports a C language function"
)]

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_rust() -> *const ();
}

// The ABI 14 language function is the entry point of grammar/parser.c.
pub(crate) const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_rust) };
