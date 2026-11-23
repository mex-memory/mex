use std::collections::{HashMap, HashSet};

use super::config::ProjectIndex;
use super::{Extensions, JS_EXTENSIONS, Reason, dirname, extension, join_path, strip_directory};

pub(super) struct OutputIndex {
    by_directory: HashMap<String, Vec<Mapping>>,
}

struct Mapping {
    project: usize,
    root: String,
    declarations: bool,
    source_inside_output: bool,
    allow_js: bool,
}

impl OutputIndex {
    pub(super) fn new(projects: &ProjectIndex) -> Self {
        let mut by_directory: HashMap<_, Vec<_>> = HashMap::new();
        for (id, project) in projects.projects.iter().enumerate() {
            if project.no_emit {
                continue;
            }
            for (directory, declarations) in [
                (project.declaration_dir.as_ref(), true),
                (project.out_dir.as_ref(), false),
            ] {
                if let Some(directory) = directory.filter(|dir| **dir != project.root) {
                    by_directory
                        .entry(directory.to_owned())
                        .or_default()
                        .push(Mapping {
                            project: id,
                            root: project.root.clone(),
                            declarations,
                            source_inside_output: strip_directory(&project.root, directory)
                                .is_some(),
                            allow_js: project.options.allow_js,
                        });
                }
            }
        }
        Self { by_directory }
    }

    pub(super) fn contains(&self, path: &str) -> bool {
        self.owners(path, extension(path)).is_some()
    }

    fn owners<'a, 'p>(
        &'a self,
        path: &'p str,
        ext: Option<&str>,
    ) -> Option<(&'p str, &'a [Mapping])> {
        if self.by_directory.is_empty() {
            return None;
        }
        let mut dir = path;
        loop {
            if let Some(owners) = self.by_directory.get(dir)
                && owners.iter().any(|owner| owner.contains(path, ext))
            {
                let suffix = strip_directory(path, dir).unwrap_or("");
                return Some((suffix, owners));
            }
            if dir.is_empty() {
                return None;
            }
            dir = dirname(dir);
        }
    }

    pub(super) fn source_for<'a>(
        &self,
        path: &str,
        importer_project: Option<usize>,
        projects: &ProjectIndex,
        files: &'a HashSet<String>,
        extensions: Extensions,
    ) -> Result<Option<&'a str>, Reason> {
        let Some(ext) = extension(path).filter(|ext| is_emitted(ext)) else {
            return Ok(None);
        };
        let Some((suffix, owners)) = self.owners(path, Some(ext)) else {
            return Ok(None);
        };
        let Some(stem) = suffix.strip_suffix(ext) else {
            return Ok(None);
        };
        let distances = importer_project
            .filter(|_| owners.len() > 1)
            .map(|id| projects.reference_distances(id));
        let mut best = None;
        let mut ambiguous = false;
        for owner in owners {
            if !owner.contains(path, Some(ext)) {
                continue;
            }
            let source = source_extensions(ext)
                .iter()
                .copied()
                .filter(|ext| {
                    (owner.allow_js || !JS_EXTENSIONS.contains(ext)) && extensions.allows(ext)
                })
                .find_map(|source_ext| {
                    files.get(&join_path(&owner.root, &format!("{stem}{source_ext}")))
                });
            let Some(source) = source else { continue };
            let distance = distances
                .as_ref()
                .and_then(|distances| distances.get(&owner.project))
                .copied()
                .unwrap_or(usize::MAX);
            let priority = (distance, !owner.declarations);
            match best {
                Some((prior, prior_source)) if prior == priority => {
                    ambiguous |= prior_source != source;
                }
                Some((prior, _)) if prior < priority => {}
                _ => {
                    best = Some((priority, source));
                    ambiguous = false;
                }
            }
        }
        if ambiguous {
            Err("ambiguous_build_output")
        } else {
            Ok(best.map(|(_, path)| path.as_str()))
        }
    }
}

impl Mapping {
    fn contains(&self, path: &str, ext: Option<&str>) -> bool {
        (!self.declarations || ext.is_none_or(|ext| ext.starts_with(".d.")))
            && (!self.source_inside_output
                || path != self.root && strip_directory(path, &self.root).is_none())
    }
}

pub(super) fn is_emitted(ext: &str) -> bool {
    !source_extensions(ext).is_empty()
}

fn source_extensions(ext: &str) -> &'static [&'static str] {
    match ext {
        ".js" | ".d.ts" => &[".tsx", ".ts", ".jsx", ".js"],
        ".jsx" => &[".tsx", ".jsx"],
        ".mjs" | ".d.mts" => &[".mts", ".mjs"],
        ".cjs" | ".d.cts" => &[".cts", ".cjs"],
        _ => &[],
    }
}
