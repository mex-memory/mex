use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};

pub const ENGINE: &str = env!("CARGO_BIN_EXE_mex-graph");

pub fn spawn_job(mode: &str, request: &Path) -> Child {
    Command::new(ENGINE)
        .args([mode, "--request"])
        .arg(request)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

pub fn run_job(mode: &str, request: &Path, stdin_text: &str) -> Output {
    let mut child = spawn_job(mode, request);
    let mut stdin = child.stdin.take().unwrap();
    // A refused request can close the pipe before the test writes to it.
    let _ = stdin.write_all(stdin_text.as_bytes());
    // Keep the parent pipe open for started jobs until the child exits.
    let _parent_stdin = (!stdin_text.is_empty()).then_some(stdin);
    child.wait_with_output().unwrap()
}

pub fn last_event(output: &Output) -> serde_json::Value {
    let text = std::str::from_utf8(&output.stdout).unwrap();
    serde_json::from_str(text.lines().last().expect("an event")).unwrap()
}
