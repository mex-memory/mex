import { findConfig } from "../config.js";
import { detectDrift } from "./detect.js";

const [root] = process.argv.slice(2);
if (!root) process.exitCode = 1;
else {
  await detectDrift(findConfig(root)).then(
    (status) => { process.stdout.write(JSON.stringify(status)); },
    () => { process.exitCode = 1; },
  );
}
