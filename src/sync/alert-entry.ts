import { runDriftAlertPass } from "./alert-pass.js";

const [root, flag] = process.argv.slice(2);
if (!root) process.exitCode = 1;
else {
  await runDriftAlertPass(root, { afterCommit: flag === "--after-commit" }).catch(() => { process.exitCode = 1; });
}
