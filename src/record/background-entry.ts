import { runBackground } from "./background.js";

/** Runs the background process directly; the CLI reaches the same loop through `mex __background`. */
const reason = await runBackground();
process.exitCode = reason === "error" ? 1 : 0;
