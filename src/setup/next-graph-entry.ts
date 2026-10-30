import { runNextGraphWorker } from "./next-graph.js";

const [root, token] = process.argv.slice(2);
if (!root || !token) process.exitCode = 1;
else await runNextGraphWorker(root, token).catch(() => { process.exitCode = 1; });
