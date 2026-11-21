//! Python resolution on small projects: each case names the call and the
//! definition it must reach, or the reason it must stay unresolved.

use mex_graph_core::facts::FileFacts;
use mex_graph_python::Python;
use mex_graph_python::resolve::{Resolution, resolve};

fn project(files: &[(&str, &str)]) -> (Vec<FileFacts>, Resolution) {
    let mut python = Python::new();
    let facts: Vec<FileFacts> = files
        .iter()
        .map(|(path, source)| python.extract(path, source, [0; 32]))
        .collect();
    let resolution = resolve(&facts);
    (facts, resolution)
}

/// Every resolved edge as "kind from-path:from-name -> to-path:to-qualified-name @line".
fn edges(facts: &[FileFacts], r: &Resolution) -> Vec<String> {
    let mut out: Vec<String> = r
        .edges
        .iter()
        .map(|e| {
            let from = &facts[e.from.0];
            let to = &facts[e.to.0];
            format!(
                "{} {}:{} -> {}:{} @{}",
                e.kind,
                from.path,
                from.defs[e.from.1].name,
                to.path,
                to.defs[e.to.1].qualified_name,
                e.line
            )
        })
        .collect();
    out.sort();
    out
}

fn has(edges: &[String], want: &str) -> bool {
    edges.iter().any(|e| e == want)
}

fn reasons(r: &Resolution) -> Vec<(&'static str, u32)> {
    let mut out: Vec<_> = r
        .unresolved
        .iter()
        .map(|(_, reason, n)| (*reason, *n))
        .collect();
    out.sort();
    out
}

#[test]
fn resolves_through_every_import_form() {
    let (facts, r) = project(&[
        ("pkg/__init__.py", "from .core import build\n"),
        (
            "pkg/core.py",
            "def build():\n    return helper()\n\ndef helper():\n    return 1\n",
        ),
        ("pkg/util/__init__.py", ""),
        ("pkg/util/text.py", "def slug(s):\n    return s\n"),
        (
            "app.py",
            "import pkg\nimport pkg.util.text as text\nfrom pkg import build\nfrom pkg.util import text as t2\n\n\
             def main():\n    build()\n    pkg.build()\n    text.slug('a')\n    t2.slug('b')\n\n\
             def lazy():\n    from pkg.core import helper\n    return helper()\n",
        ),
    ]);
    let e = edges(&facts, &r);
    assert!(
        has(&e, "calls pkg/core.py:build -> pkg/core.py:helper @2"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls app.py:main -> pkg/core.py:build @7"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls app.py:main -> pkg/core.py:build @8"),
        "re-export via package: {e:#?}"
    );
    assert!(
        has(&e, "calls app.py:main -> pkg/util/text.py:slug @9"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls app.py:main -> pkg/util/text.py:slug @10"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls app.py:lazy -> pkg/core.py:helper @14"),
        "import inside a function: {e:#?}"
    );
    assert!(
        has(
            &e,
            "imports app.py:app.py -> pkg/__init__.py:pkg/__init__.py @1"
        ),
        "{e:#?}"
    );
}

#[test]
fn resolves_self_super_and_inheritance() {
    let (facts, r) = project(&[
        (
            "base.py",
            "class Base:\n    def save(self):\n        return self.validate()\n\n    def validate(self):\n        return True\n",
        ),
        (
            "model.py",
            "from base import Base\n\nclass User(Base):\n    def validate(self):\n        return super().validate()\n\n    def run(self):\n        self.save()\n",
        ),
    ]);
    let e = edges(&facts, &r);
    assert!(
        has(&e, "extends model.py:User -> base.py:Base @3"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls base.py:save -> base.py:Base::validate @3"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls model.py:validate -> base.py:Base::validate @5"),
        "super(): {e:#?}"
    );
    assert!(
        has(&e, "calls model.py:run -> base.py:Base::save @8"),
        "inherited: {e:#?}"
    );
}

#[test]
fn types_receivers_only_from_evidence() {
    let (facts, r) = project(&[
        (
            "client.py",
            "class Client:\n    def request(self, url):\n        return url\n\ndef make() -> Client:\n    return Client()\n",
        ),
        (
            "api.py",
            "from client import Client, make\n\n\
             def get(url):\n    return client.request(url)\n\n\
             def typed(c: Client):\n    return c.request('/')\n\n\
             def built():\n    c = Client()\n    return c.request('/')\n\n\
             def returned():\n    c = make()\n    return c.request('/')\n\n\
             class Api:\n    def __init__(self):\n        self.client = Client()\n\n    def fetch(self):\n        return self.client.request('/')\n\n\
             def untyped(c):\n    return c.request('/')\n",
        ),
    ]);
    let e = edges(&facts, &r);
    assert!(
        has(&e, "calls api.py:typed -> client.py:Client::request @7"),
        "{e:#?}"
    );
    assert!(
        has(&e, "instantiates api.py:built -> client.py:Client @10"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls api.py:built -> client.py:Client::request @11"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls api.py:returned -> client.py:Client::request @15"),
        "{e:#?}"
    );
    assert!(
        has(&e, "calls api.py:fetch -> client.py:Client::request @22"),
        "field: {e:#?}"
    );
    // `client.request` in get() and `c.request` in untyped() prove nothing.
    assert!(!e.iter().any(|x| x.contains("api.py:get ->")), "{e:#?}");
    assert!(!e.iter().any(|x| x.contains("api.py:untyped ->")), "{e:#?}");
    let reasons = reasons(&r);
    assert!(
        reasons.iter().any(|(r, _)| *r == "untyped_receiver"),
        "{reasons:?}"
    );
}

#[test]
fn builtins_are_builtins_unless_shadowed() {
    let (facts, r) = project(&[
        (
            "testing.py",
            "class FlaskClient:\n    def open(self, path):\n        return path\n",
        ),
        ("app.py", "def read(path):\n    return open(path)\n"),
        (
            "local.py",
            "def open(path):\n    return path\n\ndef read(path):\n    return open(path)\n",
        ),
    ]);
    let e = edges(&facts, &r);
    // Today's graph sent the builtin open() in app.py to FlaskClient.open.
    assert!(
        !e.iter().any(|x| x.starts_with("calls app.py:read")),
        "{e:#?}"
    );
    assert!(has(&e, "calls local.py:read -> local.py:open @5"), "{e:#?}");
}

#[test]
fn nested_functions_skip_class_scope() {
    let (facts, r) = project(&[(
        "m.py",
        "def helper():\n    return 1\n\nclass A:\n    def helper(self):\n        return 2\n\n    def run(self):\n        return helper()\n",
    )]);
    let e = edges(&facts, &r);
    // Inside a method, a bare name skips the class body: module-level helper.
    assert!(has(&e, "calls m.py:run -> m.py:helper @9"), "{e:#?}");
}

#[test]
fn same_result_in_any_file_order() {
    let files = [
        ("a.py", "from b import f\n\ndef g():\n    return f()\n"),
        ("b.py", "from a import g\n\ndef f():\n    return g()\n"),
    ];
    let (facts, r) = project(&files);
    let mut reversed = files;
    reversed.reverse();
    let (facts2, r2) = project(&reversed);
    assert_eq!(edges(&facts, &r), edges(&facts2, &r2));
    assert_eq!(edges(&facts, &r).len(), 4);
}

#[test]
fn names_bound_two_ways_stay_unresolved() {
    let (facts, r) = project(&[
        ("testing.py", "class FlaskClient:\n    pass\n"),
        (
            "app.py",
            "def make(self):\n    cls = self.client_class\n    if cls is None:\n        from testing import FlaskClient as cls\n    return cls()\n\n\
             try:\n    from fast import dumps\nexcept ImportError:\n    from slow import dumps\n\n\
             def save(x):\n    return dumps(x)\n\n\
             def helper():\n    return 1\n\nhelper = staticmethod(helper)\n\n\
             def use():\n    return helper()\n",
        ),
    ]);
    let e = edges(&facts, &r);
    assert!(
        !e.iter().any(|x| x.contains("app.py:make -> testing.py")),
        "{e:#?}"
    );
    assert!(!e.iter().any(|x| x.contains("app.py:use ->")), "{e:#?}");
    let reasons = reasons(&r);
    assert!(
        reasons.iter().any(|(r, n)| *r == "rebound_name" && *n >= 2),
        "{reasons:?}"
    );
}
