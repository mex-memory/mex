use mex_graph_core::facts::{Def, FileFacts, Kind, ParseStatus, bounds};
use mex_graph_core::fingerprint::{SketchBuilder, body_hash};
use mex_graph_ecmascript::{EcmaScript, language_for_path, scanner::scan_token_names};

fn extract(path: &str, source: &str) -> FileFacts {
    let facts = EcmaScript::new().extract(path, source, [42; 32]);
    assert_eq!(facts.health.status, ParseStatus::Ok, "{:?}", facts.health);
    assert_eq!(facts.content_hash, [42; 32]);
    facts
}

fn one<'a>(facts: &'a FileFacts, name: &str) -> &'a Def {
    let mut matches = named(facts, name);
    let found = matches
        .next()
        .unwrap_or_else(|| panic!("no definition for {name}"));
    assert!(matches.next().is_none(), "several definitions for {name}");
    found
}

fn named<'a>(facts: &'a FileFacts, name: &str) -> impl Iterator<Item = &'a Def> {
    let name = name.to_owned();
    facts
        .defs
        .iter()
        .filter(move |def| def.qualified_name == name)
}

fn owner<'a>(facts: &'a FileFacts, def: &Def) -> &'a Def {
    &facts.defs[usize::try_from(def.parent).expect("a nested definition")]
}

#[test]
fn overloads_have_one_id_and_sketch_the_original_disjoint_spans() {
    let source = concat!(
        "/** Strings. */\r\n",
        "export function convert(x: string): string;\r\n",
        "const unrelated = 4;\r\n",
        "/** Numbers. */\r\n",
        "export async function convert(x: unknown): Promise<unknown> { return x; }\r\n",
    );
    let facts = extract("./src/a.ts", source);
    let file = one(&facts, "./src/a.ts");
    assert_eq!(file.name, "a.ts");
    assert_eq!(
        file.ordinal_identity(&facts.path),
        "src/a.ts\0file\0./src/a.ts\0source-file"
    );
    assert_eq!(
        (
            file.range.start_line,
            file.range.start_col,
            file.range.end_line
        ),
        (1, 0, 5)
    );
    let function = one(&facts, "convert");
    assert_eq!(
        function.ordinal_identity(&facts.path),
        "src/a.ts\0function\0convert\0function"
    );
    assert_eq!((function.range.start_line, function.range.end_line), (1, 4));
    assert!(function.exported);
    assert_eq!(function.flags, ["async"]);
    assert_eq!(function.docstring.as_deref(), Some("Strings.\nNumbers."));
    assert_eq!(function.return_type.as_deref(), Some("Promise<unknown>"));
    let lines: Vec<_> = source.split('\n').collect();
    assert_eq!(function.body_hash, Some(body_hash(&lines, 2, 5)));
    let mut tokens = scan_token_names(lines[1], false);
    tokens.push("OverloadBoundary");
    tokens.extend(scan_token_names(lines[4], false));
    let expected = SketchBuilder::default().sketch(&tokens);
    let actual = function.sketch.as_ref().unwrap();
    assert_eq!(actual.token_count as usize, expected.token_count);
    assert_eq!(actual.minhash, expected.minhash);
    assert_eq!(owner(&facts, function).kind, Kind::File);
}

#[test]
fn merges_meanings_and_keeps_declaration_ownership() {
    let facts = extract(
        "merge.ts",
        r#"
export type X = { member: string };
export const X = { run() { return 0; } };
export class Mixed {
  static same() {}
  same() {}
  get token() { return 0; }
  set token(value: number) { const listener = () => value; }
}
export interface Mixed { member: boolean; }
export function merge() {}
export namespace merge { export const item = 2; }
export enum Color { Red }
export enum Color { Blue = 1 }
interface Open { field: string; }
interface Open { field: number; }
type Weak<T> = { deref(): T; };
const { WeakRef: Weak } = globalThis;
"#,
    );
    let x = one(&facts, "X");
    assert_eq!(x.kind, Kind::TypeAlias);
    assert_eq!(x.range.end_line, 2);
    assert_eq!(
        owner(&facts, one(&facts, "X::run")).ordinal_id(&facts.path),
        x.ordinal_id(&facts.path)
    );
    assert!(one(&facts, "X::member").body_hash.is_some());
    assert_eq!(one(&facts, "Mixed").kind, Kind::Class);
    assert_eq!(one(&facts, "Mixed").range.end_line, 9);
    assert_eq!(one(&facts, "Mixed::member").kind, Kind::Property);
    let same: Vec<_> = named(&facts, "Mixed::same").collect();
    assert_eq!(
        same.iter().map(|d| d.ordinal).collect::<Vec<_>>(),
        [Some(0), Some(1)]
    );
    assert_eq!(same[0].flags, ["static"]);
    assert!(same[1].flags.is_empty());
    let accessor = one(&facts, "Mixed::token");
    assert_eq!((accessor.range.start_line, accessor.range.end_line), (6, 7));
    assert_eq!(
        owner(&facts, one(&facts, "Mixed::token::listener")),
        accessor
    );
    assert_eq!(one(&facts, "merge").range.end_line, 10);
    assert!(!one(&facts, "merge::item").exported);
    assert_eq!(one(&facts, "Color").range.end_line, 13);
    for name in ["Color::Red", "Color::Blue"] {
        let member = one(&facts, name);
        assert_eq!(member.kind, Kind::EnumMember);
        assert!(member.body_hash.is_none() && member.sketch.is_none());
    }
    let field = one(&facts, "Open::field");
    assert_eq!((field.range.start_line, field.range.end_line), (14, 15));
    let weak = one(&facts, "Weak");
    assert_eq!(weak.range.end_line, 17);
    assert!(weak.type_parameters.is_empty());
}

#[test]
fn separates_symbol_tables_and_applies_excludes_in_declaration_order() {
    let facts = extract(
        "scopes.ts",
        r#"
export {};
function wrapper() {
  { let repeat = () => 0; var shared = () => 0; }
  { let repeat = () => 1; var shared = () => 1; }
}
namespace N {
  function local() {}
  export function f(x: string): string;
}
namespace N {
  function local() {}
  export function f(x: number) { return x; }
}
const value = { run() {}, run(x: number) {} };
class Example { constructor(); constructor() {} }
type Invalid = { value: boolean } & { value: string };
const clash = () => 0;
const clash = () => 1;
"#,
    );
    assert_eq!(named(&facts, "wrapper::repeat").count(), 2);
    assert_eq!(one(&facts, "wrapper::shared").range.end_line, 4);
    assert_eq!(named(&facts, "N::local").count(), 2);
    assert_eq!(one(&facts, "N::f").range.end_line, 12);
    // The 5.9 binder applies PropertyExcludes to object-literal methods.
    assert_eq!(named(&facts, "value::run").count(), 1);
    assert_eq!(named(&facts, "Example::constructor").count(), 2);
    assert_eq!(named(&facts, "Invalid::value").count(), 2);
    let clash: Vec<_> = named(&facts, "clash").collect();
    assert_eq!(clash[0].ordinal, Some(0));
    assert_eq!(clash[1].ordinal, Some(1));
    assert_eq!(
        clash[0].ordinal_identity(&facts.path),
        "scopes.ts\0function\0clash\0function-variable\0ordinal:0"
    );
}

#[test]
fn function_values_and_type_properties_keep_the_nearest_graph_owner() {
    let facts = extract(
        "containers.ts",
        r#"
const Outer = class ClassExpression {
  method(parameter: { item: number }) {}
  static method(parameter: number) {}
  field = async <T>(value: T): Promise<T> => value;
};
const obj = {
  skip: () => 0,
  method() { const nested = function named() {}; const uninteresting = 0; }
};
function f() {
  const [skip] = [1];
  const { skip2 } = () => 0;
  const skip3 = (() => 0);
}
target["member"] = async function assigned() { const child = () => 1; };
target.member = () => 2;
target[key] = () => 3;
"#,
    );
    assert_eq!(one(&facts, "Outer").kind, Kind::Constant);
    assert_eq!(one(&facts, "Outer::method::item").kind, Kind::Property);
    assert_eq!(named(&facts, "Outer::method").count(), 2);
    let field = one(&facts, "Outer::field");
    assert_eq!(field.declaration_role.as_deref(), Some("callable-property"));
    assert_eq!(field.return_type.as_deref(), Some("Promise<T>"));
    assert!(field.type_parameters.is_empty() && field.flags.is_empty());
    assert_eq!(one(&facts, "obj::method::nested").kind, Kind::Function);
    assert!(named(&facts, "obj::skip").next().is_none());
    assert!(named(&facts, "obj::method::uninteresting").next().is_none());
    assert!(named(&facts, "f::skip2").next().is_none());
    assert_eq!(
        one(&facts, "f::<callback:ParenthesizedExpression>").kind,
        Kind::Function
    );
    let assignments: Vec<_> = named(&facts, "target.member").collect();
    assert_eq!(assignments.len(), 2);
    assert_eq!(assignments[0].flags, ["async"]);
    assert_eq!(
        owner(&facts, one(&facts, "target.member::child")),
        assignments[0]
    );
    assert_eq!(
        one(&facts, "<callback:BinaryExpression>").kind,
        Kind::Function
    );
}

#[test]
fn callbacks_use_compiler_parent_kinds_and_argument_indices() {
    let facts = extract(
        "callbacks.tsx",
        r#"
export function run(fn = () => {}) {
  call(1, /* skip trivia */ () => 2, ...[() => 3]);
  new Thing(0, async () => {});
  const left = flag ? () => 0 : () => 1;
  const div = <A prop={() => 1}>{() => 2}</A>;
  await (() => 0);
  return function () {};
}
export default () => 0;
"#,
    );
    let names = [
        "run::<callback:Parameter>",
        "run::<callback:call[1]>",
        "run::<callback:ArrayLiteralExpression>",
        "run::<callback:Thing[1]>",
        "run::<callback:ParenthesizedExpression>",
        "run::<callback:ReturnStatement>",
        "<callback:ExportAssignment>",
    ];
    for name in names {
        assert_eq!(one(&facts, name).kind, Kind::Function);
    }
    assert_eq!(
        named(&facts, "run::<callback:ConditionalExpression>").count(),
        2
    );
    assert_eq!(named(&facts, "run::<callback:JsxExpression>").count(), 2);
    assert_eq!(
        one(&facts, "run::<callback:Thing[1]>")
            .declaration_role
            .as_deref(),
        Some("constructor-callback:Thing:1"),
    );

    let receiver = format!("\"{}😀\".member", "x".repeat(78));
    let source = format!("{receiver}\u{3000}.run(() => 0);");
    let facts = extract("unicode.ts", &source);
    let expected = format!("<callback:\"{}�[0]>", "x".repeat(78));
    assert_eq!(one(&facts, &expected).kind, Kind::Function);
}

#[test]
fn declaration_boundaries_include_modifiers_and_decorators_and_count_utf16() {
    let facts = extract(
        "decorators.ts",
        concat!(
            "// leading trivia\r\n",
            "@First(() => 0) export default @Second abstract class C {\r\n",
            "  /** Document the method. */\r\n",
            "  @D('😀') @E protected static async m<T>(v: T): /* type */ Promise<T> { return v; }\r\n",
            "  abstract execute(): void;\r\n",
            "}\r\n",
            "export const x = '😀', y = 1;\r\n",
        ),
    );
    let class = one(&facts, "C");
    assert_eq!(
        (
            class.range.start_line,
            class.range.start_col,
            class.range.end_line
        ),
        (1, 0, 5)
    );
    assert_eq!(class.decorators, ["First(() => 0)", "Second"]);
    assert!(class.exported && class.is_default_export);
    assert_eq!(class.flags, ["abstract"]);
    assert_eq!(owner(&facts, one(&facts, "C::<callback:First[0]>")), class);
    let method = one(&facts, "C::m");
    assert_eq!((method.range.start_line, method.range.start_col), (3, 2));
    assert_eq!(method.decorators, ["D('😀')", "E"]);
    assert_eq!(method.visibility.as_deref(), Some("protected"));
    assert_eq!(method.flags, ["async", "static"]);
    assert_eq!(method.type_parameters, ["T"]);
    assert_eq!(method.return_type.as_deref(), Some("Promise<T>"));
    assert_eq!(method.docstring.as_deref(), Some("Document the method."));
    assert_eq!(one(&facts, "C::execute").range.end_col, 27);
    assert_eq!(one(&facts, "x").range.start_col, 13);
    assert_eq!(one(&facts, "y").range.start_col, 23);
    assert!(one(&facts, "x").exported && one(&facts, "y").exported);
}

#[test]
fn exports_distinguish_source_exports_namespace_members_and_local_aliases() {
    let facts = extract(
        "exports.mts",
        r#"
const value = 0;
export { value as exposed };
const primary = () => 0;
export default primary;
const private = 0;
export namespace A.B {
  export const constant = 0;
  export function visible() {}
  const local = 0;
}
"#,
    );
    for name in ["value", "primary", "A", "A::B", "A::B::visible"] {
        assert!(one(&facts, name).exported, "{name}");
    }
    for name in ["private", "A::B::constant", "A::B::local"] {
        assert!(!one(&facts, name).exported, "{name}");
    }
    assert_eq!(one(&facts, "A::B").range.start_col, 19);
    assert_eq!(
        one(&facts, "A::B").range.end_line,
        one(&facts, "A").range.end_line
    );
    let equals = extract(
        "equals.cts",
        r#"
function root() {}
namespace root { export const member = 0; }
export = root;
"#,
    );
    assert!(!one(&equals, "root").exported);
    assert!(one(&equals, "root::member").exported);
    let script = extract("script.ts", "const local = 1; function f() {}");
    assert!(!one(&script, "local").exported && !one(&script, "f").exported);
}

#[test]
fn javascript_commonjs_exports_and_jsdoc_parameter_properties() {
    let facts = extract(
        "common.cjs",
        r#"
function local() {}
exports.named = local;
/**
 * Parse settings.
 * @param {object} [options]
 * @param {object} [options.cache] Cache options
 * @param {boolean} [options.cache.enabled=false] Enable caching
 * @returns {void}
 */
module.exports.read = module.exports.parse = function(options) {};
exports.other = () => 0;
exports.other = async () => 1;
var first = require('first');
var second = require('second');
"#,
    );
    assert_eq!(facts.language, "javascript");
    for name in ["local", "module.exports.parse"] {
        assert!(one(&facts, name).exported);
    }
    assert!(named(&facts, "exports.other").all(|def| def.exported));
    assert_eq!(
        one(&facts, "module.exports.parse").return_type.as_deref(),
        Some("void")
    );
    let cache = one(&facts, "module.exports.parse::cache");
    let enabled = one(&facts, "module.exports.parse::cache::enabled");
    assert_eq!(owner(&facts, enabled), cache);
    assert_eq!(cache.docstring.as_deref(), Some("Cache options"));
    assert_eq!(enabled.docstring.as_deref(), Some("Enable caching"));
    assert_eq!(
        (
            cache.range.start_line,
            cache.range.end_line,
            cache.range.end_col
        ),
        (6, 8, 3)
    );
    assert_eq!(named(&facts, "first").count(), 1);
    assert_eq!(named(&facts, "second").count(), 1);
    let export_equals = extract(
        "expando.js",
        r#"
module.exports = root;
function root() {}
root.ext = () => 0;
exports.stale = () => 0;
"#,
    );
    assert!(one(&export_equals, "root.ext").exported);
    assert!(!one(&export_equals, "exports.stale").exported);
    assert!(!one(&export_equals, "root").exported);
}

#[test]
fn jsdoc_keeps_prose_and_ignores_tags_and_duplicate_overload_text() {
    let facts = extract(
        "docs.ts",
        r#"
/** Superseded. */
/** Active. */
export function a() {}
/**
 *
 * Explains {@link a} and {@link https://example.test/#fragment the link}.
 *
 * `@tag` is prose.
 *
 * @param x a tag
 */
export function b(x: number): void;
/** Overload. */
export function b(x: string): void;
/** Overload. */
export function b(x: string | number) {}
"#,
    );
    assert_eq!(one(&facts, "a").docstring.as_deref(), Some("Active."));
    assert_eq!(
        one(&facts, "b").docstring.as_deref(),
        Some(
            "\nExplains a and the link (https://example.test/#fragment).\n\n`@tag` is prose.\nOverload."
        ),
    );
}

#[test]
fn malformed_declarations_are_excluded_with_file_health() {
    let facts = EcmaScript::new().extract(
        "error.ts",
        r#"
export function before() { return true; }
export function broken(x = ) { return false; }
export function after() { return false; }
"#,
        [0; 32],
    );
    assert_eq!(facts.health.status, ParseStatus::Partial);
    assert!(!facts.health.diagnostics.is_empty());
    assert_eq!(one(&facts, "before").kind, Kind::Function);
    assert_eq!(one(&facts, "after").kind, Kind::Function);
    assert_eq!(named(&facts, "broken").count(), 0);
}

#[test]
fn repairs_unsupported_grammar_shapes_with_original_source_evidence() {
    let facts = extract(
        "grammar.ts",
        r#"
export type * from './types';
export interface Callable<out T> {
  <P>(x: P): T
  <Q>(x: Q): { result: T }
}
export const generic = <T>(value: T): T => value;
class Example {
  @(((): MethodDecorator => () => 0)())
  run() {}
}
"#,
    );
    assert_eq!(one(&facts, "Callable").type_parameters, ["T"]);
    assert_eq!(one(&facts, "Callable::result").kind, Kind::Property);
    assert_eq!(one(&facts, "generic").kind, Kind::Function);
    let method = one(&facts, "Example::run");
    assert_eq!(method.decorators, ["(((): MethodDecorator => () => 0)())"]);
    assert_eq!((method.range.start_line, method.range.start_col), (8, 2));
    assert_eq!(
        owner(
            &facts,
            one(&facts, "Example::run::<callback:ParenthesizedExpression>")
        ),
        method,
    );
}

#[test]
fn supports_all_compiler_extensions_and_keeps_the_facts_bounds() {
    for (path, language) in [
        ("entry.ts", "typescript"),
        ("a.MTS", "typescript"),
        ("entry.cts", "typescript"),
        ("entry.tsx", "tsx"),
        ("entry.mjs", "javascript"),
        ("entry.cjs", "javascript"),
        ("entry.js", "javascript"),
        ("entry.JSX", "jsx"),
    ] {
        assert_eq!(language_for_path(path), Some(language));
        assert_eq!(extract(path, "const x = () => 1;").language, language);
    }
    assert_eq!(language_for_path("entry.py"), None);
    let jsx = extract("view.jsx", "export const view = <Widget cb={() => 0}/>;");
    assert_eq!(
        one(&jsx, "view::<callback:JsxExpression>").kind,
        Kind::Function
    );

    let doc = "x".repeat(bounds::MAX_DOCSTRING_BYTES + 4);
    let source = format!("/** {doc} */\nfunction example() {{}}");
    assert_eq!(
        one(&extract("bounds.ts", &source), "example")
            .docstring
            .as_ref()
            .unwrap()
            .len(),
        bounds::MAX_DOCSTRING_BYTES
    );
    let source = (0..bounds::MAX_DEFS + 4)
        .map(|index| format!("const d{index} = 0;\n"))
        .collect::<String>();
    let facts = EcmaScript::new().extract("many.ts", &source, [0; 32]);
    assert_eq!(facts.health.status, ParseStatus::Partial);
    assert_eq!(facts.defs.len(), bounds::MAX_DEFS);
    assert_eq!(facts.health.diagnostics[0].code, "definition-limit");
}
