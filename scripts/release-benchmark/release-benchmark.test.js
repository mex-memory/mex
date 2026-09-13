import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it, vi } from "vitest";
import { assertNoForbiddenWorkbench, assertSetupManifestBoundary, evaluateAssetBudgets, evaluateSetupAssetBudget, measureBuiltAssets, measureSetupAssets } from "./assets.mjs";
import { assertReleaseRouteReady } from "./browser.mjs";
import {
  releaseWorkbenchPaths,
  RELEASE_ROUTE_KEYS,
  RELEASE_ROUTE_PATTERNS,
  RELEASE_ROUTE_REDIRECTS,
} from "./routes.mjs";
import { createBenchmarkEnvironment } from "./environment.mjs";
import {
  fixtureInputSizes,
  initializeReleaseFixtureGit,
  RELEASE_FIXTURE_PROFILES,
  snapshotReleaseReadState,
} from "./fixtures.mjs";
import {
  assertInboxFixturePage,
  assertRelayFixturePage,
  releaseCommonReadPaths,
  startHub,
} from "./hub.mjs";
import { enforceWithConfirmation } from "./enforce.mjs";
import { candidateRuntimeBudgets, evaluateRuntimeBudgets } from "./runtime-budgets.mjs";
import {
  classifyRuntimeViolations,
  evaluateRuntimeConfirmation,
  runtimeMaterialityPolicy,
  runtimeSampleSupport,
} from "./runtime-confirmation.mjs";
import { assetBudgetCandidate, runtimeBudgetCandidate, summarize } from "./statistics.mjs";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const budgetsSchema = JSON.parse(readFileSync(new URL("./budgets.schema.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const reportSchema = JSON.parse(readFileSync(new URL("./report.schema.json", import.meta.url), "utf8"));
const FROZEN_NON_OVERVIEW_UX_BUDGETS_SHA256 = "e970dea48bdaffd3ca258ce62dd56327a7692f89fd0e740c72bca61092ea10d8";
const FROZEN_PRE_GRAPH_TIMING_BUDGETS_SHA256 = "d4209e5549ed49c37dcd4e4814eab0ceb7640124d75bdf433347ea9de1514c80";
const PRE_GRAPH_TIMING_LIMITS = {
  small: { graph_refresh: 984, graph_rebuild: 496 },
  medium: { graph_refresh: 1237, graph_rebuild: 743 },
  large: { graph_rebuild: 1229 },
};

const PRE_SETTINGS_ROUTE_JS_BYTES = 8035;

// Restores the Settings route JS limit that PR #195 recalibrated, so every
// earlier frozen-budget guard keeps hashing its original state.
function beforeSettingsRouteJsCalibration(value) {
  const projected = structuredClone(value);
  projected.calibration.status = "pinned-A-G-Settings-34286120355-Graph-timing-34288560611";
  projected.assets.routes.settings.jsBytes = PRE_SETTINGS_ROUTE_JS_BYTES;
  return projected;
}

function beforeGraphTimingCalibration(value) {
  const projected = beforeSettingsRouteJsCalibration(value);
  projected.calibration.status = "pinned-checkpoints-A-G-and-Settings-34286120355";
  for (const [profile, operations] of Object.entries(PRE_GRAPH_TIMING_LIMITS)) {
    Object.assign(projected.runtime.maintenanceMs[profile], operations);
  }
  return projected;
}

function frozenAllowedCalibrationProjection(value) {
  const projected = beforeGraphTimingCalibration(value);
  projected.calibration.status = "__RELAY_CALIBRATION_STATUS__";
  projected.assets.maxJsChunkBytes = "__OVERVIEW_INITIAL_JS_CALIBRATION__";
  projected.assets.initial.jsBytes = "__OVERVIEW_INITIAL_JS_CALIBRATION__";
  projected.assets.routes.home.jsBytes = "__OVERVIEW_HOME_JS_CALIBRATION__";
  projected.assets.routes.home.cssBytes = "__OVERVIEW_HOME_CSS_CALIBRATION__";
  projected.assets.routes.relays = { jsBytes: 0, cssBytes: 0, fontBytes: 0 };
  projected.assets.routes.members.cssBytes = "__MEMBERS_CSS_CALIBRATION__";
  projected.assets.routes.activity.jsBytes = "__ACTIVITY_JS_CALIBRATION__";
  projected.assets.routes.activity.cssBytes = "__ACTIVITY_CSS_CALIBRATION__";
  delete projected.assets.routes.catchUp;
  delete projected.assets.routes.settings;
  for (const profile of ["small", "medium", "large"]) {
    delete projected.runtime.apiLatencyMs[profile].relayDrafts;
    delete projected.runtime.apiLatencyMs[profile].relays;
    projected.runtime.browserHeapBytes[profile].home = 0;
    projected.runtime.browserHeapBytes[profile].members = 0;
    projected.runtime.browserHeapBytes[profile].relays = 0;
    delete projected.runtime.browserHeapBytes[profile].catchUp;
    delete projected.runtime.browserHeapBytes[profile].settings;
  }
  return projected;
}

describe("release benchmark contract", () => {
  it("composes owned Graph timing calibration with the original frozen budget guard", () => {
    const digest = (value) => createHash("sha256")
      .update(JSON.stringify(frozenAllowedCalibrationProjection(value)))
      .digest("hex");
    expect(digest(budgets)).toBe(FROZEN_NON_OVERVIEW_UX_BUDGETS_SHA256);

    const allowed = structuredClone(budgets);
    allowed.calibration.status = "calibrated-from-pinned-run-example";
    allowed.assets.routes.relays = { jsBytes: 123, cssBytes: 45, fontBytes: 0 };
    allowed.assets.routes.settings = { jsBytes: 123, cssBytes: 45, fontBytes: 0 };
    allowed.assets.routes.members.cssBytes += 1;
    allowed.assets.routes.activity.jsBytes += 1;
    allowed.assets.routes.activity.cssBytes += 1;
    allowed.assets.maxJsChunkBytes += 1;
    allowed.assets.initial.jsBytes += 1;
    allowed.assets.routes.home.jsBytes += 1;
    allowed.assets.routes.home.cssBytes += 1;
    for (const profile of ["small", "medium", "large"]) {
      allowed.runtime.apiLatencyMs[profile].relayDrafts = 3;
      allowed.runtime.apiLatencyMs[profile].relays = 4;
      allowed.runtime.browserHeapBytes[profile].home += 1;
      allowed.runtime.browserHeapBytes[profile].members += 1;
      allowed.runtime.browserHeapBytes[profile].relays += 1;
      allowed.runtime.browserHeapBytes[profile].settings = 123;
    }
    expect(digest(allowed)).toBe(FROZEN_NON_OVERVIEW_UX_BUDGETS_SHA256);

    const forbidden = structuredClone(allowed);
    forbidden.runtime.apiLatencyMs.small.search += 1;
    expect(digest(forbidden)).not.toBe(FROZEN_NON_OVERVIEW_UX_BUDGETS_SHA256);
  });

  it("locks the sample counts and deterministic route budget surface", () => {
    expect(budgets.schemaVersion).toBe(1);
    expect(budgets.samples).toEqual({ timing: 10, idleMemory: 5 });
    expect(RELEASE_FIXTURE_PROFILES).toEqual({
      small: { sourceFiles: 4, wikiEntities: 4, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 4 },
      medium: { sourceFiles: 16, wikiEntities: 16, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 16 },
      large: { sourceFiles: 48, wikiEntities: 48, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 48 },
    });
    // Settings assets use the deterministic build; heap limits come from the
    // retained pinned Linux report, with every unrelated limit still frozen.
    expect(Object.keys(budgets.assets.routes)).toEqual(RELEASE_ROUTE_KEYS);
    expect(budgets.assets.routes.settings).toEqual({ jsBytes: 8978, cssBytes: 2910, fontBytes: 0 });
    expect(Object.keys(releaseWorkbenchPaths({
      knowledgeEntityId: "mx_knowledge",
      specEntityId: "mx_spec",
      codeSymbolId: "symbol/release",
    }))).toEqual(RELEASE_ROUTE_KEYS);
    const appRoutes = readFileSync(
      new URL("../../packages/hub-web/src/app/App.tsx", import.meta.url),
      "utf8",
    );
    const registeredPatterns = [...appRoutes.matchAll(/<Route\s+(index|path="([^"]+)")\s+element=/gu)]
      .map((match) => match[1] === "index" ? "(index)" : match[2]);
    expect(registeredPatterns.filter((pattern) => !Object.hasOwn(RELEASE_ROUTE_REDIRECTS, pattern)))
      .toEqual(Object.values(RELEASE_ROUTE_PATTERNS));
    const redirects = [...appRoutes.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<Navigate\s+to="([^"]+)"\s+replace\s*\/>\}\s*\/>/gu)]
      .map((match) => [match[1], match[2]]);
    expect(redirects).toEqual(Object.entries(RELEASE_ROUTE_REDIRECTS));
    for (const pattern of Object.keys(RELEASE_ROUTE_REDIRECTS)) {
      expect(registeredPatterns.filter((registered) => registered === pattern)).toEqual([pattern]);
    }
    for (const profile of ["small", "medium", "large"]) {
      expect(Object.keys(budgets.runtime.browserHeapBytes[profile]))
        .toEqual(RELEASE_ROUTE_KEYS);
    }
    expect({
      small: {
        inboxDrafts: budgets.runtime.apiLatencyMs.small.inboxDrafts,
        inboxProposals: budgets.runtime.apiLatencyMs.small.inboxProposals,
      },
      medium: {
        inboxDrafts: budgets.runtime.apiLatencyMs.medium.inboxDrafts,
        inboxProposals: budgets.runtime.apiLatencyMs.medium.inboxProposals,
      },
      large: {
        inboxDrafts: budgets.runtime.apiLatencyMs.large.inboxDrafts,
        inboxProposals: budgets.runtime.apiLatencyMs.large.inboxProposals,
      },
    }).toEqual({
      small: { inboxDrafts: 7, inboxProposals: 6 },
      medium: { inboxDrafts: 7, inboxProposals: 6 },
      large: { inboxDrafts: 7, inboxProposals: 6 },
    });
    expect({
      assets: budgets.assets.routes.relays,
      api: Object.fromEntries(["small", "medium", "large"].map((profile) => [profile, {
        relayDrafts: budgets.runtime.apiLatencyMs[profile].relayDrafts,
        relays: budgets.runtime.apiLatencyMs[profile].relays,
      }])),
      heap: Object.fromEntries(["small", "medium", "large"].map((profile) => [
        profile,
        budgets.runtime.browserHeapBytes[profile].relays,
      ])),
    }).toEqual({
      assets: { jsBytes: 200128, cssBytes: 12285, fontBytes: 0 },
      api: {
        small: { relayDrafts: 5, relays: 15 },
        medium: { relayDrafts: 3, relays: 12 },
        large: { relayDrafts: 4, relays: 13 },
      },
      heap: { small: 7753875, medium: 7754561, large: 7748627 },
    });
    expect(budgets.assets.routes.members).toEqual({
      jsBytes: 93022,
      cssBytes: 12640,
      fontBytes: 0,
    });
    expect(budgets.assets.routes.code).toEqual(budgets.assets.routes.search);
    expect(budgets.assets.routes.catchUp).toEqual(budgets.assets.routes.playbooks);
    for (const profile of ["small", "medium", "large"]) {
      expect(budgets.runtime.browserHeapBytes[profile].catchUp)
        .toBe(budgets.runtime.browserHeapBytes[profile].playbooks);
    }
    expect(budgets.provisional).toBe(false);
    expect(budgets.calibration).toEqual({
      status: "pinned-A-G-Settings-34286120355-Graph-timing-34288560611",
      runtimeFormula: "ceil(measured p95 * 1.15)",
      assetFormula: "ceil(built bytes * 1.05)",
    });
    expect(packageJson.scripts["benchmark:release"]).toContain(
      "scripts/release-benchmark/enforce.mjs",
    );
    expect(reportSchema.$defs.runtimeConfirmation.properties.status.enum).toEqual([
      "not_required",
      "skipped_immediate_failure",
      "passed",
      "failed",
      "operational_failure",
    ]);
    expect(reportSchema.$defs.runtimeConfirmation.required).not.toContain("advisoryAssessments");
    expect(reportSchema.$defs.runtimeConfirmation.required).not.toContain("materialAssessments");
    expect(reportSchema.$defs.runtimeConfirmation.required).not.toContain("runnerAllocations");
    expect(reportSchema.$defs.runtimeConfirmation.properties).toHaveProperty("advisoryAssessments");
    expect(reportSchema.$defs.runtimeConfirmation.properties).toHaveProperty("materialAssessments");
    expect(reportSchema.$defs.runtimeConfirmation.properties).toHaveProperty("runnerAllocations");
    expect(reportSchema.$defs.profile.properties.fixture.required).toContain("workstreams");
    expect(reportSchema.$defs.profile.properties.fixture.required).not.toContain("inboxDrafts");
    expect(reportSchema.$defs.profile.properties.fixture.required).not.toContain("inboxProposals");
    expect(reportSchema.$defs.profile.properties.fixture.required).not.toContain("members");
    expect(reportSchema.$defs.profile.properties.fixture.required).not.toContain("relayDrafts");
    expect(reportSchema.$defs.profile.properties.fixture.required).not.toContain("relays");
    expect(reportSchema.$defs.profile.properties.fixture.properties.workstreams).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(reportSchema.$defs.readSummaries.required).toEqual([
      "search",
      "code",
      "knowledge",
      "activity",
    ]);
    expect(Object.keys(releaseCommonReadPaths("symbol/release"))).toEqual([
      "search",
      "code",
      "knowledge",
      "activity",
      "inboxDrafts",
      "inboxProposals",
      "relayDrafts",
      "relays",
    ]);
    expect(releaseCommonReadPaths("symbol/release").knowledge).toBe("/api/v1/wiki/graph");
    expect(budgetsSchema.$defs.readBudgets.properties).toEqual(expect.objectContaining({
      inboxDrafts: { $ref: "#/$defs/nonNegativeNumber" },
      inboxProposals: { $ref: "#/$defs/nonNegativeNumber" },
      relayDrafts: { $ref: "#/$defs/nonNegativeNumber" },
      relays: { $ref: "#/$defs/nonNegativeNumber" },
    }));
    const validateBudgets = new Ajv2020({ strict: true }).compile(budgetsSchema);
    expect(validateBudgets(budgets), JSON.stringify(validateBudgets.errors)).toBe(true);
  });

  it.each(["ready", "canvas unavailable", "fixture node missing"])(
    "accepts only a populated Context graph before heap measurement: %s",
    async (state) => {
      const waitForNode = vi.fn(async () => {
        if (state === "fixture node missing") throw new Error("Fixture node is not visible.");
      });
      const graph = {
        waitFor: vi.fn(async () => {
          if (state === "canvas unavailable") throw new Error("Context graph is unavailable.");
        }),
        getByRole: vi.fn(() => ({ waitFor: waitForNode })),
      };
      const page = { getByLabel: vi.fn(() => graph) };
      const ready = assertReleaseRouteReady(page, "knowledge", {});

      if (state === "ready") {
        await expect(ready).resolves.toBeUndefined();
        expect(waitForNode).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 });
      } else {
        await expect(ready).rejects.toThrow(state === "canvas unavailable"
          ? "Context graph is unavailable." : "Fixture node is not visible.");
      }
      expect(page.getByLabel).toHaveBeenCalledWith("Context graph", { exact: true });
      if (state === "canvas unavailable") expect(graph.getByRole).not.toHaveBeenCalled();
    },
  );

  it.each(["ready", "preferences unavailable", "selection missing"])(
    "measures Settings only after its preference form has loaded: %s",
    async (state) => {
      const selected = { waitFor: vi.fn(async () => {
        if (state === "selection missing") throw new Error("No current preference.");
      }) };
      const group = { waitFor: vi.fn(async () => {}), locator: vi.fn(() => selected) };
      const heading = { waitFor: vi.fn(async () => {
        if (state === "preferences unavailable") throw new Error("Preferences unavailable.");
      }) };
      const page = { getByRole: vi.fn((role) => role === "heading" ? heading : group) };
      const ready = assertReleaseRouteReady(page, "settings", {});
      if (state === "ready") {
        await expect(ready).resolves.toBeUndefined();
        expect(page.getByRole).toHaveBeenCalledWith("heading", { name: "Agent logging", exact: true });
        expect(page.getByRole).toHaveBeenCalledWith("group", { name: "When to write notes", exact: true });
        expect(selected.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 30_000 });
      } else {
        await expect(ready).rejects.toThrow(state === "preferences unavailable" ? "Preferences unavailable." : "No current preference.");
      }
    },
  );

  it("pins Settings heap to retained runner samples without changing existing budgets", () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/design/settings-heap-calibration.json", import.meta.url), "utf8"));
    expect(evidence.environment).toEqual({ ...budgets.environment, pinnedBudgetEnvironment: true });
    expect(evidence.formula).toBe(budgets.calibration.runtimeFormula);
    expect(evidence.sampleCount).toBe(budgets.samples.idleMemory);
    const beforeSettings = beforeGraphTimingCalibration(budgets);
    beforeSettings.calibration.status = evidence.previousCalibrationStatus;
    for (const profile of ["small", "medium", "large"]) {
      const measured = evidence.profiles[profile];
      expect(summarize(measured.samples, evidence.sampleCount).p95).toBe(measured.p95);
      expect(runtimeBudgetCandidate(measured.p95)).toBe(measured.budgetBytes);
      expect(budgets.runtime.browserHeapBytes[profile].settings).toBe(measured.budgetBytes);
      delete beforeSettings.runtime.browserHeapBytes[profile].settings;
    }
    expect(createHash("sha256").update(JSON.stringify(beforeSettings)).digest("hex"))
      .toBe(evidence.unownedBudgetSha256);
  });

  it("pins Settings route JS to the retained runner build without changing existing budgets", () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/design/settings-route-js-calibration.json", import.meta.url), "utf8"));
    expect(evidence.environment).toEqual({ ...budgets.environment, pinnedBudgetEnvironment: true });
    expect(evidence.formula).toBe(budgets.calibration.assetFormula);
    expect(evidence.metric).toBe("assets.routes.settings.jsBytes");
    expect(evidence.previousBudgetBytes).toBe(PRE_SETTINGS_ROUTE_JS_BYTES);
    expect(evidence.files.reduce((total, file) => total + file.bytes, 0)).toBe(evidence.measuredBytes);
    expect(assetBudgetCandidate(evidence.measuredBytes)).toBe(evidence.budgetBytes);
    expect(budgets.assets.routes.settings.jsBytes).toBe(evidence.budgetBytes);
    const beforeSettings = structuredClone(budgets);
    beforeSettings.calibration.status = evidence.previousCalibrationStatus;
    delete beforeSettings.assets.routes.settings.jsBytes;
    expect(createHash("sha256").update(JSON.stringify(beforeSettings)).digest("hex"))
      .toBe(evidence.unownedBudgetSha256);
  });

  it("permits exactly five Graph timing leaves while freezing every other current budget", () => {
    const digest = (value) => createHash("sha256")
      .update(JSON.stringify(beforeGraphTimingCalibration(value)))
      .digest("hex");
    expect(digest(budgets)).toBe(FROZEN_PRE_GRAPH_TIMING_BUDGETS_SHA256);
    const allowed = structuredClone(budgets);
    allowed.calibration.status = "another-calibration-reference";
    for (const [profile, operations] of Object.entries(PRE_GRAPH_TIMING_LIMITS)) {
      for (const operation of Object.keys(operations)) allowed.runtime.maintenanceMs[profile][operation] += 1;
    }
    expect(digest(allowed)).toBe(FROZEN_PRE_GRAPH_TIMING_BUDGETS_SHA256);
    for (const path of [
      ["runtime", "maintenanceMs", "large", "graph_refresh"],
      ["runtime", "maintenanceMs", "small", "wiki_rebuild"],
      ["runtime", "maintenancePeakRssBytes", "small", "graph_refresh"],
      ["runtime", "browserHeapBytes", "small", "settings"],
      ["runtime", "apiLatencyMs", "small", "search"],
      ["assets", "initial", "jsBytes"],
    ]) {
      const forbidden = structuredClone(allowed);
      const parent = path.slice(0, -1).reduce((value, key) => value[key], forbidden);
      parent[path.at(-1)] += 1;
      expect(digest(forbidden), path.join(".")).not.toBe(FROZEN_PRE_GRAPH_TIMING_BUDGETS_SHA256);
    }
  });

  it("pins Graph timing to the first corrected runner and retains independent confirmation", () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/design/graph-maintenance-timing-calibration.json", import.meta.url), "utf8"));
    expect(evidence.environment).toEqual({ ...budgets.environment, pinnedBudgetEnvironment: true });
    expect(evidence.configuration.fixtureProfiles).toEqual(RELEASE_FIXTURE_PROFILES);
    expect(evidence.configuration.samples).toEqual(budgets.samples);
    expect(evidence.configuration).toMatchObject({ maintenanceObservation: "job-event-stream", runtimeBudgetsEnforced: true, assetBudgetsEnforced: true, provisionalBudgets: false });
    expect(evidence.formula).toBe(budgets.calibration.runtimeFormula);
    expect(evidence.sampleCount).toBe(budgets.samples.timing);
    expect(evidence.previousCalibrationStatus).toBe(beforeGraphTimingCalibration(budgets).calibration.status);
    expect(evidence.unownedBudgetSha256).toBe(FROZEN_PRE_GRAPH_TIMING_BUDGETS_SHA256);
    expect(evidence.source.primaryAttempt).toBe("first");
    expect(evidence.source.pullRequestHead).toBe("4d6683eec1a0bdcafe99d7b431d84cde7f02864d");
    expect(evidence.source.repositoryHead).toBe("6d92bb04d757c8a00693ef679d1f4281669a9b57");
    expect(evidence.attempts.map(({ role }) => role)).toEqual(["primary", "confirmation"]);
    expect(evidence.attempts.map(({ manifest }) => manifest.rawReportSha256)).toEqual([
      "fec98eae2728a017fcaf3480d275d47180d88740b248468d69a6fa858768c9b3",
      "732d2b897b4592ba7e89d9fedb508c0c86027ae7cb239580ed51aa5a9de9efb9",
    ]);
    const [primary, confirmation] = evidence.attempts;
    expect(primary.manifest.runnerAllocation.job).not.toBe(confirmation.manifest.runnerAllocation.job);
    expect(primary.manifest.runnerAllocation.runnerName).not.toBe(confirmation.manifest.runnerAllocation.runnerName);
    for (const attempt of evidence.attempts) {
      expect(attempt.manifest).toMatchObject({
        repositoryHead: evidence.source.repositoryHead,
        github: { runId: "34288560611", runAttempt: "1", sha: evidence.source.repositoryHead },
        runnerAllocation: { runnerOs: "Linux", runnerArch: "X64" },
      });
      for (const profile of ["small", "medium", "large"]) {
        for (const operation of ["graph_refresh", "graph_rebuild"]) {
          for (const [metric, summary] of Object.entries(attempt.graph[profile][operation])) {
            expect(summary).toEqual(summarize(summary.samples, metric === "peakRssBytes" ? budgets.samples.idleMemory : budgets.samples.timing));
          }
        }
      }
    }
    const expectedMetrics = Object.entries(PRE_GRAPH_TIMING_LIMITS).flatMap(([profile, operations]) =>
      Object.keys(operations).map((operation) => `runtime.maintenanceMs.${profile}.${operation}`));
    expect(evidence.calibratedLeaves.map(({ metric }) => metric)).toEqual(expectedMetrics);
    expect(evidence.confirmedMaterialAssessments.map(({ metric }) => metric)).toEqual(expectedMetrics);
    for (const [index, leaf] of evidence.calibratedLeaves.entries()) {
      const [, , profile, operation] = leaf.metric.split(".");
      const first = primary.graph[profile][operation].elapsedMs;
      const second = confirmation.graph[profile][operation].elapsedMs;
      expect(leaf.previousBudgetMs).toBe(PRE_GRAPH_TIMING_LIMITS[profile][operation]);
      expect(leaf.primaryP95Ms).toBe(first.p95);
      expect(leaf.budgetMs).toBe(runtimeBudgetCandidate(first.p95));
      expect(budgets.runtime.maintenanceMs[profile][operation]).toBe(leaf.budgetMs);
      // Reconstruct the historical assessment using the old budget, not the newly calibrated policy.
      const threshold = Math.round((leaf.previousBudgetMs + Math.max(leaf.previousBudgetMs * 0.15, 50)) * 1000) / 1000;
      const firstSupport = first.samples.filter((sample) => sample > threshold).length;
      const secondSupport = second.samples.filter((sample) => sample > threshold).length;
      expect(firstSupport).toBeGreaterThanOrEqual(2);
      expect(secondSupport).toBeGreaterThanOrEqual(2);
      expect(evidence.confirmedMaterialAssessments[index]).toEqual({
        metric: leaf.metric, category: "maintenance_ms", classification: "material", reason: "repeated_material_threshold",
        budget: leaf.previousBudgetMs, relativeExcessRatio: 0.15, minimumExcess: 50, materialThreshold: threshold,
        firstMeasured: first.p95, secondMeasured: second.p95, requiredSupportingSamples: 2,
        firstSampleCount: 10, firstSupportingSamples: firstSupport, secondSampleCount: 10, secondSupportingSamples: secondSupport,
      });
    }
    expect(evidence.unchangedLargeGraphRefreshMs).toBe(1812);
    expect(budgets.runtime.maintenanceMs.large.graph_refresh).toBe(evidence.unchangedLargeGraphRefreshMs);
  });

  it("still fails closed if a Settings heap budget is missing", () => {
    const profiles = Object.fromEntries(["small", "medium", "large"].map((profile) => [
      profile,
      { ...runtimeProfile(100), browserHeap: { outboundRequestCount: 0, routes: { settings: { p95: 123 } } } },
    ]));
    const missing = structuredClone(budgets.runtime);
    for (const profile of ["small", "medium", "large"]) delete missing.browserHeapBytes[profile].settings;
    const violations = evaluateRuntimeBudgets(profiles, missing)
      .filter(({ metric }) => metric.endsWith(".settings"));
    expect(violations).toEqual(["small", "medium", "large"].map((profile) => ({
      metric: `runtime.browserHeapBytes.${profile}.settings`, measured: 123, budget: null, reason: "budget_missing",
    })));
    expect(classifyRuntimeViolations(violations)).toEqual({ confirmable: [], immediate: violations });
    expect(RELEASE_ROUTE_KEYS).toContain("settings");
    expect(releaseWorkbenchPaths({ knowledgeEntityId: "knowledge", specEntityId: "spec", codeSymbolId: "code" }).settings).toBe("/settings");
    expect(reportSchema.$defs.routeSummaries.properties.settings).toEqual({ $ref: "#/$defs/summary5" });
    expect(reportSchema.$defs.routeSummaries.required).not.toContain("settings");
    expect(budgetsSchema.$defs.routeBudgets.properties.settings).toEqual({ $ref: "#/$defs/nonNegativeNumber" });
    expect(budgetsSchema.$defs.routeBudgets.required).not.toContain("settings");
  });

  it("uses nearest-rank p95 and rejects the wrong sample count", () => {
    expect(summarize([7, 1, 9, 4, 2, 10, 8, 6, 5, 3], 10)).toEqual({
      samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      min: 1,
      median: 5.5,
      p95: 10,
      max: 10,
    });
    expect(() => summarize([1, 2, 3, 4], 5)).toThrow(/exactly 5 samples/u);
    expect(summarize([
      1.23456,
      2.34567,
      3.45678,
      4.56789,
      5.67891,
    ], 5).samples).toEqual([1.235, 2.346, 3.457, 4.568, 5.679]);
    expect(runtimeBudgetCandidate(100.01)).toBe(116);
    expect(assetBudgetCandidate(100.01)).toBe(106);
  });

  it("accepts legacy raw precision when its rounded p95 matches the violation", () => {
    const metric = "runtime.maintenanceMs.small.graph_rebuild";
    const measured = Math.ceil(runtimeMaterialityPolicy(metric).materialThreshold) + 10.769;
    const violation = runtimeViolation(metric, measured);
    const report = benchmarkPass({ runtimeViolations: [violation] });
    const summary = report.profiles.small.maintenance.graph_rebuild.elapsedMs;
    summary.samples[summary.samples.length - 1] = measured - 0.0003;
    expect(runtimeSampleSupport(report, [violation]).get(metric)).toEqual({
      sampleCount: 10,
      supportingSamples: 2,
    });
  });

  it("strictly validates advisory and material final benchmark reports", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(reportSchema);
    const validateFixture = ajv.compile({
      $defs: reportSchema.$defs,
      ...reportSchema.$defs.profile.properties.fixture,
    });
    const generatedFixture = {
      profile: "small",
      ...RELEASE_FIXTURE_PROFILES.small,
      input: { graphBytes: 1, graphFiles: 1, wikiBytes: 1, wikiFiles: 1 },
    };
    expect(validateFixture(generatedFixture), JSON.stringify(validateFixture.errors)).toBe(true);
    expect(generatedFixture).toMatchObject({
      inboxDrafts: 1,
      inboxProposals: 1,
      members: 2,
      relayDrafts: 1,
      relays: 1,
    });
    const {
      inboxDrafts: _inboxDrafts,
      inboxProposals: _inboxProposals,
      members: _members,
      relayDrafts: _relayDrafts,
      relays: _relays,
      ...legacyFixture
    } = generatedFixture;
    expect(validateFixture(legacyFixture), JSON.stringify(validateFixture.errors)).toBe(true);
    const validateReads = ajv.compile({
      $defs: reportSchema.$defs,
      ...reportSchema.$defs.readSummaries,
    });
    const summary = {
      samples: Array.from({ length: 10 }, (_, index) => index + 1),
      min: 1,
      median: 5.5,
      p95: 10,
      max: 10,
    };
    expect(validateReads({
      search: summary,
      code: summary,
      knowledge: summary,
      activity: summary,
    }), JSON.stringify(validateReads.errors)).toBe(true);
    const metric = "runtime.apiLatencyMs.small.code";
    const legacyReport = representativeReleaseReport({
      runtimeViolations: [],
      passed: true,
      confirmation: {
        status: "passed",
        repositoryHead: "a".repeat(40),
        firstPassViolations: [],
        secondPassViolations: [],
        confirmedViolations: [],
      },
    });
    expect(validate(legacyReport), JSON.stringify(validate.errors)).toBe(true);
    delete legacyReport.assets.routes.settings;
    expect(validate(legacyReport), JSON.stringify(validate.errors)).toBe(true);

    const firstAdvisory = runtimeViolation(metric, 53);
    const secondAdvisory = runtimeViolation(metric, 58);
    const advisoryAssessment = materialityAssessment({
      classification: "advisory",
      reason: "below_material_threshold",
      firstMeasured: 53,
      secondMeasured: 58,
    });
    const advisoryReport = representativeReleaseReport({
      runtimeViolations: [],
      passed: true,
      confirmation: {
        status: "passed",
        repositoryHead: "a".repeat(40),
        firstPassViolations: [firstAdvisory],
        secondPassViolations: [secondAdvisory],
        confirmedViolations: [secondAdvisory],
        advisoryAssessments: [advisoryAssessment],
        materialAssessments: [],
        runnerAllocations: {
          first: {
            runId: "12345",
            runAttempt: "2",
            job: "release_performance_attempt_1",
            runnerName: "Hosted Agent 1",
            runnerOs: "Linux",
            runnerArch: "X64",
          },
          second: {
            runId: "12345",
            runAttempt: "2",
            job: "release_performance_attempt_2",
            runnerName: "Hosted Agent 2",
            runnerOs: "Linux",
            runnerArch: "X64",
          },
        },
      },
    });
    expect(validate(advisoryReport), JSON.stringify(validate.errors)).toBe(true);

    const supportedAdvisory = representativeReleaseReport({
      runtimeViolations: [],
      passed: true,
      confirmation: {
        status: "passed",
        repositoryHead: "a".repeat(40),
        firstPassViolations: [runtimeViolation(metric, 67)],
        secondPassViolations: [],
        confirmedViolations: [],
        advisoryAssessments: [materialityAssessment({
          classification: "advisory",
          reason: "insufficient_sample_support",
          firstMeasured: 67,
          secondMeasured: null,
          requiredSupportingSamples: 2,
          firstSampleCount: 10,
          firstSupportingSamples: 1,
        })],
        materialAssessments: [],
      },
    });
    expect(validate(supportedAdvisory), JSON.stringify(validate.errors)).toBe(true);
    supportedAdvisory.budgetEvaluation.runtimeConfirmation
      .advisoryAssessments[0].firstSampleCount = 6;
    expect(validate(supportedAdvisory)).toBe(false);

    const firstMaterial = runtimeViolation(metric, 67);
    const secondMaterial = runtimeViolation(metric, 70);
    const materialAssessment = materialityAssessment({
      classification: "material",
      reason: "repeated_material_threshold",
      firstMeasured: 67,
      secondMeasured: 70,
    });
    const materialReport = representativeReleaseReport({
      runtimeViolations: [secondMaterial],
      passed: false,
      confirmation: {
        status: "failed",
        repositoryHead: "a".repeat(40),
        firstPassViolations: [firstMaterial],
        secondPassViolations: [secondMaterial],
        confirmedViolations: [secondMaterial],
        advisoryAssessments: [],
        materialAssessments: [materialAssessment],
      },
    });
    expect(validate(materialReport), JSON.stringify(validate.errors)).toBe(true);

    materialReport.budgetEvaluation.runtimeConfirmation.materialAssessments = [
      advisoryAssessment,
    ];
    expect(validate(materialReport)).toBe(false);
  });

  it("fails deterministic asset bytes above the committed golden", () => {
    const measurement = {
      largestJsChunk: { file: "assets/index.js", bytes: budgets.assets.maxJsChunkBytes },
      initial: { ...budgets.assets.initial, files: [] },
      routes: Object.fromEntries(Object.entries(budgets.assets.routes).map(([route, value]) => [
        route,
        { ...value, files: [] },
      ])),
    };
    expect(evaluateAssetBudgets(measurement, budgets.assets)).toEqual([]);
    measurement.routes.home.jsBytes += 1;
    expect(evaluateAssetBudgets(measurement, budgets.assets)).toEqual([{
      metric: "assets.routes.home.jsBytes",
      measured: budgets.assets.routes.home.jsBytes + 1,
      budget: budgets.assets.routes.home.jsBytes,
      reason: "budget_exceeded",
    }]);
  });

  it("enforces the additive setup asset limit from retained deterministic build bytes", () => {
    const calibration = JSON.parse(readFileSync(new URL("./setup-asset-budget.json", import.meta.url), "utf8"));
    expect(calibration.schemaVersion).toBe(1);
    expect(calibration.formula).toBe("ceil(built bytes * 1.05)");
    expect(calibration.limits).toEqual({ jsBytes: 107648, cssBytes: 21081, fontBytes: 0 });
    for (const [field, extension] of [["jsBytes", ".js"], ["cssBytes", ".css"], ["fontBytes", ".woff2"]]) {
      expect(calibration.files.filter(({ file }) => file.endsWith(extension)).reduce((total, { bytes }) => total + bytes, 0))
        .toBe(calibration.measured[field]);
      expect(assetBudgetCandidate(calibration.measured[field])).toBe(calibration.limits[field]);
    }
    for (const file of calibration.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evaluateSetupAssetBudget(calibration.limits)).toEqual([]);
    for (const field of ["jsBytes", "cssBytes", "fontBytes"]) {
      expect(evaluateSetupAssetBudget({ ...calibration.limits, [field]: calibration.limits[field] + 1 }))
        .toEqual([{ metric: `assets.setup.${field}`, measured: calibration.limits[field] + 1,
          budget: calibration.limits[field], reason: "budget_exceeded" }]);
    }
    expect(evaluateSetupAssetBudget(calibration.measured, {})).toHaveLength(3);
    expect(Object.keys(budgets.assets.routes)).toEqual(RELEASE_ROUTE_KEYS);
    expect(Object.keys(budgets.assets.routes)).not.toContain("setup");
  });

  it("measures the default Context graph separately from its lazy knowledge list and detail", () => {
    const output = mkdtempSync(join(tmpdir(), "mex-context-assets-"));
    try {
      mkdirSync(join(output, ".vite"));
      mkdirSync(join(output, "assets"));
      const pages = ["HomePage", "SearchPage", "ContextPage", "KnowledgePage", "SymbolPage",
        "CapabilityPage", "WorkstreamsPage", "SpecsPage", "InboxPage", "RelayPage",
        "MembersPage", "ActivityPage", "JobsPage", "HealthPage", "SettingsPage", "SetupPage"];
      const manifest = {
        "index.html": { file: "assets/index.js", isEntry: true, dynamicImports: pages },
        "graph-runtime": { file: "assets/graph.js" },
        "record-runtime": { file: "assets/record.js" },
        "../hub-contracts/dist/setup.js": {
          file: "assets/setup.js", src: "../hub-contracts/dist/setup.js", isDynamicEntry: true,
        },
      };
      for (const page of pages) {
        manifest[page] = {
          file: `assets/${page}.js`,
          src: `src/pages/${page}.tsx`,
          isDynamicEntry: true,
        };
      }
      manifest.ContextPage.imports = ["graph-runtime"];
      manifest.ContextPage.dynamicImports = ["KnowledgePage"];
      manifest.KnowledgePage.imports = ["record-runtime"];
      writeFileSync(join(output, ".vite", "manifest.json"), JSON.stringify(manifest));
      for (const record of Object.values(manifest)) {
        writeFileSync(join(output, record.file), `// ${record.file}\n`);
      }

      const measurement = measureBuiltAssets(output, budgets.assets);

      expect(measurement.routes.knowledge.files.map(({ file }) => file)).toEqual([
        "assets/ContextPage.js", "assets/graph.js",
      ]);
      expect(measurement.routes.knowledgeDetail.files.map(({ file }) => file)).toEqual([
        "assets/KnowledgePage.js", "assets/record.js",
      ]);
      expect(measurement.initial.files.map(({ file }) => file)).toEqual(["assets/index.js"]);
      expect(measurement.routes.home.files.map(({ file }) => file)).toEqual(["assets/HomePage.js"]);
      expect(measurement.routes.settings.files.map(({ file }) => file)).toEqual(["assets/SettingsPage.js"]);
      expect(measureSetupAssets(output).files.map(({ file }) => file)).toEqual([
        "assets/SetupPage.js", "assets/setup.js",
      ]);
      const setupPage = join(output, "assets/SetupPage.js");
      const originalSetup = readFileSync(setupPage, "utf8");
      const setupLimit = JSON.parse(readFileSync(new URL("./setup-asset-budget.json", import.meta.url), "utf8")).limits.jsBytes;
      writeFileSync(setupPage, "x".repeat(setupLimit + 1));
      expect(measureBuiltAssets(output, budgets.assets).violations).toEqual([
        expect.objectContaining({ metric: "assets.setup.jsBytes", reason: "budget_exceeded" }),
      ]);
      writeFileSync(setupPage, originalSetup);

      manifest.HomePage.imports = ["SettingsPage"];
      writeFileSync(join(output, ".vite", "manifest.json"), JSON.stringify(manifest));
      expect(() => measureBuiltAssets(output, budgets.assets)).toThrow("Home workbench still includes SettingsPage.");
      delete manifest.HomePage.imports;
      manifest["index.html"].imports = ["SettingsPage"];
      writeFileSync(join(output, ".vite", "manifest.json"), JSON.stringify(manifest));
      expect(() => measureBuiltAssets(output, budgets.assets)).toThrow("initial application shell still includes SettingsPage.");
      delete manifest["index.html"].imports;
      for (const setupKey of ["SetupPage", "../hub-contracts/dist/setup.js"]) {
        manifest.HomePage.imports = [setupKey];
        writeFileSync(join(output, ".vite", "manifest.json"), JSON.stringify(manifest));
        expect(() => measureBuiltAssets(output, budgets.assets)).toThrow(/Home workbench still includes .*setup/iu);
        delete manifest.HomePage.imports;
        manifest["index.html"].imports = [setupKey];
        writeFileSync(join(output, ".vite", "manifest.json"), JSON.stringify(manifest));
        expect(() => measureBuiltAssets(output, budgets.assets)).toThrow(/initial application shell still includes .*setup/iu);
        delete manifest["index.html"].imports;
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("permits only the lazy browser setup page and contract chunks, including opaque manifest keys", () => {
    const manifest = {
      "_opaque-page.js": { file: "assets/opaque-page.js", src: "src/pages/SetupPage.tsx", isDynamicEntry: true },
      "_opaque-contract.js": { file: "assets/opaque-contract.js", src: "../hub-contracts/dist/setup.js", isDynamicEntry: true },
    };
    expect(() => assertSetupManifestBoundary(manifest)).not.toThrow();
    for (const key of Object.keys(manifest)) {
      const eager = structuredClone(manifest);
      eager[key].isDynamicEntry = false;
      expect(() => assertSetupManifestBoundary(eager)).toThrow(/unexpected or non-lazy setup/);
      const missing = structuredClone(manifest);
      delete missing[key];
      expect(() => assertSetupManifestBoundary(missing)).toThrow(/must contain the lazy setup page and setup contract/);
    }
    for (const source of ["src/setup/headless.ts", "../hub-contracts/dist/setup-internal.js", "src/pages/setup/HiddenPage.tsx"]) {
      const contaminated = {
        ...manifest,
        "_opaque-backend.js": { file: "assets/opaque.js", src: source, isDynamicEntry: true },
      };
      expect(() => assertSetupManifestBoundary(contaminated)).toThrow(/unexpected or non-lazy setup/);
    }
    const misleadingSource = {
      ...manifest,
      "src/setup/headless.ts": { file: "assets/backend.js", src: "src/pages/SetupPage.tsx", isDynamicEntry: true },
    };
    expect(() => assertSetupManifestBoundary(misleadingSource)).toThrow(/unexpected or non-lazy setup/);
  });

  it("rejects forbidden workbench modules hidden behind opaque chunk keys", () => {
    const manifest = {
      "_opaque.js": {
        file: "assets/opaque.js",
        src: "src/pages/ActivityPage.tsx",
      },
    };
    expect(() => assertNoForbiddenWorkbench(
      manifest,
      new Set(["_opaque.js"]),
      "Home workbench",
      ["ActivityPage"],
    )).toThrow(/Home workbench still includes ActivityPage/u);
  });

  it("keeps the Inbox workbench out of the initial and Home static closures", () => {
    const manifest = {
      "_inbox-opaque.js": {
        file: "assets/inbox.js",
        src: "src/pages/InboxPage.tsx",
      },
    };
    expect(() => assertNoForbiddenWorkbench(
      manifest,
      new Set(["_inbox-opaque.js"]),
      "initial application shell",
      ["InboxPage"],
    )).toThrow(/initial application shell still includes InboxPage/u);
    expect(() => assertNoForbiddenWorkbench(
      manifest,
      new Set(["_inbox-opaque.js"]),
      "Home workbench",
      ["InboxPage"],
    )).toThrow(/Home workbench still includes InboxPage/u);
  });

  it("keeps the Relay workbench out of the initial and Home static closures", () => {
    const manifest = {
      "_relay-opaque.js": {
        file: "assets/relay.js",
        src: "src/pages/RelayPage.tsx",
      },
    };
    expect(() => assertNoForbiddenWorkbench(
      manifest,
      new Set(["_relay-opaque.js"]),
      "initial application shell",
      ["RelayPage"],
    )).toThrow(/initial application shell still includes RelayPage/u);
    expect(() => assertNoForbiddenWorkbench(
      manifest,
      new Set(["_relay-opaque.js"]),
      "Home workbench",
      ["RelayPage"],
    )).toThrow(/Home workbench still includes RelayPage/u);
  });

  it("requires the exact one-item draft and pending proposal benchmark pages", () => {
    const page = (item) => ({
      items: [item],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "a".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(() => assertInboxFixturePage(page({
      id: "inbox_fixed",
      title: "Local fixture",
    }), {
      kind: "draft",
      id: "inbox_fixed",
      title: "Local fixture",
    })).not.toThrow();
    expect(() => assertInboxFixturePage(page({
      ref: { id: "proposal_fixed" },
      title: "Pending fixture",
      state: "pending",
    }), {
      kind: "proposal",
      id: "proposal_fixed",
      title: "Pending fixture",
    })).not.toThrow();
    expect(() => assertInboxFixturePage(page({
      ref: { id: "proposal_fixed" },
      title: "Pending fixture",
      state: "approved",
    }), {
      kind: "proposal",
      id: "proposal_fixed",
      title: "Pending fixture",
    })).toThrow(/not pending/u);
    expect(() => assertInboxFixturePage({
      ...page({ id: "inbox_fixed", title: "Local fixture" }),
      diagnostics: [{ code: "FIXTURE_DEGRADED" }],
    }, {
      kind: "draft",
      id: "inbox_fixed",
      title: "Local fixture",
    })).toThrow(/diagnostic-free one-item page/u);
    expect(() => assertInboxFixturePage({
      ...page({ id: "inbox_fixed", title: "Local fixture" }),
      diagnosticsTruncated: true,
    }, {
      kind: "draft",
      id: "inbox_fixed",
      title: "Local fixture",
    })).toThrow(/diagnostic-free one-item page/u);
    expect(() => assertInboxFixturePage({
      ...page({ id: "inbox_fixed", title: "Local fixture" }),
      deterministicRevision: "not-a-revision",
    }, {
      kind: "draft",
      id: "inbox_fixed",
      title: "Local fixture",
    })).toThrow(/diagnostic-free one-item page/u);
  });

  it("requires the exact one-item local draft and published Relay benchmark pages", () => {
    const page = (item) => ({
      items: [item],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "a".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(() => assertRelayFixturePage(page({
      id: "relay-draft-fixed",
      summary: "Local Relay fixture",
    }), {
      kind: "draft",
      id: "relay-draft-fixed",
      summary: "Local Relay fixture",
    })).not.toThrow();
    expect(() => assertRelayFixturePage(page({
      ref: { id: "relay_fixed" },
      summary: "Published Relay fixture",
      state: "published",
      schemaVersion: 3,
      workstream: null,
      publishedRepoState: {
        branch: "benchmark",
        head: null,
        dirty: false,
        observedAt: "2026-08-01T00:00:00.000Z",
      },
    }), {
      kind: "relay",
      id: "relay_fixed",
      summary: "Published Relay fixture",
    })).not.toThrow();
    expect(() => assertRelayFixturePage(page({
      ref: { id: "relay_fixed" },
      summary: "Published Relay fixture",
      state: "acknowledged",
      schemaVersion: 3,
      workstream: null,
      publishedRepoState: {
        branch: "benchmark",
        head: null,
        dirty: false,
        observedAt: "2026-08-01T00:00:00.000Z",
      },
    }), {
      kind: "relay",
      id: "relay_fixed",
      summary: "Published Relay fixture",
    })).toThrow(/not published/u);
    expect(() => assertRelayFixturePage(page({
      ref: { id: "relay_fixed" },
      summary: "Published Relay fixture",
      state: "published",
      schemaVersion: 2,
      workstream: { id: "ws_legacy", kind: "workstream" },
      publishedRepoState: null,
    }), {
      kind: "relay",
      id: "relay_fixed",
      summary: "Published Relay fixture",
    })).toThrow(/standalone schema-v3 publication/u);
    expect(() => assertRelayFixturePage({
      ...page({ id: "relay-draft-fixed", summary: "Local Relay fixture" }),
      diagnostics: [{ code: "RELAY_PUBLISHED_AT_MISSING" }],
    }, {
      kind: "draft",
      id: "relay-draft-fixed",
      summary: "Local Relay fixture",
    })).toThrow(/diagnostic-free one-item page/u);
  });

  it("keeps runtime candidates and enforcement scoped to each fixture profile", () => {
    const profiles = {
      small: runtimeProfile(100),
      medium: runtimeProfile(200),
      large: runtimeProfile(300),
    };
    const candidates = candidateRuntimeBudgets(profiles);
    expect(candidates.apiLatencyMs).toEqual({
      small: { search: 115 },
      medium: { search: 230 },
      large: { search: 345 },
    });
    expect(candidates.databaseToInputRatio).toEqual({
      small: { graph: 115, wiki: 115 },
      medium: { graph: 230, wiki: 230 },
      large: { graph: 345, wiki: 345 },
    });
    expect(evaluateRuntimeBudgets(profiles, candidates)).toEqual([]);
    candidates.apiLatencyMs.small.search = 99;
    expect(evaluateRuntimeBudgets(profiles, candidates)).toContainEqual({
      metric: "runtime.apiLatencyMs.small.search",
      measured: 100,
      budget: 99,
      reason: "budget_exceeded",
    });
  });

  it("keeps missing runtime budgets schema-valid and fail-closed for pinned characterization", () => {
    const profiles = Object.fromEntries(["small", "medium", "large"].map((profile) => [
      profile,
      {
        ...runtimeProfile(100),
        apiLatencyMs: {
          search: { p95: 100 },
          inboxDrafts: { p95: 2 },
          inboxProposals: { p95: 3 },
        },
      },
    ]));
    const characterizedBudgets = candidateRuntimeBudgets(profiles);
    for (const profile of ["small", "medium", "large"]) {
      delete characterizedBudgets.apiLatencyMs[profile].inboxDrafts;
      delete characterizedBudgets.apiLatencyMs[profile].inboxProposals;
    }
    const violations = evaluateRuntimeBudgets(profiles, characterizedBudgets);
    expect(violations).toHaveLength(6);
    expect(violations).toEqual(expect.arrayContaining([
      {
        metric: "runtime.apiLatencyMs.small.inboxDrafts",
        measured: 2,
        budget: null,
        reason: "budget_missing",
      },
      {
        metric: "runtime.apiLatencyMs.large.inboxProposals",
        measured: 3,
        budget: null,
        reason: "budget_missing",
      },
    ]));
    expect(JSON.parse(JSON.stringify(violations))).toEqual(violations);
  });

  it("fails closed when the six calibrated Relay API leaves are absent", () => {
    const profiles = Object.fromEntries(["small", "medium", "large"].map((profile) => [
      profile,
      {
        ...runtimeProfile(100),
        apiLatencyMs: {
          search: { p95: 100 },
          relayDrafts: { p95: 2 },
          relays: { p95: 3 },
        },
      },
    ]));
    const missingRelayBudgets = structuredClone(budgets.runtime);
    for (const profile of ["small", "medium", "large"]) {
      delete missingRelayBudgets.apiLatencyMs[profile].relayDrafts;
      delete missingRelayBudgets.apiLatencyMs[profile].relays;
    }
    const violations = evaluateRuntimeBudgets(profiles, missingRelayBudgets)
      .filter(({ metric }) => metric.includes(".relay"));
    expect(violations).toHaveLength(6);
    expect(violations).toEqual(expect.arrayContaining([
      {
        metric: "runtime.apiLatencyMs.small.relayDrafts",
        measured: 2,
        budget: null,
        reason: "budget_missing",
      },
      {
        metric: "runtime.apiLatencyMs.large.relays",
        measured: 3,
        budget: null,
        reason: "budget_missing",
      },
    ]));
    expect(JSON.parse(JSON.stringify(violations))).toEqual(violations);
  });

  it("retries only potentially material crossings and blocks supported repeats", () => {
    const knowledgePolicy = runtimeMaterialityPolicy("runtime.apiLatencyMs.medium.knowledge");
    const knowledge = runtimeViolation(
      "runtime.apiLatencyMs.medium.knowledge",
      knowledgePolicy.materialThreshold + 1,
    );
    const activity = runtimeViolation("runtime.apiLatencyMs.medium.activity");
    const initial = evaluateRuntimeConfirmation(
      [knowledge],
      undefined,
      confirmationSupport([[knowledge.metric, 2]]),
    );
    expect(initial).toMatchObject({ retryRequired: true, status: "required" });

    expect(evaluateRuntimeConfirmation(
      [knowledge],
      [activity],
      confirmationSupport([[knowledge.metric, 2]], [[activity.metric, 0]]),
    )).toMatchObject({
      retryRequired: false,
      status: "passed",
      finalViolations: [],
    });
    expect(evaluateRuntimeConfirmation(
      [knowledge],
      [knowledge],
      confirmationSupport([[knowledge.metric, 2]], [[knowledge.metric, 1]]),
    )).toMatchObject({
      retryRequired: false,
      status: "passed",
      finalViolations: [],
      confirmed: [knowledge],
      advisoryAssessments: [{
        metric: knowledge.metric,
        classification: "advisory",
        reason: "insufficient_sample_support",
      }],
      materialAssessments: [],
    });
  });

  it("requires two supporting samples for both timing and memory metrics", () => {
    for (const metric of [
      "runtime.maintenanceMs.small.graph_rebuild",
      "runtime.idleRssBytes.small",
      "runtime.browserHeapBytes.small.home",
    ]) {
      const policy = runtimeMaterialityPolicy(metric);
      const violation = runtimeViolation(metric, policy.materialThreshold + 1);
      expect(evaluateRuntimeConfirmation(
        [violation],
        undefined,
        confirmationSupport([[metric, 1]]),
      )).toMatchObject({
        retryRequired: false,
        status: "passed",
        advisoryAssessments: [{
          metric,
          reason: "insufficient_sample_support",
          requiredSupportingSamples: 2,
          firstSampleCount: policy.sampleCount,
          firstSupportingSamples: 1,
        }],
      });
      expect(evaluateRuntimeConfirmation(
        [violation],
        undefined,
        confirmationSupport([[metric, 2]]),
      )).toMatchObject({ retryRequired: true, status: "required" });
    }
  });

  it("applies every exact category policy and rejects unknown exact keys", () => {
    const policyCases = [
      ["runtime.coldHubReadyMs.small", "cold_readiness_ms", 100, 1082.15, 10],
      ["runtime.idleRssBytes.small", "rss_bytes", 32 * 1024 * 1024, 239304704, 5],
      ["runtime.idleCpuMs.large", "idle_cpu_ms", 25, 37, 5],
      ["runtime.apiLatencyMs.small.code", "api_latency_ms", 15, 66, 10],
      ["runtime.maintenanceMs.small.wiki_rebuild", "maintenance_ms", 50, 231, 10],
      ["runtime.maintenancePeakRssBytes.small.graph_refresh", "rss_bytes", 32 * 1024 * 1024, 541235558.4, 5],
      ["runtime.browserHeapBytes.small.home", "browser_heap_bytes", 2 * 1024 * 1024, 7029484, 5],
    ];
    for (const [metric, category, minimumExcess, materialThreshold, sampleCount] of policyCases) {
      const policy = runtimeMaterialityPolicy(metric);
      expect(policy).toEqual({
        budget: committedRuntimeBudget(metric),
        category,
        minimumExcess,
        materialThreshold,
        sampleCount,
        requiredSupportingSamples: 2,
      });
      expect(evaluateRuntimeConfirmation(
        [runtimeViolation(metric, policy.materialThreshold + 1)],
        [runtimeViolation(metric, policy.materialThreshold + 2)],
        confirmationSupport([[metric, 2]], [[metric, 2]]),
      )).toMatchObject({ status: "failed", materialAssessments: [{ metric }] });
      expect(evaluateRuntimeConfirmation(
        [runtimeViolation(metric, policy.materialThreshold)],
        [runtimeViolation(metric, policy.materialThreshold + 2)],
        confirmationSupport([[metric, 0]], [[metric, 2]]),
      )).toMatchObject({ status: "passed", materialAssessments: [] });
    }

    const exactMetrics = committedConfirmableRuntimeMetrics();
    expect(exactMetrics).toHaveLength(114);
    for (const metric of exactMetrics) {
      expect(runtimeMaterialityPolicy(metric)).not.toBeNull();
      const violation = runtimeViolation(metric);
      expect(classifyRuntimeViolations([violation])).toEqual({
        confirmable: [violation],
        immediate: [],
      });
    }
    expect(runtimeMaterialityPolicy("runtime.apiLatencyMs.unknown.future")).toBeNull();
  });

  it("extracts support from all seven exact runtime summary path families", () => {
    const cases = [
      ["runtime.coldHubReadyMs.small", 10],
      ["runtime.idleRssBytes.small", 5],
      ["runtime.idleCpuMs.large", 5],
      ["runtime.apiLatencyMs.small.code", 10],
      ["runtime.maintenanceMs.small.wiki_rebuild", 10],
      ["runtime.maintenancePeakRssBytes.small.graph_refresh", 5],
      ["runtime.browserHeapBytes.small.home", 5],
    ];
    for (const [metric, sampleCount] of cases) {
      const policy = runtimeMaterialityPolicy(metric);
      const violation = runtimeViolation(metric, policy.materialThreshold + 1);
      const report = benchmarkPass({ runtimeViolations: [violation] });
      expect(runtimeSampleSupport(report, [violation]).get(metric)).toEqual({
        sampleCount,
        supportingSamples: 2,
      });
    }
  });

  it("keeps small repeated API crossings advisory and blocks material ones", () => {
    const metric = "runtime.apiLatencyMs.small.code";
    const advisory = evaluateRuntimeConfirmation(
      [runtimeViolation(metric, 53)],
      [runtimeViolation(metric, 58)],
      confirmationSupport([[metric, 0]], [[metric, 0]]),
    );
    expect(advisory).toMatchObject({
      status: "passed",
      finalViolations: [],
      advisoryAssessments: [{
        metric,
        budget: 51,
        minimumExcess: 15,
        materialThreshold: 66,
        firstMeasured: 53,
        secondMeasured: 58,
        classification: "advisory",
        reason: "below_material_threshold",
      }],
      materialAssessments: [],
    });

    const material = evaluateRuntimeConfirmation(
      [runtimeViolation(metric, 67)],
      [runtimeViolation(metric, 70)],
      confirmationSupport([[metric, 2]], [[metric, 2]]),
    );
    expect(material).toMatchObject({
      status: "failed",
      finalViolations: [runtimeViolation(metric, 70)],
      materialAssessments: [{
        metric,
        budget: 51,
        materialThreshold: 66,
        firstMeasured: 67,
        secondMeasured: 70,
        classification: "material",
        reason: "repeated_material_threshold",
        firstSupportingSamples: 2,
        secondSupportingSamples: 2,
      }],
    });
    expect(evaluateRuntimeConfirmation(
      [runtimeViolation(metric, 67)],
      [runtimeViolation(metric, 60)],
      confirmationSupport([[metric, 2]], [[metric, 0]]),
    )).toMatchObject({ status: "passed", finalViolations: [] });
    expect(evaluateRuntimeConfirmation(
      [runtimeViolation(metric, 66)],
      [runtimeViolation(metric, 70)],
      confirmationSupport([[metric, 0]], [[metric, 2]]),
    )).toMatchObject({ status: "passed", finalViolations: [] });
  });

  it("keeps database ratios, outbound requests, and unknown metrics immediate", () => {
    const noisy = [
      "runtime.coldHubReadyMs.small",
      "runtime.idleRssBytes.small",
      "runtime.idleCpuMs.small",
      "runtime.apiLatencyMs.small.search",
      "runtime.maintenanceMs.small.graph_refresh",
      "runtime.maintenancePeakRssBytes.small.graph_refresh",
      "runtime.browserHeapBytes.small.home",
    ].map((metric) => runtimeViolation(metric));
    const database = runtimeViolation("runtime.databaseToInputRatio.small.graph");
    const outbound = runtimeViolation("runtime.outboundRequestCount.small");
    const unknown = runtimeViolation("runtime.apiLatencyMs.unknown.future");
    const mismatchedBudget = runtimeViolation("runtime.apiLatencyMs.small.code", 70, 52);
    expect(classifyRuntimeViolations([
      ...noisy,
      database,
      outbound,
      unknown,
      mismatchedBudget,
    ])).toEqual({
      confirmable: noisy,
      immediate: [database, outbound, unknown, mismatchedBudget],
    });
    expect(evaluateRuntimeConfirmation([noisy[0], database])).toMatchObject({
      retryRequired: false,
      status: "skipped_immediate_failure",
      finalViolations: [database],
      advisoryAssessments: [{ metric: noisy[0].metric, reason: "not_repeated" }],
      materialAssessments: [],
    });
  });

  it("does not retry a clean first pass and emits a consistent final report", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-clean-"));
    try {
      const result = runConfirmationHarness(root, [benchmarkPass()]);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(1);
      expect(result.report.budgetEvaluation).toMatchObject({
        assetViolations: [],
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "not_required",
          repositoryHead: "a".repeat(40),
          firstPassViolations: [],
          secondPassViolations: [],
          confirmedViolations: [],
          advisoryAssessments: [],
          materialAssessments: [],
        },
      });
      expect(existsSync(join(root, "report.attempt-1.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes different noisy metrics across attempts and retains both raw reports", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-different-"));
    const knowledgeMetric = "runtime.apiLatencyMs.medium.knowledge";
    const knowledge = runtimeViolation(
      knowledgeMetric,
      runtimeMaterialityPolicy(knowledgeMetric).materialThreshold + 1,
    );
    const activity = runtimeViolation("runtime.apiLatencyMs.medium.activity");
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [knowledge] }),
        benchmarkPass({ runtimeViolations: [activity] }),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        assetViolations: [],
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "passed",
          repositoryHead: "a".repeat(40),
          firstPassViolations: [knowledge],
          secondPassViolations: [activity],
          confirmedViolations: [],
          advisoryAssessments: [
            { metric: knowledge.metric, reason: "not_repeated" },
            { metric: activity.metric, reason: "not_repeated" },
          ],
          materialAssessments: [],
        },
      });
      expect(readRawAttempt(root, 1).budgetEvaluation.runtimeViolations).toEqual([knowledge]);
      expect(readRawAttempt(root, 2).budgetEvaluation.runtimeViolations).toEqual([activity]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the same noisy metric is material in both attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-same-"));
    const metric = "runtime.apiLatencyMs.small.code";
    const first = runtimeViolation(metric, 67);
    const second = runtimeViolation(metric, 70);
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [first] }),
        benchmarkPass({ runtimeViolations: [second] }),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [second],
        passed: false,
        runtimeConfirmation: {
          status: "failed",
          firstPassViolations: [first],
          secondPassViolations: [second],
          confirmedViolations: [second],
          advisoryAssessments: [],
          materialAssessments: [{
            metric,
            classification: "material",
            requiredSupportingSamples: 2,
            firstSampleCount: 10,
            firstSupportingSamples: 2,
            secondSampleCount: 10,
            secondSupportingSamples: 2,
          }],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes first-pass nonmaterial crossings without paying for confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-advisory-"));
    const metric = "runtime.apiLatencyMs.small.code";
    const first = runtimeViolation(metric, 53);
    const second = runtimeViolation(metric, 58);
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [first] }),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(1);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "passed",
          firstPassViolations: [first],
          secondPassViolations: [],
          confirmedViolations: [],
          advisoryAssessments: [{
            metric,
            classification: "advisory",
            reason: "below_material_threshold",
            firstMeasured: 53,
            secondMeasured: null,
            requiredSupportingSamples: 2,
            firstSampleCount: 10,
            firstSupportingSamples: 0,
          }],
          materialAssessments: [],
        },
      });
      expect(readRawAttempt(root, 1).budgetEvaluation.runtimeViolations).toEqual([first]);
      expect(existsSync(join(root, "report.attempt-2.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a single-outlier advisory without running a second full pass", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-single-outlier-"));
    const metric = "runtime.maintenanceMs.small.graph_rebuild";
    const policy = runtimeMaterialityPolicy(metric);
    const crossing = runtimeViolation(metric, policy.materialThreshold + 25);
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({
          runtimeViolations: [crossing],
          supportingSamples: { [metric]: 1 },
        }),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(1);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "passed",
          firstPassViolations: [crossing],
          secondPassViolations: [],
          advisoryAssessments: [{
            metric,
            classification: "advisory",
            reason: "insufficient_sample_support",
            requiredSupportingSamples: 2,
            firstSampleCount: 10,
            firstSupportingSamples: 1,
          }],
          materialAssessments: [],
        },
      });
      expect(readRawAttempt(root, 1).profiles.small.maintenance.graph_rebuild.elapsedMs.samples)
        .toHaveLength(10);
      expect(existsSync(join(root, "report.attempt-2.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails hard violations on either attempt without treating them as noise", () => {
    const graphRatio = runtimeViolation("runtime.databaseToInputRatio.small.graph");
    const knowledgeMetric = "runtime.apiLatencyMs.medium.knowledge";
    const knowledge = runtimeViolation(
      knowledgeMetric,
      runtimeMaterialityPolicy(knowledgeMetric).materialThreshold + 1,
    );
    const asset = runtimeViolation("assets.routes.home.jsBytes");
    for (const scenario of [
      {
        name: "first-runtime",
        passes: [benchmarkPass({ runtimeViolations: [graphRatio] })],
        calls: 1,
        finalRuntime: [graphRatio],
      },
      {
        name: "first-asset",
        passes: [benchmarkPass({ assetViolations: [asset] })],
        calls: 1,
        finalRuntime: [],
      },
      {
        name: "second-runtime",
        passes: [
          benchmarkPass({ runtimeViolations: [knowledge] }),
          benchmarkPass({ runtimeViolations: [graphRatio] }),
        ],
        calls: 2,
        finalRuntime: [graphRatio],
      },
    ]) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-confirm-${scenario.name}-`));
      try {
        const result = runConfirmationHarness(root, scenario.passes);
        expect(result.exitCode).toBe(1);
        expect(result.calls).toBe(scenario.calls);
        expect(result.report.budgetEvaluation.passed).toBe(false);
        expect(result.report.budgetEvaluation.runtimeViolations).toEqual(scenario.finalRuntime);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("uses exit 2 for unusable child reports", () => {
    for (const pass of [null, "invalid", "oversized", "signaled", "inconsistent"]) {
      const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-invalid-first-"));
      try {
        const result = runConfirmationHarness(root, [pass]);
        expect(result.exitCode).toBe(2);
        expect(result.calls).toBe(1);
        expect(result.report).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-missing-second-"));
    const knowledgeMetric = "runtime.apiLatencyMs.medium.knowledge";
    const knowledge = runtimeViolation(
      knowledgeMetric,
      runtimeMaterialityPolicy(knowledgeMetric).materialThreshold + 1,
    );
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [knowledge] }),
        null,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [knowledge],
        passed: false,
        runtimeConfirmation: {
          status: "operational_failure",
          firstPassViolations: [knowledge],
          secondPassViolations: [],
          confirmedViolations: [],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exit 2 when confirmation metadata would exceed the report cap", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-final-cap-"));
    try {
      const pass = { ...benchmarkPass(), padding: "" };
      const emptyBytes = Buffer.byteLength(`${JSON.stringify(pass)}\n`);
      pass.padding = "x".repeat((2 * 1024 * 1024) - emptyBytes - 32);
      expect(Buffer.byteLength(`${JSON.stringify(pass)}\n`)).toBeLessThan(2 * 1024 * 1024);
      const result = runConfirmationHarness(root, [pass]);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toBe(1);
      expect(result.report).toBeUndefined();
      expect(existsSync(join(root, "report.attempt-1.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats invalid raw evidence for a confirmable metric as operational", () => {
    const metric = "runtime.maintenanceMs.small.graph_rebuild";
    const policy = runtimeMaterialityPolicy(metric);
    const crossing = runtimeViolation(metric, policy.materialThreshold + 25);
    const scenarios = [
      ["malformed", (pass) => {
        pass.profiles.small.maintenance.graph_rebuild.elapsedMs = {
          samples: "invalid",
          p95: crossing.measured,
        };
      }],
      ["missing", (pass) => {
        delete pass.profiles.small.maintenance.graph_rebuild.elapsedMs;
      }],
      ["wrong-count", (pass) => {
        pass.profiles.small.maintenance.graph_rebuild.elapsedMs.samples.pop();
      }],
      ["nonfinite", (pass) => {
        pass.profiles.small.maintenance.graph_rebuild.elapsedMs.samples[0] = null;
      }],
      ["p95-mismatch", (pass) => {
        pass.profiles.small.maintenance.graph_rebuild.elapsedMs.p95 += 1;
      }],
      ["duplicate", (pass) => {
        pass.budgetEvaluation.runtimeViolations.push({ ...crossing });
      }],
    ];
    for (const [name, mutate] of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-confirm-evidence-${name}-`));
      try {
        const pass = benchmarkPass({ runtimeViolations: [crossing] });
        mutate(pass);
        const result = runConfirmationHarness(root, [pass]);
        expect(result.exitCode, name).toBe(2);
        expect(result.calls, name).toBe(1);
        expect(result.report.budgetEvaluation).toMatchObject({
          passed: false,
          runtimeConfirmation: { status: "operational_failure" },
        });
        expect(existsSync(join(root, "report.attempt-1.json")), name).toBe(true);
        expect(existsSync(join(root, "report.attempt-2.json")), name).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("treats invalid second-attempt sample evidence as operational", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-second-evidence-"));
    const metric = "runtime.browserHeapBytes.small.home";
    const policy = runtimeMaterialityPolicy(metric);
    const crossing = runtimeViolation(metric, policy.materialThreshold + 1);
    const second = benchmarkPass({ runtimeViolations: [crossing] });
    second.profiles.small.browserHeap.routes.home.samples.pop();
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [crossing] }),
        second,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        passed: false,
        runtimeConfirmation: { status: "operational_failure" },
      });
      expect(existsSync(join(root, "report.attempt-1.json"))).toBe(true);
      expect(existsSync(join(root, "report.attempt-2.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exit 2 if repository HEAD changes between or during attempts", () => {
    const knowledgeMetric = "runtime.apiLatencyMs.medium.knowledge";
    const knowledge = runtimeViolation(
      knowledgeMetric,
      runtimeMaterialityPolicy(knowledgeMetric).materialThreshold + 1,
    );
    for (const heads of [
      ["a".repeat(40), "b".repeat(40)],
      ["a".repeat(40), "a".repeat(40), "b".repeat(40)],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-head-change-"));
      try {
        const result = runConfirmationHarness(root, [
          benchmarkPass({ runtimeViolations: [knowledge] }),
          benchmarkPass(),
        ], { heads });
        expect(result.exitCode).toBe(2);
        expect(result.report.budgetEvaluation).toMatchObject({
          passed: false,
          runtimeConfirmation: { status: "operational_failure" },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("counts Graph configuration files in the indexed-input denominator", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-input-size-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".mex", "context"), { recursive: true });
      mkdirSync(join(root, ".mex", "events"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export const input = 1;\n");
      writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
      writeFileSync(join(root, "tsconfig.json"), "{\"compilerOptions\":{}}\n");
      writeFileSync(join(root, ".mex", "context", "knowledge.md"), "# Knowledge\n");
      writeFileSync(join(root, ".mex", "events", "ignored.md"), "# Event\n");
      const measured = fixtureInputSizes(root);
      expect(measured.graphFiles).toBe(3);
      expect(measured.graphBytes).toBe(
        Buffer.byteLength("export const input = 1;\n")
        + Buffer.byteLength("{\"private\":true}\n")
        + Buffer.byteLength("{\"compilerOptions\":{}}\n"),
      );
      expect(measured.wikiFiles).toBe(1);
      expect(measured.wikiBytes).toBe(Buffer.byteLength("# Knowledge\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes fixture Git identity deterministic despite inherited overrides and hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-git-identity-"));
    try {
      const cleanRoot = join(root, "clean");
      const contaminatedRoot = join(root, "contaminated");
      const cleanEnvironmentRoot = join(root, "clean-environment");
      const contaminatedEnvironmentRoot = join(root, "contaminated-environment");
      const hookRoot = join(root, "hostile-hooks");
      const templateRoot = join(root, "hostile-template");
      const hookMarker = join(root, "hook-executed");
      for (const directory of [
        cleanEnvironmentRoot,
        contaminatedEnvironmentRoot,
        hookRoot,
        join(templateRoot, "hooks"),
      ]) mkdirSync(directory, { recursive: true });
      const hostileHook = [
        "#!/bin/sh",
        'printf executed > "$MEX_HOOK_MARKER"',
        "exit 91",
        "",
      ].join("\n");
      writeFileSync(join(hookRoot, "pre-commit"), hostileHook);
      writeFileSync(join(templateRoot, "hooks", "pre-commit"), hostileHook);
      chmodSync(join(hookRoot, "pre-commit"), 0o755);
      chmodSync(join(templateRoot, "hooks", "pre-commit"), 0o755);

      const cleanEnvironment = createBenchmarkEnvironment(cleanEnvironmentRoot, process.env);
      const contaminatedEnvironment = createBenchmarkEnvironment(contaminatedEnvironmentRoot, {
        ...process.env,
        GIT_AUTHOR_EMAIL: "attacker@example.invalid",
        GIT_AUTHOR_NAME: "Attacker",
        GIT_COMMITTER_EMAIL: "attacker@example.invalid",
        GIT_COMMITTER_NAME: "Attacker",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hookRoot,
        GIT_DEFAULT_HASH: "sha256",
        GIT_TEMPLATE_DIR: templateRoot,
        MEX_HOOK_MARKER: hookMarker,
      });
      writeMinimalReleaseFixture(cleanRoot);
      writeMinimalReleaseFixture(contaminatedRoot);
      const cleanHead = initializeReleaseFixtureGit(cleanRoot, cleanEnvironment);
      const contaminatedHead = initializeReleaseFixtureGit(contaminatedRoot, contaminatedEnvironment);

      expect(contaminatedHead).toBe(cleanHead);
      expect(contaminatedHead).toMatch(/^[0-9a-f]{40}$/u);
      expect(existsSync(hookMarker)).toBe(false);
      expect(gitCommitIdentity(contaminatedRoot, contaminatedEnvironment)).toEqual([
        "MEX Release Benchmark",
        "release-benchmark@example.invalid",
        "MEX Release Benchmark",
        "release-benchmark@example.invalid",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds artifact locks while ignoring only SQLite reader coordination bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-read-snapshot-"));
    const environmentRoot = join(root, "environment");
    try {
      mkdirSync(environmentRoot, { recursive: true });
      const environment = createBenchmarkEnvironment(environmentRoot, process.env);
      writeMinimalReleaseFixture(root);
      writeFileSync(join(root, ".gitignore"), ".mex/graph.db*\n.mex/local/\n");
      mkdirSync(join(root, ".mex", "local"), { recursive: true });
      writeFileSync(join(root, ".mex", "local", "team.db"), "durable");
      writeFileSync(join(root, ".mex", "local", "team.db-shm"), "reader-a");
      writeFileSync(join(root, ".mex", "local", "cache-shm"), "durable-a");
      writeFileSync(join(root, ".mex", "local", "cache.shm"), "durable-a");
      initializeReleaseFixtureGit(root, environment);

      const before = snapshotReleaseReadState(root, environment);
      writeFileSync(join(root, ".mex", "local", "team.db-shm"), "reader-b");
      expect(snapshotReleaseReadState(root, environment)).toEqual(before);

      writeFileSync(join(root, ".mex", "local", "cache-shm"), "durable-b");
      expect(snapshotReleaseReadState(root, environment)).not.toEqual(before);

      const afterDashShm = snapshotReleaseReadState(root, environment);
      writeFileSync(join(root, ".mex", "local", "cache.shm"), "durable-b");
      expect(snapshotReleaseReadState(root, environment)).not.toEqual(afterDashShm);

      const beforeLock = snapshotReleaseReadState(root, environment);
      writeFileSync(join(root, ".mex", "inbox.mex-lock"), "unexpected lock");
      expect(snapshotReleaseReadState(root, environment)).not.toEqual(beforeLock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates a Hub child that misses the readiness deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-startup-timeout-"));
    const script = join(root, "hanging-hub.mjs");
    const terminated = join(root, "terminated");
    try {
      writeFileSync(script, [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => { writeFileSync(process.env.MEX_TERMINATION_FILE, "yes"); process.exit(0); });',
        "setInterval(() => undefined, 1_000);",
        "",
      ].join("\n"));
      await expect(startHub({
        projectRoot: root,
        cliPath: script,
        environment: { ...process.env, MEX_TERMINATION_FILE: terminated },
        startupTimeoutMs: 1_000,
      })).rejects.toThrow(/Timed out waiting for Hub readiness/u);
      expect(existsSync(terminated)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runtimeProfile(value) {
  return {
    coldHubReadyMs: { p95: value },
    idle: { rssBytes: { p95: value }, cpuMs: { p95: value } },
    apiLatencyMs: { search: { p95: value } },
    maintenance: {
      graph_refresh: {
        elapsedMs: { p95: value },
        peakRssBytes: { p95: value },
      },
    },
    browserHeap: {
      outboundRequestCount: 0,
      routes: { home: { p95: value } },
    },
    database: {
      graph: { ratio: value },
      wiki: { ratio: value },
    },
  };
}

function runtimeViolation(metric, measured, budget) {
  const committedBudget = runtimeMaterialityPolicy(metric)?.budget ?? 100;
  return {
    metric,
    measured: measured ?? committedBudget + 1,
    budget: budget ?? committedBudget,
    reason: "budget_exceeded",
  };
}

function materialityAssessment(overrides) {
  return {
    metric: "runtime.apiLatencyMs.small.code",
    category: "api_latency_ms",
    budget: 51,
    relativeExcessRatio: 0.15,
    minimumExcess: 15,
    materialThreshold: 66,
    ...overrides,
  };
}

function representativeReleaseReport({ runtimeViolations, passed, confirmation }) {
  const assetGroup = { jsBytes: 0, cssBytes: 0, fontBytes: 0, files: [] };
  return {
    schemaVersion: 1,
    benchmark: "mex-release-performance",
    generatedAt: "2026-08-27T00:00:00.000Z",
    environment: {},
    configuration: {},
    assets: {
      initial: assetGroup,
      routes: Object.fromEntries(RELEASE_ROUTE_KEYS.map((route) => [route, assetGroup])),
      largestJsChunk: {},
      budgetCandidates: {},
      violations: [],
    },
    profiles: {},
    budgetEvaluation: {
      assetViolations: [],
      runtimeViolations,
      runtimeConfirmation: confirmation,
      passed,
    },
    budgetCandidates: {},
  };
}

function committedRuntimeBudget(metric) {
  return runtimeMaterialityPolicy(metric)?.budget;
}

function committedConfirmableRuntimeMetrics() {
  const metrics = [];
  for (const name of ["coldHubReadyMs", "idleRssBytes", "idleCpuMs"]) {
    for (const profile of Object.keys(budgets.runtime[name])) {
      metrics.push(`runtime.${name}.${profile}`);
    }
  }
  for (const name of [
    "apiLatencyMs",
    "maintenanceMs",
    "maintenancePeakRssBytes",
    "browserHeapBytes",
  ]) {
    for (const [profile, entries] of Object.entries(budgets.runtime[name])) {
      for (const metric of Object.keys(entries)) {
        metrics.push(`runtime.${name}.${profile}.${metric}`);
      }
    }
  }
  return metrics;
}

function benchmarkPass({
  assetViolations = [],
  runtimeViolations = [],
  supportingSamples = {},
} = {}) {
  return {
    schemaVersion: 1,
    profiles: runtimeProfilesForViolations(runtimeViolations, supportingSamples),
    budgetEvaluation: {
      assetViolations,
      runtimeViolations,
      passed: assetViolations.length === 0 && runtimeViolations.length === 0,
    },
  };
}

function runtimeProfilesForViolations(violations, supportingSamples) {
  const profiles = {};
  for (const violation of violations) {
    const policy = runtimeMaterialityPolicy(violation.metric);
    if (policy === null) continue;
    const requestedSupport = supportingSamples[violation.metric]
      ?? (violation.measured > policy.materialThreshold ? 2 : 0);
    const summary = runtimeSummary(violation.measured, policy, requestedSupport);
    setRuntimeSummary(profiles, violation.metric, summary);
  }
  return profiles;
}

function runtimeSummary(measured, policy, supportingSamples) {
  if (!Number.isInteger(supportingSamples)
    || supportingSamples < 0
    || supportingSamples > policy.sampleCount
    || (measured > policy.materialThreshold && supportingSamples < 1)
    || (measured <= policy.materialThreshold && supportingSamples > 0)) {
    throw new Error("Invalid test runtime sample support.");
  }
  const samples = Array(policy.sampleCount).fill(0);
  if (supportingSamples > 0) {
    const supportingValue = policy.materialThreshold
      + ((measured - policy.materialThreshold) / 2);
    for (let index = policy.sampleCount - supportingSamples; index < policy.sampleCount - 1; index += 1) {
      samples[index] = supportingValue;
    }
  }
  samples[policy.sampleCount - 1] = measured;
  return { samples, p95: measured };
}

function setRuntimeSummary(profiles, metric, summary) {
  const [, category, profile, name] = metric.split(".");
  profiles[profile] ??= {};
  if (category === "coldHubReadyMs") profiles[profile].coldHubReadyMs = summary;
  else if (category === "idleRssBytes") {
    profiles[profile].idle ??= {};
    profiles[profile].idle.rssBytes = summary;
  } else if (category === "idleCpuMs") {
    profiles[profile].idle ??= {};
    profiles[profile].idle.cpuMs = summary;
  } else if (category === "apiLatencyMs") {
    profiles[profile].apiLatencyMs ??= {};
    profiles[profile].apiLatencyMs[name] = summary;
  } else if (category === "maintenanceMs") {
    profiles[profile].maintenance ??= {};
    profiles[profile].maintenance[name] ??= {};
    profiles[profile].maintenance[name].elapsedMs = summary;
  } else if (category === "maintenancePeakRssBytes") {
    profiles[profile].maintenance ??= {};
    profiles[profile].maintenance[name] ??= {};
    profiles[profile].maintenance[name].peakRssBytes = summary;
  } else if (category === "browserHeapBytes") {
    profiles[profile].browserHeap ??= { routes: {} };
    profiles[profile].browserHeap.routes[name] = summary;
  } else throw new Error(`Unsupported test runtime metric: ${metric}`);
}

function confirmationSupport(first = [], second = []) {
  return {
    first: sampleSupportMap(first),
    second: sampleSupportMap(second),
  };
}

function sampleSupportMap(entries) {
  return new Map(entries.map(([metric, supportingSamples]) => [metric, {
    sampleCount: runtimeMaterialityPolicy(metric).sampleCount,
    supportingSamples,
  }]));
}

function runConfirmationHarness(root, passes, options = {}) {
  let calls = 0;
  let headReads = 0;
  const output = join(root, "report.json");
  const exitCode = enforceWithConfirmation(output, {
    executePass(path) {
      const pass = passes[calls];
      calls += 1;
      if (pass === null) return { status: 1, signal: null };
      if (pass === "invalid") {
        writeFileSync(path, "not-json\n");
        return { status: 1, signal: null };
      }
      if (pass === "oversized") {
        writeFileSync(path, "x".repeat((2 * 1024 * 1024) + 1));
        return { status: 1, signal: null };
      }
      if (pass === "signaled") return { status: null, signal: "SIGTERM" };
      if (pass === "inconsistent") {
        writeFileSync(path, `${JSON.stringify(benchmarkPass())}\n`);
        return { status: 1, signal: null };
      }
      writeFileSync(path, `${JSON.stringify(pass)}\n`);
      return { status: pass.budgetEvaluation.passed ? 0 : 1, signal: null };
    },
    resolveRepositoryHead() {
      const heads = options.heads ?? ["a".repeat(40)];
      const head = heads[Math.min(headReads, heads.length - 1)];
      headReads += 1;
      return head;
    },
    emitReport: () => undefined,
  });
  return {
    calls,
    exitCode,
    report: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined,
  };
}

function readRawAttempt(root, attempt) {
  return JSON.parse(readFileSync(join(root, `report.attempt-${attempt}.json`), "utf8"));
}

function writeMinimalReleaseFixture(root) {
  mkdirSync(join(root, ".mex"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".mex/graph.db*\n");
  writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
  writeFileSync(join(root, "tsconfig.json"), "{\"compilerOptions\":{}}\n");
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Fixture\n");
  writeFileSync(join(root, "src", "index.ts"), "export const fixture = true;\n");
}

function gitCommitIdentity(root, environment) {
  const result = spawnSync(
    "git",
    ["show", "-s", "--format=%an%n%ae%n%cn%n%ce", "HEAD"],
    { cwd: root, encoding: "utf8", env: environment },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim().split("\n");
}
