// Aggregate agent-arm rows into blind-review files and report.md.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pairedRatio } from "./statistics.mjs";
import { parseSession, testCommandTime } from "./telemetry.mjs";
import { CATEGORIES } from "./classify.mjs";
import { firstCall, measureSession, neutralizeRows } from "./measures.mjs";
import { readContextLog } from "./hooks.mjs";
import { parseCodex, codexTestTime } from "./codex.mjs";
import { CHANGE_SCHEMA } from "./session.mjs";
import { ANSWER_SCHEMA } from "../../compare/lib/answer.mjs";

export function loadRows(outputDir, suite = null) {
  const dir = join(outputDir, "runs");
  if (!existsSync(dir)) return [];
  const rows = readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  for (const row of rows) {
    const path = join(outputDir, "artifacts", `${row.runId}.jsonl`);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8"), task = suite?.tasks.find((t) => t.id === row.taskId) ?? { gold: {} };
    if (row.agent === "codex") {
      const last = join(outputDir, "artifacts", `${row.runId}.last-message.json`);
      const parsed = parseCodex(raw, existsSync(last) ? readFileSync(last, "utf8") : null, row.taskType === "change" ? CHANGE_SCHEMA : ANSWER_SCHEMA);
      if (!parsed.usage.accountingValid || !parsed.structured.ok || parsed.malformedLines) {
        row.valid = false;
        row.violations = [...new Set([...(row.violations ?? []), "Codex artifacts failed accounting/schema validation"])];
      }
      row.accounting = parsed.accounting;
      row.testCommandTime = codexTestTime(parsed.events, parsed.toolCalls);
      Object.assign(row.metrics, { input: parsed.usage.input, processed: parsed.usage.reportedTotal, uncachedInput: parsed.usage.uncachedInput, cacheRead: parsed.usage.cacheRead, cacheWrite: parsed.usage.cacheWrite, output: parsed.usage.output, reasoning: parsed.usage.reasoning, newTokens: parsed.usage.newTokens, costUsd: null, neutralCostUsd: null, testCommandMs: row.testCommandTime.ms, agentMinusTestMs: row.testCommandTime.ms === null ? null : Math.max(0, row.metrics.elapsedMs - row.testCommandTime.ms) });
      continue;
    }
    const parsed = parseSession(raw, task);
    if (!parsed.usage.accountingValid) {
      row.valid = false;
      row.violations = [...new Set([...(row.violations ?? []), `token accounting: ${parsed.usage.accountingReason}`])];
    }
    row.accounting = parsed.accounting;
    row.testCommandTime = testCommandTime(raw, parsed.toolCalls);
    row.metrics.testCommandMs = row.testCommandTime.ms;
    row.metrics.agentMinusTestMs = row.testCommandTime.ms === null ? null : Math.max(0, row.metrics.elapsedMs - row.testCommandTime.ms);
    row.firstCall = firstCall(raw);
    row.metrics.costUsd = parsed.usage.reportedCostUsd;
    for (const [key, value] of Object.entries({ uncachedInput: parsed.usage.uncachedInput, cacheWrite: parsed.usage.cacheWrite, cacheRead: parsed.usage.cacheRead, output: parsed.usage.output, newTokens: parsed.usage.newTokens, processed: parsed.usage.reportedTotal })) row.metrics[key] = value;
    const cachedIndex = join(outputDir, "index-cache", row.indexKey, "context-index.json");
    row.measures = measureSession({ raw, calls: parsed.toolCalls, entries: readContextLog(join(outputDir, "artifacts", `${row.runId}.context-log.jsonl`)).entries,
      task, answer: JSON.stringify(parsed.rawResult), contextIndex: existsSync(cachedIndex) ? JSON.parse(readFileSync(cachedIndex, "utf8")) : null });
    for (const key of ["discoveryCalls", "redundantSearches", "turnsToGoldFile", "wikiShowCalls"]) row.metrics[key] = row.measures[key];
  }
  return neutralizeRows(rows);
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/** Deterministic percentile bootstrap of the mean. */
export function bootstrapMean(values, { resamples = 10_000, seed = 1 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return { mean: mean(finite), low: null, high: null, n: finite.length };
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const means = [];
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < finite.length; i += 1) sum += finite[Math.floor(random() * finite.length)];
    means.push(sum / finite.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(finite), low: means[Math.floor(0.025 * resamples)], high: means[Math.floor(0.975 * resamples)], n: finite.length };
}

function blindId(row, salt) {
  return createHash("sha256").update(`${salt}:${row.runId}`).digest("hex").slice(0, 10);
}

/** Answers without arm identity, for grading against the suite's answer points. */
export function buildBlindReview(suite, rows, salt) {
  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const items = rows.filter((row) => row.valid).map((row) => {
    const task = tasks.get(row.taskId);
    return {
      blindId: blindId(row, salt), taskId: row.taskId, type: task.type, prompt: task.prompt,
      answerPoints: task.gold?.answerPoints ?? null, staleAnswer: task.gold?.staleAnswer ?? null,
      answer: row.answer ?? null,
      change: row.change ? { summary: row.change.summary, filesChanged: row.change.filesChanged, hiddenTests: row.hiddenTests } : null,
    };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId) || a.blindId.localeCompare(b.blindId));
  const reveal = Object.fromEntries(rows.filter((row) => row.valid).map((row) => [blindId(row, salt), { runId: row.runId, arm: row.arm }]));
  return { review: { suiteId: suite.id, instructions: "Grade each item against answerPoints; record { correct, pointsMet, notes, labeler } in grades.json keyed by blindId.", items }, reveal };
}

function correctness(row, grades, salt) {
  if (row.taskType === "change") return row.hiddenTests ? row.hiddenTests.ok : null;
  const grade = grades?.[blindId(row, salt)];
  return grade ? Boolean(grade.correct) : null;
}

const fmt = (value, digits = 0) => (value === null || value === undefined || Number.isNaN(value) ? "–" : Number(value).toFixed(digits));
const pct = (value) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);

export function generateReport({ suite, rows, grades = null, salt, baselines = {} }) {
  if (rows.some((r) => r.mode === "calibration")) throw new Error("calibration rows cannot feed main reports");
  if (rows.some((r) => r.agent === "codex")) return codexReport(suite, rows, grades, salt);
  neutralizeRows(rows);
  const valid = rows.filter((row) => row.valid);
  const armIds = Object.keys(suite.arms).filter((id) => rows.some((r) => r.arm === id));
  const lines = [`# ${suite.id} agent-arm report`, "", `Rows: ${rows.length} (${valid.length} valid, ${rows.length - valid.length} invalid).`, ""];
  lines.push("## Primary measures", "", "Processed tokens count all input, cache and output tokens. Neutral cost reprices a cold first call using the median warm first-call prefix in this output. Warm-up usage is excluded. Injection uptake is a bounded heuristic, not proof of causation.", "",
    "| Arm | Rows | Processed tokens | Neutral USD | Real USD | Discovery calls | Used / ignored injections | Redundant searches | Off-gold prompt injections | Median calls to gold file | Wiki shows | Graph / knowledge injections |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of armIds) {
    const subset = valid.filter((r) => r.arm === arm);
    const sum = (key) => subset.reduce((s, r) => s + (r.measures?.[key] ?? r.metrics[key] ?? 0), 0);
    lines.push(`| ${arm} | ${subset.length} | ${fmt(sum("processed"))} | ${subset.some((r) => r.metrics.neutralCostUsd === null) ? "unavailable" : fmt(sum("neutralCostUsd"), 4)} | ${fmt(sum("costUsd"), 4)} | ${sum("discoveryCalls")} | ${sum("injectionsUsed")} / ${sum("injectionsIgnored")} | ${sum("redundantSearches")} | ${subset.reduce((s,r) => s + (r.measures?.offGoldInjections.length ?? 0),0)} | ${fmt(median(subset.map((r) => r.measures?.turnsToGoldFile)), 1)} | ${sum("wikiShowCalls")} | ${sum("graphInjections")} / ${sum("knowledgeInjections")} |`);
  }
  lines.push("", "## Discovery and gold-file latency", "", "A missing gold-file visit stays missing; latency medians exclude it.", "",
    "| Run | Discovery | Redundant | Calls to gold file | Wiki shows | Alignment |", "|---|---|---|---|---|---|");
  for (const row of valid.filter((r) => r.measures)) {
    const m=row.measures;
    lines.push(`| ${row.runId} | ${m.discoveryCalls} | ${m.redundantSearches} | ${fmt(m.turnsToGoldFile)} | ${m.wikiShowCalls} | ${m.alignment} |`);
  }
  lines.push("", "## Injection uptake", "", "Each packet is one hook injection. Follow-up calls are listed for off-gold prompt packets; complete inputs remain in the row.", "",
    "| Run | Kind / hook | IDs | After call | Uptake | Off gold | Following calls |", "|---|---|---|---|---|---|---|");
  for (const row of valid) for (const packet of row.measures?.injections ?? []) {
    lines.push(`| ${row.runId} | ${packet.kind} / ${packet.event} | ${packet.ids.join(", ") || "none"} | ${packet.afterToolCall} | ${packet.used ? "used" : "ignored"} | ${packet.offGold ? "yes" : "no"} | ${packet.followingCalls.map((c,i)=>`${packet.afterToolCall+i+1}:${c.name}`).join(", ") || "none"} |`);
  }

  lines.push("## Per task and arm", "", "| Task | Arm | Valid | Correct | Median new tokens | Median processed | Median time (s) | Median turns | Median tool calls | Median MEX calls | Median discovery calls |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const task of suite.tasks) {
    for (const arm of armIds) {
      const subset = valid.filter((row) => row.taskId === task.id && row.arm === arm);
      const graded = subset.map((row) => correctness(row, grades, salt)).filter((value) => value !== null);
      const correct = graded.length ? `${graded.filter(Boolean).length}/${graded.length}` : "ungraded";
      const pick = (key) => median(subset.map((row) => row.metrics[key]));
      lines.push(`| ${task.id} | ${arm} | ${subset.length} | ${correct} | ${fmt(pick("newTokens"))} | ${fmt(pick("processed"))} | ${fmt((pick("elapsedMs") ?? NaN) / 1000, 1)} | ${fmt(pick("turns"))} | ${fmt(pick("toolCalls"))} | ${fmt(pick("mexCalls"))} | ${fmt(pick("discoveryCalls"))} |`);
    }
  }

  const control = "files", treatments = armIds.filter((id) => id !== control);

  lines.push("", "## Task outcomes (all tasks)", "", "Win/loss counts compare paired processed tokens; correctness is shown separately. Invalid or missing pairs are excluded.", "", "| Task | Stratum | Pairs | Token wins / losses / ties | Correct files / treatment |", "|---|---|---|---|---|");
  const allPairs = [];
  for (const treatment of treatments) for (const row of valid.filter((r) => r.arm === treatment)) {
    const other = valid.find((r) => r.arm === control && r.taskId === row.taskId && r.repetition === row.repetition);
    if (other) allPairs.push({ taskId: row.taskId, treatment: row, control: other });
  }
  for (const task of suite.tasks) {
    const pairs = allPairs.filter((p) => p.taskId === task.id);
    const win = pairs.filter((p) => p.treatment.metrics.processed < p.control.metrics.processed).length;
    const loss = pairs.filter((p) => p.treatment.metrics.processed > p.control.metrics.processed).length;
    const correct = (side) => { const scores = pairs.map((p) => correctness(p[side], grades, salt)).filter((v) => v !== null); return scores.length ? `${scores.filter(Boolean).length}/${scores.length}` : "ungraded"; };
    lines.push(`| ${task.id} | ${task.stratum ?? (task.heavy ? "heavy" : "light")} | ${pairs.length} | ${win} / ${loss} / ${pairs.length - win - loss} | ${correct("control")} / ${correct("treatment")} |`);
  }
  lines.push("", "## Paired geometric ratios", "", "Treatment / files; equal task weight, geometric mean over repetitions within task. Bootstrap resamples whole tasks (10,000 draws, 95% percentile CI); signed-rank check uses task mean log ratios. Nonpositive or unavailable metrics are excluded. Light controls are separate.", "", "| Arm | Stratum | Metric | Tasks / pairs | Ratio | Cluster 95% CI | Wilcoxon p |", "|---|---|---|---|---|---|---|");
  for (const treatment of treatments) for (const stratum of ["heavy", "light"]) for (const key of ["processed", "costUsd"]) {
    const pairs = allPairs.filter((p) => p.treatment.arm === treatment && (suite.tasks.find((t) => t.id === p.taskId)?.stratum ?? (suite.tasks.find((t) => t.id === p.taskId)?.heavy ? "heavy" : "light")) === stratum);
    const result = pairedRatio(pairs, key);
    lines.push(`| ${treatment} | ${stratum} | ${key} | ${result.tasks} / ${result.pairs} | ${fmt(result.ratio, 3)} | ${fmt(result.low, 3)} … ${fmt(result.high, 3)} | ${fmt(result.wilcoxon?.p, 4)} |`);
  }
  lines.push("", "## Delivery cost and time", "", "Cost per success includes all valid attempts' paid cost; ungraded answers remain ungraded. Test time uses the union of timestamped test tool intervals; missing timestamps stay unavailable.", "", "| Arm | Kind | Correct / graded | USD per success | Median agent minus tests (ms) |", "|---|---|---|---|---|");
  for (const arm of armIds) for (const kind of ["qa", "change"]) {
    const subset = valid.filter((r) => r.arm === arm && r.taskType === kind);
    const graded = subset.map((r) => correctness(r, grades, salt)).filter((v) => v !== null);
    const successes = graded.filter(Boolean).length;
    const paid = subset.every((r) => Number.isFinite(r.metrics.costUsd)) ? subset.reduce((s, r) => s + r.metrics.costUsd, 0) : null;
    lines.push(`| ${arm} | ${kind} | ${successes} / ${graded.length} | ${graded.length !== subset.length || paid === null ? "ungraded/unavailable" : successes ? fmt(paid / successes, 4) : "no successes"} | ${fmt(median(subset.map((r) => r.metrics.agentMinusTestMs)))} |`);
  }
  lines.push("", "## Session audit", "", "| Run | Hooks fired | Settle launched / outcome | Resume / restart | Accounting |", "|---|---|---|---|---|");
  for (const row of rows) lines.push(`| ${row.runId} | ${row.arm === "files" ? "n/a" : row.hooks?.hookEvents > 0 ? "yes" : "MISSING"} | ${row.settleLaunched ?? "unknown"} / ${row.settleOutcome ?? "unknown"} | ${row.execution?.resumeCount ?? "unknown"} / ${row.execution?.restartCount ?? "unknown"} | ${row.accounting?.status ?? "legacy"} |`);

  // Tokens are never added together: uncached input, cache writes, cache reads and output stay apart, with the cost the agent reported.
  const TOKEN_KEYS = [["Input (uncached)", "uncachedInput"], ["Cache write", "cacheWrite"], ["Cache read", "cacheRead"], ["Output", "output"]];
  lines.push("", "## Tokens and cost per task and arm (medians)", "", `| Task | Arm | ${TOKEN_KEYS.map(([label]) => label).join(" | ")} | Cost (USD) |`, `|---|---|${TOKEN_KEYS.map(() => "---").join("|")}|---|`);
  for (const task of suite.tasks) {
    for (const arm of armIds) {
      const subset = valid.filter((row) => row.taskId === task.id && row.arm === arm);
      lines.push(`| ${task.id} | ${arm} | ${TOKEN_KEYS.map(([, key]) => fmt(median(subset.map((row) => row.metrics[key])))).join(" | ")} | ${fmt(median(subset.map((row) => row.metrics.costUsd)), 3)} |`);
    }
  }
  lines.push("", "Totals per arm over valid rows:", "", `| Arm | Rows | ${TOKEN_KEYS.map(([label]) => label).join(" | ")} | Cost (USD) |`, `|---|---|${TOKEN_KEYS.map(() => "---").join("|")}|---|`);
  for (const arm of armIds) {
    const subset = valid.filter((row) => row.arm === arm);
    const total = (key) => subset.reduce((sum, row) => sum + (Number(row.metrics[key]) || 0), 0);
    lines.push(`| ${arm} | ${subset.length} | ${TOKEN_KEYS.map(([, key]) => fmt(total(key))).join(" | ")} | ${fmt(total("costUsd"), 3)} |`);
  }

  for (const treatment of treatments) {
    const pairs = [];
    for (const task of suite.tasks) {
      for (const row of valid.filter((entry) => entry.taskId === task.id && entry.arm === treatment)) {
        const other = valid.find((entry) => entry.taskId === task.id && entry.arm === control && entry.repetition === row.repetition);
        if (other) pairs.push({ taskId: task.id, repetition: row.repetition, treatment: row, control: other });
      }
    }
    lines.push("", `## Paired deltas (${treatment} − ${control})`, "", `Matched pairs: ${pairs.length}. Intervals are 95% percentile bootstraps of the mean paired delta.`, "", `| Metric | Total ${control} | Total ${treatment} | Total change | Mean paired delta | 95% CI |`, "|---|---|---|---|---|---|");
    for (const [label, key] of [["Processed tokens", "processed"], ["Neutral cost (USD)", "neutralCostUsd"], ["Real cost (USD)", "costUsd"], ...TOKEN_KEYS, ["Wall time (ms)", "elapsedMs"], ["Discovery calls", "discoveryCalls"], ["Tool calls", "toolCalls"]]) {
      const digits = key.endsWith("CostUsd") || key === "costUsd" ? 3 : 0;
      const deltas = pairs.map((pair) => pair.treatment.metrics[key] - pair.control.metrics[key]);
      const totalControl = pairs.reduce((sum, pair) => sum + (pair.control.metrics[key] ?? 0), 0);
      const totalTreatment = pairs.reduce((sum, pair) => sum + (pair.treatment.metrics[key] ?? 0), 0);
      const ci = bootstrapMean(deltas);
      lines.push(`| ${label} | ${fmt(totalControl, digits)} | ${fmt(totalTreatment, digits)} | ${totalControl ? pct((totalTreatment - totalControl) / totalControl) : "–"} | ${fmt(ci.mean, digits)} | ${ci.low === null ? "–" : `${fmt(ci.low, digits)} … ${fmt(ci.high, digits)}`} |`);
    }

    const armRows = valid.filter((row) => row.arm === treatment);
    lines.push("", `## Allocation (${treatment} arm, mean share per session)`, "", "| Category | Share of calls | Share of returned chars |", "|---|---|---|");
    for (const category of CATEGORIES) {
      const calls = mean(armRows.map((row) => row.allocation?.[category]?.callShare ?? 0));
      const chars = mean(armRows.map((row) => row.allocation?.[category]?.charShare ?? 0));
      if (calls || chars) lines.push(`| ${category} | ${pct(calls)} | ${pct(chars)} |`);
    }
    const baselineControl = valid.filter((row) => row.arm === control);
    lines.push("", `Discovery calls per ${treatment} session: median ${fmt(median(armRows.map((row) => row.metrics.discoveryCalls)))}; ${control}: median ${fmt(median(baselineControl.map((row) => row.metrics.discoveryCalls)))}.`);
  }

  // What the product hooks did, per session: events, what they injected, the end-of-session work.
  const hookRows = valid.filter((row) => row.hooks);
  if (hookRows.length) {
    lines.push("", "## Hooks (per session)", "", "Events counted per kind with how many injected something; chars are what the hooks sent to the agent; hook time is in-session only (the settle worker is separate).", "",
      "| Run | Prompt (inj) | Read (inj) | Edit (inj) | Grep (inj) | Bash (inj) | Hook ms | Injected chars | Budget hit | Stop blocks | Block ids | Flagged at stop | Settle passes | Refresh mode | Regrounded | Failures | Settle wait (s) |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const cell = (hooks, kind) => `${hooks.perEvent[kind].count} (${hooks.perEvent[kind].injected})`;
    for (const row of hookRows) {
      const hooks = row.hooks;
      const modes = [...new Set(hooks.settle.passes.map((pass) => pass.refresh?.mode).filter(Boolean))].join("/") || "–";
      lines.push(`| ${row.runId} | ${["prompt", "read", "edit", "grep", "bash"].map((kind) => cell(hooks, kind)).join(" | ")} | ${fmt(hooks.hookMs)} | ${fmt(hooks.injectedChars)} | ${hooks.budgetHit ? "yes" : "no"} | ${hooks.stopBlocks.count}${hooks.stopBlocks.undelivered ? ` (${hooks.stopBlocks.undelivered} undelivered)` : ""} | ${hooks.stopBlocks.ids.join(", ") || "–"} | ${(hooks.stopFlagged ?? []).length} | ${hooks.settle.count} | ${modes} | ${hooks.settle.regrounded} | ${hooks.failures.length} | ${fmt((row.settleWait?.waitMs ?? 0) / 1000, 1)} |`);
    }
    lines.push("", "Per arm (valid rows, mean per session):", "", "| Arm | Rows | Hook events | Hook ms | Injected chars | Sessions with a Stop block | Sessions with failures |", "|---|---|---|---|---|---|---|");
    for (const arm of treatments) {
      const subset = hookRows.filter((row) => row.arm === arm);
      if (!subset.length) continue;
      lines.push(`| ${arm} | ${subset.length} | ${fmt(mean(subset.map((row) => row.hooks.hookEvents)), 1)} | ${fmt(mean(subset.map((row) => row.hooks.hookMs)))} | ${fmt(mean(subset.map((row) => row.hooks.injectedChars)))} | ${subset.filter((row) => row.hooks.stopBlocks.count > 0).length} | ${subset.filter((row) => row.hooks.failures.length > 0).length} |`);
    }
  }
  const treatment = treatments.join(", ");
  const mexRows = valid.filter((row) => treatments.includes(row.arm));

  const forced = mexRows.filter((row) => row.compliance);
  if (forced.length) {
    const checks = ["routerRead", "knowledgeConsulted", "scopeBeforeSource", "impactBeforeEdit", "checkAfterEdit"];
    const yes = (value) => (value === undefined ? "–" : value ? "yes" : "no");
    lines.push("", `## Forced-policy compliance (${treatment} arm)`, "", `Compliant: ${forced.filter((row) => row.compliance.compliant).length}/${forced.length}. Rows are kept either way; detection of shell edits is heuristic.`, "", `| Run | ${checks.join(" | ")} |`, `|---|${checks.map(() => "---").join("|")}|`);
    for (const row of forced) lines.push(`| ${row.runId} | ${checks.map((key) => yes(row.compliance[key])).join(" | ")} |`);
  }

  lines.push("", "## Loop close (change tasks)", "", "| Run | Tests | Knowledge files edited | Grounding issues vs baseline | Grounding lines rewritten | Hand-edited hashes |", "|---|---|---|---|---|---|");
  for (const row of mexRows.filter((entry) => entry.taskType === "change")) {
    const baseline = baselines[row.indexKey]?.grounding?.length ?? 0;
    const now = row.mexCheck?.grounding?.length ?? null;
    const codes = row.mexCheck ? Object.entries(row.mexCheck.counts).filter(([code]) => code.startsWith("GROUNDING_")).map(([code, n]) => `${code}×${n}`).join(", ") : "–";
    lines.push(`| ${row.runId} | ${row.hiddenTests ? `${row.hiddenTests.passed}/${row.hiddenTests.total}${row.hiddenTests.ok ? " ✓" : " ✗"}` : "–"} | ${row.diff.knowledgeFiles.join(", ") || "none"} | ${now === null ? "–" : `${now - baseline} (${codes || "none"})`} | ${row.diff.groundingLinesChanged ?? "–"} | ${row.metrics.handHashEdits} |`);
  }

  const trap = suite.tasks.find((task) => task.scaffold === "trap");
  if (trap) {
    lines.push("", `## Stale trap (${trap.id})`, "", "| Run | Arm | MEX flagged drift | Correct (graded) |", "|---|---|---|---|");
    for (const row of valid.filter((entry) => entry.taskId === trap.id)) {
      const flagged = row.mexCheck ? row.mexCheck.grounding.some((issue) => /DRIFT|MISSING|AMBIGUOUS/.test(issue.code)) : null;
      const graded = correctness(row, grades, salt);
      lines.push(`| ${row.runId} | ${row.arm} | ${flagged === null ? "–" : flagged ? "yes" : "no"} | ${graded === null ? "ungraded" : graded ? "yes" : "no"} |`);
    }
  }

  const invalid = rows.filter((row) => !row.valid);
  if (invalid.length) {
    lines.push("", "## Invalid rows (rerun; never graded)", "");
    for (const row of invalid) lines.push(`- ${row.runId}: ${row.violations.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function codexReport(suite, rows, grades, salt) {
  const lines = [`# ${suite.id} Codex report`, "", `Rows: ${rows.length} (${rows.filter((r) => r.valid).length} valid).`, "", "Usage is summed across turn.completed events. Processed = input + output; uncached = input - cached input. Reasoning is a subset of output. No dollar cost is assigned to the subscription plan.", "", "| Run | Valid | Correct | Input | Cached input | Cache write | Output | Reasoning | Processed | Uncached | Agent ms | Test ms | Agent minus test ms |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) { const m = r.metrics; lines.push(`| ${r.runId} | ${r.valid} | ${correctness(r, grades, salt) ?? "ungraded"} | ${m.input} | ${m.cacheRead} | ${m.cacheWrite} | ${m.output} | ${m.reasoning} | ${m.processed} | ${m.uncachedInput} | ${m.elapsedMs} | ${m.testCommandMs ?? "unavailable"} | ${m.agentMinusTestMs ?? "unavailable"} |`); }
  lines.push("", "| Run | Model / effort / sandbox | Hook recipes | Calls | Peak RSS bytes | Violations |", "|---|---|---|---|---|---|");
  for (const r of rows) lines.push(`| ${r.runId} | ${r.model} / ${r.effort} / ${r.sandbox} | ${Object.keys(r.hooks?.promptNotes ?? {}).join(", ") || "none"} | ${r.metrics.toolCalls} | ${r.resources?.session?.peakRss ?? "unavailable"} | ${(r.violations ?? []).join("; ").replaceAll("|", "\\|")} |`);
  lines.push("", "Fake sessions verify process wiring, isolation, parsing, hook recipe checks, grading and cleanup. They do not verify model behavior, Codex sandbox permissions for package-manager caches, semantic retrieval quality, or macOS execution. The director must run the real pilot with the same pinned CLI, model and effort for all arms.", "");
  return lines.join("\n");
}
