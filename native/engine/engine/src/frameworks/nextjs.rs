use std::collections::HashSet;

use super::source::{ecmascript_extension, rx};
use super::{ECMASCRIPT, Framework, Route};

pub(super) const FRAMEWORK: Framework = Framework {
    name: "nextjs",
    role: "nextjs-route",
    ordinal: false,
    exported: true,
    qualified_handlers: false,
    languages: ECMASCRIPT,
    handler_method: "nextjs-route-handler",
    imported_method: "nextjs",
    detect_package: Some(|package| rx!(r#"["']next["']\s*:"#).is_match(package)),
    detect_source: Some(|path, _| is_route_file(path)),
    scan,
};

fn is_route_file(path: &str) -> bool {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    file.starts_with("route.") && ecmascript_extension(file) && file.matches('.').count() == 1
}

fn route_path(path: &str) -> Option<String> {
    if !is_route_file(path) {
        return None;
    }
    let normalized = path.replace('\\', "/");
    let (dir, _) = normalized.rsplit_once('/')?;
    let parts: Vec<_> = dir.split('/').collect();
    let root = parts
        .windows(2)
        .position(|parts| parts == ["src", "app"])
        .map(|index| index + 1)
        .or_else(|| parts.iter().position(|part| *part == "app"))?;
    let segments = &parts[root + 1..];
    if segments.iter().any(|segment| segment.starts_with('_')) {
        return None;
    }
    let visible: Vec<_> = segments
        .iter()
        .copied()
        .filter(|segment| !segment.is_empty() && !segment.starts_with('('))
        .collect();
    Some(format!("/{}", visible.join("/")))
}

fn scan(path: &str, source: &str) -> Vec<Route> {
    let Some(route_path) = route_path(path) else {
        return Vec::new();
    };
    let function = rx!(r"^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)");
    let arrow = rx!(
        r"^\s*export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=>"
    );
    let mut methods = HashSet::new();
    let mut routes = Vec::new();
    for (line, text) in source.lines().enumerate() {
        let Some(captures) = function.captures(text).or_else(|| arrow.captures(text)) else {
            continue;
        };
        let method = captures.get(1).unwrap().as_str();
        if matches!(
            method,
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD"
        ) && methods.insert(method)
        {
            routes.push(Route::new(
                method,
                &route_path,
                method,
                line,
                text.encode_utf16().count(),
            ));
        }
    }
    routes
}
