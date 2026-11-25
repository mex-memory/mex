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
import { evaluateAssetBudgets, measureBuiltAssets } from "./assets.mjs";
import { assertReleaseRouteReady } from "./browser.mjs";
import {
  releaseWorkbenchPaths,
  RELEASE_ROUTE_KEYS,
  RELEASE_ROUTE_PATTERNS,
} from "./routes.mjs";
import { createBenchmarkEnvironment } from "./environment.mjs";
import {
  fixtureInputSizes,
  initializeReleaseFixtureGit,
  RELEASE_FIXTURE_PROFILES,
  snapshotReleaseReadState,
} from "./fixtures.mjs";
import {
  RELEASE_COMMON_READ_PATHS,
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
const previousCalibration = JSON.parse(readFileSync(new URL("../../docs/design/release-0.9-calibration.json", import.meta.url), "utf8"));

describe("release benchmark contract", () => {
  it("retains the pinned runtime limits and uses existing caps for provisional machine Hub metrics", () => {
    const previous = candidateRuntimeBudgets(previousCalibration.measured.profiles);
    expect(previousCalibration.source.environment).toEqual({ ...budgets.environment, pinnedBudgetEnvironment: true });
    expect(budgets.samples).toEqual(previousCalibration.samples);
    expect(budgets.provisional).toBe(true);
    expect(budgets.calibration).toEqual({
      status: "machine-hub-assets-measured-runtime-provisional",
      runtimeFormula: previousCalibration.runtimeFormula,
      assetFormula: previousCalibration.assetFormula,
      provisionalRuntimeMetrics: [
        "coldHubReadyMs", "idleRssBytes", "idleCpuMs", "apiLatencyMs",
        "maintenanceMs", "maintenancePeakRssBytes", "browserHeapBytes",
      ],
    });
    for (const metric of ["coldHubReadyMs", "idleRssBytes", "idleCpuMs", "maintenanceMs",
      "maintenancePeakRssBytes", "databaseToInputRatio"]) {
      expect(budgets.runtime[metric]).toEqual(previous[metric]);
    }
    for (const profile of Object.keys(RELEASE_FIXTURE_PROFILES)) {
      const cap = Math.min(...Object.values(previous.apiLatencyMs[profile]));
      const { session, projects, home, jobs, knowledge, knowledgeLanding, review, reviewDetail, agents, agentDetail, settings, uninstallPreview } = budgets.runtime.apiLatencyMs[profile];
      expect({ session, projects }).toEqual({ session: cap, projects: cap });
      expect(home).toBeGreaterThan(0);
      expect(jobs).toBeGreaterThan(0);
      expect(knowledge).toBeGreaterThan(0);
      expect(knowledgeLanding).toBeGreaterThan(0);
      expect(review).toBeGreaterThan(0);
      expect(reviewDetail).toBeGreaterThan(0);
      expect([agents, agentDetail, settings, uninstallPreview]).toEqual([review, review, review, review]);
      expect(budgets.runtime.browserHeapBytes[profile]).toEqual({
        home: previous.browserHeapBytes[profile].home,
        repo: Math.min(...Object.values(previous.browserHeapBytes[profile])),
      });
    }
    const assetGroup = (group) => Object.fromEntries(
      Object.entries(group).map(([field, bytes]) => [field, assetBudgetCandidate(bytes)]),
    );
    const measuredInitial = { jsBytes: 464914, cssBytes: 76818, fontBytes: 84724 };
    const home = { jsBytes: 112676, cssBytes: 9787, fontBytes: 0 };
    const jobs = { jsBytes: 69761, cssBytes: 3983, fontBytes: 0 };
    const knowledge = { jsBytes: 125960, cssBytes: 25588, fontBytes: 0 };
    const review = { jsBytes: 103715, cssBytes: 17786, fontBytes: 0 };
    const agents = { jsBytes: 132824, cssBytes: 13137, fontBytes: 0 };
    const settings = { jsBytes: 113560, cssBytes: 32363, fontBytes: 0 };
    expect(budgets.assets).toEqual({
      maxJsChunkBytes: assetBudgetCandidate(measuredInitial.jsBytes),
      initial: assetGroup(measuredInitial),
      routes: {
        home: assetGroup(home), repo: assetGroup(home), jobs: assetGroup(jobs), knowledge: assetGroup(knowledge),
        review: assetGroup(review), agents: assetGroup(agents), settings: assetGroup(settings),
      },
    });
  });

  it("locks sample counts, frozen fixtures, and the machine Hub route budget surface", () => {
    expect(budgets.schemaVersion).toBe(1);
    expect(budgets.samples).toEqual({ timing: 10, idleMemory: 5 });
    expect(RELEASE_FIXTURE_PROFILES).toEqual({
      small: { sourceFiles: 4, wikiEntities: 4, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 4 },
      medium: { sourceFiles: 16, wikiEntities: 16, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 16 },
      large: { sourceFiles: 48, wikiEntities: 48, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 48 },
    });
    expect(Object.keys(budgets.assets.routes)).toEqual([...RELEASE_ROUTE_KEYS, "jobs", "knowledge", "review", "agents", "settings"]);
    const projectId = "g-0123456789abcdef01234567";
    expect(releaseWorkbenchPaths({ projectId })).toEqual({ home: "/", repo: "/repos/" + projectId });
    expect(() => releaseWorkbenchPaths({ projectId: "../outside" })).toThrow(/machine project ID/u);
    const main = readFileSync(new URL("../../packages/hub-web/src/main.tsx", import.meta.url), "utf8");
    expect(main).toContain("<MachineHub />");
    const routes = readFileSync(new URL("../../packages/hub-web/src/machine/HubShell.tsx", import.meta.url), "utf8");
    const patterns = [...routes.matchAll(/<Route\s+[\s\S]*?\bpath="([^"]+)"/gu)].map(([, path]) => path);
    expect(patterns).toEqual([
      "/agents/:agent?", "/settings", "*",
      "/", "/review/:cardKey?", "/repos/:projectId/review/:cardKey?", "/knowledge/:entryKey?",
      "/repos/:projectId/knowledge/:entryKey?", "/repos/:projectId", "/jobs", "/repos/:projectId/jobs", "*",
    ]);
    expect(routes).toContain('<Route element={<Navigate replace to={homeHref} />} path="*" />');
    expect(RELEASE_COMMON_READ_PATHS).toEqual({
      session: "/api/v1/session", projects: "/api/v1/projects", home: "/api/v1/home", jobs: "/api/v1/jobs",
      knowledge: "/api/v1/knowledge", knowledgeLanding: "/api/v1/knowledge/landing",
      review: "/api/v1/review", reviewDetail: "/api/v1/review/cards/:key",
      agents: "/api/v1/agents", agentDetail: "/api/v1/agents/claude-code",
      settings: "/api/v1/settings", uninstallPreview: "/api/v1/settings/uninstall",
    });
    for (const profile of Object.keys(RELEASE_FIXTURE_PROFILES)) {
      expect(Object.keys(budgets.runtime.browserHeapBytes[profile])).toEqual(RELEASE_ROUTE_KEYS);
      expect(Object.keys(budgets.runtime.apiLatencyMs[profile])).toEqual(Object.keys(RELEASE_COMMON_READ_PATHS));
    }

    expect(packageJson.scripts["benchmark:release"]).toContain("scripts/release-benchmark/enforce.mjs");
    expect(reportSchema.$defs.runtimeConfirmation.properties.status.enum).toEqual([
      "not_required", "skipped_immediate_failure", "passed", "failed", "operational_failure",
    ]);
    for (const field of ["advisoryAssessments", "materialAssessments", "runnerAllocations"]) {
      expect(reportSchema.$defs.runtimeConfirmation.required).not.toContain(field);
      expect(reportSchema.$defs.runtimeConfirmation.properties).toHaveProperty(field);
    }
    const validateBudgets = new Ajv2020({ strict: true }).compile(budgetsSchema);
    expect(validateBudgets(budgets), JSON.stringify(validateBudgets.errors)).toBe(true);
  });

  it.each([
    ["home", true], ["home", false], ["repo", true], ["repo", false],
  ])("waits for populated %s content before measuring heap (visible: %s)", async (route, populated) => {
    const waitFor = vi.fn(async () => {});
    const waitForContent = vi.fn(async () => {
      if (!populated) throw new Error("The fixture checkout is not visible.");
    });
    const checkouts = { getByText: vi.fn(() => ({ waitFor: waitForContent })) };
    const switcher = { getByRole: vi.fn(() => ({ waitFor: waitForContent })) };
    const page = {
      getByRole: vi.fn((role) => role === "combobox" ? switcher : { waitFor }),
      locator: vi.fn(() => checkouts),
    };
    const project = { name: "release fixture", checkouts: [{ path: "/test/fixture" }] };
    const measured = assertReleaseRouteReady(page, route, project);
    if (populated) await expect(measured).resolves.toBeUndefined();
    else await expect(measured).rejects.toThrow("The fixture checkout is not visible.");
    expect(page.getByRole).toHaveBeenCalledWith("heading", {
      name: "Home", exact: true, level: 1,
    });
    expect(page.getByRole).toHaveBeenCalledWith("region", { name: "What MEX knows", exact: true });
    if (route === "home") expect(switcher.getByRole).toHaveBeenCalledWith("option", { name: project.name, exact: true });
    else expect(checkouts.getByText).toHaveBeenCalledWith(project.checkouts[0].path, { exact: true });
    expect(waitForContent).toHaveBeenCalledWith({ state: "attached", timeout: 30_000 });
  });

  it("fails closed if a Repo heap budget is missing", () => {
    const profiles = Object.fromEntries(Object.keys(RELEASE_FIXTURE_PROFILES).map((profile) => [
      profile,
      { ...runtimeProfile(100), browserHeap: { outboundRequestCount: 0, routes: { repo: { p95: 123 } } } },
    ]));
    const missing = structuredClone(budgets.runtime);
    for (const profile of Object.keys(profiles)) delete missing.browserHeapBytes[profile].repo;
    const violations = evaluateRuntimeBudgets(profiles, missing).filter(({ metric }) => metric.endsWith(".repo"));
    expect(violations).toEqual(Object.keys(profiles).map((profile) => ({
      metric: "runtime.browserHeapBytes." + profile + ".repo", measured: 123, budget: null, reason: "budget_missing",
    })));
    expect(classifyRuntimeViolations(violations)).toEqual({ confirmable: [], immediate: violations });
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
    const metric = "runtime.apiLatencyMs.small.session";
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
    legacyReport.assets.routes = Object.fromEntries(Object.entries(previousCalibration.measured.assets.routes)
      .map(([route, group]) => [route, { jsBytes: group.jsBytes, cssBytes: group.cssBytes, fontBytes: group.fontBytes, files: [] }]));
    delete legacyReport.assets.routes.settings;
    expect(validate(legacyReport), JSON.stringify(validate.errors)).toBe(true);

    const machineReport = representativeReleaseReport({ runtimeViolations: [], passed: true });
    const memory = summarize([1, 1, 1, 1, 1], 5);
    const database = { databaseBytes: 1, inputBytes: 1, ratio: 1 };
    machineReport.profiles.small = {
      fixture: generatedFixture, coldHubReadyMs: summary,
      idle: { rssBytes: memory, cpuMs: memory, cpuPercent: memory, windowMs: 2_000 },
      apiLatencyMs: { session: summary, projects: summary, home: summary, jobs: summary },
      browserHeap: { routes: { home: memory, repo: memory }, outboundRequestCount: 0, observedLoopbackRequests: [] },
      maintenance: null, database: { graph: database, wiki: database },
    };
    expect(validate(machineReport), JSON.stringify(validate.errors)).toBe(true);
    delete machineReport.profiles.small.apiLatencyMs.projects;
    expect(validate(machineReport)).toBe(false);

    const { budget, materialThreshold } = runtimeMaterialityPolicy(metric);
    const firstAdvisory = runtimeViolation(metric, budget + 2);
    const secondAdvisory = runtimeViolation(metric, budget + 7);
    const firstMaterial = runtimeViolation(metric, materialThreshold + 1);
    const secondMaterial = runtimeViolation(metric, materialThreshold + 4);
    const advisoryAssessment = materialityAssessment({
      classification: "advisory",
      reason: "below_material_threshold",
      firstMeasured: firstAdvisory.measured,
      secondMeasured: secondAdvisory.measured,
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
        firstPassViolations: [firstMaterial],
        secondPassViolations: [],
        confirmedViolations: [],
        advisoryAssessments: [materialityAssessment({
          classification: "advisory",
          reason: "insufficient_sample_support",
          firstMeasured: firstMaterial.measured,
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

    const materialAssessment = materialityAssessment({
      classification: "material",
      reason: "repeated_material_threshold",
      firstMeasured: firstMaterial.measured,
      secondMeasured: secondMaterial.measured,
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

  it("counts eager JS, CSS and built fonts once, with no incremental route bytes", () => {
    const output = mkdtempSync(join(tmpdir(), "mex-release-assets-"));
    try {
      const manifest = writeAssetFixture(output);
      writeAssetManifest(output, manifest);
      const measured = measureBuiltAssets(output, budgets.assets);
      expect(measured.initial).toMatchObject({ jsBytes: 10, cssBytes: 5, fontBytes: 4 });
      expect(measured.largestJsChunk).toEqual({ file: "assets/index.js", bytes: 10 });
      for (const route of RELEASE_ROUTE_KEYS) {
        expect(measured.routes[route]).toEqual({ jsBytes: 0, cssBytes: 0, fontBytes: 0, files: [] });
      }
      expect(measured.budgetCandidates.initial).toEqual({ jsBytes: 11, cssBytes: 6, fontBytes: 5 });
      expect(measured.violations).toEqual([]);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("charges a lazy Repo chunk and its nested imports only to the Repo route", () => {
    const output = mkdtempSync(join(tmpdir(), "mex-release-assets-"));
    try {
      const manifest = writeAssetFixture(output);
      manifest["index.html"].dynamicImports = ["repo-chunk", "jobs-chunk"];
      manifest["repo-chunk"] = {
        src: "src/machine/RepoPage.tsx", file: "assets/repo.js", isDynamicEntry: true,
        imports: ["index.html"], dynamicImports: ["repo-detail"],
      };
      manifest["repo-detail"] = { file: "assets/detail.js", css: ["assets/detail.css"], isDynamicEntry: true };
      manifest["jobs-chunk"] = { src: "src/machine/JobsPage.tsx", file: "assets/jobs.js", isDynamicEntry: true, imports: ["index.html"] };
      for (const file of ["repo.js", "detail.js", "detail.css", "jobs.js"]) writeFileSync(join(output, "assets", file), "123");
      writeAssetManifest(output, manifest);
      const measured = measureBuiltAssets(output, budgets.assets);
      expect(measured.initial.jsBytes).toBe(10);
      expect(measured.routes.home.jsBytes).toBe(0);
      expect(measured.routes.repo).toMatchObject({ jsBytes: 6, cssBytes: 3, fontBytes: 0 });
      expect(measured.routes.jobs).toMatchObject({ jsBytes: 3, cssBytes: 0, fontBytes: 0 });
      expect(measured.violations).toEqual([]);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects obsolete workbenches, unmeasured assets, and manifest paths outside the build", () => {
    const output = mkdtempSync(join(tmpdir(), "mex-release-assets-"));
    try {
      const manifest = writeAssetFixture(output);
      manifest.opaque = { file: "assets/old.js", src: "src/pages/SetupPage.tsx", isDynamicEntry: true };
      writeAssetManifest(output, manifest);
      expect(() => measureBuiltAssets(output, budgets.assets)).toThrow(/manifest still includes src\/pages\//u);
      manifest.opaque.src = "src/machine/Other.tsx";
      writeAssetManifest(output, manifest);
      expect(() => measureBuiltAssets(output, budgets.assets)).toThrow(/unmeasured dynamic chunk/u);
      delete manifest.opaque;
      manifest["index.html"].css.push("../outside.css");
      writeAssetManifest(output, manifest);
      expect(() => measureBuiltAssets(output, budgets.assets)).toThrow(/Manifest asset is missing/u);
      manifest["index.html"].css.pop();
      writeAssetManifest(output, manifest);
      writeFileSync(join(output, "assets", "unreferenced.css"), "unexpected");
      expect(() => measureBuiltAssets(output, budgets.assets)).toThrow(/unmeasured asset/u);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("keeps runtime candidates and enforcement scoped to each fixture profile", () => {
    const profiles = {
      small: runtimeProfile(100),
      medium: runtimeProfile(200),
      large: runtimeProfile(300),
    };
    const candidates = candidateRuntimeBudgets(profiles);
    expect(candidates.apiLatencyMs).toEqual({
      small: { projects: 115 },
      medium: { projects: 230 },
      large: { projects: 345 },
    });
    expect(candidates.databaseToInputRatio).toEqual({
      small: { graph: 115, wiki: 115 },
      medium: { graph: 230, wiki: 230 },
      large: { graph: 345, wiki: 345 },
    });
    expect(evaluateRuntimeBudgets(profiles, candidates)).toEqual([]);
    candidates.apiLatencyMs.small.projects = 99;
    expect(evaluateRuntimeBudgets(profiles, candidates)).toContainEqual({
      metric: "runtime.apiLatencyMs.small.projects",
      measured: 100,
      budget: 99,
      reason: "budget_exceeded",
    });
  });

  it("fails closed when a machine API budget is missing", () => {
    const profiles = Object.fromEntries(Object.keys(RELEASE_FIXTURE_PROFILES).map((profile) => [
      profile,
      {
        ...runtimeProfile(100),
        apiLatencyMs: { session: { p95: 2 }, projects: { p95: 3 }, review: { p95: 4 }, reviewDetail: { p95: 5 } },
        maintenance: null,
      },
    ]));
    const candidate = candidateRuntimeBudgets(profiles);
    expect(candidate.maintenanceMs).toEqual({ small: {}, medium: {}, large: {} });
    expect(candidate.maintenancePeakRssBytes).toEqual({ small: {}, medium: {}, large: {} });
    expect(evaluateRuntimeBudgets(profiles, candidate)).toEqual([]);
    for (const profile of Object.keys(profiles)) candidate.apiLatencyMs[profile] = {};
    const violations = evaluateRuntimeBudgets(profiles, candidate);
    expect(violations).toHaveLength(12);
    expect(violations).toEqual(expect.arrayContaining([
      { metric: "runtime.apiLatencyMs.small.session", measured: 2, budget: null, reason: "budget_missing" },
      { metric: "runtime.apiLatencyMs.large.projects", measured: 3, budget: null, reason: "budget_missing" },
      { metric: "runtime.apiLatencyMs.small.review", measured: 4, budget: null, reason: "budget_missing" },
      { metric: "runtime.apiLatencyMs.large.reviewDetail", measured: 5, budget: null, reason: "budget_missing" },
    ]));
    expect(classifyRuntimeViolations(violations)).toEqual({ confirmable: [], immediate: violations });
    expect(JSON.parse(JSON.stringify(violations))).toEqual(violations);
  });

  it("retries only potentially material crossings and blocks supported repeats", () => {
    const projectsPolicy = runtimeMaterialityPolicy("runtime.apiLatencyMs.medium.projects");
    const projects = runtimeViolation(
      "runtime.apiLatencyMs.medium.projects",
      projectsPolicy.materialThreshold + 1,
    );
    const session = runtimeViolation("runtime.apiLatencyMs.medium.session");
    const initial = evaluateRuntimeConfirmation(
      [projects],
      undefined,
      confirmationSupport([[projects.metric, 2]]),
    );
    expect(initial).toMatchObject({ retryRequired: true, status: "required" });

    expect(evaluateRuntimeConfirmation(
      [projects],
      [session],
      confirmationSupport([[projects.metric, 2]], [[session.metric, 0]]),
    )).toMatchObject({
      retryRequired: false,
      status: "passed",
      finalViolations: [],
    });
    expect(evaluateRuntimeConfirmation(
      [projects],
      [projects],
      confirmationSupport([[projects.metric, 2]], [[projects.metric, 1]]),
    )).toMatchObject({
      retryRequired: false,
      status: "passed",
      finalViolations: [],
      confirmed: [projects],
      advisoryAssessments: [{
        metric: projects.metric,
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
      ["runtime.apiLatencyMs.small.session", "api_latency_ms", 15, 10],
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
    expect(exactMetrics).toHaveLength(75);
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
      ["runtime.apiLatencyMs.small.session", 10],
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
    const metric = "runtime.apiLatencyMs.small.session";
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
      "runtime.apiLatencyMs.small.projects",
      "runtime.maintenanceMs.small.graph_refresh",
      "runtime.maintenancePeakRssBytes.small.graph_refresh",
      "runtime.browserHeapBytes.small.home",
    ].map((metric) => runtimeViolation(metric));
    const database = runtimeViolation("runtime.databaseToInputRatio.small.graph");
    const outbound = runtimeViolation("runtime.outboundRequestCount.small");
    const unknown = runtimeViolation("runtime.apiLatencyMs.unknown.future");
    const mismatchedBudget = runtimeViolation("runtime.apiLatencyMs.small.session", 70, 52);
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
    const projectsMetric = "runtime.apiLatencyMs.medium.projects";
    const projects = runtimeViolation(
      projectsMetric,
      runtimeMaterialityPolicy(projectsMetric).materialThreshold + 1,
    );
    const session = runtimeViolation("runtime.apiLatencyMs.medium.session");
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [projects] }),
        benchmarkPass({ runtimeViolations: [session] }),
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
          firstPassViolations: [projects],
          secondPassViolations: [session],
          confirmedViolations: [],
          advisoryAssessments: [
            { metric: projects.metric, reason: "not_repeated" },
            { metric: session.metric, reason: "not_repeated" },
          ],
          materialAssessments: [],
        },
      });
      expect(readRawAttempt(root, 1).budgetEvaluation.runtimeViolations).toEqual([projects]);
      expect(readRawAttempt(root, 2).budgetEvaluation.runtimeViolations).toEqual([session]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the same noisy metric is material in both attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-same-"));
    const metric = "runtime.apiLatencyMs.small.session";
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
    const metric = "runtime.apiLatencyMs.small.session";
    const first = runtimeViolation(metric, committedRuntimeBudget(metric) + 2);
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
            firstMeasured: first.measured,
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
    const projectsMetric = "runtime.apiLatencyMs.medium.projects";
    const projects = runtimeViolation(
      projectsMetric,
      runtimeMaterialityPolicy(projectsMetric).materialThreshold + 1,
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
          benchmarkPass({ runtimeViolations: [projects] }),
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
    const projectsMetric = "runtime.apiLatencyMs.medium.projects";
    const projects = runtimeViolation(
      projectsMetric,
      runtimeMaterialityPolicy(projectsMetric).materialThreshold + 1,
    );
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [projects] }),
        null,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [projects],
        passed: false,
        runtimeConfirmation: {
          status: "operational_failure",
          firstPassViolations: [projects],
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
    const projectsMetric = "runtime.apiLatencyMs.medium.projects";
    const projects = runtimeViolation(
      projectsMetric,
      runtimeMaterialityPolicy(projectsMetric).materialThreshold + 1,
    );
    for (const heads of [
      ["a".repeat(40), "b".repeat(40)],
      ["a".repeat(40), "a".repeat(40), "b".repeat(40)],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-head-change-"));
      try {
        const result = runConfirmationHarness(root, [
          benchmarkPass({ runtimeViolations: [projects] }),
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
        MEX_OFF: "1",
        MEX_BACKGROUND: "1",
        MEX_RECORD_HOME: join(root, "outside-record"),
      });
      expect(contaminatedEnvironment.MEX_OFF).toBe("0");
      expect(contaminatedEnvironment.MEX_BACKGROUND).toBe("0");
      expect(contaminatedEnvironment).not.toHaveProperty("MEX_RECORD_HOME");
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

  it("counts readiness only after an unauthenticated foreground hello answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-startup-hello-"));
    const script = join(root, "delayed-hub.mjs");
    try {
      writeFileSync(script, [
        'import { createServer } from "node:http";',
        'const server = createServer((req, res) => {',
        '  if (req.url !== "/api/v1/hello" || req.headers.cookie) { res.writeHead(400).end("{}"); return; }',
        '  setTimeout(() => res.end(JSON.stringify({ app: "mex-hub", homeId: "a".repeat(22), version: "test", mode: "terminal" })), 100);',
        '});',
        'if (!process.argv.includes("--foreground")) process.exit(1);',
        'server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + server.address().port + "/#token=test"));',
      ].join("\n"));
      const hub = await startHub({ projectRoot: root, cliPath: script, environment: process.env });
      try { expect(hub.readyMs).toBeGreaterThanOrEqual(100); }
      finally { await hub.close(); }
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

function writeAssetFixture(output) {
  mkdirSync(join(output, ".vite"));
  mkdirSync(join(output, "assets"));
  writeFileSync(join(output, "assets", "index.js"), "0123456789");
  writeFileSync(join(output, "assets", "index.css"), "01234");
  writeFileSync(join(output, "assets", "text.woff2"), "0123");
  return {
    "index.html": { file: "assets/index.js", css: ["assets/index.css"], isEntry: true },
  };
}

function writeAssetManifest(output, manifest) {
  writeFileSync(join(output, ".vite", "manifest.json"), JSON.stringify(manifest));
}

function runtimeProfile(value) {
  return {
    coldHubReadyMs: { p95: value },
    idle: { rssBytes: { p95: value }, cpuMs: { p95: value } },
    apiLatencyMs: { projects: { p95: value } },
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
  const metric = "runtime.apiLatencyMs.small.session";
  const { budget, category, minimumExcess, materialThreshold } = runtimeMaterialityPolicy(metric);
  return { metric, category, budget, minimumExcess, materialThreshold, relativeExcessRatio: 0.15, ...overrides };
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
