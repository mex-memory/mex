use super::Framework;
use super::python::{self, Decorators};
use super::source::rx;

pub(super) const FRAMEWORK: Framework = Framework {
    name: "flask",
    role: "flask-route",
    ordinal: true,
    exported: false,
    qualified_handlers: false,
    languages: &["python"],
    handler_method: "flask-route-handler",
    imported_method: "flask",
    detect_package: None,
    detect_source: Some(|_, source| {
        rx!(
            r"(?:^|\r?\n)\s*(?:from\s+flask(?:\.[A-Za-z0-9_.]+)?\s+import\s|import\s+flask(?-u:\b))"
        )
        .is_match(source)
    }),
    scan: |_, source| {
        python::scan(
            source,
            &Decorators {
                name: "flask",
                instance: rx!(
                    r#"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z0-9_.\[\]"]+)?\s*=\s*(?:flask\.)?(?:Flask|Blueprint)\s*\("#
                ),
                decorator: rx!(
                    r"^\s*@([A-Za-z_][A-Za-z0-9_]*)\.(route|get|post|put|patch|delete|options|head)\s*\("
                ),
                prefix: rx!(r"(?:^|[,({]|\s)url_prefix\s*=\s*"),
                multi_method: "route",
                default_method: Some("GET"),
                braces_in_path: false,
            },
        )
    },
};
