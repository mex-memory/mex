import { configurationRules } from "./configuration.js";
import { projectChecker, checkerTraceText } from "./projection.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { StatechartArtifactSchema, STATECHART_LIMITS as L, type StatechartArtifact } from "@mex/hub-contracts/statechart";
export const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
export const UPSTREAM = "backnotprop/pstack@fad8d01588a1b1ae803f87c8a1e0de79e28cffec";
let running = false;

/** One owned process group, bounded output/time; cancellation always settles children. */
export async function boundedProcess(file: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; capMs?: number; watch?: string; maxWatchBytes?: number }): Promise<{ output: string; code: number | null; stopped: "cancelled" | "resource-limited" | null }> {
  return new Promise((done) => {
    let output = "", size = 0, stopped: "cancelled" | "resource-limited" | null = null;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stop = (reason: "cancelled" | "resource-limited") => {
      stopped ??= reason;
      if (!child.pid) return;
      try { if (process.platform === "win32") { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => child.kill("SIGKILL")); } else process.kill(-child.pid, "SIGKILL"); } catch { /* Process already settled. */ }
    };
    const abort = () => stop("cancelled"); options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const cap = options.capMs ?? L.checkerMs;
    const timer = setTimeout(() => stop("resource-limited"), Math.min(options.timeoutMs ?? cap, cap));
    const watch = setInterval(() => { if (options.watch) { try { if (statSync(options.watch).size > (options.maxWatchBytes ?? L.checkerBytes)) stop("resource-limited"); } catch { /* Not emitted yet. */ } } }, 100);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (b: Buffer) => { size += b.length; if (size > L.checkerBytes) stop("resource-limited"); else output += b.toString("utf8"); });
    child.on("error", () => { /* close follows error and is the single settlement boundary */ });
    child.on("close", code => { clearTimeout(timer); clearInterval(watch); options.signal?.removeEventListener("abort", abort); done({ output, code, stopped }); });
  });
}

export function resolveTlc(env: NodeJS.ProcessEnv = process.env): { jar: string; java: string } | null {
  const cache = env.XDG_CACHE_HOME ?? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Cache") : env.HOME ? join(env.HOME, ".cache") : null);
  const candidate = env.TLA2TOOLS ?? (cache ? join(cache, "mex-statechart", "tla2tools-1.7.4.jar") : null);
  if (!candidate) return null;
  const jar = resolve(candidate);
  try { if (statSync(jar).size > 5 * 1024 * 1024 || createHash("sha256").update(readFileSync(jar)).digest("hex") !== TLC_SHA256) return null; } catch { return null; }
  return { jar, java: javaBinary(env.JAVA) };
}

/** JAVA may name a JDK or bin directory (Windows environment names are
 * case-insensitive, so a `Java` directory variable is read as JAVA). */
export function javaBinary(value: string | undefined): string {
  if (!value) return "java";
  const exe = process.platform === "win32" ? "java.exe" : "java";
  try { if (statSync(value).isDirectory()) { const found = [join(value, exe), join(value, "bin", exe)].find(p => existsSync(p)); if (found) return found; } } catch { /* Not a local path; spawn resolves the command. */ }
  return value;
}

/** Checker inputs are executed only by this explicit scratch-space generation action. */
export async function checkArtifact(input: unknown, options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; diagnostics?(output: string): void } = {}): Promise<StatechartArtifact> {
  const a = StatechartArtifactSchema.parse(input);
  if (running) throw new Error("One checker may run per helper process.");
  const tool = resolveTlc(options.env);
  const incomplete = (outcome: "unavailable" | "cancelled" | "resource-limited" | "incomplete", detail: string) => StatechartArtifactSchema.parse({ ...a, check: { ...a.check, outcome, modelStates: null, modelTransitions: null, results: a.rules.map(r => ({ rule: r.id, outcome, detail })) }, traces: [] });
  if (!tool) return incomplete("unavailable", "Set TLA2TOOLS to the checksum-verified TLC 1.7.4 jar and JAVA to Java 11 or later. See toolchain setup.");
  if (options.signal?.aborted) return incomplete("cancelled", "Checking was cancelled before execution.");
  const spec = a.files.find(f => f.name.endsWith(".tla"));
  if (!spec) return incomplete("incomplete", "No TLA+ model was supplied.");
  const module = spec.name.slice(0, -4), config = a.files.find(f => f.name === `${module}.cfg`);
  if (!config) return incomplete("incomplete", "The model's authored configuration is missing.");
  const started = Date.now();
  const scratch = mkdtempSync(join(tmpdir(), "mex-statechart-check-")); running = true;
  try {
    const javaVersion = await boundedProcess(tool.java, ["-version"], { cwd: scratch, signal: options.signal, timeoutMs: Math.min(5000, options.timeoutMs ?? L.checkerMs) });
    if (javaVersion.stopped) return incomplete(javaVersion.stopped, "Java runtime inspection did not complete.");
    if (javaVersion.code !== 0) return incomplete("unavailable", "The configured Java runtime could not start.");
    const javaDescription = javaVersion.output.split("\n").find(line => /^(?:openjdk|java) (?:version|[0-9])/u.test(line))?.slice(0, 500) ?? "Java version unavailable";
    for (const f of a.files) writeFileSync(join(scratch, f.name), f.content);
    const dot = join(scratch, "states.dot");
    const r = await boundedProcess(tool.java, ["-Xmx512m", "-XX:ActiveProcessorCount=2", "-Djava.io.tmpdir=" + scratch, "-cp", tool.jar, "tlc2.TLC", "-workers", "1", "-metadir", join(scratch, "tlc"), "-dump", "dot,actionlabels", dot, "-config", config.name, spec.name], { cwd: scratch, signal: options.signal, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? L.checkerMs, L.checkerMs) - (Date.now() - started)), watch: dot });
    options.diagnostics?.(r.output);
    if (r.stopped) return incomplete(r.stopped, r.stopped === "cancelled" ? "Checking cancelled; no success is inferred from partial output." : "Checker exceeded its time, memory, or output budget.");
    const count = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(r.output);
    const modelStates = count ? Number(count[2]!.replaceAll(",", "")) : null;
    if (modelStates && modelStates > L.modelStates) return incomplete("resource-limited", "State exploration exceeded the artifact limit.");
    const broken = /Error: Invariant (\w+) is violated/.exec(r.output)?.[1];
    const temporal = /Temporal properties were violated|Action property .+ is violated|Property .+ is violated/.test(r.output);
    if (Buffer.byteLength(checkerTraceText(r.output)) > 64 * 1024) return incomplete("resource-limited", "The full counterexample exceeded the bounded trace size; reduce model scope and rerun.");
    const success = r.code === 0 && /Model checking completed\. No error has been found\./.test(r.output);
    if (!success && !broken && !temporal && /Error: Deadlock reached\./u.test(r.output)) return incomplete("incomplete", "TLC reached a deadlock: a model state with no enabled next step. Give intended terminal states an explicit stuttering step, or set CHECK_DEADLOCK FALSE in the authored configuration; no passed result is inferred.");
    if (!success && !broken && !temporal) return incomplete("incomplete", "TLC did not complete the configured model. Inspect bounded scratch diagnostics during generation; no passed result is inferred.");
    const goal = a.rules.find(x => x.id === broken)?.kind === "goal";
    const outcome = success ? "passed" : goal ? "goal-reached" : "violated";
    // Keep the authored configuration unchanged; isolate only selected rule
    // sections in scratch, retaining exact constants, constraints and views.
    let isolated: ReturnType<typeof configurationRules>;
    try { isolated = configurationRules(config.content); } catch { return incomplete("incomplete", "The authored configuration could not be isolated without changing its meaning."); }
    const configuredRules = new Map<string, "INVARIANT" | "PROPERTY">([
      ...isolated.rules.map(name => [name, "INVARIANT"] as const),
      ...isolated.properties.map(name => [name, "PROPERTY"] as const),
    ]);
    if ([...configuredRules.keys()].some(id => !a.rules.some(rule => rule.id === id))) return incomplete("incomplete", "The authored configuration checks rules missing from the artifact. Retain and explain every configured rule.");
    const results: StatechartArtifact["check"]["results"] = [];
    let traces: StatechartArtifact["traces"] = [];
    let projectionComplete = false;
    try { const p = await projectChecker(a, readFileSync(dot, "utf8"), r.output); projectionComplete = p.complete; } catch { /* Mapping validity remains separate. */ }
    for (const rule of a.rules) {
      const category = configuredRules.get(rule.id);
      if (!category) { results.push({ rule: rule.id, outcome: "incomplete", detail: "This rule is not selected by the authored configuration." }); continue; }
      let checked = r;
      if (!success) {
        const cfgName = `Rule_${rule.id}.cfg`;
        writeFileSync(join(scratch, cfgName), isolated.cfgWithoutRules + `\n${category} ${rule.id}\n`);
        checked = await boundedProcess(tool.java, ["-Xmx512m", "-XX:ActiveProcessorCount=2", "-Djava.io.tmpdir=" + scratch, "-cp", tool.jar, "tlc2.TLC", "-workers", "1", "-metadir", join(scratch, `rule_${rule.id}`), "-config", cfgName, spec.name], { cwd: scratch, signal: options.signal, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? L.checkerMs, L.checkerMs) - (Date.now() - started)) });
        options.diagnostics?.(checked.output);
        if (checked.stopped) return incomplete(checked.stopped, "Per-rule checking could not complete within the generation budget.");
      }
      const violated = /Error: Invariant \w+ is violated|Temporal properties were violated|Action property .+ is violated|Property .+ is violated/u.test(checked.output);
      const passed = checked.code === 0 && /Model checking completed\. No error has been found\./u.test(checked.output);
      const result = violated ? rule.kind === "goal" ? "goal-reached" : "violated" : passed ? "passed" : "incomplete";
      results.push({ rule: rule.id, outcome: result, detail: violated ? "TLC returned a counterexample for this configured rule; implementation reproduction is separate." : passed ? "TLC completed this configured rule within the recorded model bounds." : "TLC did not establish this rule." });
      if (violated) {
        const raw = checkerTraceText(checked.output);
        if (Buffer.byteLength(raw) > 64 * 1024 || traces.length >= L.traces) return incomplete("resource-limited", "Counterexamples exceeded the bounded artifact trace capacity.");
        let projected: StatechartArtifact["traces"] = [];
        try { projected = (await projectChecker(a, readFileSync(dot, "utf8"), checked.output)).traces; } catch { /* Retain full raw traces when projection is unavailable. */ }
        if (projected.length) traces.push(...projected.map(t => ({ ...t, id: `trace${traces.length + 1}` })));
        else traces.push({ id: `trace${traces.length + 1}`, rule: rule.id, kind: rule.kind === "temporal" ? "temporal" : rule.kind === "goal" ? "goal" : "counterexample", steps: [], raw });
      }
    }
    let modelTransitions: number | null = null;
    try { modelTransitions = readFileSync(dot, "utf8").split("\n").filter(line => /^-?\d+ -> -?\d+/u.test(line)).length; } catch { /* Counts remain unavailable. */ }
    // Ordered finite paths require the agent's reviewed projection; retain raw traces until mapped.
    const resultOutcome = results.some(x => x.outcome === "incomplete") ? "incomplete" : results.some(x => x.outcome === "violated") ? "violated" : results.some(x => x.outcome === "goal-reached") ? "goal-reached" : outcome;
    return StatechartArtifactSchema.parse({ ...a, diagram: { ...a.diagram, validity: projectionComplete ? "valid" : "unverified" }, check: { ...a.check, outcome: resultOutcome, results, modelStates, modelTransitions }, traces, toolchain: { ...a.toolchain, upstream: UPSTREAM, tlc: `1.7.4 sha256:${TLC_SHA256}`, java: javaDescription, renderer: "Mermaid 11.12.0; Pele 1.8.0 / resvg 2.6.2 export" } });
  } finally { running = false; rmSync(scratch, { recursive: true, force: true }); }
}
