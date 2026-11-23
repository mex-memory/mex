fn main() {
    println!("cargo:rerun-if-changed=grammar");
    cc::Build::new()
        .include("grammar")
        .files(["grammar/parser.c", "grammar/scanner.c"])
        .std("c11")
        .warnings(false)
        .compile("tree-sitter-rust-0_20_4");
}
