use mex_graph_core::facts::{CallForm, FileFacts, Kind, Receiver};
use mex_graph_ecmascript::EcmaScript;
use mex_graph_ecmascript::modules::ModuleResolver;
use mex_graph_ecmascript::resolve::{Edge, Resolution, resolve};

struct Graph {
    files: Vec<FileFacts>,
    resolution: Resolution,
}

impl Graph {
    fn new(files: &[(&str, &str)]) -> Self {
        Self::configured(files, &[])
    }

    fn configured(files: &[(&str, &str)], configs: &[(&str, &str)]) -> Self {
        let mut parser = EcmaScript::new();
        let facts: Vec<_> = files
            .iter()
            .map(|&(path, text)| parser.extract(path, text, [0; 32]))
            .collect();
        let modules = ModuleResolver::new(files.iter().map(|&(p, _)| p), configs.iter().copied());
        let resolution = resolve(&facts, &modules);
        Self {
            files: facts,
            resolution,
        }
    }

    fn calls(&self, file: usize) -> Vec<(u32, &str, &str)> {
        self.resolution
            .edges
            .iter()
            .filter(|e| {
                e.from.0 == file && matches!(e.kind, "calls" | "instantiates") && !e.is_callback()
            })
            .map(|e| {
                (
                    e.line,
                    self.files[e.to.0].path.as_str(),
                    self.files[e.to.0].defs[e.to.1].qualified_name.as_str(),
                )
            })
            .collect()
    }

    fn reason(&self, file: usize, line: u32, name: &str) -> Option<&'static str> {
        self.resolution
            .unresolved_calls
            .iter()
            .find_map(|&(f, i, reason)| {
                let call = &self.files[f].calls[i];
                (f == file && call.name_range.start_line + 1 == line && call.name == name)
                    .then_some(reason)
            })
    }

    fn edges(&self, kind: &str) -> impl Iterator<Item = &Edge> {
        self.resolution
            .edges
            .iter()
            .filter(move |edge| edge.kind == kind)
    }
}

#[test]
fn binds_lexical_names_and_does_not_search_the_corpus_by_name() {
    let graph = Graph::new(&[
        ("other.ts", "export function lost() {}"),
        (
            "app.ts",
            "\
function run() {}\n\
run();\n\
function scope(run: () => void) { run(); lost(); }\n\
{ let run: unknown; run(); }\n\
function f() { run(); var run: unknown; }\n\
try {} catch (run) { run(); }\n\
for (const run of []) { run(); }\n\
run();\n",
        ),
    ]);
    assert_eq!(graph.calls(1), [(2, "app.ts", "run"), (8, "app.ts", "run")]);
    assert_eq!(graph.reason(1, 3, "lost"), Some("unknown_binding"));
    assert_eq!(graph.reason(1, 3, "run"), Some("parameter_call"));
    for line in 4..=7 {
        assert_eq!(graph.reason(1, line, "run"), Some("local_value"));
    }
}

#[test]
fn follows_barrels_explicit_reexports_defaults_and_namespace_members() {
    let graph = Graph::new(&[
        (
            "one.ts",
            "export default function make() {}\nexport function run() {}\nexport function unique() {}",
        ),
        ("two.ts", "export function run() {}"),
        (
            "barrel.ts",
            "export * from './cycle'; export * from './one'; export * from './two'; export { default as create, run as chosen } from './one';",
        ),
        ("cycle.ts", "export * from './barrel';"),
        (
            "app.ts",
            "\
import * as ns from './barrel';\n\
import { chosen as a, create } from './barrel';\n\
import missingDefault from './barrel';\n\
import type { chosen as t } from './barrel';\n\
a(); create(); ns.unique(); ns.run(); missingDefault(); t();\n",
        ),
    ]);
    assert_eq!(
        graph.calls(4),
        [
            (5, "one.ts", "run"),
            (5, "one.ts", "make"),
            (5, "one.ts", "unique")
        ]
    );
    assert_eq!(graph.reason(4, 5, "run"), Some("ambiguous_export"));
    assert_eq!(graph.reason(4, 5, "missingDefault"), Some("export_missing"));
    assert_eq!(graph.reason(4, 5, "t"), Some("unknown_binding"));
    assert_eq!(graph.edges("imports").count(), 5);
}

#[test]
fn merges_overloads_and_keeps_type_and_value_meanings_of_one_graph_node() {
    let graph = Graph::new(&[
        (
            "lib.ts",
            "\
export interface run { value: string }\n\
export function run(x: string): number;\n\
export function run(x: number): number;\n\
export function run(x: unknown) { return 0; }\n",
        ),
        (
            "main.ts",
            "import {run as use} from './lib';\nuse(1); use('a');",
        ),
    ]);
    let calls: Vec<_> = graph.edges("calls").collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].to, calls[1].to);
    let def = &graph.files[0].defs[calls[0].to.1];
    assert_eq!(def.name, "run");
    assert_eq!(def.range.end_line, 3);
}

#[test]
fn tracks_commonjs_aliases_and_uses_require_export_conditions() {
    let graph = Graph::configured(
        &[
            ("package/def.mts", "export function open() {}"),
            (
                "package/def.cjs",
                "function open() {} module.exports = { open };",
            ),
            ("direct.cjs", "function main() {} module.exports = main;"),
            ("named.cjs", "exports.run = function () {};"),
            ("a.mts", "import { open } from 'condition'; open();"),
            (
                "b.cjs",
                "\
const {open: alias} = require('condition');\n\
const direct = require('./direct.cjs');\n\
const {run} = require('./named.cjs');\n\
alias(); direct(); run(); require('./named.cjs').run();\n\
function shadow(require) { require('./direct.cjs')(); }\n",
            ),
        ],
        &[
            (
                "tsconfig.json",
                r#"{"compilerOptions":{"moduleResolution":"node16","allowJs":true}}"#,
            ),
            (
                "package/package.json",
                r#"{"name":"condition","exports":{".":{"import":"./def.mts","require":"./def.cjs"}}}"#,
            ),
        ],
    );
    assert_eq!(graph.calls(4), [(1, "package/def.mts", "open")]);
    assert_eq!(
        graph.calls(5),
        [
            (4, "package/def.cjs", "open"),
            (4, "direct.cjs", "main"),
            (4, "named.cjs", "exports.run"),
            (4, "named.cjs", "exports.run")
        ]
    );
    assert_eq!(graph.reason(5, 5, "require"), Some("parameter_call"));
}

#[test]
fn resolves_class_members_using_types_this_super_and_the_correct_class_side() {
    let graph = Graph::new(&[(
        "service.ts",
        "\
interface Service { run(): void }\n\
abstract class Abstract { abstract run(): void; }\n\
class Base implements Service { constructor() {} run() {} static start() {} }\n\
class Derived extends Base {\n\
  private field = new Base();\n\
  constructor(private injected: Base) { super(); }\n\
  static start() { super.start(); this.start(); }\n\
  work() { this.run(); super.run(); this.field.run(); this.injected.run(); }\n\
}\n\
function asBase(): Base { return new Base(); }\n\
function use(a: Base, iface: Service, abs: Abstract) {\n\
  const { service } = { service: new Derived() };\n\
  a.run(); service.run(); asBase().run(); abs.run(); iface.run();\n\
  const x = new Derived(); x.work(); Derived.run();\n\
}\n",
    )]);
    let calls = graph.calls(0);
    assert!(
        calls.contains(&(6, "service.ts", "Base::constructor")),
        "{calls:?}"
    );
    assert!(calls.contains(&(7, "service.ts", "Base::start")));
    assert!(calls.contains(&(7, "service.ts", "Derived::start")));
    assert_eq!(
        calls
            .iter()
            .filter(|row| **row == (8, "service.ts", "Base::run"))
            .count(),
        4
    );
    assert_eq!(
        calls
            .iter()
            .filter(|row| **row == (13, "service.ts", "Base::run"))
            .count(),
        3
    );
    assert!(calls.contains(&(13, "service.ts", "Abstract::run")));
    assert!(calls.contains(&(14, "service.ts", "Derived::work")));
    assert_eq!(graph.reason(0, 13, "run"), Some("interface_dispatch"));
    assert_eq!(graph.reason(0, 14, "run"), Some("member_missing"));
    assert_eq!(graph.edges("extends").count(), 1);
    assert_eq!(graph.edges("implements").count(), 1);
}

#[test]
fn resolves_unindexed_class_expressions_and_lexical_this_only() {
    let graph = Graph::new(&[(
        "app.ts",
        "\
class Base { parent() {} }\n\
function outer() {\n\
  const C = class extends Base {\n\
    local() { (() => this.parent())(); function plain() { this.parent(); } }\n\
  };\n\
  new C().local();\n\
}\n",
    )]);
    let calls = graph.calls(0);
    assert_eq!(
        calls,
        [(4, "app.ts", "Base::parent"), (6, "app.ts", "outer::local")]
    );
    assert_eq!(graph.reason(0, 4, "parent"), Some("unbound_this"));
}

#[test]
fn takes_contextual_this_from_an_explicit_type_argument_and_this_type() {
    let graph = Graph::new(&[
        (
            "helper.ts",
            "\
export type Context<T> = { value?: number } & ThisType<T>;\n\
export function build<T>(members: Context<T>) { return members; }\n",
        ),
        (
            "app.ts",
            "\
import {build} from './helper';\n\
interface Root { run(): void }\n\
interface Child extends Root {}\n\
build<Child>({ method() { this.run(); } });\n\
const other = { method() { this.run(); } };\n",
        ),
    ]);
    assert_eq!(
        graph.calls(1),
        [(4, "helper.ts", "build"), (4, "app.ts", "Root::run")]
    );
    assert_eq!(graph.reason(1, 5, "run"), Some("member_missing"));
}

#[test]
fn tracks_callback_parameter_invocations_and_utf16_sites() {
    let graph = Graph::new(&[
        (
            "use.ts",
            "\
export function invoke(cb: () => void, unused: () => void) { cb.call(null); }\n\
export function rest(...fns: (() => void)[]) { fns[1](); }\n\
export function shadow(cb: () => void) { { let cb = () => {}; cb(); } }\n",
        ),
        (
            "app.ts",
            "\
import { invoke, rest, shadow } from './use';\n\
function done() {}\n\
/* 🚀 */ invoke(done, () => {});\n\
rest(done, () => { done(); });\n\
shadow(done);\n",
        ),
    ]);
    let callbacks: Vec<_> = graph.edges("calls").filter(|e| e.is_callback()).collect();
    assert_eq!(callbacks.len(), 2, "{callbacks:?}");
    let invoke = callbacks[0];
    assert_eq!(graph.files[0].defs[invoke.from.1].name, "invoke");
    assert_eq!(graph.files[1].defs[invoke.to.1].name, "done");
    assert_eq!((invoke.site_file, invoke.line, invoke.col), (1, 3, 16));
    let rest = callbacks[1];
    assert_eq!(graph.files[0].defs[rest.from.1].name, "rest");
    assert_eq!((rest.site_file, rest.line, rest.col), (1, 4, 11));
    let caller = graph
        .edges("calls")
        .find(|e| {
            !e.is_callback() && e.line == 4 && graph.files[e.to.0].defs[e.to.1].name == "done"
        })
        .unwrap();
    assert_eq!(caller.from, rest.to);
}

#[test]
fn keeps_reassigned_and_unknown_receivers_unresolved() {
    let graph = Graph::new(&[(
        "app.ts",
        "\
class A { run() {} }\n\
class B { run() {} }\n\
let x = new A();\n\
x = new B();\n\
x.run();\n\
function injected(input: unknown) { input.run(); }\n\
const y = new A(); y.run();\n",
    )]);
    assert_eq!(graph.reason(0, 5, "run"), Some("untyped_binding"));
    assert_eq!(graph.reason(0, 6, "run"), Some("untyped_binding"));
    assert!(graph.calls(0).contains(&(7, "app.ts", "A::run")));
}

#[test]
fn records_syntax_shapes_and_containing_definition() {
    let graph = Graph::new(&[(
        "main.tsx",
        "\
function save() {}\n\
const run = () => { const item = <div />; save(); };\n\
run();\n",
    )]);
    let facts = &graph.files[0];
    assert_eq!(facts.language, "tsx");
    let save = &facts.calls[0];
    assert_eq!(save.form, CallForm::Ident);
    assert_eq!(save.receiver, None::<Receiver>);
    assert_eq!(facts.defs[save.caller as usize].name, "run");
    assert_eq!(facts.defs[facts.calls[1].caller as usize].kind, Kind::File);
}

#[test]
fn type_only_reexports_are_available_to_annotations_and_not_calls() {
    let graph = Graph::new(&[
        (
            "impl.ts",
            "export class Service { run() {} } export function hidden() {}",
        ),
        ("types.ts", "export type { Service, hidden } from './impl';"),
        (
            "app.ts",
            "import { Service, hidden } from './types';\nfunction f(s: Service) { s.run(); }\nnew Service(); hidden();",
        ),
    ]);
    assert_eq!(graph.calls(2), [(2, "impl.ts", "Service::run")]);
    assert_eq!(graph.reason(2, 3, "Service"), Some("export_missing"));
    assert_eq!(graph.reason(2, 3, "hidden"), Some("export_missing"));
}

#[test]
fn commonjs_exports_alias_must_still_point_to_module_exports() {
    let graph = Graph::new(&[
        (
            "lib.cjs",
            "\
exports.old = function () {};\n\
module.exports = {};\n\
exports.lost = function () {};\n\
exports = module.exports;\n\
exports.current = function () {};\n\
exports = {};\n\
exports.local = function () {};\n",
        ),
        (
            "app.cjs",
            "const lib = require('./lib.cjs');\nlib.old(); lib.lost(); lib.current(); lib.local();",
        ),
    ]);
    assert_eq!(graph.calls(1), [(2, "lib.cjs", "exports.current")]);
}

#[test]
fn resolves_javascript_fields_and_jsdoc_only_when_evidence_is_stable() {
    let graph = Graph::new(&[(
        "app.js",
        "\
class Service { run() {} }\n\
class Handler {\n\
  constructor() { this.service = new Service(); }\n\
  handle() { this.service.run(); }\n\
}\n\
class Mutable {\n\
  constructor() { this.service = new Service(); }\n\
  update(next) { this.service = next; }\n\
  handle() { this.service.run(); }\n\
}\n\
/** @returns {Service} */\n\
function make(value) { return value; }\n\
/** @param {Service} service */\n\
function use(service) { service.run(); }\n\
make(input).run();\n",
    )]);
    let calls = graph.calls(0);
    for line in [4, 14, 15] {
        assert!(
            calls.contains(&(line, "app.js", "Service::run")),
            "{calls:?}"
        );
    }
    assert_eq!(graph.reason(0, 9, "run"), Some("untyped_member"));
}

#[test]
fn types_a_factory_alias_by_its_signature_without_attaching_two_calls_to_one_token() {
    let graph = Graph::new(&[(
        "app.ts",
        "\
class Product { run() {} static build(): Product { return new Product(); } }\n\
const make = Product.build;\n\
make().run();\n\
function curry() { return () => 0; }\n\
curry()();\n",
    )]);
    let calls = graph.calls(0);
    assert!(calls.contains(&(3, "app.ts", "Product::run")));
    assert_eq!(calls.iter().filter(|(line, _, _)| *line == 5).count(), 1);
}

#[test]
fn uses_declared_construct_signatures_of_bound_values() {
    let graph = Graph::new(&[
        (
            "lib.ts",
            "\
export class Product { run() {} }\n\
export interface Factory { new (): Product; }\n\
export declare const build: Factory;\n\
export declare const make: new () => Product;\n",
        ),
        (
            "app.ts",
            "import {build, make} from './lib';\nconst a = new build(); a.run();\nconst b = new (make)(); b.run();",
        ),
    ]);
    assert_eq!(
        graph.calls(1),
        [
            (2, "lib.ts", "build"),
            (2, "lib.ts", "Product::run"),
            (3, "lib.ts", "make"),
            (3, "lib.ts", "Product::run"),
        ]
    );
}

#[test]
fn callback_evidence_requires_an_invocation_in_the_selected_signature_body() {
    let graph = Graph::new(&[(
        "app.ts",
        "\
function overloaded(f: () => void): void;\n\
function overloaded(f: () => void) { f(); }\n\
function quoted(...fns: (() => void)[]) { fns['0'](); }\n\
function ready() {}\n\
overloaded(ready); quoted(ready);\n",
    )]);
    assert_eq!(
        graph
            .edges("calls")
            .filter(|edge| edge.is_callback())
            .count(),
        0
    );
    assert!(graph.calls(0).contains(&(5, "app.ts", "overloaded")));
}
