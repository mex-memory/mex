import { z } from "zod";

/** Private v1 application seam. These limits also bound storage and browser work. */
export const STATECHART_LIMITS = Object.freeze({ bytes: 512 * 1024, files: 16, fileBytes: 128 * 1024, states: 80, transitions: 200, rules: 32, traces: 16, steps: 256, evidence: 64, previews: 20, snapshots: 100, ttlMs: 24 * 60 * 60 * 1000, checkerMs: 60_000, checkerBytes: 2 * 1024 * 1024, heapMb: 512, modelStates: 100_000 });
export const DiagramIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);
const stateId = id.refine(value => !["state", "classDef", "class", "direction", "end", "note", "hide", "choice", "fork", "join", "history"].includes(value), "Reserved diagram keyword");
const text = z.string().min(1).max(2000);
const label = z.string().min(1).max(180).regex(/^[^\x00-\x1f<>"`{}\\]*$/u);
const refs = z.array(id).max(64);
export const DiagramPathSchema = z.string().min(1).max(240).refine(p => !p.startsWith("/") && !/[:\\\x00-\x1f]/u.test(p) && p.split("/").every(s => s !== "" && s !== "." && s !== ".."), "Expected a portable repository-relative path");
const file = z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.(tla|cfg|json|mmd|txt|md)$/u), content: z.string().max(STATECHART_LIMITS.fileBytes).refine(value => new TextEncoder().encode(value).length <= STATECHART_LIMITS.fileBytes, "File exceeds byte limit") }).strict();
const state = z.object({ id: stateId, label, parent: id.optional(), region: id.optional(), evidence: refs }).strict();
const transition = z.object({ id, from: id, to: id, event: label, condition: z.string().max(2000), evidence: refs, rules: refs }).strict();
const rule = z.object({ id, label: text, kind: z.enum(["invariant", "temporal", "goal"]), provenance: text, evidence: refs }).strict();
const evidence = z.object({ id, path: DiagramPathSchema, line: z.number().int().positive().max(10_000_000).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), kind: z.enum(["code", "test", "knowledge", "history", "requirement"]), explains: refs, note: text }).strict();
const outcome = z.enum(["passed", "violated", "goal-reached", "incomplete", "cancelled", "unavailable", "resource-limited"]);
export const StatechartArtifactSchema = z.object({
  schemaVersion: z.literal(1), title: label, summary: text, scope: text, subject: text, reader: text,
  classification: z.enum(["implemented", "proposed", "agreed-model"]), createdAt: z.string().datetime(),
  states: z.array(state).min(1).max(STATECHART_LIMITS.states), transitions: z.array(transition).max(STATECHART_LIMITS.transitions), initial: refs,
  rules: z.array(rule).max(STATECHART_LIMITS.rules), evidence: z.array(evidence).max(STATECHART_LIMITS.evidence),
  mapping: z.array(z.object({ model: text, targets: refs, evidence: refs }).strict()).max(200),
  files: z.array(file).min(1).max(STATECHART_LIMITS.files),
  diagram: z.object({ validity: z.enum(["valid", "unverified", "invalid"]), mermaid: z.string().max(64 * 1024) }).strict(),
  check: z.object({ outcome, bounds: text, results: z.array(z.object({ rule: id, outcome, detail: text }).strict()).max(32), modelStates: z.number().int().nonnegative().max(STATECHART_LIMITS.modelStates).nullable(), modelTransitions: z.number().int().nonnegative().max(1_000_000).nullable() }).strict(),
  traces: z.array(z.object({ id, rule: id, kind: z.enum(["counterexample", "temporal", "goal"]), steps: z.array(z.object({ state: id, transition: id.optional() }).strict()).max(STATECHART_LIMITS.steps), raw: z.string().max(64 * 1024).refine(value => new TextEncoder().encode(value).length <= 64 * 1024, "Trace exceeds byte limit"), loopTo: z.number().int().nonnegative().max(255).optional() }).strict()).max(STATECHART_LIMITS.traces),
  reproduction: z.object({ outcome: z.enum(["reproduced", "not-reproduced", "partial", "not-attempted", "not-applicable"]), detail: text, evidence: refs }).strict(),
  omissions: z.array(text).max(32), toolchain: z.object({ upstream: text, tlc: text, java: text, renderer: text, regeneration: text }).strict(),
}).strict().superRefine((a, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  const groups = [a.states, a.transitions, a.rules, a.evidence, a.traces];
  for (const xs of groups) if (new Set(xs.map(x => x.id)).size !== xs.length) fail("Duplicate identity");
  const states = new Set(a.states.map(x => x.id)), edges = new Set(a.transitions.map(x => x.id)), rules = new Set(a.rules.map(x => x.id)), evidence = new Set(a.evidence.map(x => x.id));
  const targets = new Set([...states, ...edges, ...rules]);
  const checkRefs = (xs: string[], allowed: Set<string>) => { if (xs.some(x => !allowed.has(x))) fail("Unresolved identity reference"); };
  checkRefs(a.initial, states);
  for (const s of a.states) {
    checkRefs(s.evidence, evidence);
    if (s.region && !s.parent) fail("Regions require a composite parent");
    let cursor = s.parent; const seen = new Set([s.id]);
    while (cursor) { if (seen.has(cursor) || !states.has(cursor)) { fail("Invalid composite state hierarchy"); break; } seen.add(cursor); cursor = a.states.find(x => x.id === cursor)?.parent; }
  }
  for (const t of a.transitions) { checkRefs([t.from, t.to], states); checkRefs(t.evidence, evidence); checkRefs(t.rules, rules); }
  for (const r of a.rules) checkRefs(r.evidence, evidence);
  for (const e of a.evidence) { checkRefs(e.explains, targets); if (!e.explains.length) fail("Evidence must explain behavior"); }
  for (const m of a.mapping) { checkRefs(m.targets, targets); checkRefs(m.evidence, evidence); }
  checkRefs(a.reproduction.evidence, evidence);
  for (const r of a.check.results) { checkRefs([r.rule], rules); if (r.outcome === "goal-reached" && a.rules.find(x => x.id === r.rule)?.kind !== "goal") fail("Only a goal can be reached"); }
  if (new Set(a.check.results.map(r => r.rule)).size !== a.check.results.length) fail("Duplicate rule result");
  if (a.check.outcome === "passed" && (a.check.results.length !== a.rules.length || a.check.results.some(x => x.outcome !== "passed") || !a.check.modelStates)) fail("Passing requires complete rule results and checker counts");
  if (new Set(a.files.map(f => f.name.toLowerCase())).size !== a.files.length) fail("Duplicate portable file name");
  if (a.files.some(f => ["record.md", "diagram.mmd"].includes(f.name.toLowerCase()))) fail("Reserved snapshot companion name");
  for (const t of a.traces) {
    checkRefs([t.rule], rules); if (t.kind === "goal" && a.rules.find(r => r.id === t.rule)?.kind !== "goal") fail("Goal trace requires a goal rule");
    t.steps.forEach((s, i) => { checkRefs([s.state], states); if (s.transition) { checkRefs([s.transition], edges); const e = a.transitions.find(x => x.id === s.transition); if (i === 0 || e?.from !== t.steps[i - 1]?.state || e?.to !== s.state) fail("Trace steps must follow transitions in order"); } else if (i > 0 && t.kind !== "temporal") fail("Finite paths require transition identities"); });
    if (t.kind === "temporal" && !t.raw) fail("Temporal counterexamples retain the checker trace");
    if (t.loopTo !== undefined && t.loopTo >= t.steps.length) fail("Invalid trace loop");
  }
  if (a.diagram.mermaid !== statechartMermaid(a)) fail("Mermaid must be the normalized graph projection");
  if (new TextEncoder().encode(JSON.stringify(a)).length > STATECHART_LIMITS.bytes) fail("Artifact exceeds byte limit");
});

export type StatechartArtifact = z.infer<typeof StatechartArtifactSchema>;
type Graph = { states: z.infer<typeof state>[]; transitions: z.infer<typeof transition>[]; initial: string[] };
/** Generate a closed subset; imported Mermaid directives/HTML never reach a renderer. */
export function statechartMermaid(a: Graph): string {
  const lines = ["stateDiagram-v2"];
  function children(parent?: string, indent = "  ") {
    const xs = a.states.filter(s => s.parent === parent);
    const regions = [...new Set(xs.map(s => s.region ?? ""))];
    regions.forEach((region, n) => { if (n) lines.push(`${indent}--`); for (const s of xs.filter(s => (s.region ?? "") === region)) {
      const nested = a.states.some(x => x.parent === s.id);
      lines.push(`${indent}state "${s.label}" as ${s.id}${nested ? " {" : ""}`);
      if (nested) { children(s.id, indent + "  "); lines.push(indent + "}"); }
    } });
  }
  children();
  for (const i of a.initial) lines.push(`  [*] --> ${i}`);
  for (const t of a.transitions) lines.push(`  ${t.from} --> ${t.to} : ${t.event}`);
  return lines.join("\n") + "\n";
}
export function statechartTerminal(a: StatechartArtifact): string {
  const names = new Map(a.states.map(s => [s.id, s.label]));
  return [`${a.title} — model check: ${a.check.outcome}`, ...a.states.map(s => `[${s.id}] ${s.label}${s.parent ? ` (within ${s.parent}${s.region ? ` / ${s.region}` : ""})` : ""}`), ...a.transitions.map(t => `${names.get(t.from)} -- ${t.event} --> ${names.get(t.to)}${t.condition ? ` [${t.condition}]` : ""}`), ...a.traces.map(t => `${t.kind}: ${t.rule}\n${t.steps.map((s, i) => `${i + 1}. ${names.get(s.state)}${s.transition ? ` via ${s.transition}` : ""}`).join("\n")}${t.kind === "temporal" ? `\n${t.raw}` : ""}`), ...a.rules.map(r => `Rule (${a.check.results.find(x => x.rule === r.id)?.outcome ?? "incomplete"}): ${r.label}`), `Diagram validity: ${a.diagram.validity}. Scope: ${a.scope}`, `Bounds: ${a.check.bounds}`, "Evidence freshness: recorded baselines only; compare current dependencies in Hub.", `Implementation reproduction: ${a.reproduction.outcome}. ${a.reproduction.detail}`, `Omitted: ${a.omissions.join("; ") || "none recorded"}`].join("\n");
}
export const DiagramSummarySchema = z.object({ id: DiagramIdSchema, title: label, summary: text, kind: z.enum(["preview", "saved"]), expiresAt: z.string().datetime().nullable(), outcome }).strict();
export const DiagramCollectionSchema = z.object({ items: z.array(DiagramSummarySchema).max(120), truncated: z.boolean() }).strict();
export const DiagramDetailSchema = z.object({ ...DiagramSummarySchema.shape, revision: z.string().regex(/^[a-f0-9]{64}$/u), artifact: StatechartArtifactSchema, freshness: z.array(z.object({ evidence: id, status: z.enum(["unchanged", "changed", "missing", "unverified"]) }).strict()).max(64), alignment: z.enum(["source-mapped", "unverified"]) }).strict();
export const DiagramSaveRequestSchema = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const DiagramSavePlanSchema = z.object({ token: DiagramIdSchema, previewId: DiagramIdSchema, revision: z.string(), expiresAt: z.string().datetime(), writes: z.array(z.object({ path: DiagramPathSchema, content: z.string().max(STATECHART_LIMITS.bytes) }).strict()).max(18) }).strict();
export const DiagramSaveApplySchema = z.object({ token: DiagramIdSchema }).strict();
export type DiagramCollection = z.infer<typeof DiagramCollectionSchema>;
export type DiagramDetail = z.infer<typeof DiagramDetailSchema>;
export type DiagramSavePlan = z.infer<typeof DiagramSavePlanSchema>;
