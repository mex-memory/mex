import { readFileSync } from "node:fs";
import { nearestRank, round } from "./statistics.mjs";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const MAX_VIOLATIONS = 200;
const RELATIVE_EXCESS_RATIO = 0.15;
const REQUIRED_SUPPORTING_SAMPLES = 2;
const MIB = 1024 * 1024;
const RUNTIME_MATERIALITY_POLICIES = runtimeMaterialityPolicies(
  budgets.runtime,
  budgets.samples,
);

export function classifyRuntimeViolations(violations) {
  const confirmable = [];
  const immediate = [];
  for (const violation of violations.slice(0, MAX_VIOLATIONS)) {
    const destination = isConfirmableRuntimeViolation(violation)
      ? confirmable
      : immediate;
    destination.push(violation);
  }
  return { confirmable, immediate };
}

export function evaluateRuntimeConfirmation(
  firstPassViolations,
  secondPassViolations,
  sampleSupport = {},
) {
  const first = classifyRuntimeViolations(firstPassViolations);
  if (first.immediate.length > 0) {
    const advisoryAssessments = first.confirmable.map((violation) => {
      const policy = RUNTIME_MATERIALITY_POLICIES.get(violation.metric);
      return materialityAssessment({
        metric: violation.metric,
        first: violation,
        policy,
        reason: "not_repeated",
        firstSupport: optionalSupportForMetric(sampleSupport.first, violation.metric, policy),
      });
    });
    return {
      retryRequired: false,
      status: "skipped_immediate_failure",
      finalViolations: first.immediate,
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
      advisoryAssessments,
      materialAssessments: [],
    };
  }
  if (first.confirmable.length === 0) {
    return {
      retryRequired: false,
      status: "not_required",
      finalViolations: [],
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
      advisoryAssessments: [],
      materialAssessments: [],
    };
  }
  if (secondPassViolations === undefined) {
    const advisoryAssessments = [];
    let potentiallyMaterial = false;
    for (const violation of first.confirmable) {
      const policy = RUNTIME_MATERIALITY_POLICIES.get(violation.metric);
      if (violation.measured <= policy.materialThreshold) {
        advisoryAssessments.push(materialityAssessment({
          metric: violation.metric,
          first: violation,
          policy,
          reason: "below_material_threshold",
          firstSupport: supportForMetric(sampleSupport.first, violation.metric, policy),
        }));
        continue;
      }
      const firstSupport = supportForMetric(sampleSupport.first, violation.metric, policy);
      if (firstSupport.supportingSamples < REQUIRED_SUPPORTING_SAMPLES) {
        advisoryAssessments.push(materialityAssessment({
          metric: violation.metric,
          first: violation,
          policy,
          reason: "insufficient_sample_support",
          firstSupport,
        }));
        continue;
      }
      potentiallyMaterial = true;
    }
    if (!potentiallyMaterial) {
      return {
        retryRequired: false,
        status: "passed",
        finalViolations: [],
        first,
        second: { confirmable: [], immediate: [] },
        confirmed: [],
        advisoryAssessments,
        materialAssessments: [],
      };
    }
    return {
      retryRequired: true,
      status: "required",
      finalViolations: [],
      first,
      second: { confirmable: [], immediate: [] },
      confirmed: [],
      advisoryAssessments,
      materialAssessments: [],
    };
  }

  const second = classifyRuntimeViolations(secondPassViolations);
  const firstMetrics = new Set(first.confirmable.map((violation) => violation.metric));
  const confirmed = second.confirmable.filter((violation) => firstMetrics.has(violation.metric));
  const assessments = assessMateriality(
    first.confirmable,
    second.confirmable,
    sampleSupport,
  );
  const advisoryAssessments = assessments.filter((assessment) => assessment.classification === "advisory");
  const materialAssessments = assessments.filter((assessment) => assessment.classification === "material");
  const materialMetrics = new Set(materialAssessments.map((assessment) => assessment.metric));
  const materialViolations = confirmed.filter((violation) => materialMetrics.has(violation.metric));
  const finalViolations = [...second.immediate, ...materialViolations].slice(0, MAX_VIOLATIONS);
  return {
    retryRequired: false,
    status: finalViolations.length === 0 ? "passed" : "failed",
    finalViolations,
    first,
    second,
    confirmed,
    advisoryAssessments,
    materialAssessments,
  };
}

export function runtimeMaterialityPolicy(metric) {
  const policy = RUNTIME_MATERIALITY_POLICIES.get(metric);
  if (policy === undefined) return null;
  return {
    budget: policy.budget,
    category: policy.category,
    minimumExcess: policy.minimumExcess,
    materialThreshold: policy.materialThreshold,
    sampleCount: policy.sampleCount,
    requiredSupportingSamples: REQUIRED_SUPPORTING_SAMPLES,
  };
}

export function runtimeSampleSupport(report, violations) {
  const support = new Map();
  for (const violation of classifyRuntimeViolations(violations).confirmable) {
    const policy = RUNTIME_MATERIALITY_POLICIES.get(violation.metric);
    if (support.has(violation.metric)) {
      throw new Error(`Duplicate runtime metric in benchmark report: ${violation.metric}`);
    }
    let summary = report;
    for (const segment of policy.summaryPath) {
      if (summary === null
        || typeof summary !== "object"
        || !Object.hasOwn(summary, segment)) {
        throw new Error(`Missing raw samples for runtime metric: ${violation.metric}`);
      }
      summary = summary[segment];
    }
    if (!Array.isArray(summary?.samples)
      || summary.samples.length !== policy.sampleCount
      || !summary.samples.every((sample) => Number.isFinite(sample) && sample >= 0)) {
      throw new Error(`Invalid raw samples for runtime metric: ${violation.metric}`);
    }
    const measuredP95 = round(nearestRank(summary.samples, 0.95));
    if (summary.p95 !== measuredP95 || violation.measured !== measuredP95) {
      throw new Error(`Runtime p95 does not match raw samples: ${violation.metric}`);
    }
    support.set(violation.metric, Object.freeze({
      sampleCount: summary.samples.length,
      supportingSamples: summary.samples.filter(
        (sample) => sample > policy.materialThreshold,
      ).length,
    }));
  }
  return support;
}

function isConfirmableRuntimeViolation(violation) {
  const policy = RUNTIME_MATERIALITY_POLICIES.get(violation?.metric);
  return policy !== undefined
    && violation.reason === "budget_exceeded"
    && violation.budget === policy.budget
    && Number.isFinite(violation.measured)
    && violation.measured > policy.budget;
}

function assessMateriality(firstViolations, secondViolations, sampleSupport) {
  const firstByMetric = new Map(firstViolations.map((violation) => [violation.metric, violation]));
  const secondByMetric = new Map(secondViolations.map((violation) => [violation.metric, violation]));
  const metrics = [...firstByMetric.keys()];
  for (const metric of secondByMetric.keys()) {
    if (!firstByMetric.has(metric)) metrics.push(metric);
  }
  return metrics.slice(0, MAX_VIOLATIONS * 2).map((metric) => {
    const first = firstByMetric.get(metric);
    const second = secondByMetric.get(metric);
    const policy = RUNTIME_MATERIALITY_POLICIES.get(metric);
    const repeated = first !== undefined && second !== undefined;
    const firstSupport = first === undefined
      ? undefined
      : supportForMetric(sampleSupport.first, metric, policy);
    const secondSupport = second === undefined
      ? undefined
      : supportForMetric(sampleSupport.second, metric, policy);
    const aboveMaterialThreshold = repeated
      && first.measured > policy.materialThreshold
      && second.measured > policy.materialThreshold;
    const hasSampleSupport = aboveMaterialThreshold
      && firstSupport.supportingSamples >= REQUIRED_SUPPORTING_SAMPLES
      && secondSupport.supportingSamples >= REQUIRED_SUPPORTING_SAMPLES;
    const reason = !repeated
      ? first !== undefined && first.measured <= policy.materialThreshold
        ? "below_material_threshold"
        : first !== undefined
          && firstSupport.supportingSamples < REQUIRED_SUPPORTING_SAMPLES
          ? "insufficient_sample_support"
          : "not_repeated"
      : !aboveMaterialThreshold
        ? "below_material_threshold"
        : hasSampleSupport
          ? "repeated_material_threshold"
          : "insufficient_sample_support";
    return materialityAssessment({
      metric,
      first,
      second,
      policy,
      reason,
      firstSupport,
      secondSupport,
    });
  });
}

function materialityAssessment({
  metric,
  first,
  second,
  policy,
  reason,
  firstSupport,
  secondSupport,
}) {
  const material = reason === "repeated_material_threshold";
  return {
    metric,
    category: policy.category,
    classification: material ? "material" : "advisory",
    reason,
    budget: policy.budget,
    relativeExcessRatio: RELATIVE_EXCESS_RATIO,
    minimumExcess: policy.minimumExcess,
    materialThreshold: policy.materialThreshold,
    firstMeasured: first?.measured ?? null,
    secondMeasured: second?.measured ?? null,
    requiredSupportingSamples: REQUIRED_SUPPORTING_SAMPLES,
    ...(firstSupport === undefined ? {} : {
      firstSampleCount: firstSupport.sampleCount,
      firstSupportingSamples: firstSupport.supportingSamples,
    }),
    ...(secondSupport === undefined ? {} : {
      secondSampleCount: secondSupport.sampleCount,
      secondSupportingSamples: secondSupport.supportingSamples,
    }),
  };
}

function supportForMetric(support, metric, policy) {
  const value = support instanceof Map ? support.get(metric) : undefined;
  if (value === undefined
    || value.sampleCount !== policy.sampleCount
    || !Number.isInteger(value.supportingSamples)
    || value.supportingSamples < 0
    || value.supportingSamples > value.sampleCount) {
    throw new Error(`Missing valid runtime sample support for metric: ${metric}`);
  }
  return value;
}

function optionalSupportForMetric(support, metric, policy) {
  if (!(support instanceof Map) || !support.has(metric)) return undefined;
  return supportForMetric(support, metric, policy);
}

function runtimeMaterialityPolicies(runtimeBudgets, sampleCounts) {
  const policies = new Map();
  addProfilePolicies(policies, runtimeBudgets.coldHubReadyMs, {
    category: "cold_readiness_ms",
    metricName: "coldHubReadyMs",
    minimumExcess: 100,
    sampleCount: sampleCounts.timing,
    summaryPath: (profile) => ["profiles", profile, "coldHubReadyMs"],
  });
  addProfilePolicies(policies, runtimeBudgets.idleRssBytes, {
    category: "rss_bytes",
    metricName: "idleRssBytes",
    minimumExcess: 32 * MIB,
    sampleCount: sampleCounts.idleMemory,
    summaryPath: (profile) => ["profiles", profile, "idle", "rssBytes"],
  });
  addProfilePolicies(policies, runtimeBudgets.idleCpuMs, {
    category: "idle_cpu_ms",
    metricName: "idleCpuMs",
    minimumExcess: 25,
    sampleCount: sampleCounts.idleMemory,
    summaryPath: (profile) => ["profiles", profile, "idle", "cpuMs"],
  });
  addNestedPolicies(policies, runtimeBudgets.apiLatencyMs, {
    category: "api_latency_ms",
    metricName: "apiLatencyMs",
    minimumExcess: 15,
    sampleCount: sampleCounts.timing,
    summaryPath: (profile, name) => ["profiles", profile, "apiLatencyMs", name],
  });
  addNestedPolicies(policies, runtimeBudgets.maintenanceMs, {
    category: "maintenance_ms",
    metricName: "maintenanceMs",
    minimumExcess: 50,
    sampleCount: sampleCounts.timing,
    summaryPath: (profile, name) => ["profiles", profile, "maintenance", name, "elapsedMs"],
  });
  addNestedPolicies(policies, runtimeBudgets.maintenancePeakRssBytes, {
    category: "rss_bytes",
    metricName: "maintenancePeakRssBytes",
    minimumExcess: 32 * MIB,
    sampleCount: sampleCounts.idleMemory,
    summaryPath: (profile, name) => ["profiles", profile, "maintenance", name, "peakRssBytes"],
  });
  addNestedPolicies(policies, runtimeBudgets.browserHeapBytes, {
    category: "browser_heap_bytes",
    metricName: "browserHeapBytes",
    minimumExcess: 2 * MIB,
    sampleCount: sampleCounts.idleMemory,
    summaryPath: (profile, name) => ["profiles", profile, "browserHeap", "routes", name],
  });
  return policies;
}

function addProfilePolicies(policies, budgetsForMetric, definition) {
  for (const [profile, budget] of Object.entries(budgetsForMetric ?? {})) {
    addPolicy(
      policies,
      `runtime.${definition.metricName}.${profile}`,
      budget,
      definition,
      definition.summaryPath(profile),
    );
  }
}

function addNestedPolicies(policies, budgetsForMetric, definition) {
  for (const [profile, entries] of Object.entries(budgetsForMetric ?? {})) {
    for (const [name, budget] of Object.entries(entries)) {
      addPolicy(
        policies,
        `runtime.${definition.metricName}.${profile}.${name}`,
        budget,
        definition,
        definition.summaryPath(profile, name),
      );
    }
  }
}

function addPolicy(policies, metric, budget, definition, summaryPath) {
  // Uncalibrated owned leaves fail as budget_missing, never as confirmable noise.
  if (!Number.isFinite(budget)) return;
  const minimumExcess = definition.minimumExcess;
  policies.set(metric, Object.freeze({
    budget,
    category: definition.category,
    minimumExcess,
    materialThreshold: budget + Math.max(budget * RELATIVE_EXCESS_RATIO, minimumExcess),
    sampleCount: definition.sampleCount,
    summaryPath: Object.freeze(summaryPath),
  }));
}
