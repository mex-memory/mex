//! `mex-graph`: the engine binary Node runs for graph builds and edits.
//! The interface is docs/design/graph-engine-contract.md.

use std::path::PathBuf;
use std::process::ExitCode;

mod adapters;
mod basic;
mod facts_cache;
mod facts_cmd;
mod frameworks;
mod guard;
mod job;
mod serve;
mod stage;
mod syntax_language;

const USAGE: &str = "usage: mex-graph version | languages | build --request <file> | \
    refresh --request <file> | serve --request <file> | stage --request <file> | facts --root <dir> <path>...";

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        text.push(DIGITS[(byte >> 4) as usize] as char);
        text.push(DIGITS[(byte & 15) as usize] as char);
    }
    text
}

fn is_compiler_language(language: &str) -> bool {
    matches!(language, "typescript" | "tsx" | "javascript" | "jsx")
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version") => {
            println!(
                "{{\"engine\":\"mex-graph\",\"version\":\"{}\",\"contract\":{}}}",
                env!("CARGO_PKG_VERSION"),
                mex_graph_core::CONTRACT_VERSION
            );
            ExitCode::SUCCESS
        }
        Some("languages") => {
            println!(
                "{}",
                serde_json::to_string(&adapters::registry().languages())
                    .expect("serializable language registry")
            );
            ExitCode::SUCCESS
        }
        Some("facts") => match facts_cmd::run(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("mex-graph facts: {message}");
                ExitCode::from(2)
            }
        },
        Some(mode @ ("build" | "refresh" | "serve" | "stage")) => {
            let Some(request) = args
                .iter()
                .position(|a| a == "--request")
                .and_then(|i| args.get(i + 1))
                .map(PathBuf::from)
            else {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            };
            if cfg!(target_os = "wasi") && mode == "serve" {
                job::emit_error("graph_serve_unavailable", "WASI uses one-shot graph jobs");
                return ExitCode::from(2);
            }
            let run = if mode == "serve" {
                serve::run
            } else {
                job::run
            };
            match job::load(&request, mode).and_then(run) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    job::emit_error(error.code, &error.message);
                    ExitCode::from(u8::try_from(error.exit).unwrap_or(70))
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}
