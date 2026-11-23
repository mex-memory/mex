// On the matching runner, build a graph platform package. --wasi stages the
// already built Preview 1 module in dist/ after the Node build.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryFor, packagesFor } from "./release/plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = join(root, "native/engine");
const wasi = process.argv[2] === "--wasi";
const host = `${process.platform}-${process.arch}`;
const entry = packagesFor("").find((pkg) => pkg.target === host && pkg.executable === "mex-graph");
if (!wasi && !entry) throw new Error(`No mex-graph package for ${host}`);
if (!wasi && process.argv[2] && process.argv[2] !== host) throw new Error("The runner does not match the requested graph package");

const command = (program, args) => execFileSync(program, args, { cwd, encoding: "utf8" }).trim();
const target = wasi ? "wasm32-wasip1" : command("rustc", ["-vV"]).match(/^host: (\S+)$/m)[1];
if (!wasi) execFileSync("cargo", ["build", "--locked", "--release"], { cwd, stdio: "inherit" });
const metadata = JSON.parse(command("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target]));
const destination = wasi ? join(root, "dist") : join(root, entry.directory, "bin");
mkdirSync(destination, { recursive: true });
const binary = wasi ? "mex-graph.wasm" : binaryFor(entry);
const targetDirectory = wasi ? join(metadata.target_directory, target) : metadata.target_directory;
copyFileSync(join(targetDirectory, "release", binary), join(destination, binary));

const notices = ["MEX graph engine dependency notices", "This inventory may include build dependencies.",
  readFileSync(join(root, "LICENSE"), "utf8"), readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
  readFileSync(join(cwd, "langs/rust/grammar/LICENSE"), "utf8")];
for (const pkg of metadata.packages.filter((pkg) => pkg.source)) {
  const directory = dirname(pkg.manifest_path);
  notices.push(`${pkg.name}@${pkg.version} · ${pkg.license ?? "See license below"} · ${pkg.repository ?? pkg.source}`);
  for (const filename of readdirSync(directory).filter((file) => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(file))) {
    notices.push(`${filename}\n${readFileSync(join(directory, filename), "utf8")}`);
  }
}
const sysroot = command("rustc", ["--print", "sysroot"]);
notices.push("Rust standard library and bundled runtime copyrights", readFileSync(join(sysroot, "share/doc/rust/COPYRIGHT-library.html"), "utf8"));
if (wasi) notices.push("WASI libc and compiler runtime source and notices: https://github.com/WebAssembly/wasi-sdk/tree/wasi-sdk-29");
writeFileSync(join(destination, wasi ? "mex-graph-wasi-notices.txt" : "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n") + "\n");
