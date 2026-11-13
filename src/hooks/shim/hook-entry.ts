import { runNodeHook } from "./node-hook.js";

void runNodeHook({
  stdin: process.stdin,
  write: (text) => process.stdout.write(text),
  env: process.env,
}).then(
  () => process.exit(0),
  () => process.exit(0),
);
