import { modelUsage, totals } from "./usage.mjs";

const usd = value => value === null ? "to confirm" : "$" + value.toFixed(6);
const cells = usage => [usage.input, usage.cacheWrite, usage.cacheRead, usage.output, usd(usage.dollars)].join(" | ");

export function buildReport(rows, setup) {
  const tasks = rows.map(({ agentUsage, mexCalls, ...row }) => {
    const mexUsage = modelUsage(mexCalls);
    return { ...row, agentUsage, mexUsage, mexCalls, combined: totals([agentUsage, mexUsage]) };
  });
  const chains = ["baseline", "mex"].map(arm => {
    const attempts = tasks.filter(row => row.arm === arm);
    const accepted = attempts.filter(row => row.accepted).length;
    const usage = totals(attempts.map(row => row.combined));
    return { arm, accepted, tasks: attempts.length, turns: attempts.reduce((n, row) => n + row.turns, 0),
      wallMs: attempts.reduce((n, row) => n + row.wallMs, 0), usage,
      costPerAccepted: accepted && usage.dollars !== null ? usage.dollars / accepted : null };
  });
  return { tasks, chains, setup: modelUsage(setup) };
}

export function renderReport(report, manifest) {
  const lines = [
    "# " + manifest.agent + " · " + manifest.suite,
    "",
    "Tokens counted from native sessions and the MEX local record. Time measured in milliseconds.",
    "USD at list prices (" + manifest.prices.profile + ", " + manifest.prices.date + ").",
    "",
    "| Task | Arm | Usage | Accepted | Uncached input | Cache write | Cache read | Output | List-price USD | Turns | Wall ms |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const task of report.tasks) {
    lines.push("| " + task.task + " | " + task.arm + " | Agent | " + (task.accepted ? "yes" : "no") + " | "
      + cells(task.agentUsage) + " | " + task.turns + " | " + task.wallMs + " |");
    if (task.arm === "mex") lines.push("| " + task.task + " | mex | MEX AI" + (task.mexUsage.estimated ? " (estimated)" : "")
      + " | | " + cells(task.mexUsage) + " | | |");
  }
  lines.push("", "| Chain | Accepted / tasks | Uncached input | Cache write | Cache read | Output | List-price USD | Turns | Wall ms | USD per accepted |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const chain of report.chains) {
    const perAccepted = chain.accepted ? usd(chain.costPerAccepted) : "n/a";
    lines.push("| " + chain.arm + " | " + chain.accepted + " / " + chain.tasks + " | " + cells(chain.usage)
      + " | " + chain.turns + " | " + chain.wallMs + " | " + perAccepted + " |");
  }
  const unknown = [...new Set(report.chains.flatMap(chain => chain.usage.unpricedModels).concat(report.setup.unpricedModels))].sort();
  if (unknown.length) lines.push("", "List prices to confirm for " + unknown.join(", ") + ".");
  lines.push("", "MEX setup AI" + (report.setup.estimated ? " (estimated)" : "") + " outside chain totals: "
    + report.setup.input + " uncached input, " + report.setup.cacheWrite + " cache write, " + report.setup.cacheRead
    + " cache read, " + report.setup.output + " output, " + usd(report.setup.dollars) + ".");
  return lines.join("\n") + "\n";
}
