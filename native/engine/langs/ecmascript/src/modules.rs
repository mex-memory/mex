//! ECMAScript module resolution over one immutable repository view.
//!
//! The caller supplies paths and config text captured by discovery. Resolution
//! uses those inputs alone, including for project inheritance and package maps.

mod config;
mod output;
mod package;

use mex_graph_core::facts::ImportForm;

use config::{Options, ProjectIndex, ResolutionKind};
use output::OutputIndex;
use package::{PackageIndex, PackageManifest, PackagePattern, evaluate_target, package_name};
use std::collections::HashSet;
use std::sync::LazyLock;

type Reason = &'static str;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Syntax {
    /// Import and export declarations, and type references without a mode override.
    Import,
    /// Require calls and import-equals declarations with an external module reference.
    Require,
    /// Type-only imports with an explicit import mode in Node16/NodeNext.
    ForceImport,
    /// Type-only imports with an explicit require mode in Node16/NodeNext.
    ForceRequire,
}

impl From<ImportForm> for Syntax {
    fn from(form: ImportForm) -> Self {
        match form {
            ImportForm::CommonJs => Self::Require,
            ImportForm::TypeWithImportMode => Self::ForceImport,
            ImportForm::TypeWithRequireMode => Self::ForceRequire,
            _ => Self::Import,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolutionMode {
    Import,
    Require,
}

impl ResolutionMode {
    fn condition(self) -> &'static str {
        match self {
            Self::Import => "import",
            Self::Require => "require",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModuleTarget {
    File { path: String, basis: &'static str },
    Namespace { dir: String, basis: &'static str },
    Ambiguous { paths: Vec<String> },
    External { pkg: String },
    Builtin { name: String },
    Unresolved { reason: &'static str },
}

/// A config edge that could not be followed. The project's own options and
/// other available bases still apply.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ConfigIssue {
    pub config: String,
    pub reference: String,
    pub reason: &'static str,
}

pub struct ModuleResolver {
    paths: RepositoryPaths,
    files: HashSet<String>,
    packages: PackageIndex,
    projects: ProjectIndex,
    outputs: OutputIndex,
    defaults: Options,
}

impl ModuleResolver {
    /// Build once per repository snapshot. File and config keys are POSIX
    /// paths relative to its root. Additional JSON config texts may be
    /// supplied for explicitly named bases and project references.
    ///
    /// Without a physical root, absolute specifiers are rooted at the view
    /// (for example, `/src/app.js` is looked up as `src/app.js`).
    pub fn new<'a>(
        files: impl IntoIterator<Item = &'a str>,
        configs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        Self::build(RepositoryPaths { root: None }, files, configs)
    }

    /// Bind absolute file candidates to an explicit absolute POSIX repository
    /// root. A specifier can also match a project's explicit `paths` mapping.
    pub fn with_repository_root<'a>(
        root: &str,
        files: impl IntoIterator<Item = &'a str>,
        configs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        assert!(root.starts_with('/'), "repository root must be absolute");
        Self::build(
            RepositoryPaths {
                root: Some(root.trim_end_matches('/').to_owned()),
            },
            files,
            configs,
        )
    }

    fn build<'a>(
        paths: RepositoryPaths,
        files: impl IntoIterator<Item = &'a str>,
        configs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        let files: HashSet<_> = files.into_iter().filter_map(index_path).collect();
        let configs = config::parse_configs(configs);
        let mut directories = HashSet::new();
        for path in files.iter().chain(configs.keys()) {
            let mut dir = dirname(path);
            loop {
                if !directories.insert(dir.to_owned()) || dir.is_empty() {
                    break;
                }
                dir = dirname(dir);
            }
        }
        let packages = PackageIndex::new(&configs, directories);
        let projects = ProjectIndex::new(&paths, &files, &configs, &packages);
        let outputs = OutputIndex::new(&projects);
        Self {
            paths,
            files,
            packages,
            projects,
            outputs,
            defaults: Options::default(),
        }
    }

    /// The nearest configured project that includes this file in its root
    /// file set. In the same directory, standard config names take precedence
    /// over variants. Referenced variants precede other variants.
    pub fn project_config(&self, from_path: &str) -> Option<&str> {
        self.projects
            .for_file(from_path)
            .map(|(_, project)| project.path.as_str())
    }

    pub fn config_issues(&self) -> &[ConfigIssue] {
        &self.projects.issues
    }

    /// Resolve one literal import using the supplied syntax. Both hits and
    /// misses use the same prepared indexes, which may be shared by threads.
    pub fn resolve(&self, from_path: &str, specifier: &str, syntax: Syntax) -> ModuleTarget {
        if !valid_input_path(from_path) {
            return ModuleTarget::Unresolved {
                reason: "importer_outside_repository",
            };
        }
        if let Some(builtin) = builtin(specifier) {
            return builtin;
        }
        if specifier.is_empty() || specifier.contains(['\\', '\0']) {
            return ModuleTarget::Unresolved {
                reason: "invalid_module_specifier",
            };
        }
        let project = self.projects.for_file(from_path);
        let options = project.map_or(&self.defaults, |(_, project)| &project.options);
        let from_dir = dirname(from_path);
        let lookup = Lookup {
            resolver: self,
            project_id: project.map(|(id, _)| id),
            options,
            config_issue: project.and_then(|(_, project)| project.inheritance_issue),
            mode: match syntax {
                Syntax::Require => ResolutionMode::Require,
                Syntax::Import if options.kind == ResolutionKind::Node16 => {
                    self.implied_node_format(from_path, from_dir)
                }
                Syntax::ForceRequire if options.kind == ResolutionKind::Node16 => {
                    ResolutionMode::Require
                }
                _ => ResolutionMode::Import,
            },
        };
        let result = if is_path(specifier) {
            lookup.resolve_relative(from_dir, specifier)
        } else {
            lookup.resolve_bare(from_dir, specifier, 0)
        };
        result.unwrap_or_else(|reason| ModuleTarget::Unresolved { reason })
    }

    fn implied_node_format(&self, path: &str, dir: &str) -> ResolutionMode {
        match extension(path) {
            Some(".mts" | ".d.mts" | ".mjs") => ResolutionMode::Import,
            Some(".ts" | ".d.ts" | ".tsx" | ".js" | ".jsx")
                if self
                    .packages
                    .scope(dir)
                    .is_some_and(|manifest| manifest.esm) =>
            {
                ResolutionMode::Import
            }
            _ => ResolutionMode::Require,
        }
    }
}

#[derive(Clone, Copy)]
enum Extensions {
    Typed,
    Runtime,
    All,
}

impl Extensions {
    fn allows(self, extension: &str) -> bool {
        match self {
            Self::Typed => !matches!(extension, ".js" | ".jsx" | ".mjs" | ".cjs" | ".json"),
            Self::Runtime => matches!(extension, ".js" | ".jsx" | ".mjs" | ".cjs" | ".json"),
            Self::All => true,
        }
    }
}

const LEGACY_EXTENSIONS: &[Extensions] = &[Extensions::Typed, Extensions::Runtime];
const MODERN_EXTENSIONS: &[Extensions] = &[Extensions::All];
const TS_EXTENSIONS: &[&str] = &[".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx", ".mts", ".cts"];
const JS_EXTENSIONS: &[&str] = &[".js", ".jsx", ".mjs", ".cjs"];
const IMPLICIT: &[&str] = &[".ts", ".tsx", ".d.ts", ".js", ".jsx"];

#[derive(Clone, Copy)]
struct Found<'a> {
    path: &'a str,
    mapped: bool,
}

impl Found<'_> {
    fn target(self, basis: &'static str) -> ModuleTarget {
        ModuleTarget::File {
            path: self.path.to_owned(),
            basis: if self.mapped {
                "build_to_source"
            } else {
                basis
            },
        }
    }
}

type Search<'a> = Result<Option<Found<'a>>, Reason>;

#[derive(Clone, Copy)]
struct Lookup<'a> {
    resolver: &'a ModuleResolver,
    project_id: Option<usize>,
    options: &'a Options,
    config_issue: Option<Reason>,
    mode: ResolutionMode,
}

impl<'a> Lookup<'a> {
    fn extension_passes(self) -> &'static [Extensions] {
        match self.options.kind {
            ResolutionKind::Classic | ResolutionKind::Node10 => LEGACY_EXTENSIONS,
            ResolutionKind::Node16 | ResolutionKind::Bundler => MODERN_EXTENSIONS,
        }
    }

    fn strict_esm(self) -> bool {
        self.options.kind == ResolutionKind::Node16 && self.mode == ResolutionMode::Import
    }

    fn resolve_relative(self, from_dir: &str, specifier: &str) -> Result<ModuleTarget, Reason> {
        let base = self.resolver.paths.target(from_dir, specifier);
        let alias = specifier
            .starts_with('/')
            .then(|| self.options.paths.find(specifier))
            .flatten();
        let mut alias_reason = "tsconfig_path_not_found";
        let trailing_slash = specifier.ends_with('/') || matches!(basename(specifier), "." | "..");
        let root_dirs = &self.options.root_dirs;
        let virtual_root = base
            .as_ref()
            .ok()
            .filter(|_| alias.is_none())
            .and_then(|base| {
                root_dirs
                    .iter()
                    .filter_map(|root| strip_directory(base, root).map(|suffix| (root, suffix)))
                    .max_by_key(|(root, _)| root.len())
            });

        for &extensions in self.extension_passes() {
            if let Some((capture, targets)) = alias
                && let Some(found) =
                    self.load_alias(capture, targets, extensions, &mut alias_reason)?
            {
                return Ok(found.target("tsconfig_paths"));
            }
            let Ok(base) = &base else { continue };
            if let Some(found) = self.load_path(base, extensions, trailing_slash)? {
                return Ok(found.target("relative"));
            }
            if let Some((root, suffix)) = virtual_root {
                for other in root_dirs.iter().filter(|dir| *dir != root) {
                    let candidate = join_path(other, suffix);
                    if let Some(found) = self.load_path(&candidate, extensions, trailing_slash)? {
                        return Ok(found.target("tsconfig_root_dirs"));
                    }
                }
            }
        }
        let base = base?;
        let reason = if self.strict_esm() && (trailing_slash || file_parts(&base).is_none()) {
            "explicit_extension_required"
        } else {
            "module_not_found"
        };
        Err(self.missing_path(&base, reason))
    }

    fn resolve_bare(
        self,
        from_dir: &str,
        specifier: &str,
        depth: usize,
    ) -> Result<ModuleTarget, Reason> {
        let alias = self.options.paths.find(specifier);
        let mut alias_reason = "tsconfig_path_not_found";
        for &extensions in self.extension_passes() {
            if let Some((capture, targets)) = alias {
                if let Some(found) =
                    self.load_alias(capture, targets, extensions, &mut alias_reason)?
                {
                    return Ok(found.target("tsconfig_paths"));
                }
            } else if let Some(base_url) = &self.options.base_url
                && let Ok(candidate) = self.resolver.paths.target(base_url, specifier)
                && let Some(found) =
                    self.load_path(&candidate, extensions, specifier.ends_with('/'))?
            {
                return Ok(found.target("tsconfig_base_url"));
            }
        }

        if specifier.starts_with('#') {
            return self.resolve_imports(from_dir, specifier, depth);
        }
        if specifier.contains(':') {
            return Err("unsupported_module_scheme");
        }
        let Some((name, subpath)) = package_name(specifier) else {
            return Err("invalid_package_specifier");
        };
        if let Some(package) = self.workspace_package(from_dir, name)? {
            return self.resolve_package(package, subpath);
        }
        if alias.is_some() {
            return Err(self.config_issue.unwrap_or(alias_reason));
        }
        if let Some(reason) = self.config_issue {
            return Err(reason);
        }
        Ok(ModuleTarget::External {
            pkg: name.to_owned(),
        })
    }

    fn load_alias(
        self,
        capture: Option<&str>,
        targets: &[String],
        extensions: Extensions,
        hint: &mut Reason,
    ) -> Search<'a> {
        for target in targets {
            let substituted = capture
                .filter(|text| !text.is_empty())
                .map(|text| package::replace_stars(target, text, false));
            let candidate = match config::config_path(
                &self.resolver.paths,
                self.options.paths_base.as_deref(),
                &self.options.config_dir,
                substituted.as_deref().unwrap_or(target),
            ) {
                Ok(candidate) => candidate,
                Err(reason) => {
                    *hint = reason;
                    continue;
                }
            };
            // A literal path mapping with a recognized extension is
            // checked before file-extension substitution.
            if extension(target).is_some()
                && let Some(found) = self.probe(&candidate, Extensions::All)?
            {
                return Ok(Some(found));
            }
            if let Some(found) = self.load_path(&candidate, extensions, target.ends_with('/'))? {
                return Ok(Some(found));
            }
            *hint = self.missing_path(&candidate, hint);
        }
        Ok(None)
    }

    fn workspace_package(
        self,
        from_dir: &str,
        name: &str,
    ) -> Result<Option<&'a PackageManifest>, Reason> {
        let packages = &self.resolver.packages;
        match packages.workspace(from_dir, name) {
            Ok(package) => Ok(package),
            Err(reason) => {
                let projects = &self.resolver.projects;
                let from = self.project_id.ok_or(reason)?;
                let mut closest: Option<(&PackageManifest, usize)> = None;
                let mut ambiguous = false;
                for (&id, &distance) in projects.reference_distances(from) {
                    let Some(package) = packages
                        .scope(dirname(&projects.projects[id].path))
                        .filter(|manifest| manifest.has_name(name))
                    else {
                        continue;
                    };
                    match closest {
                        Some((prior, rank)) if rank == distance => {
                            ambiguous |= prior.dir != package.dir
                        }
                        Some((_, rank)) if rank < distance => {}
                        _ => {
                            closest = Some((package, distance));
                            ambiguous = false;
                        }
                    }
                }
                if ambiguous {
                    Err(reason)
                } else {
                    closest.map(|(package, _)| Some(package)).ok_or(reason)
                }
            }
        }
    }

    fn resolve_imports(
        self,
        from_dir: &str,
        specifier: &str,
        depth: usize,
    ) -> Result<ModuleTarget, Reason> {
        if depth >= 64 {
            return Err("package_import_cycle");
        }
        if specifier == "#" || specifier.starts_with("#/") {
            return Err("invalid_package_import");
        }
        if !self.options.package_imports {
            return Err("package_imports_disabled");
        }
        let package = self
            .resolver
            .packages
            .scope(from_dir)
            .ok_or("package_import_not_defined")?;
        let selected = package
            .imports
            .as_ref()
            .and_then(|map| map.select(specifier))
            .ok_or("package_import_not_defined")?;
        self.resolve_map(package, selected, Some(depth))
    }

    fn resolve_package(
        self,
        package: &PackageManifest,
        subpath: Option<&str>,
    ) -> Result<ModuleTarget, Reason> {
        if self.options.package_exports
            && let Some(exports) = &package.exports
        {
            let requested = subpath.map_or_else(|| ".".to_owned(), |rest| format!("./{rest}"));
            let selected = exports
                .select(&requested)?
                .ok_or("package_subpath_not_exported")?;
            return self.resolve_map(package, selected, None);
        }
        let candidate = subpath
            .map(|rest| self.resolver.paths.target(&package.dir, rest))
            .transpose()?;
        if candidate
            .as_ref()
            .is_some_and(|path| strip_directory(path, &package.dir).is_none())
        {
            return Err("package_target_outside_package");
        }

        for &extensions in self.extension_passes() {
            let found = if let Some(candidate) = &candidate {
                self.load_path(
                    candidate,
                    extensions,
                    subpath.is_some_and(|s| s.ends_with('/')),
                )?
            } else {
                // A bare package root can use its legacy entry point even in
                // Node ESM mode. An ESM subpath gets no implicit index probe.
                self.load_directory(&package.dir, extensions, Some(package), self.strict_esm())?
            };
            if let Some(found) = found {
                return Ok(found.target("workspace_package"));
            }
        }
        Err(self.missing_path(
            candidate.as_deref().unwrap_or(&package.dir),
            "workspace_entry_not_found",
        ))
    }

    fn resolve_map(
        self,
        package: &PackageManifest,
        selected: PackagePattern<'_>,
        imports_depth: Option<usize>,
    ) -> Result<ModuleTarget, Reason> {
        let missing = if imports_depth.is_some() {
            "package_import_not_defined"
        } else {
            "package_subpath_not_exported"
        };
        evaluate_target(
            selected.value,
            &|condition| self.matches_condition(condition),
            missing,
            &mut |target| {
                let target = selected.substitute(target)?;
                if !target.starts_with("./") {
                    if let Some(depth) = imports_depth
                        && !is_path(&target)
                    {
                        if let Some(builtin) = builtin(&target) {
                            return Ok(builtin);
                        }
                        return self.resolve_bare(&package.dir, &target, depth + 1);
                    }
                    return Err("package_target_invalid");
                }
                let candidate = package::package_path(&self.resolver.paths, &package.dir, &target)?;
                match self.load_manifest_file(&candidate, Extensions::All) {
                    Ok(Some(found)) => Ok(found.target(if imports_depth.is_some() {
                        "package_imports"
                    } else {
                        "workspace_package"
                    })),
                    Ok(None) => Err(self.missing(&candidate, "package_target_not_found")),
                    // The selected file is a build artifact without a usable
                    // source. Preserve that result across condition fallbacks.
                    Err(reason) => Ok(ModuleTarget::Unresolved { reason }),
                }
            },
        )
    }

    fn matches_condition(self, condition: &str) -> bool {
        matches!(condition, "types" | "node" | "default")
            || condition == self.mode.condition()
            || self.options.custom_conditions.contains(condition)
    }

    fn load_path(self, path: &str, extensions: Extensions, directory_only: bool) -> Search<'a> {
        let implicit = !self.strict_esm();
        if !directory_only && let Some(found) = self.load_file(path, extensions, implicit)? {
            return Ok(Some(found));
        }
        if implicit
            && self.options.kind != ResolutionKind::Classic
            && self.resolver.packages.has_directory(path)
        {
            return self.load_directory(path, extensions, self.resolver.packages.at(path), false);
        }
        // The build directory need not exist when the workspace is unbuilt.
        if implicit
            && self.options.kind != ResolutionKind::Classic
            && self.resolver.outputs.contains(path)
        {
            return self.load_file(&join_path(path, "index"), extensions, true);
        }
        Ok(None)
    }

    fn load_directory(
        self,
        path: &str,
        extensions: Extensions,
        package: Option<&PackageManifest>,
        esm_package_root: bool,
    ) -> Search<'a> {
        if let Some(entry) = package.and_then(|manifest| manifest.entry(extensions.allows(".d.ts")))
            && let Ok(candidate) = self.resolver.paths.target(path, entry)
            && candidate != path
        {
            if let Some(found) = self.load_manifest_file(&candidate, extensions)? {
                return Ok(Some(found));
            }
            // TypeScript does not recursively load a second manifest from a
            // main/types target. The target may itself be an index directory.
            if !esm_package_root || package.is_some_and(|manifest| !manifest.esm) {
                if let Some(found) = self.load_file(&candidate, extensions, true)? {
                    return Ok(Some(found));
                }
                if let Some(found) =
                    self.load_file(&join_path(&candidate, "index"), extensions, true)?
                {
                    return Ok(Some(found));
                }
            }
        }
        self.load_file(
            &join_path(
                path,
                if esm_package_root {
                    "index.js"
                } else {
                    "index"
                },
            ),
            extensions,
            !esm_package_root,
        )
    }

    fn load_manifest_file(self, path: &str, extensions: Extensions) -> Search<'a> {
        if let Some(ext) = extension(path)
            && TS_EXTENSIONS.contains(&ext)
        {
            if extensions.allows(ext) {
                return self.probe(path, extensions);
            }
            return Ok(None);
        }
        self.load_file(path, extensions, false)
    }

    fn load_file(self, path: &str, extensions: Extensions, implicit: bool) -> Search<'a> {
        if path.is_empty() {
            return Ok(None);
        }
        if let Some((stem, ext)) = file_parts(path) {
            // As with local package maps in TypeScript, an explicit output
            // path can redirect before any on-disk extension is considered.
            if output::is_emitted(ext)
                && let Some(found) = self.probe_candidate(path, extensions, true)?
            {
                return Ok(Some(found));
            }
            let candidates: &[&str] = match ext {
                ".mjs" | ".mts" | ".d.mts" => &[".mts", ".d.mts", ".mjs"],
                ".cjs" | ".cts" | ".d.cts" => &[".cts", ".d.cts", ".cjs"],
                ".json" => &[".d.json.ts", ".json"],
                ".tsx" | ".jsx" => &[".tsx", ".ts", ".d.ts", ".jsx", ".js"],
                ".ts" | ".d.ts" | ".js" => IMPLICIT,
                ext => {
                    if let Some(found) =
                        self.probe_extension(stem, &format!(".d{ext}.ts"), extensions)?
                    {
                        return Ok(Some(found));
                    }
                    &[]
                }
            };
            for candidate in candidates {
                if let Some(found) = self.probe_extension(stem, candidate, extensions)? {
                    return Ok(Some(found));
                }
            }
        }
        if implicit {
            for ext in IMPLICIT {
                if let Some(found) = self.probe_extension(path, ext, extensions)? {
                    return Ok(Some(found));
                }
            }
        }
        Ok(None)
    }

    fn probe_extension(self, stem: &str, ext: &str, extensions: Extensions) -> Search<'a> {
        if ext == ".json" && !self.options.resolve_json {
            return Ok(None);
        }
        if !extensions.allows(ext) {
            return Ok(None);
        }
        self.probe(&format!("{stem}{ext}"), extensions)
    }

    fn probe(self, path: &str, extensions: Extensions) -> Search<'a> {
        self.probe_candidate(path, extensions, false)
    }

    fn probe_candidate(self, path: &str, extensions: Extensions, mapping_only: bool) -> Search<'a> {
        let (stem, ext) =
            extension(path).map_or((path, ""), |ext| (&path[..path.len() - ext.len()], ext));
        for suffix in &self.options.module_suffixes {
            let changed;
            let candidate = if suffix.is_empty() {
                path
            } else {
                changed = format!("{stem}{suffix}{ext}");
                &changed
            };
            let source_extensions = if extensions.allows(ext) {
                Extensions::All
            } else {
                extensions
            };
            if let Some(found) = self.map_output(candidate, source_extensions)? {
                return Ok(Some(found));
            }
            if !mapping_only && let Some(present) = self.resolver.files.get(candidate) {
                if output::is_emitted(ext) && self.resolver.outputs.contains(candidate) {
                    return Err("build_output_without_source");
                }
                return Ok(Some(Found {
                    path: present,
                    mapped: false,
                }));
            }
        }
        Ok(None)
    }

    fn map_output(self, path: &str, extensions: Extensions) -> Search<'a> {
        self.resolver
            .outputs
            .source_for(
                path,
                self.project_id,
                &self.resolver.projects,
                &self.resolver.files,
                extensions,
            )
            .map(|path| path.map(|path| Found { path, mapped: true }))
    }

    fn missing(self, path: &str, fallback: Reason) -> Reason {
        if self.resolver.outputs.contains(path) {
            "build_output_without_source"
        } else {
            fallback
        }
    }

    fn missing_path(self, path: &str, fallback: Reason) -> Reason {
        if let Some(manifest) = self.resolver.packages.at(path) {
            for entry in [manifest.entry(true), manifest.entry(false)]
                .into_iter()
                .flatten()
            {
                if let Ok(candidate) = self.resolver.paths.target(path, entry)
                    && self.resolver.outputs.contains(&candidate)
                {
                    return "build_output_without_source";
                }
            }
        }
        self.missing(path, fallback)
    }
}

struct RepositoryPaths {
    root: Option<String>,
}

impl RepositoryPaths {
    fn target(&self, base: &str, path: &str) -> Result<String, Reason> {
        if path.contains(['\\', '\0']) {
            return Err("invalid_repository_path");
        }
        if path.starts_with('/') {
            let rooted = if let Some(root) = &self.root {
                if root == path {
                    ""
                } else {
                    path.strip_prefix(root)
                        .and_then(|rest| rest.strip_prefix('/'))
                        .ok_or("outside_repository")?
                }
            } else {
                path.trim_start_matches('/')
            };
            resolve_rel("", rooted)
        } else {
            resolve_rel(base, path)
        }
    }
}

fn dirname(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn join_path(base: &str, rel: &str) -> String {
    if base.is_empty() {
        rel.to_owned()
    } else if rel.is_empty() {
        base.to_owned()
    } else {
        format!("{base}/{rel}")
    }
}

fn strip_directory<'a>(path: &'a str, dir: &str) -> Option<&'a str> {
    if dir.is_empty() {
        Some(path)
    } else {
        path.strip_prefix(dir)?.strip_prefix('/')
    }
}

fn is_dependency_component(part: &str) -> bool {
    part.eq_ignore_ascii_case("node_modules")
}

fn resolve_rel(base: &str, relative: &str) -> Result<String, Reason> {
    // Most probes are simple concatenations. Normalize only when a path
    // actually contains a dot segment or redundant separator.
    if !relative
        .split('/')
        .any(|part| matches!(part, "" | "." | "..") || is_dependency_component(part))
    {
        return Ok(join_path(base, relative));
    }
    let mut parts: Vec<_> = if base.is_empty() {
        Vec::new()
    } else {
        base.split('/').collect()
    };
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or("outside_repository")?;
            }
            part if is_dependency_component(part) => return Err("node_modules_target"),
            part => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

fn valid_input_path(path: &str) -> bool {
    !path.contains(['\\', '\0'])
        && !path
            .split('/')
            .any(|part| matches!(part, "" | "." | "..") || is_dependency_component(part))
}

fn index_path(path: &str) -> Option<String> {
    valid_input_path(path).then(|| path.to_owned())
}

fn is_path(specifier: &str) -> bool {
    matches!(specifier, "." | "..")
        || specifier.starts_with('/')
        || specifier.starts_with("./")
        || specifier.starts_with("../")
}

fn extension(path: &str) -> Option<&'static str> {
    TS_EXTENSIONS
        .iter()
        .chain(JS_EXTENSIONS)
        .copied()
        .find(|ext| path.ends_with(ext))
        .or_else(|| path.ends_with(".json").then_some(".json"))
}

fn file_parts(path: &str) -> Option<(&str, &str)> {
    let extent = extension(path).or_else(|| {
        let name = basename(path);
        name.rfind('.').map(|index| &name[index..])
    })?;
    Some((&path[..path.len() - extent.len()], extent))
}

const NODE_BUILTIN_MODULES: &str = "_http_agent _http_client _http_common _http_incoming _http_outgoing _http_server _stream_duplex _stream_passthrough _stream_readable _stream_transform _stream_wrap _stream_writable _tls_common _tls_wrap assert assert/strict async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https inspector inspector/promises module net os path path/posix path/win32 perf_hooks process punycode querystring readline readline/promises repl stream stream/consumers stream/promises stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8 vm wasi worker_threads zlib";

fn builtin(specifier: &str) -> Option<ModuleTarget> {
    static NAMES: LazyLock<HashSet<&str>> =
        LazyLock::new(|| NODE_BUILTIN_MODULES.split(' ').collect());
    if specifier.starts_with("node:") {
        Some(ModuleTarget::Builtin {
            name: specifier.to_owned(),
        })
    } else if NAMES.contains(specifier) {
        Some(ModuleTarget::Builtin {
            name: format!("node:{specifier}"),
        })
    } else {
        None
    }
}

#[cfg(test)]
mod tests;
