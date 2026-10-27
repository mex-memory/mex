import * as modules from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { unsupportedNodeMessage } from "./node-version.js";
import { VERSION } from "./version.js";

let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // Missing or synthetic argv[1] is not this executable entry point.
  }
}

if (isMainModule) {
  const unsupported = unsupportedNodeMessage(process.versions.node);
  if (unsupported !== null) {
    console.error(unsupported);
    process.exitCode = 1;
  } else if (process.argv.length === 3 && ["--version", "-V"].includes(process.argv[2]!)) {
    console.log(VERSION);
  } else {
    // Available from runtime 22.8; earlier supported releases use ordinary loading.
    // The runtime validates cached compilation against the module's exact bytes.
    modules.enableCompileCache?.();
    const { runCli } = await import("./cli.js");
    runCli();
  }
}
