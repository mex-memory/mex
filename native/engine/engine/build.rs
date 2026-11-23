use std::fmt::Write;
use std::fs;
use std::path::Path;

fn main() {
    let langs = Path::new("../langs");
    println!("cargo:rerun-if-changed=../langs");
    let mut configs = Vec::new();
    for folder in fs::read_dir(langs).into_iter().flatten().flatten() {
        for file in fs::read_dir(folder.path()).into_iter().flatten().flatten() {
            let path = file.path();
            if path.extension().is_some_and(|ext| ext == "toml")
                && path.file_name().is_some_and(|name| name != "Cargo.toml")
                && let Ok(bytes) = fs::read(&path)
            {
                let key = path
                    .strip_prefix(langs)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                configs.push((key, bytes));
            }
        }
    }
    configs.sort_by(|a, b| a.0.cmp(&b.0));
    // Keep adapter data in the binary, including malformed configs so the
    // graph job can warn about them without depending on the source checkout.
    let manifest = fs::read(langs.join("registry.toml")).unwrap_or_default();
    let mut output =
        format!("const MANIFEST: &[u8] = &{manifest:?};\nconst CONFIGS: &[(&str, &[u8])] = &[\n");
    for (key, bytes) in configs {
        writeln!(output, "    ({key:?}, &{bytes:?}),").unwrap();
    }
    output.push_str("];\n");
    let out = std::env::var_os("OUT_DIR").expect("Cargo build output");
    fs::write(Path::new(&out).join("adapters.rs"), output).expect("write embedded adapter configs");
}
