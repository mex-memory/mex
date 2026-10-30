import { configurationRules } from "./configuration.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFileSync, writeFileSync, statSync, mkdtempSync, cpSync, rmSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { StatechartArtifactSchema, statechartMermaid, statechartTerminal, STATECHART_LIMITS as L } from "@mex/hub-contracts/statechart";
import { checkArtifact, boundedProcess, resolveTlc, TLC_SHA256 } from "./checker.js";
import { DiagramRepository } from "./repository.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
function read(path: string) { const stat = statSync(path); if (!stat.isFile() || stat.size > L.bytes) throw new Error("Artifact input exceeds limit."); return StatechartArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
// Scratch must sit outside every Git work tree and the target repository,
// wherever the helper runs from; the working directory proves nothing.
function scratchOnly(path: string, repository?: string) {
  const p = resolve(path);
  let ancestor = p;
  while (!existsSync(ancestor)) { const next = dirname(ancestor); if (next === ancestor) throw new Error("Scratch path cannot be resolved."); ancestor = next; }
  const physical = resolve(realpathSync(ancestor), relative(ancestor, p));
  const inside = (root: string) => { const rel = relative(root, physical); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
  if (repository && inside(realpathSync(resolve(repository)))) throw new Error("Generate in scratch space outside the repository.");
  for (let dir = physical; ; dir = dirname(dir)) { if (existsSync(join(dir, ".git"))) throw new Error(`Generate in scratch space outside the repository (${dir} is a Git work tree).`); if (dirname(dir) === dir) break; }
  return p;
}
/** Hand the rendered image to the desktop's default viewer without waiting on it. */
function openImage(path: string): boolean {
  const [file, args] = process.platform === "win32" ? ["explorer.exe", [path]] : process.platform === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
  try { const child = spawn(file, args, { detached: true, stdio: "ignore" }); child.on("error", () => { /* No viewer; the printed path remains. */ }); child.unref(); return true; } catch { return false; }
}
// Rendering may install its pinned image packages once; that gets a longer cap than TLC.
const RENDER_MS = 180_000;
/** Run the attributed baseline from a disposable copy with owned resource caps.
 * No Java/TLC installation is attempted by ordinary installation or Hub reads. */
async function runWorkflow(args: string[]) {
  const render = args[0] === "render";
  const tools = render ? null : resolveTlc(); if (!render && !tools) throw new Error("TLC unavailable. Set checksum-verified TLA2TOOLS and JAVA; read references/toolchain.md.");
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
    const renderer = join(runtime, "render.mjs"); writeFileSync(renderer, readFileSync(renderer, "utf8").replace("100_000_000", "16_000_000"));
    // from-spec/from-chart/render each take their model/chart at argument 1.
    if (!args[1]) throw new Error("Workflow requires a scratch input."); scratchOnly(args[1]);
    if (statSync(args[1]).size > L.fileBytes) throw new Error("Model input exceeds limit.");
    for (let i = 2; i < args.length; i++) { if (["--map", "--config", "--fixed", "--fixed-config", "--against", "--against-config", "--out"].includes(args[i]!)) { if (!args[i + 1]) throw new Error("Missing workflow path."); scratchOnly(args[++i]!); } }
    return await boundedProcess(process.execPath, ["--max-old-space-size=256", entry, ...args], { cwd: dirname(resolve(args[1])), env: { ...process.env, ...(tools ? { TLA2TOOLS: tools.jar, ...(process.env.JAVA ? { JAVA: tools.java } : {}) } : {}) }, signal: controller.signal, ...(render ? { capMs: RENDER_MS } : {}) });
  } finally { rmSync(runtime, { recursive: true, force: true }); }
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
  else if (command === "status") {
    // Report the resolved toolchain so agents need not expand environment variables.
    const tools = resolveTlc(); const java = tools ? await boundedProcess(tools.java, ["-version"], { cwd: tmpdir(), signal: controller.signal, timeoutMs: 5000 }) : null;
    const starts = !!java && java.code === 0 && !java.stopped;
    console.log(JSON.stringify({ ready: starts, tlc: tools ? { jar: tools.jar, sha256: TLC_SHA256 } : null, java: tools ? { path: tools.java, starts, version: java?.output.split("\n").find(line => /^(?:openjdk|java) (?:version|[0-9])/u.test(line))?.trim() ?? null } : null }, null, 2));
  }
  else if (command === "validate" && input) { read(input); console.log("Artifact v1 valid."); }
  else if (command === "normalize" && input && output) {
    // Derive the exact Mermaid projection so agents never hand-write or guess it.
    scratchOnly(input); scratchOnly(output); const stat = statSync(input); if (!stat.isFile() || stat.size > L.bytes) throw new Error("Artifact input exceeds limit.");
    const draft = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(draft?.states) || !Array.isArray(draft?.transitions) || !Array.isArray(draft?.initial)) throw new Error("The draft needs states, transitions and initial arrays; see references/artifact.md.");
    const a = StatechartArtifactSchema.parse({ ...draft, diagram: { validity: draft.diagram?.validity ?? "unverified", mermaid: statechartMermaid(draft) } });
    writeFileSync(output, JSON.stringify(a, null, 2) + "\n"); console.log("Artifact v1 normalized and valid.");
  }
  else if (command === "terminal" && input) console.log(statechartTerminal(read(input)));
  else if (command === "check" && input && output) { scratchOnly(input); scratchOnly(output); const result = await checkArtifact(read(input), { signal: controller.signal, diagnostics: text => writeFileSync(output + ".tlc.log", text, { mode: 0o600 }) }); writeFileSync(output, JSON.stringify(result, null, 2) + "\n"); console.log(statechartTerminal(result)); }
  else if (command === "register" && input && output) { scratchOnly(input, output); console.log(JSON.stringify(await new DiagramRepository(output).register(read(input)))); }
  else if (command === "show" && input && output) {
    // One delivery step for clients without native Mermaid: the readable text view
    // now, plus the same graph as an image on disk for clients that display files.
    scratchOnly(input); const dir = scratchOnly(output); const a = read(input);
    mkdirSync(dir, { recursive: true }); const chart = join(dir, "diagram.mmd"), png = join(dir, "diagram.png");
    writeFileSync(chart, a.diagram.mermaid); rmSync(png, { force: true });
    console.log(statechartTerminal(a));
    if (rest.includes("--text-only")) console.log(`\nMermaid: ${chart}`);
    else {
      const r = await runWorkflow(["render", chart]);
      if (r.stopped || r.code !== 0 || !existsSync(png)) console.log(`\nImage unavailable (${r.stopped ?? "render failed"}); Mermaid: ${chart}`);
      else {
        // A terminal cannot show images: in interactive Claude Code (entrypoint "cli")
        // open the picture in the system viewer. Headless, SDK and CI runs never open one.
        const open = !rest.includes("--no-open") && (rest.includes("--open") || process.env.CLAUDE_CODE_ENTRYPOINT === "cli");
        console.log(`\nImage: ${png}${open && openImage(png) ? "\nOpened in the system image viewer." : ""}`);
      }
    }
  }
  else if (command === "workflow" && input) {
    const result = await runWorkflow([input, ...(output ? [output] : []), ...rest]);
    console.log(result.output); if (result.stopped || result.code !== 0) throw new Error(`Workflow ${result.stopped ?? "incomplete"}; no successful check is inferred.`);
  } else console.log("MEX statechart helper (explicit generation only)\nstatus\nsetup-tlc TOOL_CACHE_DIRECTORY\nvalidate ARTIFACT.json\nnormalize DRAFT.json ARTIFACT.json\ncheck ARTIFACT.json CHECKED.json\nterminal ARTIFACT.json\nshow ARTIFACT.json OUTPUT_DIRECTORY [--text-only | --open | --no-open]\nregister ARTIFACT.json REPOSITORY\nworkflow from-spec MODEL.tla [upstream flags]\nworkflow from-chart CHART.mmd [upstream flags]\nworkflow render CHART.mmd");
} catch (error) { console.error(error instanceof Error ? error.message : "Statechart generation failed."); process.exitCode = 1; }
