import { configurationRules } from "./configuration.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFileSync, writeFileSync, statSync, mkdtempSync, cpSync, rmSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StatechartArtifactSchema, statechartTerminal, STATECHART_LIMITS as L } from "@mex/hub-contracts/statechart";
import { checkArtifact, boundedProcess, resolveTlc, TLC_SHA256 } from "./checker.js";
import { DiagramRepository } from "./repository.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
function read(path: string) { const stat = statSync(path); if (!stat.isFile() || stat.size > L.bytes) throw new Error("Artifact input exceeds limit."); return StatechartArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
function scratchOnly(path: string, repository = process.cwd()) {
  const p = resolve(path), root = realpathSync(resolve(repository));
  let ancestor = p;
  while (!existsSync(ancestor)) { const next = dirname(ancestor); if (next === ancestor) throw new Error("Scratch path cannot be resolved."); ancestor = next; }
  const physical = resolve(realpathSync(ancestor), relative(ancestor, p));
  const rel = relative(root, physical);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Generate in scratch space outside the repository.");
  return p;
}
try {
  const [command, input, output, ...rest] = process.argv.slice(2);
  if (command === "setup-tlc" && input) {
    const cache = scratchOnly(input); const target = join(cache, "tla2tools-1.7.4.jar");
    if (existsSync(target)) throw new Error("A checker already exists at this target; inspect it before changing it.");
    console.error("Downloading pinned TLC 1.7.4 (up to 5 MiB); Java must already be installed.");
    const response = await fetch("https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(L.checkerMs)]) });
    if (!response.ok || !response.body) throw new Error("TLC download failed.");
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 5 * 1024 * 1024) throw new Error("TLC download exceeded its byte budget."); chunks.push(chunk); }
    const jar = Buffer.concat(chunks);
    if (createHash("sha256").update(jar).digest("hex") !== TLC_SHA256) throw new Error("TLC checksum mismatch; nothing was installed.");
    mkdirSync(cache, { recursive: true }); writeFileSync(target, jar, { flag: "wx", mode: 0o600 });
    console.error("Verified TLC 1.7.4. Set TLA2TOOLS to this file for explicit generation:"); console.log(target);
  }
  else if (command === "validate" && input) { read(input); console.log("Artifact v1 valid."); }
  else if (command === "terminal" && input) console.log(statechartTerminal(read(input)));
  else if (command === "check" && input && output) { scratchOnly(input); scratchOnly(output); const result = await checkArtifact(read(input), { signal: controller.signal, diagnostics: text => writeFileSync(output + ".tlc.log", text, { mode: 0o600 }) }); writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); console.log(statechartTerminal(result)); }
  else if (command === "register" && input && output) { scratchOnly(input, output); console.log(JSON.stringify(await new DiagramRepository(output).register(read(input)))); }
  else if (command === "workflow" && input) {
    // Run the attributed baseline from a disposable copy with owned resource caps.
    // No Java/TLC installation is attempted by ordinary installation or Hub reads.
    const tools = input === "render" ? null : resolveTlc(); if (input !== "render" && !tools) throw new Error("TLC unavailable. Set checksum-verified TLA2TOOLS and JAVA; read references/toolchain.md.");
    const here = dirname(fileURLToPath(import.meta.url));
    const runtime = mkdtempSync(join(tmpdir(), "mex-statechart-runtime-"));
    try {
      cpSync(resolve(here, "../upstream/scripts"), runtime, { recursive: true });
      const entry = join(runtime, "statechart.mjs"); let code = readFileSync(entry, "utf8");
      code = code.replace('const { MAX_STRING_LENGTH } = constants;', 'const MAX_STRING_LENGTH = 2 * 1024 * 1024;');
      code = code.replaceAll('workers: "auto"', 'workers: "1"').replace('"-XX:+UseParallelGC",', '"-Xmx512m", "-XX:ActiveProcessorCount=2", "-XX:+UseParallelGC",');
      const rulesStart = code.indexOf("function splitRules(cfg) {");
      const rulesEnd = code.indexOf("\nfunction runJava", rulesStart);
      if (rulesStart < 0 || rulesEnd < 0) throw new Error("Pinned workflow configuration boundary changed.");
      code = code.slice(0, rulesStart) + `const splitRules = (${configurationRules.toString()});\n` + code.slice(rulesEnd);
      writeFileSync(entry, code);
      const render = join(runtime, "render.mjs"); writeFileSync(render, readFileSync(render, "utf8").replace("100_000_000", "16_000_000"));
      const args = [input, ...(output ? [output] : []), ...rest];
      // from-spec/from-chart/render each take their model/chart at argument 1.
      if (!args[1]) throw new Error("Workflow requires a scratch input."); scratchOnly(args[1]);
      if (statSync(args[1]).size > L.fileBytes) throw new Error("Model input exceeds limit.");
      for (let i = 2; i < args.length; i++) { if (["--map", "--config", "--fixed", "--fixed-config", "--against", "--against-config", "--out"].includes(args[i]!)) { if (!args[i + 1]) throw new Error("Missing workflow path."); scratchOnly(args[++i]!); } }
      const result = await boundedProcess(process.execPath, ["--max-old-space-size=256", entry, ...args], { cwd: dirname(resolve(args[1])), env: { ...process.env, ...(tools ? { TLA2TOOLS: tools.jar, ...(process.env.JAVA ? { JAVA: tools.java } : {}) } : {}) }, signal: controller.signal });
      console.log(result.output); if (result.stopped || result.code !== 0) throw new Error(`Workflow ${result.stopped ?? "incomplete"}; no successful check is inferred.`);
    } finally { rmSync(runtime, { recursive: true, force: true }); }
  } else console.log("MEX statechart helper (explicit generation only)\nsetup-tlc TOOL_CACHE_DIRECTORY\nvalidate ARTIFACT.json\ncheck ARTIFACT.json CHECKED.json\nterminal ARTIFACT.json\nregister ARTIFACT.json REPOSITORY\nworkflow from-spec MODEL.tla [upstream flags]\nworkflow from-chart CHART.mmd [upstream flags]\nworkflow render CHART.mmd");
} catch (error) { console.error(error instanceof Error ? error.message : "Statechart generation failed."); process.exitCode = 1; }
