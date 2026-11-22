use mex_graph_core::id::is_js_whitespace;
use mex_graph_core::text::js_trim;

use super::source::{balanced, blank_comments, ecmascript_extension, path, quoted, rx};
use super::{Framework, Route, has_dependency};

pub(super) const FRAMEWORK: Framework = Framework {
    name: "nestjs",
    role: "nestjs-route",
    ordinal: true,
    exported: false,
    qualified_handlers: true,
    languages: &["typescript", "javascript"],
    handler_method: "nestjs-route-handler",
    imported_method: "nestjs",
    detect_package: Some(|package| has_dependency(package, &["@nestjs/core", "@nestjs/common"])),
    detect_source: None,
    scan,
};

fn scan(file: &str, source: &str) -> Vec<Route> {
    if !ecmascript_extension(file) || !source.contains('@') {
        return Vec::new();
    }
    let controller = rx!(r"^@Controller(?-u:\b)");
    let class =
        rx!(r"^(?:export\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)");
    let http = rx!(r"^@(Get|Post|Put|Patch|Delete|Options|Head|All)(?-u:\b)");
    let source = blank_comments(source, false);
    let mut pending = None;
    let mut active = None;
    let mut routes = Vec::new();
    let mut line_start = 0;
    for (index, line) in source.split('\n').enumerate() {
        let start = line_start;
        line_start += line.len() + 1;
        let trimmed = js_trim(line);
        if controller.is_match(trimmed) {
            pending = controller_prefix(trimmed);
            continue;
        }
        if let Some(class) = class.captures(trimmed) {
            active = pending
                .take()
                .map(|prefix| (class.get(1).unwrap().as_str(), prefix));
            continue;
        }
        let Some((class, prefix)) = active else {
            continue;
        };
        let Some(method) = http.captures(trimmed) else {
            continue;
        };
        let Some((args, end)) = line.find('(').and_then(|open| balanced(line, open, true)) else {
            continue;
        };
        let Some(path_suffix) = static_path(args) else {
            continue;
        };
        let Some(handler) = handler_name(&source[start + end..]) else {
            continue;
        };
        let route_path = path(prefix, path_suffix, true);
        let mut route = Route::new(
            &method[1].to_uppercase(),
            &route_path,
            handler,
            index,
            line.encode_utf16().count(),
        );
        route.qualified_handler = Some(format!("{class}::{handler}"));
        routes.push(route);
    }
    routes
}

fn static_path(args: &str) -> Option<&str> {
    let args = js_trim(args);
    if args.is_empty() {
        Some("")
    } else {
        quoted(args, true, false)
    }
}

fn controller_prefix(line: &str) -> Option<&str> {
    let Some(open) = line.find('(') else {
        return Some("");
    };
    let (args, _) = balanced(line, open, true)?;
    let args = js_trim(args);
    if !args.starts_with('{') {
        return static_path(args);
    }
    let key = rx!(r"(?:^|[,{]\s*)path\s*:\s*");
    match key.find(args) {
        Some(key) if matches!(args.as_bytes().get(key.end()), Some(b'\'' | b'"')) => {
            quoted(&args[key.end()..], false, false)
        }
        Some(_) => None,
        None => Some(""),
    }
}

fn handler_name(mut source: &str) -> Option<&str> {
    let modifier = rx!(r"^(?:public|private|protected|static|readonly|override|async)\s+");
    let method = rx!(r"^([A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]");
    loop {
        source = source.trim_start_matches(is_js_whitespace);
        if let Some(decorator) = source.strip_prefix('@') {
            let rest = decorator.trim_start_matches(|ch: char| {
                ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$')
            });
            source = if rest.starts_with('(') {
                &rest[balanced(rest, 0, true)?.1..]
            } else {
                rest
            };
        } else if let Some(modifier) = modifier.find(source) {
            source = &source[modifier.end()..];
        } else {
            return method.captures(source).map(|m| m.get(1).unwrap().as_str());
        }
    }
}
