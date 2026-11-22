use mex_graph_rust::{Rust, resolve::resolve};
use mex_graph_syntax::resolve::Site;

#[test]
fn associated_calls_require_the_written_owner() {
    let mut rust = Rust::new();
    let files = [
        rust.extract(
            "src/lib.rs",
            r#"
mod workers;
use crate::workers::{inner::{new as worker_new}, State};
struct Local;
impl Local {
    fn new() -> Self { Self }
    fn own(&self) {}
    fn run(&self) {
        Local::new();
        Self::new();
        Local::new().own();
        external::Error::new();
        worker_new();
        State::Ready.step();
        other.step();
    }
}
"#,
            [0; 32],
        ),
        rust.extract(
            "src/workers.rs",
            r#"
pub mod inner { pub fn new() {} }
pub enum State { Ready }
impl State { pub fn step(&self) {} }
"#,
            [1; 32],
        ),
    ];
    let resolution = resolve(&files);
    let calls: Vec<_> = resolution[0]
        .edges
        .iter()
        .filter(|edge| edge.site.kind() == "calls")
        .map(|edge| {
            (
                edge.site.name(),
                files[edge.to.0].defs[edge.to.1].qualified_name.as_str(),
            )
        })
        .collect();
    assert_eq!(
        calls,
        [
            ("Local::new", "Local::new"),
            ("Self::new", "Local::new"),
            ("Local::new().own", "Local::own"),
            ("Local::new", "Local::new"),
            ("worker_new", "inner::new"),
            ("State::Ready.step", "State::step"),
        ]
    );
    for name in ["external::Error::new", "other.step"] {
        assert!(resolution[0].unresolved.iter().any(|reference| {
            matches!(reference.site, Site::Symbol(_)) && reference.site.name() == name
        }));
    }
}

#[test]
fn follows_test_root_module_and_named_reexport() {
    let mut rust = Rust::new();
    let files = [
        rust.extract(
            "tests/tests.rs",
            "mod helper; fn test() { crate::helper::run(); }",
            [0; 32],
        ),
        rust.extract(
            "tests/helper/mod.rs",
            "mod detail; pub use self::detail::run;",
            [1; 32],
        ),
        rust.extract("tests/helper/detail.rs", "pub fn run() {}", [2; 32]),
    ];
    let resolution = resolve(&files);
    assert!(resolution[0].edges.iter().any(|edge| {
        edge.site.kind() == "calls" && edge.to.0 == 2 && files[2].defs[edge.to.1].name == "run"
    }));
}
