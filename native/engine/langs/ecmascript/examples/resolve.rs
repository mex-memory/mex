//! Measure and inspect one repository's module resolution over JSON lines.
//! The first line supplies the view, followed by one request per line.

use std::collections::BTreeMap;
use std::error::Error;
use std::io::{self, BufRead, BufWriter, Write};
use std::time::{Duration, Instant};

use mex_graph_ecmascript::modules::{ModuleResolver, ModuleTarget, Syntax};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct View {
    root: String,
    files: Vec<String>,
    configs: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Request {
    from: String,
    specifier: String,
    syntax: RequestSyntax,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RequestSyntax {
    Import,
    Require,
}

impl From<RequestSyntax> for Syntax {
    fn from(value: RequestSyntax) -> Self {
        match value {
            RequestSyntax::Import => Self::Import,
            RequestSyntax::Require => Self::Require,
        }
    }
}

fn target_json(target: ModuleTarget) -> Value {
    match target {
        ModuleTarget::File { path, basis } => json!({"kind": "file", "path": path, "basis": basis}),
        ModuleTarget::Namespace { dir, basis } => {
            json!({"kind": "namespace", "dir": dir, "basis": basis})
        }
        ModuleTarget::Ambiguous { paths } => json!({"kind": "ambiguous", "paths": paths}),
        ModuleTarget::External { pkg } => json!({"kind": "external", "pkg": pkg}),
        ModuleTarget::Builtin { name } => json!({"kind": "builtin", "name": name}),
        ModuleTarget::Unresolved { reason } => json!({"kind": "unresolved", "reason": reason}),
    }
}

fn write_line(output: &mut impl Write, value: &Value) -> Result<(), Box<dyn Error>> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut lines = io::stdin().lock().lines();
    let mut output = BufWriter::new(io::stdout().lock());
    let view: View = serde_json::from_str(&lines.next().ok_or("expected repository view")??)?;
    let start = Instant::now();
    let resolver = ModuleResolver::with_repository_root(
        &view.root,
        view.files.iter().map(String::as_str),
        view.configs
            .iter()
            .map(|(path, text)| (path.as_str(), text.as_str())),
    );
    let index_time = start.elapsed();
    drop(view);
    let mut resolve_time = Duration::ZERO;
    let mut count = 0;
    for line in lines {
        let request: Request = serde_json::from_str(&line?)?;
        let start = Instant::now();
        let target = resolver.resolve(&request.from, &request.specifier, request.syntax.into());
        resolve_time += start.elapsed();
        count += 1;
        write_line(
            &mut output,
            &json!({
                "project": resolver.project_config(&request.from),
                "target": target_json(target),
            }),
        )?;
    }
    let issues: Vec<_> = resolver
        .config_issues()
        .iter()
        .map(|issue| {
            json!({
                "config": issue.config, "reference": issue.reference, "reason": issue.reason,
            })
        })
        .collect();
    write_line(
        &mut output,
        &json!({
            "timing": {
                "requests": count,
                "indexMs": index_time.as_secs_f64() * 1000.0,
                "resolveMs": resolve_time.as_secs_f64() * 1000.0,
            },
            "configIssues": issues,
        }),
    )?;
    output.flush()?;
    Ok(())
}
