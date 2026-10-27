import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, ".."), scratch = mkdtempSync(join(tmpdir(), "mex-statechart-packed-"));
const run = (file, args, cwd = root, extraEnv = {}) => { const r = spawnSync(file, args, { cwd, env: { ...process.env, MEX_TELEMETRY: "0", ...extraEnv }, encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }); if (r.error || r.status !== 0) throw new Error(`${file} failed: ${r.stderr}\n${r.stdout}`); return r.stdout; };
try {
  if (!process.env.TLA2TOOLS) throw new Error("Packed checker qualification requires the real checksum-verified TLA2TOOLS jar.");
  const npm = process.env.npm_execpath; if (!npm) throw new Error("Run through npm.");
  const raw = run(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", scratch]);
  const start = raw.trim().lastIndexOf("\n[");
  const pack = JSON.parse(start === -1 ? raw.trim() : raw.trim().slice(start + 1));
  run("tar", ["-xf", join(scratch, pack[0].filename), "-C", scratch]);
  const source = join(scratch, "package/skills/mex-statechart");
  for (const p of ["scripts/runtime.mjs", "upstream/LICENSE", "upstream/SHA256.json", "references/upstream-workflow.md"]) if (!existsSync(join(source, p))) throw new Error(`Packed skill missing ${p}`);
  // Exercise the managed-installed tree from a clean consumer with no node_modules.
  const consumer = join(scratch, "consumer"); mkdirSync(join(consumer, ".mex"), { recursive: true });
  const installed = join(consumer, ".agents/skills/mex-statechart"); cpSync(source, installed, { recursive: true });
  const candidate = join(scratch, "candidate.json"), checked = join(scratch, "checked.json");
  writeFileSync(candidate, readFileSync(join(installed, "references/example.json")));
  const helper = join(installed, "scripts/runtime.mjs"); run(process.execPath, [helper, "validate", candidate], consumer);
  run(process.execPath, [helper, "check", candidate, checked], consumer);
  const a = JSON.parse(readFileSync(checked, "utf8")); if (a.check.outcome !== "passed" || a.diagram.validity !== "valid") throw new Error("Packed helper did not check the real model and graph.");
  const terminal = run(process.execPath, [helper, "terminal", checked], consumer); if (!terminal.includes("Ready -- Start work --> Working") || !terminal.includes("model check: passed")) throw new Error("Packed terminal projection is unreadable.");
  const draft = join(scratch, "draft.json"), normalized = join(scratch, "normalized.json"); writeFileSync(draft, JSON.stringify({ ...a, diagram: { validity: "unverified", mermaid: "" } }));
  run(process.execPath, [helper, "normalize", draft, normalized], consumer); if (JSON.parse(readFileSync(normalized, "utf8")).diagram.mermaid !== a.diagram.mermaid) throw new Error("Packed normalize did not derive the graph's Mermaid.");
  const view = join(scratch, "view"), shown = run(process.execPath, [helper, "show", checked, view, "--text-only"], consumer);
  if (!shown.includes("Ready -- Start work --> Working") || readFileSync(join(view, "diagram.mmd"), "utf8") !== a.diagram.mermaid) throw new Error("Packed show did not deliver the checked graph.");
  const chart = join(scratch, "agreed.mmd");
  writeFileSync(chart, 'stateDiagram-v2\n  state "Ready" as ready\n  state "Complete" as done\n  [*] --> ready\n  ready --> done : Finish work\n');
  run(process.execPath, [helper, "workflow", "from-chart", chart], consumer, { JAVA: undefined });
  const model = join(scratch, "Agreed.tla"), config = join(scratch, "Agreed.cfg"), map = join(scratch, "Agreed.map.mjs");
  const referenceBefore = readFileSync(model, "utf8"), configBefore = readFileSync(config, "utf8");
  const referenceDir = join(scratch, "reference"), fixedDir = join(scratch, "fixed");
  mkdirSync(referenceDir); mkdirSync(fixedDir);
  for (const dir of [referenceDir, fixedDir]) { writeFileSync(join(dir, "Agreed.tla"), referenceBefore); writeFileSync(join(dir, "Agreed.cfg"), configBefore); }
  run(process.execPath, [helper, "workflow", "from-spec", model, "--map", map, "--against", join(referenceDir, "Agreed.tla"), "--against-config", join(referenceDir, "Agreed.cfg"), "--out", join(scratch, "reference-comparison")], consumer, { JAVA: undefined });
  run(process.execPath, [helper, "workflow", "from-spec", model, "--map", map, "--fixed", join(fixedDir, "Agreed.tla"), "--fixed-config", join(fixedDir, "Agreed.cfg"), "--out", join(scratch, "fixed-comparison")], consumer, { JAVA: undefined });
  if ([scratch, referenceDir, fixedDir].some(dir => readFileSync(join(dir, "Agreed.tla"), "utf8") !== referenceBefore || readFileSync(join(dir, "Agreed.cfg"), "utf8") !== configBefore)) throw new Error("Baseline comparisons changed their reference model or authored config.");
  const preview = JSON.parse(run(process.execPath, [helper, "register", checked, consumer], consumer)); if (!/^\/diagrams\/preview\/[a-f0-9]{32}$/.test(preview.route)) throw new Error("Missing opaque preview route.");
  if (existsSync(join(consumer, ".mex/diagrams")) || existsSync(join(consumer, ".mex/graph.db"))) throw new Error("Generation wrote canonical/index state.");
  console.log("Packed self-contained statechart skill: real TLC, projection, terminal output and private preview registration passed.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
