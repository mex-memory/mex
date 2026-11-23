//! Print one JSON token list per input path, in argument order.

use std::error::Error;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;

use mex_graph_ecmascript::scanner::scan_token_names;

fn main() -> Result<(), Box<dyn Error>> {
    let mut output = BufWriter::new(io::stdout().lock());
    for path in std::env::args_os().skip(1).map(PathBuf::from) {
        let bytes = fs::read(&path).map_err(|error| {
            io::Error::new(error.kind(), format!("{}: {error}", path.display()))
        })?;
        // Match Node's UTF-8 file decoding, including replacement characters.
        let text = String::from_utf8_lossy(&bytes);
        let jsx = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".tsx") || name.ends_with(".jsx"));
        serde_json::to_writer(&mut output, &scan_token_names(&text, jsx))?;
        output.write_all(b"\n")?;
    }
    output.flush()?;
    Ok(())
}
