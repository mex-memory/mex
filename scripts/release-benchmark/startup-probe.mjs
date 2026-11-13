import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

// Separate diagnostics only: measured release samples never use this wrapper.
const cli = process.env.MEX_STARTUP_DIAGNOSTIC_CLI;
const output = process.env.MEX_STARTUP_DIAGNOSTIC_SAMPLE;
if (!cli || !output) throw new Error("Startup diagnostic configuration is missing.");

const counts = { fsCalls: 0, fsMs: 0, childCalls: 0, childMs: 0 };
const require = createRequire(import.meta.url);
const fsModule = require("node:fs");
const childModule = require("node:child_process");
function observe(original, calls, elapsed) {
  return function (...args) {
    const start = performance.now();
    try { return Reflect.apply(original, this, args); }
    finally { counts[calls]++; counts[elapsed] += performance.now() - start; }
  };
}
for (const name of ["readFileSync", "statSync", "lstatSync", "realpathSync", "readdirSync"]) {
  const original = fsModule[name];
  const wrapped = observe(original, "fsCalls", "fsMs");
  Object.assign(wrapped, original);
  if (original.native) wrapped.native = observe(original.native, "fsCalls", "fsMs");
  fsModule[name] = wrapped;
}
for (const name of ["spawnSync", "execSync", "execFileSync"]) {
  childModule[name] = observe(childModule[name], "childCalls", "childMs");
}
syncBuiltinESMExports();

const started = performance.now();
const importCpu = process.cpuUsage();
let importMs = 0, importCpuMs = 0, recorded = false;
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, ...args) {
  const ready = !recorded && /http:\/\/127\.0\.0\.1:\d+\/#token=/u.test(String(chunk));
  const now = performance.now();
  const cpu = ready ? process.cpuUsage() : undefined;
  if (ready) {
    recorded = true;
    fs.writeFileSync(output, JSON.stringify({
      importMs, importCpuMs, scriptToReadyMs: now - started,
      cpuMs: (cpu.user + cpu.system) / 1000, ...counts,
    }), { flag: "wx", mode: 0o600 });
  }
  return Reflect.apply(originalWrite, this, [chunk, ...args]);
};

// Keep the real bootstrap, including its compile-cache and argv behavior.
process.argv[1] = cli;
await import(pathToFileURL(cli).href);
importMs = performance.now() - started;
const importedCpu = process.cpuUsage(importCpu);
importCpuMs = (importedCpu.user + importedCpu.system) / 1000;
