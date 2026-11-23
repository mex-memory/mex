use super::Framework;
use super::python::{self, Decorators};
use super::source::rx;

pub(super) const FRAMEWORK: Framework = Framework {
    name: "fastapi",
    role: "fastapi-route",
    ordinal: true,
    exported: false,
    qualified_handlers: false,
    languages: &["python"],
    handler_method: "fastapi-route-handler",
    imported_method: "fastapi",
    detect_package: None,
    detect_source: Some(|_, source| {
        rx!(r"(?:^|\r?\n)\s*(?:from\s+fastapi(?:\.[A-Za-z0-9_.]+)?\s+import\s|import\s+fastapi(?-u:\b))").is_match(source)
    }),
    scan: |_, source| {
        python::scan(
            source,
            &Decorators {
                name: "fastapi",
                instance: rx!(
                    r#"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z0-9_.\[\]"]+)?\s*=\s*(?:fastapi\.)?(?:FastAPI|APIRouter)\s*\("#
                ),
                decorator: rx!(
                    r"^\s*@([A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|patch|delete|options|head|trace|api_route)\s*\("
                ),
                prefix: rx!(r"(?:^|[,({]|\s)prefix\s*=\s*"),
                multi_method: "api_route",
                default_method: None,
                braces_in_path: true,
            },
        )
    },
};
