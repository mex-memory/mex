//! `mex-graph`: the engine binary Node runs for graph builds and edits.
//! The interface is docs/design/graph-engine-contract.md.

use std::path::PathBuf;
use std::process::ExitCode;

mod guard;
mod job;

const USAGE: &str = "usage: mex-graph version | languages | build --request <file>";

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
        // Adapters register here from M2.
        Some("languages") => {
            println!("[]");
            ExitCode::SUCCESS
        }
        Some(mode @ "build") => {
            let Some(request) = args
                .iter()
                .position(|a| a == "--request")
                .and_then(|i| args.get(i + 1))
                .map(PathBuf::from)
            else {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            };
            match job::load(&request, mode).and_then(job::run) {
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
