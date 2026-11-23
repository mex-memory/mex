use super::{ConfigIssue, ModuleResolver, ModuleTarget, Syntax};

fn resolver(files: &[&str], configs: &[(&str, &str)]) -> ModuleResolver {
    ModuleResolver::new(files.iter().copied(), configs.iter().copied())
}

fn file(path: &str, basis: &'static str) -> ModuleTarget {
    ModuleTarget::File {
        path: path.to_owned(),
        basis,
    }
}

fn unresolved(reason: &'static str) -> ModuleTarget {
    ModuleTarget::Unresolved { reason }
}

fn external(pkg: &str) -> ModuleTarget {
    ModuleTarget::External {
        pkg: pkg.to_owned(),
    }
}

#[test]
fn probes_typescript_extensions_first_and_never_guesses_by_basename() {
    let view = resolver(
        &[
            "src/app.ts",
            "src/same.js",
            "src/same.ts",
            "src/j.tsx",
            "src/m.mts",
            "src/c.cts",
            "src/stub.d.mts",
            "src/t/icon.d.svg.ts",
            "src/folder/index.ts",
            "other/lost.ts",
            "src/runtime.js",
            "src/hidden.mts",
        ],
        &[("tsconfig.json", "{}")],
    );
    for (specifier, path) in [
        ("./same.js", "src/same.ts"),
        ("./j.js", "src/j.tsx"),
        ("./m.mjs", "src/m.mts"),
        ("./c.cjs", "src/c.cts"),
        ("./stub.mjs", "src/stub.d.mts"),
        ("./t/icon.svg", "src/t/icon.d.svg.ts"),
        ("./folder", "src/folder/index.ts"),
        ("./runtime", "src/runtime.js"),
        ("/src/same.js", "src/same.ts"),
    ] {
        assert_eq!(
            view.resolve("src/app.ts", specifier, Syntax::Import),
            file(path, "relative"),
            "{specifier}"
        );
    }
    for specifier in ["./lost", "./hidden"] {
        assert_eq!(
            view.resolve("src/app.ts", specifier, Syntax::Import),
            unresolved("module_not_found")
        );
    }
    assert_eq!(
        view.resolve("src/app.ts", "lost", Syntax::Import),
        external("lost")
    );
}

#[test]
fn relative_directory_entries_use_typings_types_and_main() {
    let view = resolver(
        &[
            "entry.ts",
            "typed/legacy.d.ts",
            "typed/new.d.ts",
            "typed/index.ts",
            "sub/decl/api.d.ts",
            "main/src/entry.ts",
            "runtime/src/index.js",
            "index-only/index.ts",
            "index.ts",
        ],
        &[
            (
                "typed/package.json",
                r#"{"typings":"legacy.d.ts","types":"new.d.ts","main":"entry.js"}"#,
            ),
            ("sub/package.json", r#"{"types":"decl/api.d.ts"}"#),
            (
                "main/package.json",
                r#"{"main":"src/entry.js","module":"unused.ts"}"#,
            ),
            ("runtime/package.json", r#"{"main":"src"}"#),
        ],
    );
    for (specifier, path) in [
        ("./typed", "typed/legacy.d.ts"),
        ("./sub", "sub/decl/api.d.ts"),
        ("./main", "main/src/entry.ts"),
        ("./runtime/", "runtime/src/index.js"),
        ("./index-only", "index-only/index.ts"),
        (".", "index.ts"),
    ] {
        assert_eq!(
            view.resolve("entry.ts", specifier, Syntax::Require),
            file(path, "relative")
        );
    }
}

#[test]
fn absolute_paths_and_workspace_targets_cannot_leave_the_view() {
    let view = ModuleResolver::with_repository_root(
        "/code/example",
        [
            "src/app.ts",
            "src/local.ts",
            "node_modules/evil/index.ts",
            "../outside.ts",
            "/hidden.ts",
        ],
        [
            (
                "node_modules/evil/package.json",
                r#"{"name":"evil","main":"index.ts"}"#,
            ),
            (
                "pkg/package.json",
                r#"{"name":"pkg","exports":"./../src/local.js"}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("src/app.ts", "/code/example/src/local.js", Syntax::Import),
        file("src/local.ts", "relative")
    );
    assert_eq!(
        view.resolve(
            "src/app.ts",
            "/code/example-copy/src/local.js",
            Syntax::Import
        ),
        unresolved("outside_repository")
    );
    assert_eq!(
        view.resolve("src/app.ts", "../../outside", Syntax::Import),
        unresolved("outside_repository")
    );
    assert_eq!(
        view.resolve("src/app.ts", "../node_modules/evil", Syntax::Require),
        unresolved("node_modules_target")
    );
    assert_eq!(
        view.resolve("src/app.ts", "evil", Syntax::Require),
        external("evil")
    );
    assert_eq!(
        view.resolve("src/app.ts", "pkg", Syntax::Import),
        unresolved("package_target_invalid")
    );
    assert_eq!(
        view.resolve("../outside.ts", "./src/local", Syntax::Import),
        unresolved("importer_outside_repository")
    );
    assert_eq!(
        view.resolve("src/app.ts", "fs/promises", Syntax::Import),
        ModuleTarget::Builtin {
            name: "node:fs/promises".to_owned()
        }
    );
    assert_eq!(
        view.resolve("src/app.ts", "node:anything", Syntax::Require),
        ModuleTarget::Builtin {
            name: "node:anything".to_owned()
        }
    );
}

#[test]
fn longest_paths_prefix_exact_keys_fallbacks_and_base_url() {
    let view = resolver(
        &[
            "app.ts",
            "root/exact.ts",
            "root/prefix/other.ts",
            "root/general/other.ts",
            "root/pre/a.tail.ts",
            "root/tie/a.ts",
            "root/leaf.ts",
            "root/targets/exact.js",
            "root/targets/exact.ts",
        ],
        &[(
            "tsconfig.json",
            r#"{
          "compilerOptions": {
            "baseUrl":"./root",
            "paths": {
              "@/*":["general/*"],
              "@/sub/*":["missing/*","prefix/*"],
              "@/sub/special":["exact"],
              "~/*tail":["pre/*.tail"],
              "~/*":["tie/*"],
              "explicit":["targets/exact.js"],
              "broken":["no-such-file"],
            }
          }
        }"#,
        )],
    );
    for (specifier, path, basis) in [
        ("@/sub/special", "root/exact.ts", "tsconfig_paths"),
        ("@/sub/other", "root/prefix/other.ts", "tsconfig_paths"),
        ("@/other", "root/general/other.ts", "tsconfig_paths"),
        ("~/atail", "root/pre/a.tail.ts", "tsconfig_paths"),
        ("leaf", "root/leaf.ts", "tsconfig_base_url"),
        ("explicit", "root/targets/exact.js", "tsconfig_paths"),
    ] {
        assert_eq!(
            view.resolve("app.ts", specifier, Syntax::Import),
            file(path, basis)
        );
    }
    assert_eq!(
        view.resolve("app.ts", "broken", Syntax::Import),
        unresolved("tsconfig_path_not_found")
    );
    assert_eq!(
        view.resolve("app.ts", "third-party/utils", Syntax::Import),
        external("third-party")
    );
}

#[test]
fn chooses_the_nearest_project_that_includes_the_importer() {
    let view = resolver(
        &[
            "src/entry.ts",
            "src/nested/excluded.ts",
            "src/nested/explicit.ts",
            "src/nested/checked.ts",
            "src/nested/deep/hidden/a.ts",
            "src/nested/.hidden.ts",
            "other/only.ts",
            "other/unowned.ts",
            "top/target.ts",
            "src/nested/target.ts",
        ],
        &[
            (
                "tsconfig.json",
                r#"{"include":["src"],"compilerOptions":{"paths":{"alias":["top/target"]}}}"#,
            ),
            (
                "src/nested/tsconfig.json",
                r#"{"files":["explicit.ts"],"include":["**/*.ts"],"exclude":["excluded.ts","**/hidden","explicit.ts"],"compilerOptions":{"paths":{"alias":["target"]}}}"#,
            ),
            (
                "other/tsconfig.json",
                r#"{"files":["only.ts"],"compilerOptions":{"paths":{"alias":["../top/target"]}}}"#,
            ),
        ],
    );
    for path in [
        "src/entry.ts",
        "src/nested/excluded.ts",
        "src/nested/deep/hidden/a.ts",
    ] {
        assert_eq!(view.project_config(path), Some("tsconfig.json"));
        assert_eq!(
            view.resolve(path, "alias", Syntax::Import),
            file("top/target.ts", "tsconfig_paths")
        );
    }
    for path in ["src/nested/explicit.ts", "src/nested/checked.ts"] {
        assert_eq!(view.project_config(path), Some("src/nested/tsconfig.json"));
        assert_eq!(
            view.resolve(path, "alias", Syntax::Import),
            file("src/nested/target.ts", "tsconfig_paths")
        );
    }
    assert_eq!(view.project_config("src/nested/.hidden.ts"), None);
    assert_eq!(view.project_config("other/unowned.ts"), None);
    assert_eq!(
        view.project_config("other/only.ts"),
        Some("other/tsconfig.json")
    );
}

#[test]
fn inherits_config_values_with_their_origins_and_expands_config_dir_in_the_leaf() {
    let view = resolver(
        &[
            "app/src/main.ts",
            "shared/pkg/entry.ts",
            "app/local/file.ts",
            "common/fallback.ts",
            "shared/pkg/generated/template.ts",
            "app/src/template.ts",
        ],
        &[
            ("shared/pkg/package.json", r#"{"name":"@tsconfig/node20"}"#),
            (
                "shared/pkg/tsconfig.json",
                r#"{"extends":"./base","compilerOptions":{"moduleResolution":"Bundler","baseUrl":"."}}"#,
            ),
            (
                "shared/pkg/base.json",
                r#"{"compilerOptions":{"paths":{"provided":["entry"],"template":["${configDir}/src/template"]}}}"#,
            ),
            (
                "common/tsconfig.base.json",
                r#"{"compilerOptions":{"rootDirs":["../app/src","."],"paths":{"provided":["fallback"]}}}"#,
            ),
            (
                "app/tsconfig.json",
                r#"{"extends":["../common/tsconfig.base.json","@tsconfig/node20/tsconfig.json"],"include":["src"]}"#,
            ),
        ],
    );
    assert_eq!(
        view.project_config("app/src/main.ts"),
        Some("app/tsconfig.json")
    );
    assert_eq!(
        view.resolve("app/src/main.ts", "provided", Syntax::Import),
        file("shared/pkg/entry.ts", "tsconfig_paths")
    );
    assert_eq!(
        view.resolve("app/src/main.ts", "template", Syntax::Import),
        file("app/src/template.ts", "tsconfig_paths")
    );
    assert_eq!(
        view.resolve("app/src/main.ts", "./fallback", Syntax::Import),
        file("common/fallback.ts", "tsconfig_root_dirs")
    );
    assert!(view.config_issues().is_empty());
}

#[test]
fn extends_stops_at_missing_external_bases_and_cycles_with_a_diagnostic() {
    let view = resolver(
        &["app/main.ts", "app/local.ts", "other/main.ts"],
        &[
            (
                "app/tsconfig.json",
                r#"{"extends":"@tsconfig/node20/tsconfig.json","compilerOptions":{"paths":{"local":["local"]}}}"#,
            ),
            ("other/tsconfig.json", r#"{"extends":"./first.json"}"#),
            ("other/first.json", r#"{"extends":"./tsconfig.json"}"#),
        ],
    );
    assert_eq!(
        view.config_issues(),
        &[
            ConfigIssue {
                config: "app/tsconfig.json".to_owned(),
                reference: "@tsconfig/node20/tsconfig.json".to_owned(),
                reason: "extends_outside_repository"
            },
            ConfigIssue {
                config: "other/first.json".to_owned(),
                reference: "./tsconfig.json".to_owned(),
                reason: "extends_cycle"
            },
        ]
    );
    assert_eq!(
        view.resolve("app/main.ts", "local", Syntax::Import),
        file("app/local.ts", "tsconfig_paths")
    );
    assert_eq!(
        view.resolve("app/main.ts", "./local", Syntax::Import),
        file("app/local.ts", "relative")
    );
    assert_eq!(
        view.resolve("app/main.ts", "unknown", Syntax::Import),
        unresolved("extends_outside_repository")
    );
    assert_eq!(
        view.resolve("other/main.ts", "unknown", Syntax::Import),
        unresolved("extends_cycle")
    );
}

#[test]
fn resolves_workspace_exports_in_object_order_with_syntax_and_custom_conditions() {
    let view = resolver(
        &[
            "app/main.ts",
            "plain/main.ts",
            "dual/import.mts",
            "dual/require.cts",
            "dual/types.d.ts",
            "dual/node.ts",
            "dual/browser.ts",
            "dual/plain.ts",
        ],
        &[
            (
                "app/tsconfig.json",
                r#"{"compilerOptions":{"moduleResolution":"bundler","customConditions":["browser"]}}"#,
            ),
            (
                "dual/package.json",
                r#"{
              "name":"@local/dual",
              "exports":{
                ".":{"import":"./import.mjs","require":"./require.cjs","types":"./types.d.ts"},
                "./typed":{"types":"./types.d.ts","default":"./plain.js"},
                "./order":{"default":"./plain.js","types":"./types.d.ts"},
                "./custom":{"browser":"./browser.js","node":"./node.js","default":"./plain.js"},
                "./no-match":{"custom":"./plain.js"},
                "./fallback":[{"import":"./absent.js"},"./plain.js"]
              }
            }"#,
            ),
        ],
    );
    for (from, specifier, syntax, path) in [
        (
            "app/main.ts",
            "@local/dual",
            Syntax::Import,
            "dual/import.mts",
        ),
        (
            "app/main.ts",
            "@local/dual",
            Syntax::Require,
            "dual/require.cts",
        ),
        (
            "app/main.ts",
            "@local/dual/typed",
            Syntax::Require,
            "dual/types.d.ts",
        ),
        (
            "app/main.ts",
            "@local/dual/order",
            Syntax::Import,
            "dual/plain.ts",
        ),
        (
            "app/main.ts",
            "@local/dual/custom",
            Syntax::Import,
            "dual/browser.ts",
        ),
        (
            "plain/main.ts",
            "@local/dual/custom",
            Syntax::Import,
            "dual/node.ts",
        ),
        (
            "app/main.ts",
            "@local/dual/fallback",
            Syntax::Import,
            "dual/plain.ts",
        ),
    ] {
        assert_eq!(
            view.resolve(from, specifier, syntax),
            file(path, "workspace_package")
        );
    }
    assert_eq!(
        view.resolve("app/main.ts", "@local/dual/no-match", Syntax::Import),
        unresolved("no_matching_export_condition")
    );
}

#[test]
fn selects_one_export_pattern_and_keeps_null_subpaths_closed() {
    let view = resolver(
        &[
            "app.ts",
            "pkg/general/sub/foo.js.ts",
            "pkg/special/foo.ts",
            "pkg/general/open.ts",
            "pkg/general/private.ts",
            "pkg/general/closed/foo.ts",
            "pkg/unexported.ts",
        ],
        &[(
            "pkg/package.json",
            r#"{
          "name":"pkg",
          "exports":{
            "./*":"./general/*.js",
            "./sub/*.js":"./special/*.js",
            "./private":null,
            "./closed/*":null
          }
        }"#,
        )],
    );
    assert_eq!(
        view.resolve("app.ts", "pkg/open", Syntax::Import),
        file("pkg/general/open.ts", "workspace_package")
    );
    assert_eq!(
        view.resolve("app.ts", "pkg/sub/foo.js", Syntax::Import),
        file("pkg/special/foo.ts", "workspace_package")
    );
    for specifier in ["pkg/private", "pkg/closed/foo", "pkg"] {
        assert_eq!(
            view.resolve("app.ts", specifier, Syntax::Import),
            unresolved("package_subpath_not_exported")
        );
    }
    assert_eq!(
        view.resolve("app.ts", "pkg/unexported", Syntax::Import),
        unresolved("package_target_not_found")
    );
}

#[test]
fn imports_are_package_scoped_and_can_alias_packages() {
    let view = resolver(
        &[
            "pkg/src/a.ts",
            "pkg/src/b.cts",
            "pkg/src/d/topic.ts",
            "pkg/nested/own.ts",
            "lib/index.ts",
        ],
        &[
            (
                "pkg/package.json",
                r##"{
              "name":"pkg","imports":{
                "#a":{"import":"./src/a.js","require":"./src/b.cjs"},
                "#data/*":"./src/d/*.js",
                "#data/private":null,
                "#lib":"library",
                "#external":"@remote/other/feature",
                "#invalid":"../lib/index.ts",
                "#alias":"#a",
                "#cycle":"#cycle"
              }
            }"##,
            ),
            ("pkg/nested/package.json", "{}"),
            (
                "lib/package.json",
                r#"{"name":"library","exports":"./index.ts"}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#a", Syntax::Import),
        file("pkg/src/a.ts", "package_imports")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#a", Syntax::Require),
        file("pkg/src/b.cts", "package_imports")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#data/topic", Syntax::Import),
        file("pkg/src/d/topic.ts", "package_imports")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#data/private", Syntax::Import),
        unresolved("package_import_not_defined")
    );
    assert_eq!(
        view.resolve("pkg/nested/own.ts", "#a", Syntax::Import),
        unresolved("package_import_not_defined")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#lib", Syntax::Import),
        file("lib/index.ts", "workspace_package")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#external", Syntax::Import),
        external("@remote/other")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#invalid", Syntax::Import),
        unresolved("package_target_invalid")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#alias", Syntax::Require),
        file("pkg/src/b.cts", "package_imports")
    );
    assert_eq!(
        view.resolve("pkg/src/a.ts", "#cycle", Syntax::Import),
        unresolved("package_import_cycle")
    );
}

#[test]
fn distinguishes_node_esm_extension_requirements_from_node10_and_bundler() {
    let view = resolver(
        &[
            "app/main.ts",
            "app/local.ts",
            "app/sub/index.ts",
            "bundle/main.ts",
            "bundle/local.ts",
            "bundle/sub/index.ts",
            "legacy/main.ts",
            "legacy/sub/index.ts",
        ],
        &[
            (
                "app/tsconfig.json",
                r#"{"compilerOptions":{"module":"node16"}}"#,
            ),
            (
                "bundle/tsconfig.json",
                r#"{"compilerOptions":{"moduleResolution":"Bundler"}}"#,
            ),
            (
                "legacy/tsconfig.json",
                r#"{"compilerOptions":{"moduleResolution":"node10"}}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("app/main.ts", "./local", Syntax::Import),
        unresolved("explicit_extension_required")
    );
    assert_eq!(
        view.resolve("app/main.ts", "./sub", Syntax::Import),
        unresolved("explicit_extension_required")
    );
    assert_eq!(
        view.resolve("app/main.ts", "./local.js", Syntax::Import),
        file("app/local.ts", "relative")
    );
    assert_eq!(
        view.resolve("app/main.ts", "./sub", Syntax::Require),
        file("app/sub/index.ts", "relative")
    );
    assert_eq!(
        view.resolve("bundle/main.ts", "./local", Syntax::Import),
        file("bundle/local.ts", "relative")
    );
    assert_eq!(
        view.resolve("bundle/main.ts", "./sub", Syntax::Import),
        file("bundle/sub/index.ts", "relative")
    );
    assert_eq!(
        view.resolve("legacy/main.ts", "./sub", Syntax::Import),
        file("legacy/sub/index.ts", "relative")
    );
}

#[test]
fn module_suffixes_keep_order_and_require_an_explicit_empty_fallback() {
    let view = resolver(
        &[
            "test/app.ts",
            "test/platform.ts",
            "test/platform.native.ts",
            "test/plugin.native.d.mts",
            "test/plain.ts",
            "test/normal/uses.ts",
            "test/normal/base.ts",
        ],
        &[
            (
                "test/tsconfig.json",
                r#"{"compilerOptions":{"moduleSuffixes":[".native",".browser"]}}"#,
            ),
            (
                "test/normal/tsconfig.json",
                r#"{"compilerOptions":{"moduleSuffixes":[".native",""]}}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("test/app.ts", "./platform.js", Syntax::Import),
        file("test/platform.native.ts", "relative")
    );
    assert_eq!(
        view.resolve("test/app.ts", "./plugin.mjs", Syntax::Import),
        file("test/plugin.native.d.mts", "relative")
    );
    assert_eq!(
        view.resolve("test/app.ts", "./plain", Syntax::Import),
        unresolved("module_not_found")
    );
    assert_eq!(
        view.resolve("test/normal/uses.ts", "./base", Syntax::Import),
        file("test/normal/base.ts", "relative")
    );
}

#[test]
fn supports_javascript_only_projects_and_check_js_membership() {
    let view = resolver(
        &[
            "web/index.js",
            "web/src/a.jsx",
            "web/disallowed/entry.js",
            "web/disallowed/src/a.js",
            "tests/test.cjs",
            "tests/dep.cjs",
        ],
        &[
            (
                "web/jsconfig.json",
                r#"{"compilerOptions":{"baseUrl":"src"}}"#,
            ),
            (
                "web/disallowed/tsconfig.json",
                r#"{"compilerOptions":{"allowJs":false,"baseUrl":"src"}}"#,
            ),
            (
                "tests/tsconfig.json",
                r#"{"compilerOptions":{"checkJs":true}}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("web/index.js", "a", Syntax::Import),
        file("web/src/a.jsx", "tsconfig_base_url")
    );
    assert_eq!(
        view.project_config("web/disallowed/entry.js"),
        Some("web/jsconfig.json")
    );
    assert_eq!(
        view.resolve("web/disallowed/entry.js", "a", Syntax::Import),
        file("web/src/a.jsx", "tsconfig_base_url")
    );
    assert_eq!(
        view.project_config("tests/test.cjs"),
        Some("tests/tsconfig.json")
    );
    assert_eq!(
        view.resolve("tests/test.cjs", "./dep.cjs", Syntax::Require),
        file("tests/dep.cjs", "relative")
    );
}

#[test]
fn maps_unbuilt_outputs_to_source_using_out_and_declaration_roots() {
    let view = resolver(
        &[
            "app.ts",
            "pkg/src/index.ts",
            "pkg/src/sub/tool.mts",
            "pkg/dist/compiled.js",
            "pkg/dist/fossil.js",
            "pkg/src/compiled.ts",
            "pkg/src/upper.native.ts",
        ],
        &[
            (
                "tsconfig.json",
                r#"{"compilerOptions":{"moduleResolution":"bundler","moduleSuffixes":[".native",""],"paths":{"out":["pkg/dist/index.js"]}}}"#,
            ),
            (
                "pkg/tsconfig.json",
                r#"{"include":["src"],"compilerOptions":{"rootDir":"src","outDir":"dist","declarationDir":"types"}}"#,
            ),
            (
                "pkg/package.json",
                r#"{
              "name":"pkg","exports":{
                ".":"./dist/index.js","./compiled":"./dist/compiled.js","./tool":"./types/sub/tool.d.mts",
                "./fossil":"./dist/fossil.js","./absent":"./dist/absent.d.ts","./upper":"./dist/upper.js"
              }
            }"#,
            ),
        ],
    );
    for (specifier, path) in [
        ("pkg", "pkg/src/index.ts"),
        ("pkg/compiled", "pkg/src/compiled.ts"),
        ("pkg/tool", "pkg/src/sub/tool.mts"),
        ("./pkg/dist/compiled.js", "pkg/src/compiled.ts"),
        ("pkg/upper", "pkg/src/upper.native.ts"),
        ("out", "pkg/src/index.ts"),
    ] {
        assert_eq!(
            view.resolve("app.ts", specifier, Syntax::Import),
            file(path, "build_to_source"),
            "{specifier}"
        );
    }
    for specifier in ["pkg/fossil", "pkg/absent", "./pkg/dist/fossil.js"] {
        assert_eq!(
            view.resolve("app.ts", specifier, Syntax::Import),
            unresolved("build_output_without_source"),
            "{specifier}"
        );
    }
}

#[test]
fn project_references_disambiguate_shared_output_directories_transitively() {
    let view = resolver(
        &[
            "apps/entry/main.ts",
            "libs/a/src/index.ts",
            "libs/b/src/index.ts",
            "outside.ts",
        ],
        &[
            (
                "apps/entry/tsconfig.json",
                r#"{"references":[{"path":"../../libs/solution.json"}]}"#,
            ),
            (
                "libs/solution.json",
                r#"{"files":[],"references":[{"path":"./a"}]}"#,
            ),
            (
                "libs/a/tsconfig.json",
                r#"{"compilerOptions":{"rootDir":"src","outDir":"../../shared/dist"}}"#,
            ),
            (
                "libs/b/tsconfig.json",
                r#"{"compilerOptions":{"rootDir":"src","outDir":"../../shared/dist"}}"#,
            ),
            (
                "shared/package.json",
                r#"{"name":"shared","exports":"./dist/index.js"}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("apps/entry/main.ts", "shared", Syntax::Import),
        file("libs/a/src/index.ts", "build_to_source")
    );
    assert_eq!(
        view.resolve("outside.ts", "shared", Syntax::Import),
        unresolved("ambiguous_build_output")
    );
}

#[test]
fn jsonc_preserves_quoted_commas_urls_and_unused_json_values() {
    let view = resolver(
        &["app.ts", "pkg/with, }.ts", "src/*.ts"],
        &[
            (
                "tsconfig.json",
                "\u{feff}{/* allow aliases */\"compilerOptions\":{\"paths\":{\"@/*\":[\"src/*\",],},},// end\r\n}",
            ),
            (
                "pkg/package.json",
                r#"{"name":"pkg","exports":"./with, }.ts","description":"https://example.com/\ud800","number":1e400,}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("app.ts", "pkg", Syntax::Import),
        file("pkg/with, }.ts", "workspace_package")
    );
    assert_eq!(
        view.resolve("app.ts", "@/$&", Syntax::Import),
        file("src/*.ts", "tsconfig_paths")
    );
}

#[test]
fn ambiguous_workspace_names_do_not_depend_on_manifest_order() {
    let view = resolver(
        &[
            "app.ts",
            "left/index.ts",
            "right/index.ts",
            "right/from.ts",
            "right/src/internal.ts",
        ],
        &[
            (
                "left/package.json",
                r#"{"name":"duplicate","main":"index.ts"}"#,
            ),
            (
                "right/package.json",
                r#"{"name":"duplicate","main":"index.ts"}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("app.ts", "duplicate", Syntax::Import),
        unresolved("ambiguous_workspace_package")
    );
    assert_eq!(
        view.resolve("right/from.ts", "duplicate", Syntax::Import),
        file("right/index.ts", "workspace_package")
    );
    assert_eq!(
        view.resolve("right/from.ts", "duplicate/internal", Syntax::Import),
        unresolved("workspace_entry_not_found")
    );
}

#[test]
fn project_references_identify_duplicate_workspace_manifests() {
    let view = resolver(
        &[
            "app/src/main.ts",
            "one/src/index.ts",
            "another/src/index.ts",
        ],
        &[
            ("app/tsconfig.json", r#"{"references":[{"path":"../one"}]}"#),
            ("one/tsconfig.json", "{}"),
            (
                "one/package.json",
                r#"{"name":"workspace","exports":"./src/index.js"}"#,
            ),
            (
                "another/package.json",
                r#"{"name":"workspace","exports":"./src/index.js"}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("app/src/main.ts", "workspace", Syntax::Import),
        file("one/src/index.ts", "workspace_package")
    );
}

#[test]
fn declarations_can_redirect_to_javascript_sources_in_an_allow_js_project() {
    let view = resolver(
        &["app.ts", "pkg/lib/src.js", "pkg/build/src.d.ts"],
        &[
            (
                "pkg/jsconfig.json",
                r#"{"include":["lib"],"compilerOptions":{"rootDir":"lib","outDir":"build"}}"#,
            ),
            (
                "pkg/package.json",
                r#"{"name":"pkg","types":"build/src.d.ts"}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("app.ts", "pkg", Syntax::Import),
        file("pkg/lib/src.js", "build_to_source")
    );
}

#[test]
fn selected_build_artifacts_without_sources_remain_unresolved() {
    let view = resolver(
        &["app.ts", "pkg/dist/index.js", "pkg/src/alternate.ts"],
        &[
            (
                "pkg/tsconfig.json",
                r#"{"compilerOptions":{"rootDir":"src","outDir":"dist"}}"#,
            ),
            (
                "pkg/package.json",
                r#"{"name":"pkg","exports":{"import":"./dist/index.js","default":"./src/alternate.js"}}"#,
            ),
        ],
    );
    assert_eq!(
        view.resolve("app.ts", "pkg", Syntax::Import),
        unresolved("build_output_without_source")
    );
}

#[test]
fn redundant_separators_in_export_targets_keep_the_package_root() {
    let view = resolver(
        &["app.ts", "entry.ts", "pkg/entry.ts", "pkg/missing.ts"],
        &[(
            "pkg/package.json",
            r#"{"name":"pkg","exports":{".":".//entry.js","./trailing":"./missing.js/"}}"#,
        )],
    );
    assert_eq!(
        view.resolve("app.ts", "pkg", Syntax::Import),
        file("pkg/entry.ts", "workspace_package")
    );
    assert_eq!(
        view.resolve("app.ts", "pkg/trailing", Syntax::Import),
        unresolved("package_target_not_found")
    );
}

#[test]
fn nested_declaration_directory_does_not_own_javascript_outputs() {
    let view = resolver(
        &["app.ts", "pkg/src/types/tool.ts", "pkg/src/root.ts"],
        &[(
            "pkg/tsconfig.json",
            r#"{"compilerOptions":{"rootDir":"src","outDir":"dist","declarationDir":"dist/types"}}"#,
        )],
    );
    assert_eq!(
        view.resolve("app.ts", "./pkg/dist/types/tool.js", Syntax::Import),
        file("pkg/src/types/tool.ts", "build_to_source")
    );
    assert_eq!(
        view.resolve("app.ts", "./pkg/dist/types/root.d.ts", Syntax::Import),
        file("pkg/src/root.ts", "build_to_source")
    );
}

#[test]
fn explicit_paths_mappings_apply_to_absolute_specifiers() {
    let view = ModuleResolver::with_repository_root(
        "/checkout",
        ["src/app.ts", "src/tool.ts", "src/direct.ts"],
        [(
            "tsconfig.json",
            r#"{"compilerOptions":{"paths":{"/legacy/*":["src/*"],"/checkout/src/direct.js":["absent"]}}}"#,
        )],
    );
    assert_eq!(
        view.resolve("src/app.ts", "/legacy/tool.js", Syntax::Import),
        file("src/tool.ts", "tsconfig_paths")
    );
    assert_eq!(
        view.resolve("src/app.ts", "/checkout/src/direct.js", Syntax::Import),
        file("src/direct.ts", "relative")
    );
}
