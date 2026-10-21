export function calibrationSummary(suite, rows, { repetitions = 2, tokenThreshold = 150_000, turnThreshold = 20 } = {}) {
  return { suiteId: suite.id, mode: "calibration", repetitions, tokenThreshold, turnThreshold,
    tasks: suite.tasks.map((task) => {
      const runs = rows.filter((r) => r.taskId === task.id && r.arm === "files");
      const selected = Array.from({ length: repetitions }, (_, i) => runs.find((r) => r.repetition === i + 1));
      const complete = selected.every((r) => r?.valid && Number.isFinite(r.metrics.processed) && Number.isFinite(r.metrics.turns));
      return { taskId: task.id, complete, selected: complete && selected.every((r) => r.metrics.processed >= tokenThreshold && r.metrics.turns >= turnThreshold),
        runs: selected.map((r, i) => ({ repetition: i + 1, valid: r?.valid ?? false, processed: r?.metrics.processed ?? null, turns: r?.metrics.turns ?? null })) };
    }) };
}

export function calibrationMarkdown(summary) {
  return `# Calibration: ${summary.suiteId}\n\nAll ${summary.repetitions} valid files runs must reach ${summary.tokenThreshold} processed tokens and ${summary.turnThreshold} turns.\n\n| Task | Complete | Select | Tokens / turns per run |\n|---|---|---|---|\n${summary.tasks.map((t) => `| ${t.taskId} | ${t.complete} | ${t.selected} | ${t.runs.map((r) => `${r.processed ?? "missing"} / ${r.turns ?? "missing"}`).join("; ")} |`).join("\n")}\n`;
}
