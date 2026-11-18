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
describe("release benchmark contract", () => {
  it("binds every budget leaf to the retained 0.9 pinned calibration report", () => {
    const record = JSON.parse(readFileSync(new URL("../../docs/design/release-0.9-calibration.json", import.meta.url), "utf8"));
    expect(record.source.environment).toEqual({ ...budgets.environment, pinnedBudgetEnvironment: true });
    expect(budgets.calibration).toEqual({
      status: `pinned-0.9-${record.source.runId}`,
      runtimeFormula: record.runtimeFormula,
      assetFormula: record.assetFormula,
    });
    expect(record.source.reportSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.samples).toEqual(budgets.samples);
    const { assets, profiles } = record.measured;
    expect(Object.keys(assets.routes)).toEqual(RELEASE_ROUTE_KEYS);
    const assetGroup = (group) => Object.fromEntries(["jsBytes", "cssBytes", "fontBytes"]
      .map((field) => [field, assetBudgetCandidate(group[field])]));
    expect(budgets.assets).toEqual({
      maxJsChunkBytes: assetBudgetCandidate(assets.largestJsChunk.bytes),
      initial: assetGroup(assets.initial),
      routes: Object.fromEntries(Object.entries(assets.routes).map(([route, group]) => [route, assetGroup(group)])),
    });
    for (const profile of ["small", "medium", "large"]) {
      const measured = profiles[profile];
      expect(measured.browserHeap.outboundRequestCount).toBe(0);
      expect(Object.keys(measured.browserHeap.routes)).toEqual(RELEASE_ROUTE_KEYS);
      for (const summary of [measured.coldHubReadyMs, ...Object.values(measured.apiLatencyMs),
        ...Object.values(measured.maintenance).map(({ elapsedMs }) => elapsedMs)]) {
        expect(summary).toEqual(summarize(summary.samples, budgets.samples.timing));
      }
      for (const summary of [measured.idle.rssBytes, measured.idle.cpuMs,
        ...Object.values(measured.maintenance).map(({ peakRssBytes }) => peakRssBytes),
        ...Object.values(measured.browserHeap.routes)]) {
        expect(summary).toEqual(summarize(summary.samples, budgets.samples.idleMemory));
      }
    }
    expect(budgets.runtime).toEqual(candidateRuntimeBudgets(profiles));
  });
  it("locks the sample counts and deterministic route budget surface", () => {
    expect(budgets.schemaVersion).toBe(1);
    expect(budgets.samples).toEqual({ timing: 10, idleMemory: 5 });
    expect(RELEASE_FIXTURE_PROFILES).toEqual({
      small: { sourceFiles: 4, wikiEntities: 4, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 4 },
      medium: { sourceFiles: 16, wikiEntities: 16, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 16 },
      large: { sourceFiles: 48, wikiEntities: 48, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 48 },
    });
    expect(Object.keys(budgets.assets.routes)).toEqual(RELEASE_ROUTE_KEYS);
    expect(Object.keys(releaseWorkbenchPaths({
      knowledgeEntityId: "mx_knowledge",
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
    expect(budgets.assets.routes.code).toEqual(budgets.assets.routes.search);
    expect(budgets.assets.routes.catchUp).toEqual(budgets.assets.routes.playbooks);
    expect(budgets.provisional).toBe(false);
    expect(budgets.calibration).toEqual({
      status: "pinned-0.9-43151888852",
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
      "relayDrafts",
      "relays",
    ]);
    expect(releaseCommonReadPaths("symbol/release").knowledge).toBe("/api/v1/wiki/graph");
    expect(budgetsSchema.$defs.readBudgets.properties).not.toHaveProperty("inboxDrafts");
    expect(budgetsSchema.$defs.readBudgets.properties).not.toHaveProperty("inboxProposals");
    expect(budgetsSchema.$defs.readBudgets.properties).toEqual(expect.objectContaining({
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
    expect(releaseWorkbenchPaths({ knowledgeEntityId: "knowledge", codeSymbolId: "code" }).settings).toBe("/settings");
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
    expect(calibration.limits).toEqual({ jsBytes: 81866, cssBytes: 25146, fontBytes: 0 });
    const record = JSON.parse(readFileSync(new URL("../../docs/design/setup-progress-asset-calibration.json", import.meta.url), "utf8"));
    expect(record.previousLimits).toEqual({ jsBytes: 80646, cssBytes: 25146, fontBytes: 0 });
    expect(record.measured).toEqual(calibration.measured);
    expect(record.limits).toEqual(calibration.limits);
    expect(record.files).toEqual(calibration.files);
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
        "CapabilityPage", "WorkstreamsPage", "DiagramsPage", "StatechartCanvas", "SpecsPage", "InboxPage", "RelayPage",
        "MembersPage", "ActivityPage", "JobsPage", "HealthPage", "SettingsPage", "SetupPage"];
      const manifest = {
        "index.html": { file: "assets/index.js", isEntry: true, dynamicImports: pages },
        "graph-runtime": { file: "assets/graph.js" },
        "record-runtime": { file: "assets/record.js" },
        "../hub-contracts/dist/setup.js": {
          file: "assets/setup.js", src: "../hub-contracts/dist/setup.js", isDynamicEntry: true,
        },
        "../hub-contracts/dist/contact.js": {
          file: "assets/contact.js", src: "../hub-contracts/dist/contact.js", isDynamicEntry: true,
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
        "assets/SetupPage.js", "assets/contact.js", "assets/setup.js",
      ]);
      const setupPage = join(output, "assets/SetupPage.js");
      const originalSetup = readFileSync(setupPage, "utf8");
      const setupLimit = JSON.parse(readFileSync(new URL("./setup-asset-budget.json", import.meta.url), "utf8")).limits.jsBytes;
      writeFileSync(setupPage, "x".repeat(setupLimit + 1));
      expect(measureBuiltAssets(output, budgets.assets).violations).toEqual([
        expect.objectContaining({ metric: "assets.setup.jsBytes", reason: "budget_exceeded" }),
      ]);
      writeFileSync(setupPage, originalSetup);
      const contactContract = join(output, "assets/contact.js");
      const originalContact = readFileSync(contactContract, "utf8");
      writeFileSync(contactContract, "x".repeat(setupLimit + 1));
      expect(measureBuiltAssets(output, budgets.assets).violations).toEqual([
        expect.objectContaining({ metric: "assets.setup.jsBytes", reason: "budget_exceeded" }),
      ]);
      writeFileSync(contactContract, originalContact);

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
      ["runtime.coldHubReadyMs.small", "cold_readiness_ms", 100, 10],
      ["runtime.idleRssBytes.small", "rss_bytes", 32 * 1024 * 1024, 5],
      ["runtime.idleCpuMs.large", "idle_cpu_ms", 25, 5],
      ["runtime.apiLatencyMs.small.code", "api_latency_ms", 15, 10],
      ["runtime.maintenanceMs.small.wiki_rebuild", "maintenance_ms", 50, 10],
      ["runtime.maintenancePeakRssBytes.small.graph_refresh", "rss_bytes", 32 * 1024 * 1024, 5],
      ["runtime.browserHeapBytes.small.home", "browser_heap_bytes", 2 * 1024 * 1024, 5],
    ];
    for (const [metric, category, minimumExcess, sampleCount] of policyCases) {
      const policy = runtimeMaterialityPolicy(metric);
      const budget = committedRuntimeBudget(metric);
      const materialThreshold = budget + Math.max(budget * 0.15, minimumExcess);
      expect(policy).toEqual({
        budget,
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
    expect(exactMetrics).toHaveLength(102);
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
    const budget = committedRuntimeBudget(metric);
    expect(budget).toBeLessThan(100);
    const threshold = budget + 15;
    const advisory = evaluateRuntimeConfirmation(
      [runtimeViolation(metric, budget + 2)],
      [runtimeViolation(metric, budget + 7)],
      confirmationSupport([[metric, 0]], [[metric, 0]]),
    );
    expect(advisory).toMatchObject({
      status: "passed",
      finalViolations: [],
      advisoryAssessments: [{
        metric,
        budget,
        minimumExcess: 15,
        materialThreshold: threshold,
        firstMeasured: budget + 2,
        secondMeasured: budget + 7,
        classification: "advisory",
        reason: "below_material_threshold",
      }],
      materialAssessments: [],
    });

    const material = evaluateRuntimeConfirmation(
      [runtimeViolation(metric, threshold + 1)],
      [runtimeViolation(metric, threshold + 4)],
      confirmationSupport([[metric, 2]], [[metric, 2]]),
    );
    expect(material).toMatchObject({
      status: "failed",
      finalViolations: [runtimeViolation(metric, threshold + 4)],
      materialAssessments: [{
        metric,
        budget,
        materialThreshold: threshold,
        firstMeasured: threshold + 1,
        secondMeasured: threshold + 4,
        classification: "material",
        reason: "repeated_material_threshold",
        firstSupportingSamples: 2,
        secondSupportingSamples: 2,
      }],
    });
    expect(evaluateRuntimeConfirmation(
      [runtimeViolation(metric, threshold + 1)],
      [runtimeViolation(metric, threshold - 6)],
      confirmationSupport([[metric, 2]], [[metric, 0]]),
    )).toMatchObject({ status: "passed", finalViolations: [] });
    expect(evaluateRuntimeConfirmation(
      [runtimeViolation(metric, threshold)],
      [runtimeViolation(metric, threshold + 4)],
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
    const started = join(root, "started-pid");
    try {
      writeFileSync(script, [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.MEX_PID_FILE, String(process.pid));',
        'process.on("SIGTERM", () => { writeFileSync(process.env.MEX_TERMINATION_FILE, "yes"); process.exit(0); });',
        "setInterval(() => undefined, 1_000);",
        "",
      ].join("\n"));
      await expect(startHub({
        projectRoot: root,
        cliPath: script,
        environment: { ...process.env, MEX_TERMINATION_FILE: terminated, MEX_PID_FILE: started },
        startupTimeoutMs: 1_000,
      })).rejects.toThrow(/Timed out waiting for Hub readiness/u);
      const pid = Number(readFileSync(started, "utf8"));
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      // Windows terminates the process without dispatching POSIX signal handlers.
      if (process.platform !== "win32") expect(existsSync(terminated)).toBe(true);
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
      for (const metric of Object.keys(entries).filter(metric => Number.isFinite(entries[metric]))) {
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
