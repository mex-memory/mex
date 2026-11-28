import { runtimeBudgetCandidate } from "./statistics.mjs";

export function evaluateRuntimeBudgets(profiles, budgetsForRuntime) {
  const violations = [];
  for (const [profileName, profile] of Object.entries(profiles)) {
    compare(violations, `runtime.coldHubReadyMs.${profileName}`, profile.coldHubReadyMs.p95, budgetsForRuntime.coldHubReadyMs[profileName]);
    compare(violations, `runtime.idleRssBytes.${profileName}`, profile.idle.rssBytes.p95, budgetsForRuntime.idleRssBytes[profileName]);
    compare(violations, `runtime.idleCpuMs.${profileName}`, profile.idle.cpuMs.p95, budgetsForRuntime.idleCpuMs[profileName]);
    for (const [name, measured] of Object.entries(profile.apiLatencyMs)) {
      compare(violations, `runtime.apiLatencyMs.${profileName}.${name}`, measured.p95, budgetsForRuntime.apiLatencyMs[profileName]?.[name]);
    }
    for (const [kind, measured] of Object.entries(profile.maintenance ?? {})) {
      compare(violations, `runtime.maintenanceMs.${profileName}.${kind}`, measured.elapsedMs.p95, budgetsForRuntime.maintenanceMs[profileName]?.[kind]);
      compare(violations, `runtime.maintenancePeakRssBytes.${profileName}.${kind}`, measured.peakRssBytes.p95, budgetsForRuntime.maintenancePeakRssBytes[profileName]?.[kind]);
    }
    compare(violations, `runtime.databaseToInputRatio.${profileName}.graph`, profile.database.graph.ratio, budgetsForRuntime.databaseToInputRatio[profileName]?.graph);
    compare(violations, `runtime.databaseToInputRatio.${profileName}.wiki`, profile.database.wiki.ratio, budgetsForRuntime.databaseToInputRatio[profileName]?.wiki);
    if (profile.browserHeap) {
      if (profile.browserHeap.outboundRequestCount !== 0) {
        violations.push({ metric: `runtime.outboundRequestCount.${profileName}`, measured: profile.browserHeap.outboundRequestCount, budget: 0, reason: "budget_exceeded" });
      }
      for (const [route, measured] of Object.entries(profile.browserHeap.routes)) {
        compare(violations, `runtime.browserHeapBytes.${profileName}.${route}`, measured.p95, budgetsForRuntime.browserHeapBytes[profileName]?.[route]);
      }
    }
  }
  return violations.slice(0, 200);
}

export function candidateRuntimeBudgets(profiles) {
  const coldHubReadyMs = {};
  const idleRssBytes = {};
  const idleCpuMs = {};
  const apiLatencyMs = {};
  const maintenanceMs = {};
  const maintenancePeakRssBytes = {};
  const browserHeapBytes = {};
  const databaseToInputRatio = {};
  for (const [profileName, profile] of Object.entries(profiles)) {
    coldHubReadyMs[profileName] = runtimeBudgetCandidate(profile.coldHubReadyMs.p95);
    idleRssBytes[profileName] = runtimeBudgetCandidate(profile.idle.rssBytes.p95);
    idleCpuMs[profileName] = runtimeBudgetCandidate(profile.idle.cpuMs.p95);
    apiLatencyMs[profileName] = Object.fromEntries(
      Object.entries(profile.apiLatencyMs).map(([name, measured]) => [
        name,
        runtimeBudgetCandidate(measured.p95),
      ]),
    );
    maintenanceMs[profileName] = Object.fromEntries(
      Object.entries(profile.maintenance ?? {}).map(([kind, measured]) => [
        kind,
        runtimeBudgetCandidate(measured.elapsedMs.p95),
      ]),
    );
    maintenancePeakRssBytes[profileName] = Object.fromEntries(
      Object.entries(profile.maintenance ?? {}).map(([kind, measured]) => [
        kind,
        runtimeBudgetCandidate(measured.peakRssBytes.p95),
      ]),
    );
    databaseToInputRatio[profileName] = {
      graph: runtimeBudgetCandidate(profile.database.graph.ratio),
      wiki: runtimeBudgetCandidate(profile.database.wiki.ratio),
    };
    browserHeapBytes[profileName] = Object.fromEntries(
      Object.entries(profile.browserHeap?.routes ?? {}).map(([route, measured]) => [
        route,
        runtimeBudgetCandidate(measured.p95),
      ]),
    );
  }
  return {
    coldHubReadyMs,
    idleRssBytes,
    idleCpuMs,
    apiLatencyMs,
    maintenanceMs,
    maintenancePeakRssBytes,
    browserHeapBytes,
    databaseToInputRatio,
  };
}

function compare(violations, metric, measured, budget) {
  if (!Number.isFinite(budget)) {
    violations.push({ metric, measured, budget: null, reason: "budget_missing" });
    return;
  }
  if (measured > budget) {
    violations.push({ metric, measured, budget, reason: "budget_exceeded" });
  }
}
