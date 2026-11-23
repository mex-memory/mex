use super::source::{ecmascript_extension, rx};
use super::{ECMASCRIPT, Framework, Route, has_dependency};

pub(super) const FRAMEWORK: Framework = Framework {
    name: "express",
    role: "express-route",
    ordinal: true,
    exported: false,
    qualified_handlers: false,
    languages: ECMASCRIPT,
    handler_method: "express-route-handler",
    imported_method: "express-route-handler",
    detect_package: Some(|package| has_dependency(package, &["express"])),
    detect_source: None,
    scan,
};

fn scan(path: &str, source: &str) -> Vec<Route> {
    if !ecmascript_extension(path) {
        return Vec::new();
    }
    let pattern = rx!(
        r#"(?-u:\b)(?:app|router)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*(?:"([^"'`]+)"|'([^"'`]+)'|`([^"'`]+)`)\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)"#
    );
    let mut routes = Vec::new();
    let mut line = 0;
    let mut previous = 0;
    for matched in pattern.captures_iter(source) {
        let whole = matched.get(0).unwrap();
        let method = &matched[1];
        let route = matched
            .get(2)
            .or_else(|| matched.get(3))
            .or_else(|| matched.get(4))
            .unwrap();
        let start = whole.start();
        line += source.as_bytes()[previous..start]
            .iter()
            .filter(|&&byte| byte == b'\n')
            .count();
        previous = start;
        routes.push(Route::new(
            &method.to_uppercase(),
            route.as_str(),
            &matched[5],
            line,
            whole.as_str().encode_utf16().count(),
        ));
    }
    routes
}
