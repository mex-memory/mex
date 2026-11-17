import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkEnvironment } from "./environment.mjs";
import { copyReleaseFixture, createReleaseFixture, prepareReleaseFixtureTools } from "./fixtures.mjs";
import { startHub } from "./hub.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const SAMPLE_KEYS = ["importMs", "importCpuMs", "scriptToReadyMs", "cpuMs", "fsCalls", "fsMs", "childCalls", "childMs"];
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { "--report": "report", "--output": "output" }[process.argv[index]];
  if (!key || !process.argv[index + 1] || options[key]) throw new Error("Use --report <path> --output <path>.");
  options[key] = resolve(process.argv[index + 1]);
}
if (!options.report || !options.output) throw new Error("Report and output paths are required.");

const report = {
  schemaVersion: 1, benchmark: "mex-hub-startup-diagnostic", diagnosticOnly: true,
  node: process.version, platform: process.platform, architecture: process.arch,
  repositoryHead: null, dirty: null, profile: "small", status: "not-needed", samples: [],
};
let workRoot, tools, active;
try {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (head.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(head.stdout.trim())) throw new Error("Checkout identity is unavailable.");
  report.repositoryHead = head.stdout.trim();
  const state = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (state.status !== 0) throw new Error("Checkout state is unavailable.");
  report.dirty = state.stdout.length > 0;
  if (statSync(options.report).size > MAX_REPORT_BYTES) throw new Error("Input report exceeds its bound.");
  const measured = JSON.parse(readFileSync(options.report, "utf8"));
  if (measured.schemaVersion !== 1 || measured.benchmark !== "mex-release-performance"
    || !Array.isArray(measured.budgetEvaluation?.runtimeViolations)) throw new Error("Input report is invalid.");
  const needed = measured.budgetEvaluation.runtimeViolations.some((item) =>
    item.metric === "runtime.coldHubReadyMs.small" && item.reason === "budget_exceeded");
  if (needed) {
    workRoot = mkdtempSync(join(tmpdir(), "mex-startup-diagnostic-"));
    const environment = createBenchmarkEnvironment(workRoot);
    const cliPath = join(root, "dist", "cli.js");
    tools = prepareReleaseFixtureTools({ cliPath, environment });
    const fixture = createReleaseFixture({ destination: join(workRoot, "base"), profileName: "small", cliPath, environment, fixtureTools: tools });
    for (let index = 0; index < 10; index++) {
      try {
        const samplePath = join(workRoot, "sample-" + index + ".json");
        const projectRoot = copyReleaseFixture(fixture.root, join(workRoot, "cold-" + index));
        active = await startHub({
          projectRoot, cliPath: fileURLToPath(new URL("./startup-probe.mjs", import.meta.url)),
          startupTimeoutMs: 10_000,
          environment: { ...environment, MEX_STARTUP_DIAGNOSTIC_CLI: cliPath, MEX_STARTUP_DIAGNOSTIC_SAMPLE: samplePath },
        });
        const readyMs = active.readyMs;
        await active.close();
        const exitKind = active.child.exitCode === 0 ? "clean"
          : active.child.signalCode === "SIGTERM" ? "sigterm"
          : active.child.signalCode === "SIGKILL" ? "sigkill" : "failed";
        active = undefined;
        if (statSync(samplePath).size > 4_096) throw new Error("Sample exceeds its bound.");
        const sample = JSON.parse(readFileSync(samplePath, "utf8"));
        if (Object.keys(sample).length !== SAMPLE_KEYS.length
          || SAMPLE_KEYS.some((key) => !Number.isFinite(sample[key]) || sample[key] < 0)) throw new Error("Sample is invalid.");
        report.samples.push({ status: "collected", exitKind, readyMs: rounded(readyMs),
          ...Object.fromEntries(SAMPLE_KEYS.map((key) => [key, rounded(sample[key])])) });
      } catch {
        report.samples.push({ status: "failed", reason: "startup-observation-failed" });
      } finally {
        if (active) await active.close().catch(() => undefined);
        active = undefined;
      }
    }
    report.status = report.samples.every((sample) => sample.status === "collected") ? "collected" : "failed";
  }
} catch {
  report.status = "failed";
  report.reason = "diagnostic-unavailable";
} finally {
  try { tools?.cleanup(); } catch { report.cleanup = "retained"; }
  if (workRoot) {
    try {
      // Never follow links or junctions while removing the generated fixture.
      if (containsLink(workRoot)) report.cleanup = "retained-links";
      else rmSync(workRoot, { recursive: true, force: true });
    } catch { report.cleanup = "retained"; }
  }
  const encoded = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("Diagnostic output exceeds its bound.");
  mkdirSync(dirname(options.output), { recursive: true });
  const temporary = options.output + "." + process.pid + ".tmp";
  try {
    writeFileSync(temporary, encoded, { flag: "wx", mode: 0o600 });
    renameSync(temporary, options.output);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  console.log(JSON.stringify({ diagnosticOnly: true, status: report.status, samples: report.samples.length }));
  if (report.status === "failed") process.exitCode = 1;
}

function rounded(value) { return Math.round(value * 1000) / 1000; }
function containsLink(path) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return true;
  return entry.isDirectory() && readdirSync(path).some((name) => containsLink(join(path, name)));
}
