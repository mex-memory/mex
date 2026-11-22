# Rust tree-sitter grammar

Unmodified C sources from tree-sitter-rust 0.20.4, upstream revision
`afb6000a71fb9dff3f47f90d412ec080ae12bbb4`. This is the parser in
tree-sitter-wasms 0.1.12. The upstream crate pins tree-sitter 0.20 and cc 1.0,
so the adapter compiles these sources using the workspace toolchain and
loads the original C language function through tree-sitter-language.

The sources are MIT licensed. See [LICENSE](LICENSE).
