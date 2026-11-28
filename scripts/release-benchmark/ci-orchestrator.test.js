import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  finalizeCiAttempts,
  readCiRetryRequired,
  runCiAttempt,
} from "./ci-orchestrator.mjs";
import { runtimeMaterialityPolicy } from "./runtime-confirmation.mjs";

const HEAD = "a".repeat(40);
const SCRIPT = new URL("./ci-orchestrator.mjs", import.meta.url);

describe("release benchmark fresh-runner CI orchestration", () => {
  it("runs exactly one enforcing raw attempt and prints its bounded retry decision", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-ci-attempt-"));
    const metric = "runtime.apiLatencyMs.small.session";
    const pass = runtimePass(metric);
    try {
      const blocked = attempt(root, "first", pass, { enforceReleaseBudgets: "0" });
      expect(blocked.exitCode).toBe(2);
      expect(blocked.calls).toBe(0);
      expect(blocked.errors).toEqual([
        "MEX_ENFORCE_RELEASE_BUDGETS=1 is required for a CI benchmark attempt",
      ]);

      const result = attempt(root, "first", pass);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(1);
      expect(result.manifest).toEqual({
        schemaVersion: 1,
        kind: "mex-release-benchmark-attempt",
        repositoryHead: HEAD,
        github: { runId: "12345", runAttempt: "2", sha: HEAD },
        runnerAllocation: {
          job: "first",
          runnerName: "runner-first",
          runnerOs: "Linux",
          runnerArch: "X64",
        },
        rawReportSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        retryRequired: true,
        disposition: "confirmation_required",
      });
      expect(readCiRetryRequired(result.manifestPath)).toBe(true);
      expect(Buffer.byteLength(readFileSync(result.manifestPath))).toBeLessThan(16 * 1024);

      const cli = spawnSync(process.execPath, [
        fileURLToPath(SCRIPT),
        "retry-required",
        "--manifest",
        result.manifestPath,
      ], { encoding: "utf8" });
      expect(cli.status).toBe(0);
      expect(cli.stdout).toBe("true\n");
      expect(cli.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires raw reports to prove pinned runtime and asset enforcement", () => {
    for (const mutate of [
      (pass) => { pass.environment.pinnedBudgetEnvironment = false; },
      (pass) => { pass.configuration.runtimeBudgetsEnforced = false; },
      (pass) => { pass.configuration.assetBudgetsEnforced = false; },
      (pass) => { delete pass.configuration.runtimeBudgetsEnforced; },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "mex-release-ci-pinned-"));
      try {
        const pass = benchmarkPass();
        mutate(pass);
        const result = attempt(root, "first", pass);
        expect(result.exitCode).toBe(2);
        expect(result.calls).toBe(1);
        expect(result.manifest).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("skips a fresh runner for clean and advisory first attempts", () => {
    for (const [name, pass, expectedStatus] of [
      ["clean", benchmarkPass(), "not_required"],
      ["advisory", runtimePass("runtime.apiLatencyMs.small.session", { measured: runtimeMaterialityPolicy("runtime.apiLatencyMs.small.session").budget + 1, support: 0 }), "passed"],
    ]) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-ci-${name}-`));
      try {
        const first = attempt(root, "first", pass);
        expect(first.exitCode).toBe(0);
        expect(first.manifest.retryRequired).toBe(false);
        const finalized = finalize(root, first);
        expect(finalized.exitCode).toBe(0);
        expect(finalized.report.budgetEvaluation).toMatchObject({
          runtimeViolations: [],
          passed: true,
          runtimeConfirmation: {
            status: expectedStatus,
            repositoryHead: HEAD,
            runnerAllocations: {
              first: {
                runId: "12345",
                runAttempt: "2",
                job: "first",
              },
            },
          },
        });
        expect(finalized.report.budgetEvaluation.runtimeConfirmation.runnerAllocations)
          .not.toHaveProperty("second");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("passes different material metrics measured by distinct job allocations", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-ci-different-"));
    try {
      const first = attempt(root, "first", runtimePass("runtime.apiLatencyMs.small.session"));
      const second = attempt(root, "second", runtimePass("runtime.apiLatencyMs.small.projects"));
      expect(first.manifest.retryRequired).toBe(true);
      expect(second.manifest.retryRequired).toBe(true);

      const finalized = finalize(root, first, second);
      expect(finalized.exitCode).toBe(0);
      expect(finalized.report.budgetEvaluation).toMatchObject({
        assetViolations: [],
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "passed",
          confirmedViolations: [],
          materialAssessments: [],
          runnerAllocations: {
            first: { job: "first" },
            second: { job: "second" },
          },
        },
      });
      expect(finalized.report.budgetEvaluation.runtimeConfirmation.advisoryAssessments)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ metric: "runtime.apiLatencyMs.small.session", reason: "not_repeated" }),
          expect.objectContaining({ metric: "runtime.apiLatencyMs.small.projects", reason: "not_repeated" }),
        ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the same supported material metric across distinct jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-ci-same-"));
    const metric = "runtime.apiLatencyMs.small.session";
    try {
      const first = attempt(root, "first", runtimePass(metric, { excess: 1 }));
      const second = attempt(root, "second", runtimePass(metric, { excess: 4 }));
      const finalized = finalize(root, first, second);
      expect(finalized.exitCode).toBe(1);
      expect(finalized.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [expect.objectContaining({ metric })],
        passed: false,
        runtimeConfirmation: {
          status: "failed",
          confirmedViolations: [expect.objectContaining({ metric })],
          materialAssessments: [{
            metric,
            classification: "material",
            reason: "repeated_material_threshold",
            firstSupportingSamples: 2,
            secondSupportingSamples: 2,
          }],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts mixed selective-rerun attempts and still applies the exact metric policy", () => {
    const metric = "runtime.apiLatencyMs.small.session";
    for (const [name, secondMetric, expectedExit] of [
      ["different", "runtime.apiLatencyMs.small.projects", 0],
      ["same", metric, 1],
    ]) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-ci-mixed-${name}-`));
      try {
        const first = attempt(root, "first", runtimePass(metric), { runAttempt: "1" });
        const second = attempt(root, "second", runtimePass(secondMetric), { runAttempt: "2" });
        const finalized = finalize(root, first, second, { runAttempt: "2" });
        expect(finalized.exitCode, name).toBe(expectedExit);
        expect(finalized.errors, name).toEqual([]);
        expect(finalized.report.budgetEvaluation.runtimeConfirmation.runnerAllocations)
          .toMatchObject({
            first: { runAttempt: "1", job: "first" },
            second: { runAttempt: "2", job: "second" },
          });
        expect(finalized.report.budgetEvaluation.runtimeConfirmation.status)
          .toBe(expectedExit === 0 ? "passed" : "failed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects producer evidence from a future workflow attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-ci-future-attempt-"));
    try {
      const first = attempt(
        root,
        "first",
        runtimePass("runtime.apiLatencyMs.small.session"),
        { runAttempt: "9007199254740993" },
      );
      const result = finalize(root, first, undefined, { runAttempt: "9007199254740992" });
      expect(result.exitCode).toBe(2);
      expect(result.errors).toEqual([
        "Benchmark evidence belongs to a different GitHub run allocation",
      ]);
      expect(result.report).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps deterministic, immediate, and second-attempt asset failures hard", () => {
    const immediate = violation("runtime.databaseToInputRatio.small.graph", 101, 100);
    const asset = violation("assets.routes.home.jsBytes", 101, 100);
    for (const [name, firstPass, secondPass] of [
      ["first-immediate", benchmarkPass({ runtimeViolations: [immediate] }), undefined],
      ["first-asset", benchmarkPass({ assetViolations: [asset] }), undefined],
      ["second-immediate", runtimePass("runtime.apiLatencyMs.small.session"), benchmarkPass({ runtimeViolations: [immediate] })],
      ["second-asset", runtimePass("runtime.apiLatencyMs.small.session"), benchmarkPass({ assetViolations: [asset] })],
    ]) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-ci-${name}-`));
      try {
        const first = attempt(root, "first", firstPass);
        const second = secondPass === undefined ? undefined : attempt(root, "second", secondPass);
        const finalized = finalize(root, first, second);
        expect(finalized.exitCode, name).toBe(1);
        expect(finalized.report.budgetEvaluation.passed, name).toBe(false);
        if (name === "second-asset") {
          expect(finalized.report.budgetEvaluation.assetViolations).toEqual([asset]);
          expect(finalized.report.budgetEvaluation.runtimeConfirmation.status).toBe("failed");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("fails operationally for missing, invalid, mismatched, or reused evidence", () => {
    const metric = "runtime.apiLatencyMs.small.session";
    const scenarios = [
      ["missing-first-report", ({ root, first }) => {
        rmSync(first.reportPath, { force: true });
        return finalize(root, first);
      }],
      ["malformed-first-report", ({ root, first }) => {
        writeFileSync(first.reportPath, "not-json\n");
        return finalize(root, first);
      }],
      ["missing-second", ({ root, first }) => finalize(root, first)],
      ["same-job", ({ root, first }) => {
        const second = attempt(root, "first", runtimePass(metric), { suffix: "second" });
        return finalize(root, first, second);
      }],
      ["different-run", ({ root, first }) => {
        const second = attempt(root, "second", runtimePass(metric), { runId: "99999" });
        return finalize(root, first, second);
      }],
      ["older-confirmation-attempt", ({ root, first }) => {
        const second = attempt(root, "second", runtimePass(metric), { runAttempt: "1" });
        return finalize(root, first, second);
      }],
      ["second-sha", ({ root, first }) => {
        const second = attempt(root, "second", runtimePass(metric), { sha: "b".repeat(40) });
        return finalize(root, first, second);
      }],
      ["report-digest", ({ root, first }) => {
        const second = attempt(root, "second", runtimePass(metric));
        writeFileSync(second.reportPath, `${readFileSync(second.reportPath, "utf8")}\n`);
        return finalize(root, first, second);
      }],
      ["malformed-manifest", ({ root, first }) => {
        const second = attempt(root, "second", runtimePass(metric));
        writeFileSync(second.manifestPath, "not-json\n");
        return finalize(root, first, second);
      }],
    ];
    for (const [name, run] of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-ci-operational-${name}-`));
      try {
        const first = attempt(root, "first", runtimePass(metric));
        const outputPath = join(root, "report.json");
        writeFileSync(outputPath, "stale\n");
        const result = run({ root, first });
        expect(result.exitCode, name).toBe(2);
        expect(result.errors, name).toHaveLength(1);
        expect(existsSync(outputPath), name).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects malformed sample evidence before publishing a retry manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-ci-evidence-"));
    const pass = runtimePass("runtime.apiLatencyMs.small.session");
    pass.profiles.small.apiLatencyMs.session.samples.pop();
    try {
      const result = attempt(root, "first", pass);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toBe(1);
      expect(result.manifest).toBeUndefined();
      expect(result.errors[0]).toMatch(/Invalid raw samples/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function attempt(root, job, pass, overrides = {}) {
  const suffix = overrides.suffix ?? job;
  const reportPath = join(root, `report-${suffix}.json`);
  const manifestPath = join(root, `manifest-${suffix}.json`);
  let calls = 0;
  const errors = [];
  const dependencies = {
    enforceReleaseBudgets: Object.hasOwn(overrides, "enforceReleaseBudgets")
      ? overrides.enforceReleaseBudgets
      : "1",
    resolveRepositoryHead: () => overrides.sha ?? HEAD,
    resolveGithubIdentity: () => githubIdentity(job, overrides),
    executePass(path) {
      calls += 1;
      writeFileSync(path, `${JSON.stringify(pass, null, 2)}\n`);
      return { status: pass.budgetEvaluation.passed ? 0 : 1, signal: null };
    },
    emitError: (error) => errors.push(error.message),
  };
  const exitCode = runCiAttempt({ reportPath, manifestPath }, dependencies);
  return {
    calls,
    errors,
    exitCode,
    reportPath,
    manifestPath,
    manifest: existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf8"))
      : undefined,
  };
}

function finalize(root, first, second, identityOverrides = {}) {
  const outputPath = join(root, "report.json");
  const errors = [];
  const exitCode = finalizeCiAttempts({
    firstReportPath: first.reportPath,
    firstManifestPath: first.manifestPath,
    ...(second === undefined ? {} : {
      secondReportPath: second.reportPath,
      secondManifestPath: second.manifestPath,
    }),
    outputPath,
  }, {
    resolveRepositoryHead: () => HEAD,
    resolveGithubIdentity: () => githubIdentity("finalizer", identityOverrides),
    emitReport: () => undefined,
    emitError: (error) => errors.push(error.message),
  });
  return {
    errors,
    exitCode,
    report: existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, "utf8")) : undefined,
  };
}

function githubIdentity(job, overrides = {}) {
  return {
    runId: overrides.runId ?? "12345",
    runAttempt: overrides.runAttempt ?? "2",
    sha: overrides.sha ?? HEAD,
    job,
    runnerName: `runner-${job}`,
    runnerOs: "Linux",
    runnerArch: "X64",
  };
}

function benchmarkPass({ assetViolations = [], runtimeViolations = [], profiles = {} } = {}) {
  return {
    schemaVersion: 1,
    benchmark: "mex-release-performance",
    environment: { pinnedBudgetEnvironment: true },
    configuration: { runtimeBudgetsEnforced: true, assetBudgetsEnforced: true },
    profiles,
    budgetEvaluation: {
      assetViolations,
      runtimeViolations,
      passed: assetViolations.length === 0 && runtimeViolations.length === 0,
    },
  };
}

function runtimePass(metric, { measured, excess = 1, support = 2 } = {}) {
  const policy = runtimeMaterialityPolicy(metric);
  const value = measured ?? policy.materialThreshold + excess;
  const runtimeViolation = violation(metric, value, policy.budget);
  const samples = Array(policy.sampleCount).fill(0);
  if (support > 0) {
    for (let index = policy.sampleCount - support; index < policy.sampleCount - 1; index += 1) {
      samples[index] = policy.materialThreshold + ((value - policy.materialThreshold) / 2);
    }
  }
  samples[policy.sampleCount - 1] = value;
  const summary = { samples, p95: value };
  const [, category, profile, name] = metric.split(".");
  if (category !== "apiLatencyMs") throw new Error(`Unsupported test metric: ${metric}`);
  return benchmarkPass({
    runtimeViolations: [runtimeViolation],
    profiles: { [profile]: { apiLatencyMs: { [name]: summary } } },
  });
}

function violation(metric, measured, budget) {
  return { metric, measured, budget, reason: "budget_exceeded" };
}
