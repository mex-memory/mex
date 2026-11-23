//! Shared decorator scanner for Flask and FastAPI.

use std::collections::HashMap;

use mex_graph_core::text::js_trim;
use regex::Regex;

use super::Route;
use super::source::{balanced, blank_comments, path, quoted, rx};

pub(super) struct Decorators {
    pub name: &'static str,
    pub instance: &'static Regex,
    pub decorator: &'static Regex,
    pub prefix: &'static Regex,
    pub multi_method: &'static str,
    pub default_method: Option<&'static str>,
    pub braces_in_path: bool,
}

struct Pending {
    methods: Vec<String>,
    path: String,
    line: usize,
    end_column: usize,
}

pub(super) fn scan(source: &str, config: &Decorators) -> Vec<Route> {
    if !source.contains('@') {
        return Vec::new();
    }
    let source = blank_comments(source, true);
    let lines = logical_lines(&source);
    let mut receivers = HashMap::new();
    let mut imports = Vec::new();
    let from_import = rx!(r"^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$");
    let import_name = rx!(r"^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?");
    let handler = rx!(r"^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(");

    for (_, line) in &lines {
        if let Some(instance) = config.instance.captures(line) {
            let open = instance.get(0).unwrap().end() - 1;
            let prefix = balanced(line, open, false)
                .and_then(|(args, _)| {
                    config
                        .prefix
                        .find_iter(args)
                        .find_map(|m| quoted(&args[m.end()..], false, true))
                })
                .unwrap_or("");
            receivers.insert(
                instance.get(1).unwrap().as_str().to_owned(),
                prefix.to_owned(),
            );
        } else if let Some(import) = from_import.captures(line) {
            if import[1]
                .split('.')
                .next()
                .unwrap_or("")
                .starts_with(config.name)
            {
                continue;
            }
            for raw in import[2].split(',') {
                let raw = js_trim(raw).replace(['(', ')'], "");
                if let Some(name) = import_name.captures(&raw) {
                    imports.push(
                        name.get(2)
                            .unwrap_or_else(|| name.get(1).unwrap())
                            .as_str()
                            .to_owned(),
                    );
                }
            }
        }
    }
    for name in imports {
        receivers.entry(name).or_insert_with(String::new);
    }

    let mut routes = Vec::new();
    let mut pending = Vec::new();
    for (index, line) in &lines {
        if let Some(decorator) = config.decorator.captures(line)
            && let Some(prefix) = receivers.get(&decorator[1])
        {
            let open = decorator.get(0).unwrap().end() - 1;
            if let Some((args, _)) = balanced(line, open, false)
                && let Some(route) = parse(config, &decorator[2], args, prefix, *index)
            {
                pending.push(route);
            }
            continue;
        }
        let trimmed = js_trim(line);
        if pending.is_empty() || trimmed.is_empty() || trimmed.starts_with(['@', '#']) {
            continue;
        }
        if let Some(handler) = handler.captures(line) {
            for route in pending.drain(..) {
                routes.extend(route.methods.iter().map(|method| {
                    Route::new(
                        method,
                        &route.path,
                        &handler[1],
                        route.line,
                        route.end_column,
                    )
                }));
            }
        } else {
            pending.clear();
        }
    }

    routes
}

fn parse(
    config: &Decorators,
    decorator: &str,
    args: &str,
    prefix: &str,
    line: usize,
) -> Option<Pending> {
    let literal = js_trim(args);
    let trimmed = literal.trim_start_matches(['f', 'F', 'b', 'B', 'u', 'U']);
    let string_prefix = &literal[..literal.len() - trimmed.len()];
    if string_prefix.len() > 2 || string_prefix.contains(['f', 'F']) {
        return None;
    }
    if trimmed.starts_with(mex_graph_core::id::is_js_whitespace) {
        return None;
    }
    let raw = quoted(trimmed, false, true)?;
    if raw.contains('%') || (!config.braces_in_path && raw.contains(['{', '}'])) {
        return None;
    }
    let methods = if decorator == config.multi_method {
        methods(args, config.default_method)?
    } else {
        vec![decorator.to_uppercase()]
    };
    Some(Pending {
        methods,
        path: path(prefix, raw, false),
        line,
        end_column: args.encode_utf16().count(),
    })
}

fn methods(args: &str, default: Option<&str>) -> Option<Vec<String>> {
    let key = rx!(r"(?:^|[,({]|\s)methods\s*=\s*");
    let value = rx!(r"(?:^|[,({]|\s)methods\s*=\s*[\[(]([^\])]*?)[\])]");
    let Some(value) = value.captures(args) else {
        return if key.is_match(args) {
            None
        } else {
            default.map(|verb| vec![verb.into()])
        };
    };
    let mut methods = Vec::new();
    for part in value[1]
        .split(',')
        .map(js_trim)
        .filter(|part| !part.is_empty())
    {
        let method = quoted(part, false, false)?;
        if method.is_empty()
            || method.len() + 2 != part.len()
            || !method.bytes().all(|ch| ch.is_ascii_alphabetic())
        {
            return None;
        }
        methods.push(method.to_uppercase());
    }
    (!methods.is_empty()).then_some(methods)
}

fn logical_lines(source: &str) -> Vec<(usize, String)> {
    let mut lines = Vec::new();
    let mut buffer = None::<(usize, String)>;
    let mut depth = 0;
    for (index, line) in source.lines().enumerate() {
        let mut quote = None;
        let bytes = line.as_bytes();
        let mut delta = 0;
        for (i, &ch) in bytes.iter().enumerate() {
            if let Some(delimiter) = quote {
                if ch == delimiter && bytes[i - 1] != b'\\' {
                    quote = None;
                }
            } else {
                match ch {
                    b'\'' | b'"' => quote = Some(ch),
                    b'(' => delta += 1,
                    b')' => delta -= 1,
                    _ => {}
                }
            }
        }
        if let Some((_, text)) = buffer.as_mut() {
            text.push(' ');
            text.push_str(js_trim(line));
            depth += delta;
            if depth <= 0 {
                lines.extend(buffer.take());
            }
        } else if delta > 0 {
            buffer = Some((index, line.into()));
            depth = delta;
        } else {
            lines.push((index, line.into()));
        }
    }
    lines.extend(buffer);
    lines
}
