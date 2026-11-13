import * as modules from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { unsupportedNodeMessage } from "./node-version.js";
import { VERSION } from "./version.js";
import { removedCommandMessage } from "./removed-commands.js";

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
  } else if (process.argv[2] === "__background" && process.argv.length === 3) {
    // MEX's own background process: no telemetry, notices or command parsing.
    const { runBackground } = await import("./record/background.js");
    const reason = await runBackground();
    process.exitCode = reason === "error" ? 1 : 0;
  } else if (process.argv[2] === "__ensure-background" && process.argv.length === 3) {
    // Started by the hook shim at session start when work is waiting: start the
    // background process if it isn't running, then exit.
    const { ensureBackground } = await import("./record/background.js");
    ensureBackground();
  } else if (removedCommandMessage(process.argv.slice(2)) !== null) {
    console.error(removedCommandMessage(process.argv.slice(2)));
    process.exitCode = 1;
  } else {
    // Available from runtime 22.8; earlier supported releases use ordinary loading.
    // The runtime validates cached compilation against the module's exact bytes.
    modules.enableCompileCache?.();
    const { runCli } = await import("./cli.js");
    runCli();
  }
}
