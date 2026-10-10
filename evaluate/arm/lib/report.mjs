// Aggregate agent-arm rows into blind-review files and report.md.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES } from "./classify.mjs";

export function loadRows(outputDir) {
  const dir = join(outputDir, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
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
  const valid = rows.filter((row) => row.valid);
  const armIds = Object.keys(suite.arms);
  const lines = [`# ${suite.id} agent-arm report`, "", `Rows: ${rows.length} (${valid.length} valid, ${rows.length - valid.length} invalid).`, ""];

  lines.push("## Per task and arm", "", "| Task | Arm | Valid | Correct | Median new tokens | Median processed | Median time (s) | Median turns | Median tool calls | Median MEX calls | Median fallbacks |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const task of suite.tasks) {
    for (const arm of armIds) {
      const subset = valid.filter((row) => row.taskId === task.id && row.arm === arm);
      const graded = subset.map((row) => correctness(row, grades, salt)).filter((value) => value !== null);
      const correct = graded.length ? `${graded.filter(Boolean).length}/${graded.length}` : "ungraded";
      const pick = (key) => median(subset.map((row) => row.metrics[key]));
      lines.push(`| ${task.id} | ${arm} | ${subset.length} | ${correct} | ${fmt(pick("newTokens"))} | ${fmt(pick("processed"))} | ${fmt((pick("elapsedMs") ?? NaN) / 1000, 1)} | ${fmt(pick("turns"))} | ${fmt(pick("toolCalls"))} | ${fmt(pick("mexCalls"))} | ${fmt(pick("fallbacks"))} |`);
    }
  }

  const [control, treatment] = armIds;
  const pairs = [];
  for (const task of suite.tasks) {
    for (const row of valid.filter((entry) => entry.taskId === task.id && entry.arm === treatment)) {
      const other = valid.find((entry) => entry.taskId === task.id && entry.arm === control && entry.repetition === row.repetition);
      if (other) pairs.push({ taskId: task.id, repetition: row.repetition, treatment: row, control: other });
    }
  }
  lines.push("", `## Paired deltas (${treatment} − ${control})`, "", `Matched pairs: ${pairs.length}. Intervals are 95% percentile bootstraps of the mean paired delta.`, "", `| Metric | Total ${control} | Total ${treatment} | Total change | Mean paired delta | 95% CI |`, "|---|---|---|---|---|---|");
  for (const [label, key] of [["New tokens", "newTokens"], ["Processed tokens", "processed"], ["Wall time (ms)", "elapsedMs"], ["Tool calls", "toolCalls"]]) {
    const deltas = pairs.map((pair) => pair.treatment.metrics[key] - pair.control.metrics[key]);
    const totalControl = pairs.reduce((sum, pair) => sum + (pair.control.metrics[key] ?? 0), 0);
    const totalTreatment = pairs.reduce((sum, pair) => sum + (pair.treatment.metrics[key] ?? 0), 0);
    const ci = bootstrapMean(deltas);
    lines.push(`| ${label} | ${fmt(totalControl)} | ${fmt(totalTreatment)} | ${totalControl ? pct((totalTreatment - totalControl) / totalControl) : "–"} | ${fmt(ci.mean)} | ${ci.low === null ? "–" : `${fmt(ci.low)} … ${fmt(ci.high)}`} |`);
  }

  const mexRows = valid.filter((row) => row.arm === treatment);
  lines.push("", `## Allocation (${treatment} arm, mean share per session)`, "", "| Category | Share of calls | Share of returned chars |", "|---|---|---|");
  for (const category of CATEGORIES) {
    const calls = mean(mexRows.map((row) => row.allocation?.[category]?.callShare ?? 0));
    const chars = mean(mexRows.map((row) => row.allocation?.[category]?.charShare ?? 0));
    if (calls || chars) lines.push(`| ${category} | ${pct(calls)} | ${pct(chars)} |`);
  }
  const baselineControl = valid.filter((row) => row.arm === control);
  lines.push("", `Fallbacks per ${treatment} session: median ${fmt(median(mexRows.map((row) => row.metrics.fallbacks)))}; ${control} discovery calls per session: median ${fmt(median(baselineControl.map((row) => row.allocation?.discovery?.calls ?? 0)))}.`, "Fallback causes (empty / wrong / verify / skipped) need transcript review; record them in grades.json under `fallbackCauses`.");

  const forced = mexRows.filter((row) => row.compliance);
  if (forced.length) {
    const checks = ["routerRead", "routedRead", "scopeBeforeSource", "impactBeforeEdit", "checkAfterEdit"];
    const yes = (value) => (value === undefined ? "–" : value ? "yes" : "no");
    lines.push("", `## Forced-policy compliance (${treatment} arm)`, "", `Compliant: ${forced.filter((row) => row.compliance.compliant).length}/${forced.length}. Rows are kept either way; detection of shell edits is heuristic.`, "", `| Run | ${checks.join(" | ")} |`, `|---|${checks.map(() => "---").join("|")}|`);
    for (const row of forced) lines.push(`| ${row.runId} | ${checks.map((key) => yes(row.compliance[key])).join(" | ")} |`);
  }

  lines.push("", "## Loop close (change tasks)", "", "| Run | Tests | Knowledge files edited | Grounding issues vs baseline | Hand-edited hashes |", "|---|---|---|---|---|");
  for (const row of mexRows.filter((entry) => entry.taskType === "change")) {
    const baseline = baselines[row.indexKey]?.grounding?.length ?? 0;
    const now = row.mexCheck?.grounding?.length ?? null;
    const codes = row.mexCheck ? Object.entries(row.mexCheck.counts).filter(([code]) => code.startsWith("GROUNDING_")).map(([code, n]) => `${code}×${n}`).join(", ") : "–";
    lines.push(`| ${row.runId} | ${row.hiddenTests ? `${row.hiddenTests.passed}/${row.hiddenTests.total}${row.hiddenTests.ok ? " ✓" : " ✗"}` : "–"} | ${row.diff.knowledgeFiles.join(", ") || "none"} | ${now === null ? "–" : `${now - baseline} (${codes || "none"})`} | ${row.metrics.handHashEdits} |`);
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
