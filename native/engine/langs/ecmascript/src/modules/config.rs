use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::OnceLock;

use serde_json::{Map, Value, value::RawValue};

use super::package::{PackageIndex, evaluate_target, package_name, package_path, utf16_len};
use super::{
    ConfigIssue, JS_EXTENSIONS, Reason, RepositoryPaths, TS_EXTENSIONS, basename, dirname,
    extension, join_path, strip_directory, valid_input_path,
};

const CONFIG_DIR: &str = "${configDir}";
const OPTION_KEYS: &[&str] = &[
    "allowJs",
    "baseUrl",
    "checkJs",
    "composite",
    "customConditions",
    "declarationDir",
    "module",
    "moduleResolution",
    "moduleSuffixes",
    "noEmit",
    "outDir",
    "paths",
    "resolveJsonModule",
    "resolvePackageJsonExports",
    "resolvePackageJsonImports",
    "rootDir",
    "rootDirs",
    "target",
];
const SPEC_KEYS: &[&str] = &["files", "include", "exclude"];
const CONFIG_KEYS: &[&str] = &["extends", "references", "files", "include", "exclude"];
const PACKAGE_KEYS: &[&str] = &[
    "name", "type", "types", "typings", "main", "tsconfig", "exports", "imports",
];

pub(super) fn parse_configs<'a>(
    configs: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> BTreeMap<String, Option<Value>> {
    configs
        .into_iter()
        .filter(|(path, _)| valid_input_path(path))
        .map(|(path, text)| {
            (
                path.to_owned(),
                parse_jsonc(text, basename(path) == "package.json"),
            )
        })
        .collect()
}

fn parse_jsonc(text: &str, package: bool) -> Option<Value> {
    let clean = sanitize_jsonc(text)?;
    match serde_json::from_str::<Value>(&clean) {
        Ok(value) => value.is_object().then_some(value),
        Err(_) => {
            // An unused string can legally contain a lone UTF-16 surrogate.
            // Decode only resolution fields if the full document cannot be
            // represented in UTF-8. A used invalid field fails the config.
            let fields: BTreeMap<String, &RawValue> = serde_json::from_str(&clean).ok()?;
            let keys = if package { PACKAGE_KEYS } else { CONFIG_KEYS };
            let mut result = decode_fields(&fields, keys)?;
            if !package && let Some(raw) = fields.get("compilerOptions") {
                let options: BTreeMap<String, &RawValue> = serde_json::from_str(raw.get()).ok()?;
                result.insert(
                    "compilerOptions".to_owned(),
                    Value::Object(decode_fields(&options, OPTION_KEYS)?),
                );
            }
            Some(Value::Object(result))
        }
    }
}

fn decode_fields(
    fields: &BTreeMap<String, &RawValue>,
    keys: &[&str],
) -> Option<Map<String, Value>> {
    keys.iter()
        .filter_map(|&key| {
            fields.get(key).map(|raw| {
                serde_json::from_str(raw.get())
                    .ok()
                    .map(|value| (key.to_owned(), value))
            })
        })
        .collect()
}

fn sanitize_jsonc(text: &str) -> Option<String> {
    let mut bytes = text.trim_start_matches('\u{feff}').as_bytes().to_vec();
    let mut cursor = 0;
    let mut in_string = false;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'"' => in_string = !in_string,
            b'\\' if in_string => cursor += 1,
            b'/' if !in_string && bytes.get(cursor + 1) == Some(&b'/') => {
                while cursor < bytes.len() && !matches!(bytes[cursor], b'\r' | b'\n') {
                    bytes[cursor] = b' ';
                    cursor += 1;
                }
                continue;
            }
            b'/' if !in_string && bytes.get(cursor + 1) == Some(&b'*') => {
                let end = cursor
                    + 2
                    + bytes[cursor + 2..]
                        .windows(2)
                        .position(|pair| pair == b"*/")?;
                bytes[cursor..end + 2].fill(b' ');
                cursor = end + 2;
                continue;
            }
            _ => {}
        }
        cursor += 1;
    }

    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index += 1;
                while index < bytes.len() && bytes[index] != b'"' {
                    index += if bytes[index] == b'\\' { 2 } else { 1 };
                }
            }
            b',' if bytes[index + 1..]
                .iter()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|byte| matches!(byte, b'}' | b']')) =>
            {
                bytes[index] = b' ';
            }
            _ => {}
        }
        index += 1;
    }
    String::from_utf8(bytes).ok()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ResolutionKind {
    Classic,
    Node10,
    Node16,
    Bundler,
}

pub(super) struct Options {
    pub(super) kind: ResolutionKind,
    pub(super) config_dir: String,
    pub(super) base_url: Option<String>,
    pub(super) paths_base: Option<String>,
    pub(super) paths: Paths,
    pub(super) root_dirs: Vec<String>,
    pub(super) module_suffixes: Vec<String>,
    pub(super) custom_conditions: HashSet<String>,
    pub(super) package_exports: bool,
    pub(super) package_imports: bool,
    pub(super) resolve_json: bool,
    pub(super) allow_js: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            kind: ResolutionKind::Node10,
            config_dir: String::new(),
            base_url: None,
            paths_base: None,
            paths: Paths::default(),
            root_dirs: Vec::new(),
            module_suffixes: vec![String::new()],
            custom_conditions: HashSet::new(),
            package_exports: true,
            package_imports: true,
            resolve_json: false,
            allow_js: true,
        }
    }
}

impl Options {
    fn new(config: &MergedConfig, dir: &str, paths: &RepositoryPaths) -> Self {
        let option = |key| config.options.get(key).map(|located| &located.value);
        let enabled = |key| option(key).and_then(Value::as_bool);
        let string = |key| {
            option(key)
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
        };
        let option_paths = |key| {
            config
                .options
                .get(key)
                .into_iter()
                .flat_map(|located| strings(&located.value).map(move |path| (located, path)))
                .filter_map(|(located, path)| located.path(paths, dir, path).ok())
                .collect()
        };
        let kind = match string("moduleResolution").as_deref() {
            Some("classic") => ResolutionKind::Classic,
            Some("node" | "node10") => ResolutionKind::Node10,
            Some("node16" | "nodenext") => ResolutionKind::Node16,
            Some("bundler") => ResolutionKind::Bundler,
            _ => match string("module").as_deref() {
                Some("node16" | "node18" | "node20" | "nodenext") => ResolutionKind::Node16,
                Some("preserve") => ResolutionKind::Bundler,
                Some("commonjs") => ResolutionKind::Node10,
                Some(_) => ResolutionKind::Classic,
                None if string("target")
                    .is_some_and(|target| !matches!(target.as_str(), "es3" | "es5")) =>
                {
                    ResolutionKind::Classic
                }
                None => ResolutionKind::Node10,
            },
        };
        let base_url = config.dir_option("baseUrl", paths, dir);
        let paths_base = if option("baseUrl").is_some() {
            base_url.clone()
        } else {
            config.options.get("paths").map(|paths| paths.dir.clone())
        };
        let module_suffixes: Vec<_> = option("moduleSuffixes")
            .into_iter()
            .flat_map(strings)
            .filter(|suffix| !suffix.contains(['/', '\\', '\0']))
            .map(str::to_owned)
            .collect();
        Self {
            kind,
            config_dir: dir.to_owned(),
            paths_base,
            base_url,
            paths: Paths::new(option("paths")),
            root_dirs: option_paths("rootDirs"),
            module_suffixes: if module_suffixes.is_empty() {
                vec![String::new()]
            } else {
                module_suffixes
            },
            custom_conditions: option("customConditions")
                .into_iter()
                .flat_map(strings)
                .map(str::to_owned)
                .collect(),
            // Workspace maps are explicit repository evidence in every mode.
            package_exports: enabled("resolvePackageJsonExports").unwrap_or(true),
            package_imports: enabled("resolvePackageJsonImports").unwrap_or(true),
            resolve_json: enabled("resolveJsonModule").unwrap_or(kind == ResolutionKind::Bundler),
            allow_js: enabled("allowJs").unwrap_or_else(|| enabled("checkJs").unwrap_or(false)),
        }
    }
}

#[derive(Default)]
pub(super) struct Paths {
    exact: HashMap<String, Vec<String>>,
    patterns: Vec<AliasPattern>,
}

struct AliasPattern {
    prefix: String,
    suffix: String,
    prefix_len: usize,
    targets: Vec<String>,
}

impl Paths {
    fn new(value: Option<&Value>) -> Self {
        let mut paths = Self::default();
        if let Some(object) = value.and_then(Value::as_object) {
            for (pattern, value) in object {
                if !value.is_array() {
                    continue;
                }
                let targets = strings(value).map(str::to_owned).collect();
                if let Some((prefix, suffix)) = pattern.split_once('*') {
                    if !suffix.contains('*') {
                        paths.patterns.push(AliasPattern {
                            prefix: prefix.to_owned(),
                            suffix: suffix.to_owned(),
                            prefix_len: utf16_len(prefix),
                            targets,
                        });
                    }
                } else {
                    paths.exact.insert(pattern.to_owned(), targets);
                }
            }
        }
        // Stable sort preserves declaration order when prefixes tie.
        paths
            .patterns
            .sort_by_key(|pattern| std::cmp::Reverse(pattern.prefix_len));
        paths
    }

    pub(super) fn find<'a>(&'a self, name: &'a str) -> Option<(Option<&'a str>, &'a [String])> {
        if let Some(targets) = self.exact.get(name) {
            return Some((None, targets));
        }
        self.patterns.iter().find_map(|pattern| {
            let capture = name
                .strip_prefix(&pattern.prefix)?
                .strip_suffix(&pattern.suffix)?;
            Some((Some(capture), pattern.targets.as_slice()))
        })
    }
}

pub(super) fn config_path(
    paths: &RepositoryPaths,
    origin: Option<&str>,
    leaf: &str,
    value: &str,
) -> Result<String, Reason> {
    if let Some(rest) = value.strip_prefix(CONFIG_DIR)
        && (rest.is_empty() || rest.starts_with('/'))
    {
        return paths.target(leaf, rest.trim_start_matches('/'));
    }
    let base = if value.starts_with('/') {
        ""
    } else {
        origin.ok_or("outside_repository")?
    };
    paths.target(base, value)
}

pub(super) struct ProjectIndex {
    pub(super) projects: Vec<Project>,
    file_projects: HashMap<String, usize>,
    pub(super) issues: Vec<ConfigIssue>,
}

pub(super) struct Project {
    pub(super) path: String,
    pub(super) options: Options,
    pub(super) inheritance_issue: Option<Reason>,
    pub(super) references: Vec<usize>,
    reference_distances: OnceLock<HashMap<usize, usize>>,
    pub(super) root: String,
    pub(super) out_dir: Option<String>,
    pub(super) declaration_dir: Option<String>,
    pub(super) no_emit: bool,
}

impl ProjectIndex {
    pub(super) fn new(
        paths: &RepositoryPaths,
        files: &HashSet<String>,
        configs: &BTreeMap<String, Option<Value>>,
        packages: &PackageIndex,
    ) -> Self {
        let mut pending: VecDeque<_> = configs
            .keys()
            .filter(|path| is_project(basename(path)))
            .cloned()
            .collect();
        let mut project_paths: BTreeSet<_> = pending.iter().cloned().collect();
        let mut reference_paths = BTreeMap::new();
        let mut loader = ConfigLoader {
            paths,
            configs,
            packages,
            merged: HashMap::new(),
            bases: HashSet::new(),
            issues: BTreeSet::new(),
        };
        while let Some(path) = pending.pop_front() {
            let references = loader.references(&path);
            for reference in &references {
                if project_paths.insert(reference.clone()) {
                    pending.push_back(reference.clone());
                }
            }
            loader.load(&path, &mut Vec::new()).ok();
            reference_paths.insert(path, references);
        }

        let ids: HashMap<_, _> = project_paths
            .iter()
            .enumerate()
            .map(|(id, key)| (key, id))
            .collect();
        let referenced: HashSet<_> = reference_paths.values().flatten().collect();
        let mut sorted_files: Vec<_> = files
            .iter()
            .filter(|path| extension(path).is_some())
            .map(String::as_str)
            .collect();
        sorted_files.sort_unstable();
        let mut projects: Vec<Project> = Vec::new();
        let mut selected = HashMap::new();
        for path in &project_paths {
            let dir = dirname(path);
            let own_options;
            let merged = if let Some(merged) = loader.merged.get(path) {
                merged
            } else {
                own_options = MergedConfig {
                    issue: Some("invalid_project_config"),
                    ..MergedConfig::default()
                };
                &own_options
            };
            let options = Options::new(merged, dir, paths);
            let out_dir = merged.dir_option("outDir", paths, dir);
            let declaration_dir = merged.dir_option("declarationDir", paths, dir);
            let no_emit = merged
                .options
                .get("noEmit")
                .and_then(|located| located.value.as_bool())
                .unwrap_or(false);
            let members = project_members(
                paths,
                files,
                &sorted_files,
                dir,
                merged,
                &options,
                [&out_dir, &declaration_dir],
            );
            let root = merged.dir_option("rootDir", paths, dir).unwrap_or_else(|| {
                if merged
                    .options
                    .get("composite")
                    .is_some_and(|located| located.value == true)
                {
                    dir.to_owned()
                } else {
                    common_source_root(&members).unwrap_or(dir).to_owned()
                }
            });
            let id = projects.len();
            for file in members {
                let preference = project_preference(
                    file,
                    path,
                    referenced.contains(path),
                    loader.bases.contains(path),
                );
                let record = selected.entry(file).or_insert((id, preference));
                if preference < record.1 {
                    *record = (id, preference);
                }
            }
            projects.push(Project {
                path: path.clone(),
                options,
                inheritance_issue: merged.issue,
                references: reference_paths[path]
                    .iter()
                    .map(|reference| ids[reference])
                    .collect(),
                reference_distances: OnceLock::new(),
                root,
                out_dir,
                declaration_dir,
                no_emit,
            });
        }
        Self {
            projects,
            file_projects: selected
                .into_iter()
                .map(|(path, (id, _))| (path.to_owned(), id))
                .collect(),
            issues: loader.issues.into_iter().collect(),
        }
    }

    pub(super) fn for_file(&self, path: &str) -> Option<(usize, &Project)> {
        let &id = self.file_projects.get(path)?;
        Some((id, &self.projects[id]))
    }

    pub(super) fn reference_distances(&self, from: usize) -> &HashMap<usize, usize> {
        self.projects[from].reference_distances.get_or_init(|| {
            let mut distances = HashMap::from([(from, 0)]);
            let mut pending = VecDeque::from([(from, 0)]);
            while let Some((id, distance)) = pending.pop_front() {
                for &reference in &self.projects[id].references {
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        distances.entry(reference)
                    {
                        entry.insert(distance + 1);
                        pending.push_back((reference, distance + 1));
                    }
                }
            }
            distances
        })
    }
}

type Preference = (usize, bool, usize, bool, bool);

fn project_preference(file: &str, config: &str, referenced: bool, base: bool) -> Preference {
    let dir = dirname(config);
    let file_dirs = dirname(file).split('/').filter(|s| !s.is_empty());
    let project_dirs = dir.split('/').filter(|s| !s.is_empty());
    let shared = file_dirs
        .clone()
        .zip(project_dirs.clone())
        .take_while(|(a, b)| a == b)
        .count();
    let file_depth = file_dirs.count();
    let project_depth = project_dirs.count();
    let canonical = match basename(config) {
        "tsconfig.json" => 0,
        "jsconfig.json" => 1,
        _ => 2,
    };
    (
        file_depth + project_depth - 2 * shared,
        shared != project_depth,
        canonical,
        !referenced,
        base,
    )
}

fn is_project(name: &str) -> bool {
    name == "jsconfig.json" || (name.starts_with("tsconfig") && name.ends_with(".json"))
}

#[derive(Clone)]
struct Located {
    dir: String,
    value: Value,
}

impl Located {
    fn path(&self, paths: &RepositoryPaths, leaf: &str, value: &str) -> Result<String, Reason> {
        config_path(paths, Some(&self.dir), leaf, value)
    }
}

#[derive(Clone, Default)]
struct MergedConfig {
    options: BTreeMap<String, Located>,
    specs: BTreeMap<String, Located>,
    issue: Option<Reason>,
}

impl MergedConfig {
    fn dir_option(&self, key: &str, paths: &RepositoryPaths, dir: &str) -> Option<String> {
        let located = self.options.get(key)?;
        located.path(paths, dir, located.value.as_str()?).ok()
    }
}

struct ConfigLoader<'a> {
    paths: &'a RepositoryPaths,
    configs: &'a BTreeMap<String, Option<Value>>,
    packages: &'a PackageIndex,
    merged: HashMap<String, MergedConfig>,
    bases: HashSet<String>,
    issues: BTreeSet<ConfigIssue>,
}

impl ConfigLoader<'_> {
    fn load(&mut self, path: &str, stack: &mut Vec<String>) -> Result<(), Reason> {
        if stack.iter().any(|prior| prior == path) {
            return Err("extends_cycle");
        }
        if stack.len() >= 128 {
            return Err("extends_depth_exceeded");
        }
        if self.merged.contains_key(path) {
            return Ok(());
        }
        let Some(json) = self.configs.get(path).and_then(Option::as_ref) else {
            self.issue(path, "", "invalid_project_config");
            return Err("invalid_project_config");
        };
        let dir = dirname(path);
        let mut config = MergedConfig::default();
        stack.push(path.to_owned());
        for reference in json["extends"]
            .as_str()
            .into_iter()
            .chain(strings(&json["extends"]))
        {
            let inherited = self.extends_path(dir, reference).and_then(|base| {
                self.bases.insert(base.clone());
                self.load(&base, stack)?;
                Ok(base)
            });
            match inherited {
                Ok(base) => {
                    let base = &self.merged[&base];
                    config.options.extend(base.options.clone());
                    config.specs.extend(base.specs.clone());
                    config.issue = config.issue.or(base.issue);
                }
                Err(reason) => {
                    self.issue(path, reference, reason);
                    config.issue = config.issue.or(Some(reason));
                }
            }
        }
        stack.pop();
        if basename(path) == "jsconfig.json" {
            config.options.insert(
                "allowJs".to_owned(),
                Located {
                    dir: dir.to_owned(),
                    value: Value::Bool(true),
                },
            );
        }
        for &key in OPTION_KEYS {
            if let Some(value) = json["compilerOptions"].get(key) {
                config.options.insert(
                    key.to_owned(),
                    Located {
                        dir: dir.to_owned(),
                        value: value.clone(),
                    },
                );
            }
        }
        for &key in SPEC_KEYS {
            if let Some(value) = json.get(key).filter(|value| value.is_array()) {
                config.specs.insert(
                    key.to_owned(),
                    Located {
                        dir: dir.to_owned(),
                        value: value.clone(),
                    },
                );
            }
        }
        self.merged.insert(path.to_owned(), config);
        Ok(())
    }

    fn extends_path(&self, dir: &str, reference: &str) -> Result<String, Reason> {
        if super::is_path(reference) {
            let path = self
                .paths
                .target(dir, reference)
                .map_err(|_| "extends_outside_repository")?;
            return self.config_file(&path).ok_or("extends_not_found");
        }
        let (name, subpath) = package_name(reference).ok_or("extends_outside_repository")?;
        let package = self
            .packages
            .workspace(dir, name)?
            .ok_or("extends_outside_repository")?;
        if let Some(exports) = &package.exports {
            let requested = subpath.map_or_else(|| ".".to_owned(), |rest| format!("./{rest}"));
            let selected = exports.select(&requested)?.ok_or("extends_not_found")?;
            return evaluate_target(
                selected.value,
                &|key| matches!(key, "require" | "node" | "types" | "default"),
                "extends_not_found",
                &mut |target| {
                    let target = selected.substitute(target)?;
                    let path = package_path(self.paths, &package.dir, &target)?;
                    self.config_file(&path).ok_or("extends_not_found")
                },
            );
        }
        let entry = subpath
            .or(package.tsconfig.as_deref())
            .unwrap_or("tsconfig.json");
        let path = self
            .paths
            .target(&package.dir, entry)
            .map_err(|_| "extends_outside_repository")?;
        self.config_file(&path).ok_or("extends_not_found")
    }

    fn config_file(&self, path: &str) -> Option<String> {
        if self.configs.contains_key(path) {
            return Some(path.to_owned());
        }
        let suffixed = format!("{path}.json");
        (!path.ends_with(".json") && self.configs.contains_key(&suffixed)).then_some(suffixed)
    }

    fn references(&mut self, config: &str) -> Vec<String> {
        let references = self
            .configs
            .get(config)
            .and_then(Option::as_ref)
            .and_then(|json| json["references"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|entry| entry["path"].as_str());
        let mut paths = Vec::new();
        for reference in references {
            match self.paths.target(dirname(config), reference) {
                Ok(path) => {
                    let candidate = if path.ends_with(".json") {
                        path
                    } else {
                        join_path(&path, "tsconfig.json")
                    };
                    if self.configs.contains_key(&candidate) {
                        paths.push(candidate);
                    } else {
                        self.issue(config, reference, "reference_not_found");
                    }
                }
                Err(_) => self.issue(config, reference, "reference_outside_repository"),
            }
        }
        paths
    }

    fn issue(&mut self, config: &str, reference: &str, reason: Reason) {
        self.issues.insert(ConfigIssue {
            config: config.to_owned(),
            reference: reference.to_owned(),
            reason,
        });
    }
}

fn strings(value: &Value) -> impl Iterator<Item = &str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn project_members<'a>(
    paths: &RepositoryPaths,
    files: &'a HashSet<String>,
    sorted: &[&'a str],
    dir: &str,
    config: &MergedConfig,
    options: &Options,
    outputs: [&Option<String>; 2],
) -> HashSet<&'a str> {
    let files_spec = config.specs.get("files");
    let literal: HashSet<_> = files_spec
        .into_iter()
        .flat_map(|spec| strings(&spec.value).filter_map(|path| spec.path(paths, dir, path).ok()))
        .filter_map(|path| files.get(&path).map(String::as_str))
        .collect();

    let includes: Vec<_> = if let Some(spec) = config.specs.get("include") {
        globs(paths, dir, spec, false).collect()
    } else if files_spec.is_none() {
        vec![Glob::new(join_path(dir, "**/*"), false).expect("default glob is valid")]
    } else {
        Vec::new()
    };
    let excludes: Vec<_> = if let Some(spec) = config.specs.get("exclude") {
        globs(paths, dir, spec, true).collect()
    } else {
        outputs
            .into_iter()
            .flatten()
            .map(|path| Glob {
                base: path.clone(),
                parts: Vec::new(),
                exclude: true,
                json: false,
            })
            .collect()
    };

    let mut wildcard = HashSet::new();
    for include in includes {
        let prefix = if include.base.is_empty() {
            String::new()
        } else {
            format!("{}/", include.base)
        };
        let start = sorted.partition_point(|path| *path < prefix.as_str());
        for &file in &sorted[start..] {
            if !file.starts_with(&prefix) {
                break;
            }
            let ext = extension(file).expect("only supported paths are sorted");
            if (TS_EXTENSIONS.contains(&ext)
                || options.allow_js && JS_EXTENSIONS.contains(&ext)
                || options.resolve_json && include.json && ext == ".json")
                && include.matches(file)
                && !excludes.iter().any(|exclude| exclude.matches(file))
            {
                wildcard.insert(file);
            }
        }
    }

    let mut members = literal.clone();
    for &file in &wildcard {
        if extension(file).is_none() {
            continue;
        }
        let shadowed = higher_priorities(file)
            .any(|path| literal.contains(path.as_str()) || wildcard.contains(path.as_str()));
        if !shadowed {
            members.insert(file);
        }
    }
    members
}

fn higher_priorities(path: &str) -> impl Iterator<Item = String> + '_ {
    let ext = extension(path).unwrap_or("");
    let group: &[&str] = match ext {
        ".cts" | ".d.cts" | ".cjs" => &[".cts", ".d.cts", ".cjs"],
        ".mts" | ".d.mts" | ".mjs" => &[".mts", ".d.mts", ".mjs"],
        ".ts" | ".tsx" | ".d.ts" | ".js" | ".jsx" => &[".ts", ".tsx", ".d.ts", ".js", ".jsx"],
        _ => &[],
    };
    group
        .iter()
        .copied()
        .take_while(move |prior| *prior != ext)
        .filter(move |prior| !(*prior == ".d.ts" && JS_EXTENSIONS.contains(&ext)))
        .map(move |prior| format!("{}{prior}", &path[..path.len() - ext.len()]))
}

fn common_source_root<'a>(members: &HashSet<&'a str>) -> Option<&'a str> {
    let mut dirs = members
        .iter()
        .filter(|path| extension(path).is_some_and(|ext| !ext.starts_with(".d.") && ext != ".json"))
        .map(|path| dirname(path));
    let mut root = dirs.next()?;
    for dir in dirs {
        while dir != root && strip_directory(dir, root).is_none() {
            root = dirname(root);
        }
    }
    Some(root)
}

fn globs<'a>(
    paths: &'a RepositoryPaths,
    dir: &'a str,
    spec: &'a Located,
    exclude: bool,
) -> impl Iterator<Item = Glob> + 'a {
    strings(&spec.value)
        .filter(move |text| {
            !text.is_empty()
                && !text
                    .split("/**/")
                    .skip(1)
                    .any(|part| part.split('/').any(|segment| segment == ".."))
        })
        .filter_map(move |text| Glob::new(spec.path(paths, dir, text).ok()?, exclude))
}

struct Glob {
    base: String,
    parts: Vec<String>,
    exclude: bool,
    json: bool,
}

impl Glob {
    fn new(pattern: String, exclude: bool) -> Option<Self> {
        if !exclude && basename(&pattern) == "**" {
            return None;
        }
        let json = pattern.ends_with(".json");
        let mut parts: Vec<_> = pattern
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect();
        if !basename(&pattern).contains(['.', '*', '?']) {
            if exclude && !pattern.contains(['*', '?']) {
                return Some(Self {
                    base: pattern,
                    parts: Vec::new(),
                    exclude,
                    json,
                });
            }
            if !exclude {
                parts.extend(["**".to_owned(), "*".to_owned()]);
            }
        }
        let first_wildcard = parts
            .iter()
            .position(|segment| segment.contains(['*', '?']))
            .unwrap_or_else(|| parts.len().saturating_sub(1));
        let base = parts[..first_wildcard].join("/");
        parts.drain(..first_wildcard);
        Some(Self {
            base,
            parts,
            exclude,
            json,
        })
    }

    fn matches(&self, path: &str) -> bool {
        let Some(rest) = strip_directory(path, &self.base) else {
            return false;
        };
        if self.parts.is_empty() {
            return self.exclude;
        }
        if self.parts.len() == 1 && !self.parts[0].contains(['*', '?']) {
            return rest == self.parts[0]
                || self.exclude && strip_directory(rest, &self.parts[0]).is_some();
        }
        if self.parts.len() == 2 && self.parts[0] == "**" && self.parts[1] == "*" {
            return self.exclude || !rest.ends_with(".min.js") && rest.split('/').all(visible);
        }

        let parts: Vec<_> = rest.split('/').collect();
        // Each state represents a prefix consumed by the previous segments.
        // This bounds work for repeated recursive wildcards.
        let mut reachable = vec![false; parts.len() + 1];
        reachable[0] = true;
        for pattern in &self.parts {
            if pattern == "**" {
                for index in 0..parts.len() {
                    if reachable[index] && (self.exclude || visible(parts[index])) {
                        reachable[index + 1] = true;
                    }
                }
            } else {
                for index in (0..parts.len()).rev() {
                    reachable[index + 1] =
                        reachable[index] && segment_matches(pattern, parts[index], self.exclude);
                }
                reachable[0] = false;
            }
        }
        if self.exclude {
            reachable.into_iter().any(|matched| matched)
        } else {
            reachable[parts.len()]
        }
    }
}

fn visible(segment: &str) -> bool {
    !segment.starts_with('.')
        && !matches!(
            segment,
            "node_modules" | "bower_components" | "jspm_packages"
        )
}

fn segment_matches(pattern: &str, value: &str, exclude: bool) -> bool {
    if !pattern.contains(['*', '?']) {
        return pattern == value;
    }
    if !exclude
        && (!visible(value) && !pattern.starts_with('.')
            || value.ends_with(".min.js") && !pattern.ends_with(".min.js"))
    {
        return false;
    }
    let pattern: Vec<_> = pattern.encode_utf16().collect();
    let value: Vec<_> = value.encode_utf16().collect();
    let (mut p, mut v) = (0, 0);
    let mut star = None;
    while v < value.len() {
        match pattern.get(p).copied() {
            Some(42) => {
                star = Some((p, v));
                p += 1;
            }
            Some(ch) if ch == 63 || ch == value[v] => {
                p += 1;
                v += 1;
            }
            _ => {
                let Some((resume, used)) = star else {
                    return false;
                };
                v = used + 1;
                star = Some((resume, v));
                p = resume + 1;
            }
        }
    }
    pattern[p..].iter().all(|&ch| ch == 42)
}
