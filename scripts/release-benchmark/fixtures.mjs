import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const FIXED_GIT_DATE = "2026-08-01T00:00:00Z";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

export const RELEASE_FIXTURE_PROFILES = Object.freeze({
  small: Object.freeze({ sourceFiles: 4, wikiEntities: 4, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 4 }),
  medium: Object.freeze({ sourceFiles: 16, wikiEntities: 16, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 16 }),
  large: Object.freeze({ sourceFiles: 48, wikiEntities: 48, workstreams: 1, inboxDrafts: 1, inboxProposals: 1, members: 2, relayDrafts: 1, relays: 1, activityEvents: 48 }),
});

export function createReleaseFixture({
  destination,
  profileName,
  cliPath,
  environment,
  fixtureTools,
}) {
  const profile = RELEASE_FIXTURE_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown release benchmark profile: ${profileName}`);
  if (existsSync(destination)) throw new Error(`Fixture destination already exists: ${destination}`);

  const root = resolve(destination);
  const scaffold = join(root, ".mex");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(scaffold, "context"), { recursive: true });
  mkdirSync(join(scaffold, "inbox"), { recursive: true });
  mkdirSync(join(scaffold, "relays"), { recursive: true });
  mkdirSync(join(scaffold, "specs"), { recursive: true });
  mkdirSync(join(scaffold, "team", "members"), { recursive: true });
  mkdirSync(join(scaffold, "workstreams"), { recursive: true });
  mkdirSync(join(scaffold, "events", "activity", "2026-08"), { recursive: true });

  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: `mex-release-benchmark-${profileName}`,
    private: true,
    type: "module",
  }, null, 2)}\n`);
  writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2022",
    },
    include: ["src/**/*.ts"],
  }, null, 2)}\n`);
  writeFileSync(join(root, ".gitignore"), [
    ".mex/graph.db*",
    ".mex/wiki.db*",
    ".mex/local/",
    "node_modules/",
    "",
  ].join("\n"));
  writeFileSync(join(scaffold, "ROUTER.md"), [
    "# Release benchmark fixture",
    "",
    "Deterministic local input for the MEX release resource benchmark.",
    "",
  ].join("\n"));
  writeFileSync(join(scaffold, "config.json"), `${JSON.stringify({
    scaffold_id: fixtureUuid(profileName),
    scaffold_name: `release-benchmark-${profileName}`,
    aiTools: [],
    wiki: {
      exclude: ["**/node_modules/**", "events/**"],
      readOnly: ["team/**", "workstreams/**", "inbox/**", "relays/**"],
    },
  }, null, 2)}\n`);
  // Measure a returning checkout: the first-run Hub tour would otherwise
  // overlay the dashboard and intercept every route interaction.
  mkdirSync(join(scaffold, "local"), { recursive: true });
  writeFileSync(join(scaffold, "local", "hub-onboarding.json"), `${JSON.stringify({ schemaVersion: 1, completed: true })}\n`);

  for (let index = 0; index < profile.sourceFiles; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const previous = String(Math.max(0, index - 1)).padStart(4, "0");
    writeFileSync(join(root, "src", `module-${suffix}.ts`), sourceModule(index, suffix, previous));
  }

  const wikiIds = Array.from({ length: profile.wikiEntities }, (_, index) => fixedId("mx_", index + 1));
  for (let index = 0; index < wikiIds.length; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const nextId = wikiIds[(index + 1) % wikiIds.length];
    const wikiPath = index < 4
      ? join(scaffold, "specs", `${wikiIds[index]}.md`)
      : join(scaffold, "context", `benchmark-${suffix}.md`);
    writeFileSync(
      wikiPath,
      wikiDocument({
        id: wikiIds[index],
        nextId,
        rootId: wikiIds[0],
        constraintId: wikiIds[2],
        index,
        mutable: index === 0,
      }),
    );
  }

  const draftId = "inbox_00000000000000000000000000000001";
  const proposalId = fixedId("proposal_", 40_000);
  const workstreamId = fixedId("ws_", 20_000);
  const publisherMemberId = fixedId("member_", 30_000);
  const recipientMemberId = fixedId("member_", 30_001);
  const relayDraftId = "relay_release_benchmark_local_draft";
  const relayId = fixedId("relay_", 50_000);
  const relayEventId = fixedId("event_", 10_000);
  const ownedFixtureTools = fixtureTools === undefined
    ? prepareReleaseFixtureTools({ cliPath, environment })
    : null;
  const fixtureTool = (fixtureTools ?? ownedFixtureTools)?.inboxFixtureTool;
  if (typeof fixtureTool !== "string" || !existsSync(fixtureTool)) {
    ownedFixtureTools?.cleanup();
    throw new Error("The prepared release Inbox fixture tool is unavailable.");
  }
  try {
    seedInboxFixture({
      fixtureTool,
      mode: "canonical",
      root,
      scaffoldId: fixtureUuid(profileName),
      draftId,
      proposalId,
      specId: wikiIds[0],
      specPath: `.mex/specs/${wikiIds[0]}.md`,
      publisherMemberId,
      recipientMemberId,
      relayDraftId,
      relayId,
      relayEventId,
      environment,
    });

    writeFileSync(
      join(scaffold, "workstreams", `${workstreamId}.md`),
      workstreamDocument(workstreamId),
    );

    for (let index = 1; index < profile.activityEvents; index += 1) {
      const id = fixedId("event_", 10_000 + index);
      const timestamp = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString();
      writeFileSync(
        join(scaffold, "events", "activity", "2026-08", `${id}.md`),
        activityDocument({ id, index, timestamp }),
      );
    }

    initializeReleaseFixtureGit(root, environment);

    run(process.execPath, [cliPath, "graph", "rebuild", "--root", root, "--json"], root, environment, 180_000);
    run(process.execPath, [cliPath, "wiki", "rebuild-index", "--json"], root, environment, 180_000);
    seedInboxFixture({
      fixtureTool,
      mode: "local",
      root,
      scaffoldId: fixtureUuid(profileName),
      draftId,
      proposalId,
      specId: wikiIds[0],
      specPath: `.mex/specs/${wikiIds[0]}.md`,
      publisherMemberId,
      recipientMemberId,
      relayDraftId,
      relayId,
      relayEventId,
      environment,
    });

    const input = fixtureInputSizes(root);
    return {
      profileName,
      root,
      profile,
      firstWikiEntityId: wikiIds[0],
      firstSpecId: wikiIds[0],
      firstWorkstreamId: workstreamId,
      firstInboxDraftId: draftId,
      firstInboxProposalId: proposalId,
      inboxDraftTitle: "Release benchmark local draft Requirement",
      inboxProposalTitle: "Release benchmark pending Spec update",
      firstPublisherMemberId: publisherMemberId,
      firstRecipientMemberId: recipientMemberId,
      firstRelayDraftId: relayDraftId,
      firstRelayId: relayId,
      relayDraftSummary: "Release benchmark local Relay draft",
      relaySummary: "Release benchmark published Relay handoff",
      mutableWikiPath: `.mex/specs/${wikiIds[0]}.md`,
      input,
    };
  } finally {
    ownedFixtureTools?.cleanup();
  }
}

export function prepareReleaseFixtureTools({ cliPath, environment }) {
  const repositoryRoot = resolve(dirname(cliPath), "..");
  const tsupCli = join(repositoryRoot, "node_modules", "tsup", "dist", "cli-default.js");
  const source = join(repositoryRoot, "scripts", "release-benchmark", "seed-inbox-fixture.ts");
  const outputParent = join(
    repositoryRoot,
    "test-results",
    "release-benchmark",
    "fixture-tools",
  );
  mkdirSync(outputParent, { recursive: true });
  const output = mkdtempSync(join(outputParent, `fixture-tool-${process.pid}-`));
  try {
    run(process.execPath, [
      tsupCli,
      source,
      "--no-config",
      "--format", "esm",
      "--platform", "node",
      "--target", "node22",
      "--out-dir", output,
      "--clean",
    ], repositoryRoot, environment, 180_000);
    const built = join(output, "seed-inbox-fixture.js");
    if (!existsSync(built)) throw new Error("The release Inbox fixture tool did not build.");
    let cleaned = false;
    return Object.freeze({
      inboxFixtureTool: built,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        rmSync(output, { recursive: true, force: true });
      },
    });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function seedInboxFixture({
  fixtureTool,
  mode,
  root,
  scaffoldId,
  draftId,
  proposalId,
  specId,
  specPath,
  publisherMemberId,
  recipientMemberId,
  relayDraftId,
  relayId,
  relayEventId,
  environment,
}) {
  run(process.execPath, [
    fixtureTool,
    mode,
    root,
    scaffoldId,
    draftId,
    proposalId,
    specId,
    specPath,
    publisherMemberId,
    recipientMemberId,
    relayDraftId,
    relayId,
    relayEventId,
  ], root, environment, 30_000);
}

export function initializeReleaseFixtureGit(root, environment) {
  run("git", ["init", "--quiet", "--initial-branch=benchmark", "--object-format=sha1"], root, environment);
  run("git", ["config", "user.name", "MEX Release Benchmark"], root, environment);
  run("git", ["config", "user.email", "release-benchmark@example.invalid"], root, environment);
  run("git", ["add", "--", ".gitignore", "package.json", "tsconfig.json", ".mex", "src"], root, environment);
  run("git", ["commit", "--quiet", "--no-gpg-sign", "--message", "release benchmark fixture"], root, {
    ...environment,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_AUTHOR_EMAIL: "release-benchmark@example.invalid",
    GIT_AUTHOR_NAME: "MEX Release Benchmark",
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_EMAIL: "release-benchmark@example.invalid",
    GIT_COMMITTER_NAME: "MEX Release Benchmark",
  });
  return run("git", ["rev-parse", "HEAD"], root, environment).trim();
}

export function copyReleaseFixture(source, destination) {
  if (existsSync(destination)) throw new Error(`Fixture copy destination already exists: ${destination}`);
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  return resolve(destination);
}

export function toggleWikiRefreshMarker(root, relativePath) {
  const path = join(root, relativePath);
  const before = readFileSync(path, "utf8");
  const from = before.includes("benchmark-state:A") ? "benchmark-state:A" : "benchmark-state:B";
  const to = from.endsWith("A") ? "benchmark-state:B" : "benchmark-state:A";
  const after = before.replace(from, to);
  if (after === before || Buffer.byteLength(after) !== Buffer.byteLength(before)) {
    throw new Error("The Wiki refresh marker could not be toggled byte-for-byte.");
  }
  writeFileSync(path, after, "utf8");
}

export function toggleSourceRefreshMarker(root, relativePath = "src/module-0000.ts") {
  toggleMarker(join(root, relativePath), "source");
}

export function fixtureInputSizes(root) {
  const graphPaths = graphInputFiles(root);
  const wikiPaths = filesUnder(join(root, ".mex"))
    .filter((path) => /\.mdx?$/iu.test(path))
    .filter((path) => !toPosix(relative(join(root, ".mex"), path)).startsWith("events/"));
  return {
    graphBytes: totalBytes(graphPaths),
    graphFiles: graphPaths.length,
    wikiBytes: totalBytes(wikiPaths),
    wikiFiles: wikiPaths.length,
  };
}

function graphInputFiles(root) {
  const ignoredDirectories = new Set([
    ".git",
    ".mex",
    ".next",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
  ]);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !ignoredDirectories.has(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (/\.(?:[cm]?[jt]sx?|py|rs)$/u.test(entry.name)
        || entry.name === "package.json"
        || /^(?:ts|js)config[^/]*\.json$/u.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function sqliteFamilySize(databasePath) {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .filter(existsSync)
    .reduce((total, path) => total + statSync(path).size, 0);
}

const SQLITE_READER_COORDINATION_PATHS = new Set([
  ".mex/graph.db-shm",
  ".mex/wiki.db-shm",
  ".mex/local/team.db-shm",
]);

/**
 * Exact ordinary-read proof captured after Hub startup (the explicit local
 * write boundary) and before any maintenance job. SQLite shared-memory files
 * carry reader coordination bits, so bind the durable database and WAL bytes
 * while inventorying the complete family separately.
 */
export function snapshotReleaseReadState(root, environment) {
  const mexRoot = join(root, ".mex");
  const files = filesUnder(mexRoot)
    .map((path) => ({ path, relativePath: toPosix(relative(root, path)) }))
    .filter(({ relativePath }) => !SQLITE_READER_COORDINATION_PATHS.has(relativePath))
    .map(({ path, relativePath }) => {
      const stats = statSync(path);
      return {
        path: relativePath,
        bytes: stats.size,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      };
    });
  const sqliteFamilies = filesUnder(mexRoot)
    .map((path) => toPosix(relative(root, path)))
    .filter((path) => /(?:graph|wiki|team)\.db(?:-wal|-shm)?$/u.test(path))
    .sort();
  return {
    gitHead: run("git", ["rev-parse", "--verify", "HEAD"], root, environment).trim(),
    gitBranch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root, environment).trim(),
    gitStatus: run(
      "git",
      ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      root,
      environment,
    ),
    files,
    sqliteFamilies,
  };
}

function sourceModule(index, suffix, previous) {
  const dependency = index === 0
    ? ""
    : `import { releaseBenchmarkNeedle${previous} } from \"./module-${previous}.js\";\n\n`;
  const upstream = index === 0 ? "input + 17" : `releaseBenchmarkNeedle${previous}(input)`;
  return `${dependency}`
    + (index === 0 ? "// benchmark-source-state:A\n" : "")
    + `export interface BenchmarkPayload${suffix} {\n`
    + "  readonly id: number;\n"
    + "  readonly label: string;\n"
    + "  readonly values: readonly number[];\n"
    + "}\n\n"
    + `export function releaseBenchmarkNeedle${suffix}(input: number): number {\n`
    + `  const upstream = ${upstream};\n`
    + `  const payload: BenchmarkPayload${suffix} = { id: ${index}, label: \"release-benchmark-${suffix}\", values: [upstream, upstream + 1] };\n`
    + "  return payload.values.reduce((total, value) => total + value, payload.id);\n"
    + "}\n\n"
    + `export const benchmarkDescriptor${suffix} = Object.freeze({ key: \"release-benchmark-needle\", run: releaseBenchmarkNeedle${suffix} });\n`;
}

function toggleMarker(path, label) {
  const before = readFileSync(path, "utf8");
  const stateA = `benchmark-${label}-state:A`;
  const stateB = `benchmark-${label}-state:B`;
  const from = before.includes(stateA) ? stateA : stateB;
  const to = from.endsWith("A") ? stateB : stateA;
  const after = before.replace(from, to);
  if (after === before || Buffer.byteLength(after) !== Buffer.byteLength(before)) {
    throw new Error(`The ${label} refresh marker could not be toggled byte-for-byte.`);
  }
  writeFileSync(path, after, "utf8");
}

function wikiDocument({ id, nextId, rootId, constraintId, index, mutable }) {
  const suffix = String(index).padStart(4, "0");
  const type = index === 0
    ? "spec"
    : index === 1
      ? "requirement"
      : index === 2
        ? "constraint"
        : index === 3
          ? "acceptance_criterion"
          : index % 2 === 0 ? "decision" : "pattern";
  const relations = index === 0
    ? ["  - type: constrained_by", `    target: ${constraintId}`]
    : index === 1
      ? ["  - type: derived_from", `    target: ${rootId}`]
      : index === 3
        ? ["  - type: verified_by", `    target: ${rootId}`]
        : ["  - type: related_to", `    target: ${nextId}`];
  return [
    "<!-- mex:entity",
    `id: ${id}`,
    `type: ${type}`,
    "status: promoted",
    "revision: 1",
    `summary: Release benchmark knowledge needle ${suffix}.`,
    "relations:",
    ...relations,
    "sources:",
    "  - type: manual",
    "    note: Deterministic release benchmark evidence.",
    "-->",
    `## Release benchmark knowledge ${suffix}`,
    "",
    `This fixed Knowledge record contains the release benchmark search needle ${suffix}.`,
    ...(mutable ? ["", "<!-- benchmark-state:A -->"] : []),
    "",
  ].join("\n");
}

function workstreamDocument(id) {
  const actor = {
    email: "release-benchmark@example.invalid",
    kind: "git",
    name: "MEX Release Benchmark",
  };
  const title = "Release benchmark Workstream";
  const summary = "One canonical populated Workstream for release route measurement.";
  const timestamp = "2026-08-01T00:00:00.000Z";
  const entries = [
    ["schema_version", 1],
    ["id", id],
    ["mex", {
      id,
      revision: 1,
      status: "in_flight",
      summary,
      title,
      type: "workstream",
    }],
    ["state", "active"],
    ["title", title],
    ["goal", "Exercise the real Checkpoint D route and bounded projection."],
    ["summary", summary],
    ["owners", [actor]],
    ["contributors", []],
    ["paths", ["src"]],
    ["code", [{ kind: "file", path: "src/module-0000.ts" }]],
    ["topics", []],
    ["components", []],
    ["related", []],
    ["blockers", []],
    ["current_state", "Running pinned release checks."],
    ["next_milestone", "Pass the release gate."],
    ["created_by", actor],
    ["created_at", timestamp],
    ["updated_by", actor],
    ["updated_at", timestamp],
  ];
  return `---\n${entries.map(([key, value]) => `${key}: ${canonicalJson(value)}`).join("\n")}\n---\n`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function activityDocument({ id, index, timestamp }) {
  const suffix = String(index).padStart(4, "0");
  return [
    "---",
    "schema_version: 2",
    `id: ${JSON.stringify(id)}`,
    `timestamp: ${JSON.stringify(timestamp)}`,
    "actor: {\"email\":\"release-benchmark@example.invalid\",\"kind\":\"git\",\"name\":\"MEX Release Benchmark\"}",
    `action: ${JSON.stringify(`benchmark.read.${suffix}`)}`,
    "origin: {\"kind\":\"custom\"}",
    `label: ${JSON.stringify(`Release benchmark event ${suffix}`)}`,
    `subjects: [{\"kind\":\"file\",\"path\":\"src/module-${suffix}.ts\"}]`,
    "repo_state: {\"branch\":\"benchmark\",\"dirty\":false,\"head\":null,\"observedAt\":\"2026-08-01T00:00:00.000Z\"}",
    "metadata: {}",
    "---",
    "",
  ].join("\n");
}

function fixedId(prefix, value) {
  let remaining = (1n << 120n) + BigInt(value);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return `${prefix}${encoded}`;
}

function fixtureUuid(profileName) {
  const suffix = String(Object.keys(RELEASE_FIXTURE_PROFILES).indexOf(profileName) + 1);
  return `22222222-2222-4222-8222-22222222222${suffix}`;
}

function filesUnder(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function totalBytes(paths) {
  return paths.reduce((total, path) => total + statSync(path).size, 0);
}

function run(command, args, cwd, environment, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    killSignal: "SIGKILL",
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    shell: false,
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed with status ${String(result.status)}: ${bounded(result.stderr || result.stdout)}`);
  }
  return result.stdout;
}

function bounded(value) {
  const text = String(value ?? "").trim();
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}

function toPosix(path) {
  return path.replaceAll("\\", "/");
}
