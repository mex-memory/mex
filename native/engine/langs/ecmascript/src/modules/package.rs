use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use super::{Reason, RepositoryPaths, basename, dirname, is_dependency_component, is_path};

pub(super) struct PackageIndex {
    manifests: Vec<PackageManifest>,
    by_directory: HashMap<String, usize>,
    by_name: HashMap<String, Vec<usize>>,
    scopes: HashMap<String, Option<usize>>,
}

impl PackageIndex {
    pub(super) fn new(
        configs: &BTreeMap<String, Option<Value>>,
        directories: HashSet<String>,
    ) -> Self {
        let mut manifests = Vec::new();
        let mut by_directory = HashMap::new();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        for (path, manifest) in configs {
            if basename(path) != "package.json" {
                continue;
            }
            let dir = dirname(path);
            let manifest = manifest.as_ref().unwrap_or(&Value::Null);
            let package = PackageManifest {
                dir: dir.to_owned(),
                name: string_field(manifest, "name"),
                types: string_field(manifest, "typings")
                    .or_else(|| string_field(manifest, "types")),
                main: string_field(manifest, "main"),
                tsconfig: string_field(manifest, "tsconfig"),
                esm: manifest["type"] == "module",
                exports: manifest
                    .get("exports")
                    .filter(|value| !value.is_null())
                    .map(PackageExports::new),
                imports: manifest["imports"]
                    .as_object()
                    .map(|object| PackageMap::new(object.clone())),
            };
            let index = manifests.len();
            if let Some(name) = &package.name {
                by_name.entry(name.to_owned()).or_default().push(index);
            }
            by_directory.insert(dir.to_owned(), index);
            manifests.push(package);
        }
        let mut index = Self {
            manifests,
            by_directory,
            by_name,
            scopes: HashMap::new(),
        };
        index.scopes = directories
            .into_iter()
            .map(|dir| {
                let scope = index.find_scope(&dir);
                (dir, scope)
            })
            .collect();
        index
    }

    pub(super) fn has_directory(&self, dir: &str) -> bool {
        self.scopes.contains_key(dir)
    }

    pub(super) fn at(&self, dir: &str) -> Option<&PackageManifest> {
        self.by_directory.get(dir).map(|&id| &self.manifests[id])
    }

    pub(super) fn scope(&self, dir: &str) -> Option<&PackageManifest> {
        self.scopes
            .get(dir)
            .copied()
            .unwrap_or_else(|| self.find_scope(dir))
            .map(|id| &self.manifests[id])
    }

    fn find_scope(&self, mut dir: &str) -> Option<usize> {
        loop {
            if let Some(&id) = self.by_directory.get(dir) {
                return Some(id);
            }
            if dir.is_empty() {
                return None;
            }
            dir = dirname(dir);
        }
    }

    pub(super) fn workspace(
        &self,
        from_dir: &str,
        name: &str,
    ) -> Result<Option<&PackageManifest>, Reason> {
        let Some(ids) = self.by_name.get(name) else {
            return Ok(None);
        };
        if let &[id] = ids.as_slice() {
            return Ok(Some(&self.manifests[id]));
        }
        if let Some(own) = self.scope(from_dir)
            && own.name.as_deref() == Some(name)
        {
            return Ok(Some(own));
        }
        Err("ambiguous_workspace_package")
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub(super) struct PackageManifest {
    pub(super) dir: String,
    name: Option<String>,
    types: Option<String>,
    main: Option<String>,
    pub(super) tsconfig: Option<String>,
    pub(super) esm: bool,
    pub(super) exports: Option<PackageExports>,
    pub(super) imports: Option<PackageMap>,
}

impl PackageManifest {
    pub(super) fn has_name(&self, name: &str) -> bool {
        self.name.as_deref() == Some(name)
    }

    pub(super) fn entry(&self, typed: bool) -> Option<&str> {
        typed
            .then_some(self.types.as_deref())
            .flatten()
            .or(self.main.as_deref())
    }
}

pub(super) enum PackageExports {
    Root(Value),
    Subpaths(PackageMap),
    Invalid,
}

impl PackageExports {
    fn new(value: &Value) -> Self {
        if let Some(object) = value.as_object()
            && object.keys().any(|key| key.starts_with('.'))
        {
            if object
                .keys()
                .any(|key| key != "." && !key.starts_with("./"))
            {
                return Self::Invalid;
            }
            return Self::Subpaths(PackageMap::new(object.clone()));
        }
        Self::Root(value.clone())
    }

    pub(super) fn select<'a>(
        &'a self,
        requested: &'a str,
    ) -> Result<Option<PackagePattern<'a>>, Reason> {
        match self {
            Self::Root(value) if requested == "." => Ok(Some(PackagePattern {
                value,
                capture: "",
                pattern: false,
            })),
            Self::Root(_) => Ok(None),
            Self::Subpaths(map) => Ok(map.select(requested)),
            Self::Invalid => Err("package_exports_invalid"),
        }
    }
}

pub(super) struct PackageMap {
    entries: serde_json::Map<String, Value>,
    expanding_keys: Vec<ExpandingKey>,
}

struct ExpandingKey {
    key: String,
    star: Option<usize>,
    prefix_len: usize,
    len: usize,
}

impl PackageMap {
    fn new(entries: serde_json::Map<String, Value>) -> Self {
        let mut expanding_keys = Vec::new();
        for key in entries.keys() {
            let star = key
                .find('*')
                .filter(|index| !key[index + 1..].contains('*'));
            if star.is_none() && !key.ends_with('/') {
                continue;
            }
            let len = utf16_len(key);
            let prefix_len = star.map_or(len, |index| utf16_len(&key[..index]) + 1);
            expanding_keys.push(ExpandingKey {
                key: key.clone(),
                star,
                prefix_len,
                len,
            });
        }
        expanding_keys.sort_by(|a, b| {
            b.prefix_len
                .cmp(&a.prefix_len)
                .then_with(|| b.star.is_some().cmp(&a.star.is_some()))
                .then_with(|| b.len.cmp(&a.len))
        });
        Self {
            entries,
            expanding_keys,
        }
    }

    pub(super) fn select<'a>(&'a self, requested: &'a str) -> Option<PackagePattern<'a>> {
        if !requested.ends_with('/')
            && !requested.contains('*')
            && let Some(value) = self.entries.get(requested)
        {
            return Some(PackagePattern {
                value,
                capture: "",
                pattern: false,
            });
        }
        for key in &self.expanding_keys {
            let capture = match key.star {
                Some(index) => requested
                    .strip_prefix(&key.key[..index])
                    .and_then(|rest| rest.strip_suffix(&key.key[index + 1..])),
                None => requested.strip_prefix(&key.key),
            };
            if let Some(capture) = capture {
                return Some(PackagePattern {
                    value: &self.entries[&key.key],
                    capture,
                    pattern: key.star.is_some(),
                });
            }
        }
        None
    }
}

pub(super) struct PackagePattern<'a> {
    pub(super) value: &'a Value,
    capture: &'a str,
    pattern: bool,
}

impl PackagePattern<'_> {
    pub(super) fn substitute<'a>(&self, target: &'a str) -> Result<Cow<'a, str>, Reason> {
        if self.pattern {
            if invalid_target_parts(self.capture) {
                return Err("package_target_invalid");
            }
            Ok(Cow::Owned(replace_stars(target, self.capture, true)))
        } else if self.capture.is_empty() {
            Ok(Cow::Borrowed(target))
        } else if target.ends_with('/') {
            Ok(Cow::Owned(format!("{target}{}", self.capture)))
        } else {
            Err("package_target_invalid")
        }
    }
}

/// The exact subpath or most specific pattern is selected once. Within that
/// target, TypeScript tries active conditions and array entries in order.
pub(super) fn evaluate_target<T>(
    value: &Value,
    active: &impl Fn(&str) -> bool,
    no_subpath: Reason,
    load: &mut impl FnMut(&str) -> Result<T, Reason>,
) -> Result<T, Reason> {
    if let Some(target) = value.as_str() {
        return load(target);
    }
    if value.is_null() {
        return Err(no_subpath);
    }
    let mut first_failure = None;
    if let Some(conditions) = value.as_object() {
        for (condition, target) in conditions {
            if active(condition) {
                match evaluate_target(target, active, no_subpath, load) {
                    Ok(found) => return Ok(found),
                    Err(reason) => {
                        first_failure.get_or_insert(reason);
                    }
                }
            }
        }
        Err(first_failure.unwrap_or("no_matching_export_condition"))
    } else if let Some(alternatives) = value.as_array() {
        for target in alternatives {
            match evaluate_target(target, active, no_subpath, load) {
                Ok(found) => return Ok(found),
                Err(reason) => {
                    first_failure.get_or_insert(reason);
                }
            }
        }
        Err(first_failure.unwrap_or("package_target_invalid"))
    } else {
        Err("package_target_invalid")
    }
}

pub(super) fn package_path(
    paths: &RepositoryPaths,
    dir: &str,
    target: &str,
) -> Result<String, Reason> {
    let relative = target.strip_prefix("./").ok_or("package_target_invalid")?;
    if invalid_target_parts(relative) || target.contains(['\\', '\0']) {
        return Err("package_target_invalid");
    }
    // Normalize the leading "./" together with the rest of the target.
    // Otherwise a redundant separator could restart the path at the root.
    let path = paths.target(dir, target)?;
    if path == dir || target.ends_with('/') {
        return Err("package_target_not_found");
    }
    Ok(path)
}

fn invalid_target_parts(path: &str) -> bool {
    path.split('/')
        .any(|part| matches!(part, "." | "..") || is_dependency_component(part))
}

pub(super) fn package_name(specifier: &str) -> Option<(&str, Option<&str>)> {
    if specifier.is_empty() || is_path(specifier) || specifier.starts_with('#') {
        return None;
    }
    let split_at = if let Some((first, rest)) = specifier.split_once('/') {
        if first.starts_with('@') {
            if rest.is_empty() || rest.starts_with('/') {
                return None;
            }
            rest.find('/').map(|index| first.len() + 1 + index)
        } else {
            Some(first.len())
        }
    } else {
        if specifier.starts_with('@') {
            return None;
        }
        None
    };
    Some(split_at.map_or((specifier, None), |index| {
        (&specifier[..index], Some(&specifier[index + 1..]))
    }))
}

pub(super) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

// String.replace interprets dollars in the captured replacement even when
// the pattern being replaced is a literal star.
pub(super) fn replace_stars(input: &str, replacement: &str, all: bool) -> String {
    let mut out = String::new();
    let mut previous = 0;
    for (at, _) in input.match_indices('*') {
        out.push_str(&input[previous..at]);
        let mut chars = replacement.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '$' {
                match chars.peek().copied() {
                    Some('$') => {
                        out.push('$');
                        chars.next();
                    }
                    Some('&') => {
                        out.push('*');
                        chars.next();
                    }
                    Some('\u{60}') => {
                        out.push_str(&input[..at]);
                        chars.next();
                    }
                    Some('\'') => {
                        out.push_str(&input[at + 1..]);
                        chars.next();
                    }
                    _ => out.push('$'),
                }
            } else {
                out.push(ch);
            }
        }
        previous = at + 1;
        if !all {
            break;
        }
    }
    out.push_str(&input[previous..]);
    out
}
