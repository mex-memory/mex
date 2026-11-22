import { copyFileSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTimed } from "../../compare/lib/process.mjs";
import { makeArm } from "./arms.mjs";
import { restoreFiles } from "./history.mjs";

const noNetwork = fileURLToPath(new URL("../no-network.cjs", import.meta.url));

function safeFile(root, file) {
  let next = root;
  for (const component of file.split("/")) {
    next = join(next, component);
    try { if (lstatSync(next).isSymbolicLink()) throw new Error("Grader path contains a link"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return next;
}

export async function grade({ task, profile, subjectRoot, path, transcript, timeoutMs }) {
  const hidden = task.hiddenTests;
  if (hidden.fromCommit) {
    restoreFiles(subjectRoot, profile.workspace, hidden.fromCommit, hidden.files);
  } else {
    for (const file of hidden.files) {
      const target = safeFile(profile.workspace, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(safeFile(hidden.fromDirectory, file), target);
    }
  }
  const [program, ...args] = hidden.command;
  const { env } = makeArm(profile.root, "grader", path);
  env.NODE_OPTIONS = "--require=" + JSON.stringify(noNetwork);
  env.MEX_OFF = "1";
  env.MEX_ARM_TRANSCRIPT = transcript;
  const result = await runTimed(program, args, { cwd: profile.workspace, env, timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.error || result.timedOut || result.signal) throw new Error("Grader could not finish for " + task.id);
  return { accepted: result.code === 0, exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}
