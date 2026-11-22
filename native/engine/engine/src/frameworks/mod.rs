//! Framework extraction against the same source snapshot that produced the
//! language facts. Project detection activates route markers after extraction.

use std::collections::HashMap;

use mex_graph_core::facts::{Def, FileFacts, FrameworkMarker, Kind, NONE, ParseStatus, Range};
use mex_graph_ecmascript::resolve::{DefRef, ImportResolution};
use mex_graph_syntax::{empty_def, resolve::visible};
use serde_json::Value;

mod express;
mod fastapi;
mod flask;
mod nestjs;
mod nextjs;
mod python;
mod source;

const ECMASCRIPT: &[&str] = &["typescript", "javascript", "tsx", "jsx"];
pub(crate) const DETECTION: &str = "framework_detected";
pub(crate) const CONFIDENCE: f64 = 0.8;

pub(crate) struct Framework {
    name: &'static str,
    role: &'static str,
    ordinal: bool,
    exported: bool,
    qualified_handlers: bool,
    languages: &'static [&'static str],
    handler_method: &'static str,
    imported_method: &'static str,
    detect_package: Option<fn(&str) -> bool>,
    detect_source: Option<fn(&str, &str) -> bool>,
    scan: fn(&str, &str) -> Vec<Route>,
}

const FRAMEWORKS: &[Framework] = &[
    express::FRAMEWORK,
    fastapi::FRAMEWORK,
    flask::FRAMEWORK,
    nextjs::FRAMEWORK,
    nestjs::FRAMEWORK,
];

struct Route {
    name: String,
    handler: String,
    qualified_handler: Option<String>,
    range: Range,
}

impl Route {
    fn new(method: &str, path: &str, handler: &str, line: usize, end_col: usize) -> Self {
        Self {
            name: format!("{method} {path}"),
            handler: handler.into(),
            qualified_handler: None,
            range: Range {
                start_line: line as u32,
                end_line: line as u32,
                end_col: end_col as u32,
                ..Range::default()
            },
        }
    }
}

pub(crate) fn capture(facts: &mut FileFacts, source: &str) {
    for framework in FRAMEWORKS
        .iter()
        .filter(|framework| framework.languages.contains(&facts.language.as_str()))
    {
        if framework
            .detect_source
            .is_some_and(|detect| detect(&facts.path, source))
        {
            facts.frameworks.push(FrameworkMarker {
                kind: DETECTION.into(),
                name: framework.name.into(),
                arguments: Vec::new(),
                def: NONE,
                range: Range::default(),
            });
        }
        if facts.health.status != ParseStatus::Ok {
            continue;
        }
        facts.frameworks.extend(
            (framework.scan)(&facts.path, source)
                .into_iter()
                .map(|route| FrameworkMarker {
                    kind: framework.name.into(),
                    name: route.name,
                    arguments: std::iter::once(route.handler)
                        .chain(route.qualified_handler)
                        .collect(),
                    def: NONE,
                    range: route.range,
                }),
        );
    }
}

#[derive(Clone, Default)]
pub(crate) struct Enabled(Vec<&'static Framework>);

impl Enabled {
    pub(crate) fn names(&self) -> String {
        self.0
            .iter()
            .map(|framework| framework.name)
            .collect::<Vec<_>>()
            .join(",")
    }

    pub(crate) fn detect(
        python: &[FileFacts],
        ecmascript: &[FileFacts],
        package: Option<&str>,
    ) -> Self {
        let detections = python
            .iter()
            .chain(ecmascript)
            .flat_map(|file| &file.frameworks)
            .filter(|marker| marker.kind == DETECTION)
            .map(|marker| marker.name.clone())
            .collect();
        Self::with_detections(package, &detections)
    }

    pub(crate) fn with_detections(
        package: Option<&str>,
        names: &std::collections::HashSet<String>,
    ) -> Self {
        Self(
            FRAMEWORKS
                .iter()
                .filter(|framework| {
                    names.contains(framework.name)
                        || framework
                            .detect_package
                            .is_some_and(|detect| package.is_some_and(detect))
                })
                .collect(),
        )
    }

    pub(crate) fn activate(&self, files: &mut [FileFacts]) {
        for file in files {
            let mut counts = HashMap::new();
            // A framework route has a contains edge, but its v4 node row does
            // not carry containerId. Keep that same shape with a separate edge.
            for marker in &mut file.frameworks {
                let Some(framework) = self.0.iter().find(|f| f.name == marker.kind) else {
                    continue;
                };
                let mut def = empty_def(marker.range);
                def.kind = Kind::Route;
                def.name.clone_from(&marker.name);
                def.qualified_name.clone_from(&marker.name);
                def.signature = format!("{} -> {}", marker.name, marker.arguments[0]);
                def.range = marker.range;
                def.exported = framework.exported;
                def.declaration_role = Some(if framework.ordinal {
                    let ordinal = counts
                        .entry((framework.name, marker.name.as_str()))
                        .or_insert(0);
                    let role = format!("{}:{ordinal}", framework.role);
                    *ordinal += 1;
                    role
                } else {
                    framework.role.into()
                });
                marker.def = file.defs.len() as i32;
                file.defs.push(def);
            }
        }
    }

    pub(crate) fn links<'a>(
        &self,
        files: &'a [FileFacts],
        imports: Option<&[Vec<ImportResolution>]>,
    ) -> Vec<Vec<Link<'a>>> {
        let _timer = mex_graph_core::timing::Timer::start("frameworks.links");
        files
            .iter()
            .enumerate()
            .map(|(file, facts)| {
                self.file_links(file, facts, imports.map_or(&[], |imports| &imports[file]))
            })
            .collect()
    }

    pub(crate) fn file_links<'a>(
        &self,
        file: usize,
        facts: &'a FileFacts,
        imports: &[ImportResolution],
    ) -> Vec<Link<'a>> {
        let mut handlers: HashMap<&str, Vec<usize>> = HashMap::new();
        if facts.frameworks.iter().any(|marker| marker.def != NONE) {
            for (index, node) in facts.defs.iter().enumerate().filter(|(_, def)| {
                visible(def) && matches!(def.kind, Kind::Function | Kind::Method)
            }) {
                handlers.entry(&node.name).or_default().push(index);
            }
        }
        let mut imported: HashMap<&str, Vec<DefRef>> = HashMap::new();
        if !handlers.is_empty() || facts.frameworks.iter().any(|marker| marker.def != NONE) {
            for resolution in imports {
                if let Some(target) = resolution.target {
                    let binding =
                        &facts.imports[resolution.site.import].bindings[resolution.site.binding];
                    if let Some(local) = binding.local.as_deref() {
                        let targets = imported.entry(local).or_default();
                        if !targets.contains(&target) {
                            targets.push(target);
                        }
                    }
                }
            }
        }

        facts
            .frameworks
            .iter()
            .filter_map(|marker| {
                let from = usize::try_from(marker.def).ok()?;
                let framework = self.0.iter().copied().find(|f| f.name == marker.kind)?;
                let name = marker.arguments[0].as_str();
                let target = match imported.get(name).map(Vec::as_slice) {
                    Some(&[target]) => Ok((target, framework.imported_method, true)),
                    _ => self.local_handler(
                        file,
                        facts,
                        marker,
                        handlers.get(name).map_or(&[], Vec::as_slice),
                    ),
                };
                Some(Link {
                    from,
                    name,
                    line: marker.range.start_line + 1,
                    framework: framework.name,
                    target,
                })
            })
            .collect()
    }

    fn local_handler(
        &self,
        file: usize,
        facts: &FileFacts,
        marker: &FrameworkMarker,
        handlers: &[usize],
    ) -> Result<(DefRef, &'static str, bool), &'static str> {
        match handlers {
            [] => Err("framework_handler_not_found"),
            &[handler] => {
                // The v4 fallback offers a function_ref to active resolvers in
                // registry order. All five can prove a unique same-file handler.
                let method = self
                    .0
                    .iter()
                    .find(|f| f.languages.contains(&facts.language.as_str()))
                    .expect("the route's resolver is active")
                    .handler_method;
                Ok(((file, handler), method, false))
            }
            candidates => {
                let resolver = self
                    .0
                    .iter()
                    .find(|framework| {
                        framework.qualified_handlers
                            && framework.languages.contains(&facts.language.as_str())
                    })
                    .ok_or("ambiguous_framework_handler")?;
                let owner = marker
                    .arguments
                    .get(1)
                    .ok_or("ambiguous_framework_handler")?;
                let mut matches = candidates
                    .iter()
                    .copied()
                    .filter(|&def| facts.defs[def].qualified_name == *owner);
                let target = matches
                    .next()
                    .filter(|_| matches.next().is_none())
                    .ok_or("ambiguous_framework_handler")?;
                Ok(((file, target), resolver.handler_method, false))
            }
        }
    }
}

pub(crate) struct Link<'a> {
    pub from: usize,
    pub name: &'a str,
    pub line: u32,
    pub framework: &'static str,
    /// The written target, resolver, and whether it used a named import.
    pub target: Result<(DefRef, &'static str, bool), &'static str>,
}

pub(crate) fn route_framework(def: &Def) -> Option<&'static str> {
    if def.kind != Kind::Route {
        return None;
    }
    let role = def.declaration_role.as_deref()?;
    let role = role.split_once(':').map_or(role, |(prefix, _)| prefix);
    FRAMEWORKS.iter().find(|f| f.role == role).map(|f| f.name)
}

fn has_dependency(package: &str, names: &[&str]) -> bool {
    let Ok(package) = serde_json::from_str::<Value>(package) else {
        return false;
    };
    // The legacy list uses nullish coalescing before applying JS truthiness.
    ["dependencies", "devDependencies"]
        .into_iter()
        .flat_map(|group| names.iter().map(move |name| (group, name)))
        .map(|(group, name)| &package[group][name])
        .find(|value| !value.is_null())
        .is_some_and(|value| match value {
            Value::Bool(value) => *value,
            Value::String(value) => !value.is_empty(),
            Value::Number(value) => value.as_f64().is_none_or(|value| value != 0.0),
            _ => true,
        })
}
