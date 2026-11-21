//! `mex-graph`: the engine binary Node runs for graph builds and edits.

use std::process::ExitCode;

// Used by the job runner, which arrives in the next commit.
#[allow(dead_code)]
mod guard;

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
        _ => {
            eprintln!("usage: mex-graph version");
            ExitCode::from(2)
        }
    }
}
