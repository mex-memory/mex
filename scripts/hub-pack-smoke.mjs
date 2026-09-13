import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OFFICIAL_SKILLS = ["mex-inbox", "mex-relay"];
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("The packed Hub smoke must run through npm so its CLI entry is known.");
}
const work = mkdtempSync(join(tmpdir(), "mex-hub-pack-smoke-"));
const npmCache = join(work, "npm-cache");
mkdirSync(npmCache, { recursive: true });
let child;

try {
  const packOutput = runNpm([
    "pack",
    "--json",
    "--cache",
    npmCache,
    "--pack-destination",
    work,
  ], root);
  const packResult = parsePackResult(packOutput);
  const tarball = join(work, basename(packResult.filename));
  verifyPackedSkillTrees(packResult);
  await verifyFreshCodeRepoSetup(tarball, work, npmCache, packResult.version);
  const project = join(work, "project");
  mkdirSync(join(project, ".mex"), { recursive: true });
  writeFileSync(join(project, "package.json"), "{\n  \"private\": true\n}\n");
  writeFileSync(join(project, ".gitignore"), "node_modules/\n.mex/graph.db*\n.mex/local/\n");
  writeFileSync(join(project, "CLAUDE.md"), [
    "# Consumer Claude instructions",
    "",
    "Keep this line byte-for-byte.",
    "",
  ].join("\n"));
  writeFileSync(join(project, "AGENTS.md"), [
    "# Consumer Codex instructions",
    "",
    "Keep this line byte-for-byte.",
    "",
  ].join("\n"));
  mkdirSync(join(project, ".claude", "skills", "consumer-owned"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "consumer-owned", "SKILL.md"), [
    "---",
    "name: consumer-owned",
    "description: A consumer-owned Claude skill that MEX must never inspect or rewrite.",
    "---",
    "",
  ].join("\n"));
  mkdirSync(join(project, ".agents", "skills", "consumer-owned"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "consumer-owned", "SKILL.md"), [
    "---",
    "name: consumer-owned",
    "description: A consumer-owned Codex skill that MEX must never inspect or rewrite.",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(project, ".mex", "ROUTER.md"), "# Project Router\n");
  writeFileSync(
    join(project, ".mex", "config.json"),
    JSON.stringify({
      scaffold_id: "11111111-1111-4111-8111-111111111111",
      scaffold_name: "packed-hub-smoke",
      wiki: {
        exclude: ["excluded/**"],
        readOnly: ["context/read-only/**"],
      },
    }, null, 2) + "\n",
  );
  writeActivityFixture(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "packed.ts"), [
    "export function packedService(input: number): number {",
    "  return input * 2;",
    "}",
    "",
    "export function packedCaller(): number {",
    "  return packedService(21);",
    "}",
    "",
  ].join("\n"));
  run("git", ["init", "--quiet"], project);
  run("git", ["config", "user.name", "Packed Ada"], project);
  run("git", ["config", "user.email", "packed@example.test"], project);
  run("git", [
    "add",
    ".gitignore",
    "package.json",
    "CLAUDE.md",
    "AGENTS.md",
    ".claude",
    ".agents",
    ".mex",
    "src",
  ], project);
  run("git", ["commit", "--quiet", "-m", "test fixture"], project);
  const beforeInstallAgentSurfaces = snapshotAgentSurfaces(project);
  runNpm([
    "install",
    tarball,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--cache",
    npmCache,
  ], project);
  const afterInstallAgentSurfaces = snapshotAgentSurfaces(project);
  if (
    JSON.stringify(afterInstallAgentSurfaces) !== JSON.stringify(beforeInstallAgentSurfaces)
    || [".claude", ".agents"].some((clientRoot) => OFFICIAL_SKILLS.some((skill) => (
      existsSync(join(project, clientRoot, "skills", skill))
    )))
    || ["CLAUDE.md", "AGENTS.md"].some((name) => (
      readFileSync(join(project, name), "utf8").includes("<!-- mex-agent:skills:start -->")
    ))
  ) {
    throw new Error("Plain npm install mutated project skills or root agent instructions.");
  }

  const installed = join(project, "node_modules", "mex-agent");
  const manifest = join(installed, "dist", "hub", ".vite", "manifest.json");
  if (!existsSync(manifest)) throw new Error("The packed package omitted dist/hub assets.");
  const installedPackageVersion = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  ).version;
  if (installedPackageVersion !== packResult.version) {
    throw new Error("The installed package version did not match the npm pack result.");
  }
  verifyInstalledPackageSkillTrees(installed);
  const declaration = readFileSync(join(installed, "dist", "index.d.ts"), "utf8");
  if (
    /Hub(?:Job|Api|Session|Capabilities|Activity|Wiki)|Activity(?:Request|Response|Item|Diagnostic)|CodeWorkspace|CodeKnowledge(?:Request|Response)|GraphHealthDetails|WikiHealthDetails|WikiEntity(?:List|Detail)(?:Request|Response)|Wiki(?:Relations|Backlinks)(?:Request|Response)|WikiSearchResult|RepositoryGraphPort|RepositoryWiki|createRepositoryWikiPort|runHubCommand|TeamRelay|RelayHandoff/.test(
      declaration,
    )
  ) {
    throw new Error("Private Hub or Relay declarations leaked through the package root.");
  }

  const cli = join(installed, "dist", "cli.js");
  const beforeLoggingRead = snapshotProtectedProjectState(project);
  const localBeforeLoggingRead = existsSync(join(project, ".mex", "local"));
  const defaultLogging = JSON.parse(run(process.execPath, [cli, "logging", "--json"], project));
  if (
    defaultLogging?.schemaVersion !== 1
    || defaultLogging?.command !== "logging"
    || defaultLogging?.ok !== true
    || defaultLogging?.scope !== "checkout"
    || defaultLogging?.problem !== null
    || JSON.stringify(defaultLogging?.data) !== JSON.stringify({ mode: "significant", revision: null, source: "default" })
    || existsSync(join(project, ".mex", "local", "agent-preferences.json"))
    || existsSync(join(project, ".mex", "local")) !== localBeforeLoggingRead
    || JSON.stringify(snapshotProtectedProjectState(project)) !== JSON.stringify(beforeLoggingRead)
  ) {
    throw new Error("The packed logging getter did not return the quiet default without initializing state.");
  }
  const cliHelp = run(process.execPath, [cli, "--help"], project);
  const skillSyncHelp = run(process.execPath, [cli, "skills", "sync", "--help"], project);
  if (
    !/^\s*skills\s+/mu.test(cliHelp)
    || !skillSyncHelp.includes("--dry-run")
    || !skillSyncHelp.includes("--json")
    || !skillSyncHelp.includes("--tool <tool>")
  ) {
    throw new Error("The packed CLI help omitted the official skill sync surface.");
  }

  const beforeSetupHead = run("git", ["rev-parse", "HEAD"], project).trim();
  const setupOutput = await runInteractiveAgentSetup(cli, project, work);
  verifyPackedSetupOutput(setupOutput);
  verifySetupConfig(project);
  verifySetupIgnoreProtection(project);
  verifyInstalledAgentAssets(project, installed, installedPackageVersion);
  if (
    run("git", ["rev-parse", "HEAD"], project).trim() !== beforeSetupHead
    || run("git", ["diff", "--cached", "--name-only"], project).trim().length !== 0
  ) {
    throw new Error("The packed setup staged or committed project changes automatically.");
  }

  // Team workflows intentionally require the current config bytes to be
  // tracked. The product setup must not commit them, so the smoke fixture does
  // that explicitly before exercising its pre-existing Relay/Hub assertions.
  run("git", ["add", ".mex/config.json"], project);
  run("git", ["commit", "--quiet", "-m", "record packed setup selection"], project);

  const afterSetup = snapshotAgentSurfaces(project);
  const firstSkillSync = parseSkillSyncReport(run(
    process.execPath,
    [cli, "skills", "sync", "--json"],
    project,
  ), installedPackageVersion, false);
  if (
    firstSkillSync.clients.length !== 2
    || !firstSkillSync.clients.includes("claude")
    || !firstSkillSync.clients.includes("codex")
    || firstSkillSync.applied !== true
    || firstSkillSync.changed !== false
    || firstSkillSync.conflicted !== false
    || firstSkillSync.actions.length !== 6
    || firstSkillSync.actions.some((action) => action.action !== "noop")
    || JSON.stringify(snapshotAgentSurfaces(project)) !== JSON.stringify(afterSetup)
  ) {
    throw new Error("The first packed skill sync was not an idempotent update of setup-installed assets.");
  }

  const afterFirstSkillSync = snapshotAgentSurfaces(project);
  const secondSkillSync = parseSkillSyncReport(run(
    process.execPath,
    [cli, "skills", "sync", "--json"],
    project,
  ), installedPackageVersion, false);
  const afterSecondSkillSync = snapshotAgentSurfaces(project);
  if (
    secondSkillSync.applied !== true
    || secondSkillSync.changed !== false
    || secondSkillSync.conflicted !== false
    || secondSkillSync.actions.length !== 6
    || secondSkillSync.actions.some((action) => action.action !== "noop")
    || JSON.stringify(secondSkillSync.warnings) !== JSON.stringify(firstSkillSync.warnings)
    || JSON.stringify(afterSecondSkillSync) !== JSON.stringify(afterFirstSkillSync)
  ) {
    throw new Error("A repeated packed skill sync was not byte- and timestamp-idempotent.");
  }

  const dryRunSkillSync = parseSkillSyncReport(run(
    process.execPath,
    [cli, "skills", "sync", "--dry-run", "--json"],
    project,
  ), installedPackageVersion, true);
  const afterDryRunSkillSync = snapshotAgentSurfaces(project);
  if (
    dryRunSkillSync.applied !== false
    || dryRunSkillSync.changed !== false
    || dryRunSkillSync.conflicted !== false
    || dryRunSkillSync.actions.length !== 6
    || dryRunSkillSync.actions.some((action) => action.action !== "noop")
    || JSON.stringify(dryRunSkillSync.warnings) !== JSON.stringify(firstSkillSync.warnings)
    || JSON.stringify(afterDryRunSkillSync) !== JSON.stringify(afterFirstSkillSync)
  ) {
    throw new Error("The packed dry-run skill sync wrote to the project or reported a spurious change.");
  }

  const relayContractOutput = run(
    process.execPath,
    [cli, "relay", "contract", "--json"],
    work,
  );
  if (Buffer.byteLength(relayContractOutput, "utf8") > 65_536) {
    throw new Error("The packed Relay resolver exceeded its 64 KiB output ceiling.");
  }
  const relayContract = JSON.parse(relayContractOutput);
  if (
    relayContract?.command !== "relay.contract"
    || relayContract?.ok !== true
    || relayContract?.data?.requestFile?.schemaRef
      !== "https://mex.dev/contracts/team-relay-request-v1.json"
    || relayContract?.data?.applyFile?.schemaRef
      !== "https://mex.dev/contracts/team-relay-preview-envelope-v1.json"
  ) {
    throw new Error("The packed install omitted the static Relay command contract.");
  }
  const relayExamples = relayContract?.data?.requestFile?.examples;
  const sparseRelayDraft = relayExamples?.[0]?.request?.action?.draft;
  if (
    !Array.isArray(relayExamples)
    || relayExamples.length === 0
    || relayExamples[0]?.command !== "relay.draft.save"
    || JSON.stringify(Object.keys(sparseRelayDraft ?? {}).sort())
      !== JSON.stringify(["audience", "recipients", "summary"])
    || sparseRelayDraft?.audience !== "team"
    || JSON.stringify(sparseRelayDraft?.recipients) !== "[]"
    || !relayExamples.some((example) => (
      Array.isArray(example?.request?.action?.draft?.evidence)
      && example.request.action.draft.evidence.some((item) => item?.kind === "commit")
      && example.request.action.draft.evidence.some((item) => item?.kind === "external")
    ))
  ) {
    throw new Error("The packed Relay resolver did not lead with the sparse standalone v1 request contract.");
  }
  const sparseRelayRequest = join(work, "relay-sparse-request.json");
  writeFileSync(sparseRelayRequest, JSON.stringify(relayExamples[0].request));
  const sparseRelayPreview = JSON.parse(run(
    process.execPath,
    [cli, "relay", "draft", "save", sparseRelayRequest, "--json"],
    project,
  ));
  const normalizedSparseDraft = sparseRelayPreview?.data?.request?.action?.draft;
  if (
    sparseRelayPreview?.ok !== true
    || normalizedSparseDraft?.audience !== "team"
    || JSON.stringify(normalizedSparseDraft?.recipients) !== "[]"
    || Object.hasOwn(normalizedSparseDraft ?? {}, "workstream")
    || ![
      "completed",
      "inProgress",
      "decisions",
      "blockers",
      "unresolvedQuestions",
      "changedFiles",
      "code",
      "evidence",
      "nextActions",
    ].every((key) => Array.isArray(normalizedSparseDraft?.[key]))
  ) {
    throw new Error("The packed Relay CLI did not normalize the sparse standalone draft.");
  }
  const relaySaveHelp = run(process.execPath, [cli, "relay", "draft", "save", "--help"], project);
  if (!relaySaveHelp.includes("--from <draft-file>") || !relaySaveHelp.includes("--operation-id <id>")) {
    throw new Error("The packed Relay help omitted the sparse local quick-save surface.");
  }
  const packedCapabilitiesOutput = run(
    process.execPath,
    [cli, "capabilities", "--json"],
    project,
  );
  if (Buffer.byteLength(packedCapabilitiesOutput, "utf8") > 32_768) {
    throw new Error("The packed capability manifest exceeded its 32 KiB output ceiling.");
  }
  const packedCapabilities = JSON.parse(packedCapabilitiesOutput);
  const packedRelayCommands = Object.values(packedCapabilities?.data?.commands ?? {})
    .flat()
    .filter((entry) => typeof entry?.id === "string" && entry.id.startsWith("relay."));
  if (
    packedRelayCommands.length !== 1
    || packedRelayCommands[0]?.id !== "relay.contract"
    || packedRelayCommands[0]?.contractResolver !== "relay.contract"
    || packedCapabilitiesOutput.includes("team-relay-request-v1.json")
    || packedCapabilitiesOutput.includes("team-relay-preview-envelope-v1.json")
  ) {
    throw new Error("The packed capability manifest expanded the compact Relay resolver descriptor.");
  }
  run(process.execPath, [cli, "graph", "rebuild", "--root", project, "--json"], project);
  const graphScope = run(process.execPath, [
    cli,
    "graph",
    "scope",
    "packedService",
    "--detail",
    "minimal",
    "--fingerprint",
    "--max-nodes",
    "10",
    "--max-files",
    "1",
    "--max-output-tokens",
    "2000",
  ], project).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const groundedFact = graphScope.find((record) => (
    record.type === "fact" && record.name === "packedService"
  ));
  if (
    typeof groundedFact?.id !== "string"
    || typeof groundedFact.fingerprint !== "string"
    || typeof groundedFact.bodyHash !== "string"
  ) {
    throw new Error("The packed graph did not expose exact grounding facts for the Wiki fixture.");
  }
  writeWikiFixture(project, {
    nodeId: groundedFact.id,
    fingerprint: groundedFact.fingerprint,
    bodyHash: groundedFact.bodyHash,
  });
  run("git", ["add", ".mex/context", ".mex/excluded", ".mex/topics"], project);
  run("git", ["commit", "--quiet", "-m", "add packed wiki fixture"], project);
  run(process.execPath, [cli, "graph", "rebuild", "--root", project, "--json"], project);
  run(process.execPath, [cli, "wiki", "rebuild-index", "--json"], project);
  child = spawn(process.execPath, [cli, "--no-open"], {
    cwd: project,
    env: { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bootstrapUrl = await readBootstrapUrl(child);
  const url = new URL(bootstrapUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  if (!token) throw new Error("The packaged Hub did not emit a bootstrap token.");
  const beforeReads = snapshotProtectedProjectState(project);

  const html = await fetch(`${url.origin}/`, { redirect: "error" });
  if (!html.ok || !(await html.text()).includes("<div id=\"root\"></div>")) {
    throw new Error("The packaged Hub did not serve its application shell.");
  }
  const bootstrap = await fetch(`${url.origin}/api/v1/session/bootstrap`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      origin: url.origin,
    },
    body: JSON.stringify({ token }),
  });
  if (bootstrap.status !== 201) {
    throw new Error(`Hub bootstrap failed with HTTP ${bootstrap.status}.`);
  }
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Hub bootstrap did not set a session cookie.");
  const session = await fetch(`${url.origin}/api/v1/session`, {
    headers: { cookie },
    redirect: "error",
  });
  const sessionBody = await session.json();
  if (!session.ok || typeof sessionBody.csrfToken !== "string") {
    throw new Error("The packaged Hub session API did not load.");
  }
  const logging = await fetch(`${url.origin}/api/v1/settings/logging`, {
    headers: { cookie }, redirect: "error",
  });
  if (!logging.ok || JSON.stringify(await logging.json()) !== JSON.stringify(defaultLogging.data)) {
    throw new Error("The packaged Hub logging read did not share the CLI's checkout default.");
  }
  const capabilities = await fetch(`${url.origin}/api/v1/capabilities`, {
    headers: { cookie },
    redirect: "error",
  });
  const capabilitiesBody = await capabilities.json();
  if (
    !capabilities.ok
    || capabilitiesBody.apiVersion !== "v1"
    || capabilitiesBody.graph?.read?.availability !== "available"
    || capabilitiesBody.graph?.refresh?.availability !== "available"
    || capabilitiesBody.graph?.rebuild?.availability !== "available"
    || capabilitiesBody.wiki?.read?.availability !== "available"
    || capabilitiesBody.wiki?.refresh?.availability !== "available"
    || capabilitiesBody.wiki?.rebuild?.availability !== "available"
    || capabilitiesBody.relays?.read?.availability !== "available"
    || capabilitiesBody.relays?.draftMutation?.availability !== "available"
    || capabilitiesBody.relays?.publish?.availability !== "available"
    || capabilitiesBody.relays?.lifecycleMutation?.availability !== "available"
  ) {
    throw new Error("The packaged Hub capabilities API did not load.");
  }
  const relayDrafts = await fetch(`${url.origin}/api/v1/relays/drafts?limit=25`, {
    headers: { cookie },
    redirect: "error",
  });
  const relayDraftsBody = await relayDrafts.json();
  const relays = await fetch(`${url.origin}/api/v1/relays?perspective=all&limit=25`, {
    headers: { cookie },
    redirect: "error",
  });
  const relaysBody = await relays.json();
  if (
    !relayDrafts.ok
    || relayDraftsBody.items?.length !== 0
    || relayDraftsBody.nextCursor !== null
    || !relays.ok
    || relaysBody.items?.length !== 0
    || relaysBody.nextCursor !== null
  ) {
    throw new Error("The packaged Hub did not expose empty repository-independent Relay reads.");
  }
  const home = await fetch(`${url.origin}/api/v1/home`, {
    headers: { cookie },
    redirect: "error",
  });
  const homeBody = await home.json();
  const overview = await fetch(`${url.origin}/api/v1/overview`, {
    headers: { cookie },
    redirect: "error",
  });
  const overviewBody = await overview.json();
  const activity = await fetch(`${url.origin}/api/v1/activity`, {
    headers: { cookie },
    redirect: "error",
  });
  const activityBody = await activity.json();
  const overviewCanonicalActivityCount = overviewBody.activity?.availability === "available"
    && Array.isArray(overviewBody.activity.items)
    ? overviewBody.activity.items.filter((item) => item?.source === "activity").length
    : null;
  if (
    !home.ok
    || Object.hasOwn(homeBody, "sections")
    || Object.hasOwn(homeBody, "activity")
    || !overview.ok
    || overviewCanonicalActivityCount !== 1
  ) {
    const diagnosticCodes = Array.isArray(activityBody?.diagnostics)
      ? activityBody.diagnostics.slice(0, 10).map((item) => ({
          code: typeof item?.code === "string" ? item.code : "UNKNOWN",
          severity: typeof item?.severity === "string" ? item.severity : "unknown",
        }))
      : null;
    const detail = JSON.stringify({
      homeStatus: home.status,
      homeProblemCode: typeof homeBody?.code === "string" ? homeBody.code : null,
      homeHasActivity: Object.hasOwn(homeBody, "sections") || Object.hasOwn(homeBody, "activity"),
      overviewStatus: overview.status,
      overviewProblemCode: typeof overviewBody?.code === "string" ? overviewBody.code : null,
      overviewCanonicalActivityCount,
      activityStatus: activity.status,
      canonicalActivityCount: Array.isArray(activityBody?.items)
        ? activityBody.items.filter((item) => item?.source === "activity").length
        : null,
      fixtureHasCarriageReturn: readFileSync(
        join(
          project,
          ".mex",
          "events",
          "activity",
          "2026-08",
          "event_01K3Q080000000000000000001.md",
        ),
      ).includes(13),
      diagnosticCodes,
    });
    throw new Error(`The packaged Hub did not keep the shell lightweight and Overview Activity exact: ${detail}`);
  }
  const packedActivity = activityBody.items?.find((item) => (
    item.source === "activity" && item.action === "activity.packed"
  ));
  if (
    !activity.ok
    || activityBody.items?.length !== 2
    || !packedActivity
    || packedActivity.recordOrigin?.kind !== "unknown"
    || packedActivity.label !== null
    || !activityBody.items.some((item) => item.source === "legacy" && item.message === "Packed legacy decision")
  ) {
    throw new Error("The packaged Hub did not project v1 Activity as unknown-origin beside Project notes.");
  }
  const serializedActivity = JSON.stringify(activityBody);
  for (const secret of [
    "fixture must stay private",
    "/Users/alice/private-project",
    ".mex/traces/private.md",
    "private-agent",
    "private-status",
    "../outside.ts",
  ]) {
    if (serializedActivity.includes(secret)) {
      throw new Error(`The packaged activity API leaked a private field: ${secret}`);
    }
  }
  const search = await fetch(`${url.origin}/api/v1/search?q=packedService&limit=10`, {
    headers: { cookie },
    redirect: "error",
  });
  const searchBody = await search.json();
  const symbol = searchBody.groups?.symbols?.items?.find((item) => (
    item.kind === "code_symbol" && item.name === "packedService"
  ));
  if (
    !search.ok
    || searchBody.groups?.symbols?.status !== "available"
    || searchBody.groups?.sources?.status !== "available"
    || !symbol
  ) {
    throw new Error("The packaged Hub did not expose real grouped graph search.");
  }
  const code = await fetch(
    `${url.origin}/api/v1/code/symbols/${encodeURIComponent(symbol.id)}?view=callers`,
    { headers: { cookie }, redirect: "error" },
  );
  const codeBody = await code.json();
  if (
    !code.ok
    || codeBody.symbol?.id !== symbol.id
    || !codeBody.source?.items?.some((item) => item.content.includes("packedService"))
    || codeBody.traversal?.view !== "callers"
  ) {
    throw new Error("The packaged Hub did not expose the real symbol workspace.");
  }
  const wikiSearch = await fetch(`${url.origin}/api/v1/search?q=packed&limit=10`, {
    headers: { cookie },
    redirect: "error",
  });
  const wikiSearchBody = await wikiSearch.json();
  const wikiHit = wikiSearchBody.groups?.wiki?.items?.find((item) => (
    item.kind === "wiki" && item.title === "Preserve packed retries"
  ));
  if (!wikiSearch.ok || wikiSearchBody.groups?.wiki?.status !== "available" || !wikiHit) {
    throw new Error("The packaged Hub did not expose real Wiki search.");
  }
  const excludedSearch = await fetch(`${url.origin}/api/v1/search?q=excluded-only-sentinel&limit=10`, {
    headers: { cookie },
    redirect: "error",
  });
  const excludedSearchBody = await excludedSearch.json();
  if (
    !excludedSearch.ok
    || excludedSearchBody.groups?.wiki?.status !== "available"
    || excludedSearchBody.groups.wiki.items?.length !== 0
  ) {
    throw new Error("The packaged Hub ignored the configured Wiki exclusion during search.");
  }
  const completeKnowledgeList = await fetch(`${url.origin}/api/v1/wiki/entities?limit=50`, {
    headers: { cookie },
    redirect: "error",
  });
  const completeKnowledgeListBody = await completeKnowledgeList.json();
  if (
    !completeKnowledgeList.ok
    || completeKnowledgeListBody.items?.some((item) => item.id === "mx_01J00000000000000000000004")
  ) {
    throw new Error("The packaged Hub indexed a Wiki entity excluded by project configuration.");
  }
  const knowledgeList = await fetch(
    `${url.origin}/api/v1/wiki/entities?kind=decision&sourceType=symbol`,
    { headers: { cookie }, redirect: "error" },
  );
  const knowledgeListBody = await knowledgeList.json();
  if (
    !knowledgeList.ok
    || knowledgeListBody.items?.length !== 1
    || knowledgeListBody.items[0]?.id !== wikiHit.id
    || knowledgeListBody.items[0]?.groundingHealth !== "fresh"
  ) {
    throw new Error("The packaged Hub did not list real filtered Knowledge.");
  }
  const knowledge = await fetch(
    `${url.origin}/api/v1/wiki/entities/${encodeURIComponent(wikiHit.id)}`,
    { headers: { cookie }, redirect: "error" },
  );
  const knowledgeBody = await knowledge.json();
  if (
    !knowledge.ok
    || knowledgeBody.entity?.id !== wikiHit.id
    || !knowledgeBody.body?.content?.includes("original stable request key")
    || knowledgeBody.relationCount !== 1
    || knowledgeBody.backlinkCount !== 1
    || knowledgeBody.groundings?.items?.[0]?.requestedNode !== symbol.id
  ) {
    throw new Error("The packaged Hub did not expose a bounded real Knowledge detail.");
  }
  const relations = await fetch(
    `${url.origin}/api/v1/wiki/entities/${encodeURIComponent(wikiHit.id)}/relations?direction=both`,
    { headers: { cookie }, redirect: "error" },
  );
  const relationsBody = await relations.json();
  if (
    !relations.ok
    || !relationsBody.items?.some((item) => item.direction === "outgoing" && item.relation?.type === "implements")
    || !relationsBody.items?.some((item) => item.direction === "incoming" && item.relation?.type === "depends_on")
  ) {
    throw new Error("The packaged Hub did not expose real Knowledge relations.");
  }
  const backlinks = await fetch(
    `${url.origin}/api/v1/wiki/entities/${encodeURIComponent(wikiHit.id)}/backlinks?type=depends_on`,
    { headers: { cookie }, redirect: "error" },
  );
  const backlinksBody = await backlinks.json();
  if (!backlinks.ok || backlinksBody.items?.length !== 1 || backlinksBody.items[0]?.type !== "depends_on") {
    throw new Error("The packaged Hub did not expose real Knowledge backlinks.");
  }
  const codeKnowledge = await fetch(
    `${url.origin}/api/v1/code/symbols/${encodeURIComponent(symbol.id)}/knowledge`,
    { headers: { cookie }, redirect: "error" },
  );
  const codeKnowledgeBody = await codeKnowledge.json();
  if (
    !codeKnowledge.ok
    || codeKnowledgeBody.items?.length !== 1
    || codeKnowledgeBody.items[0]?.entity?.id !== wikiHit.id
    || codeKnowledgeBody.items[0]?.matchedNodes?.[0] !== symbol.id
  ) {
    throw new Error("The packaged Hub did not expose explicit Code-to-Knowledge links.");
  }
  const serializedKnowledge = JSON.stringify({
    wikiSearchBody,
    knowledgeListBody,
    knowledgeBody,
    relationsBody,
    backlinksBody,
    codeKnowledgeBody,
    excludedSearchBody,
    completeKnowledgeListBody,
  });
  for (const secret of [
    project,
    "packed-private-session",
    "packed-topic-private-metadata",
    "packed-source-private-metadata",
    "packed-entity-private-metadata",
    "excluded-only-private-body",
  ]) {
    if (serializedKnowledge.includes(secret)) {
      throw new Error(`The packaged Knowledge API leaked a private field: ${secret}`);
    }
  }
  const health = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const healthBody = await health.json();
  const graphHealth = healthBody.components?.find((component) => component.id === "graph");
  const wikiHealth = healthBody.components?.find((component) => component.id === "wiki");
  if (
    !health.ok
    || graphHealth?.graph?.indexStatus !== "fresh"
    || wikiHealth?.wiki?.indexStatus !== "fresh"
    || JSON.stringify(wikiHealth.wiki.allowedJobKinds) !== JSON.stringify(["wiki_refresh", "wiki_rebuild"])
    || wikiHealth.wiki.recommendedJobKind !== null
  ) {
    throw new Error("The packaged Hub did not report fresh graph and Wiki health.");
  }
  const afterReads = snapshotProtectedProjectState(project);
  if (JSON.stringify(afterReads) !== JSON.stringify(beforeReads)) {
    throw new Error("Reading packaged Home, Activity, Search, Code, Knowledge, or Health mutated protected project state.");
  }

  const beforeMaintenance = snapshotProtectedProjectState(project, { includeRuntimeState: false });

  for (const kind of ["graph_refresh", "graph_rebuild"]) {
    if (kind === "graph_rebuild") {
      writeFileSync(join(project, ".mex", "graph.db"), "intentionally corrupt graph for rebuild coverage\n");
      const corruptHealth = await fetch(`${url.origin}/api/v1/health`, {
        headers: { cookie },
        redirect: "error",
      });
      const corruptHealthBody = await corruptHealth.json();
      const corruptGraph = corruptHealthBody.components?.find((component) => component.id === "graph");
      if (!corruptHealth.ok || corruptGraph?.graph?.indexStatus !== "corrupt") {
        throw new Error("The packaged Hub did not observe the intentionally corrupt graph before rebuild.");
      }
    }
    const started = await fetch(`${url.origin}/api/v1/jobs`, {
      method: "POST",
      headers: {
        cookie,
        origin: url.origin,
        "content-type": "application/json",
        "x-mex-csrf": sessionBody.csrfToken,
      },
      body: JSON.stringify({ kind }),
      redirect: "error",
    });
    const startedBody = await started.json();
    if (started.status !== 202 || typeof startedBody.id !== "string") {
      throw new Error(`The packaged Hub could not start ${kind}.`);
    }
    const terminal = await waitForJob(url.origin, cookie, startedBody.id);
    if (terminal.state !== "succeeded") {
      throw new Error(`The packaged Hub ${kind} job did not succeed.`);
    }
  }
  const repairedHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const repairedHealthBody = await repairedHealth.json();
  const repairedGraph = repairedHealthBody.components?.find((component) => component.id === "graph");
  if (!repairedHealth.ok || repairedGraph?.graph?.indexStatus !== "fresh") {
    throw new Error("The packaged Hub graph rebuild did not replace the corrupt graph with a fresh index.");
  }
  const afterMaintenance = snapshotProtectedProjectState(project, { includeRuntimeState: false });
  if (JSON.stringify(afterMaintenance) !== JSON.stringify(beforeMaintenance)) {
    throw new Error("Packaged graph maintenance mutated source, Git, activity, member, or Wiki state.");
  }

  const wikiSource = join(project, ".mex", "context", "packed-knowledge.md");
  writeFileSync(
    wikiSource,
    readFileSync(wikiSource, "utf8").replace(
      "The packed service retries only with the original stable request key.",
      "The packed service retries transient failures with the original stable request key.",
    ),
  );
  const staleWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const staleWikiHealthBody = await staleWikiHealth.json();
  const staleWiki = staleWikiHealthBody.components?.find((component) => component.id === "wiki");
  if (
    !staleWikiHealth.ok
    || staleWiki?.wiki?.indexStatus !== "stale"
    || staleWiki?.wiki?.recommendedJobKind !== "wiki_refresh"
  ) {
    throw new Error("The packaged Hub did not recommend explicit Wiki refresh for stale canonical Markdown.");
  }
  const beforeWikiMaintenance = snapshotProtectedProjectState(project, {
    includeRuntimeState: false,
    includeGraphIndex: true,
    includeWikiIndex: false,
  });
  const wikiRefresh = await startJob(
    url.origin,
    cookie,
    sessionBody.csrfToken,
    "wiki_refresh",
    [project],
  );
  if (wikiRefresh.state !== "succeeded") {
    throw new Error("The packaged Hub wiki_refresh job did not succeed.");
  }
  const refreshedWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const refreshedWikiBody = await refreshedWikiHealth.json();
  if (
    !refreshedWikiHealth.ok
    || refreshedWikiBody.components?.find((component) => component.id === "wiki")?.wiki?.indexStatus !== "fresh"
  ) {
    throw new Error("The packaged Hub did not report fresh Wiki health after refresh.");
  }

  writeFileSync(join(project, ".mex", "wiki.db"), "intentionally corrupt Wiki index for rebuild coverage\n");
  const corruptWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const corruptWikiBody = await corruptWikiHealth.json();
  if (
    !corruptWikiHealth.ok
    || corruptWikiBody.components?.find((component) => component.id === "wiki")?.wiki?.indexStatus !== "corrupt"
  ) {
    throw new Error("The packaged Hub did not observe the intentionally corrupt Wiki index before rebuild.");
  }
  const wikiRebuild = await startJob(
    url.origin,
    cookie,
    sessionBody.csrfToken,
    "wiki_rebuild",
    [project],
  );
  if (wikiRebuild.state !== "succeeded") {
    throw new Error("The packaged Hub wiki_rebuild job did not succeed.");
  }
  const repairedWikiHealth = await fetch(`${url.origin}/api/v1/health`, {
    headers: { cookie },
    redirect: "error",
  });
  const repairedWikiBody = await repairedWikiHealth.json();
  if (
    !repairedWikiHealth.ok
    || repairedWikiBody.components?.find((component) => component.id === "wiki")?.wiki?.indexStatus !== "fresh"
  ) {
    throw new Error("The packaged Hub Wiki rebuild did not publish a fresh replacement index.");
  }
  const afterWikiMaintenance = snapshotProtectedProjectState(project, {
    includeRuntimeState: false,
    includeGraphIndex: true,
    includeWikiIndex: false,
  });
  if (JSON.stringify(afterWikiMaintenance) !== JSON.stringify(beforeWikiMaintenance)) {
    throw new Error("Packaged Wiki maintenance mutated canonical Wiki, Graph, Activity, members, source, or Git state.");
  }

  // Preference changes are checkout-only. Exercise both surfaces with exact
  // revisions after ordinary-read/maintenance assertions, before stopping Hub.
  const beforeLoggingUpdate = snapshotProtectedProjectState(project, {
    includeRuntimeState: false, includeGraphIndex: true,
  });
  const settingsHeaders = {
    cookie, origin: url.origin, "content-type": "application/json", "x-mex-csrf": sessionBody.csrfToken,
  };
  const savedLogging = await fetch(`${url.origin}/api/v1/settings/logging`, {
    method: "POST", headers: settingsHeaders, redirect: "error",
    body: JSON.stringify({ mode: "manual", expectedRevision: null }),
  });
  const savedLoggingBody = await savedLogging.json();
  const cliLogging = JSON.parse(run(process.execPath, [cli, "logging", "--json"], project));
  if (
    savedLogging.status !== 200
    || savedLoggingBody?.mode !== "manual"
    || savedLoggingBody?.source !== "local"
    || !/^[a-f0-9]{64}$/u.test(savedLoggingBody?.revision ?? "")
    || cliLogging?.ok !== true
    || JSON.stringify(cliLogging.data) !== JSON.stringify(savedLoggingBody)
  ) {
    throw new Error("The packaged Hub did not persist the same exact logging preference read by the CLI.");
  }
  const changedLogging = JSON.parse(run(process.execPath, [
    cli, "logging", "checkpoints", "--expected-revision", savedLoggingBody.revision, "--json",
  ], project));
  if (
    changedLogging?.ok !== true
    || changedLogging?.scope !== "checkout"
    || changedLogging?.data?.mode !== "checkpoints"
    || changedLogging?.data?.source !== "local"
    || !/^[a-f0-9]{64}$/u.test(changedLogging?.data?.revision ?? "")
    || changedLogging.data.revision === savedLoggingBody.revision
  ) {
    throw new Error("The packed CLI did not update logging with the exact Hub revision.");
  }
  const staleLogging = await fetch(`${url.origin}/api/v1/settings/logging`, {
    method: "POST", headers: settingsHeaders, redirect: "error",
    body: JSON.stringify({ mode: "manual", expectedRevision: savedLoggingBody.revision }),
  });
  const currentLogging = await fetch(`${url.origin}/api/v1/settings/logging`, {
    headers: { cookie }, redirect: "error",
  });
  if (
    staleLogging.status !== 409
    || (await staleLogging.json())?.code !== "REVISION_CONFLICT"
    || !currentLogging.ok
    || JSON.stringify(await currentLogging.json()) !== JSON.stringify(changedLogging.data)
    || JSON.stringify(snapshotProtectedProjectState(project, {
      includeRuntimeState: false, includeGraphIndex: true,
    })) !== JSON.stringify(beforeLoggingUpdate)
  ) {
    throw new Error("Packaged logging lost a concurrent preference or changed canonical, index, Activity, or Git state.");
  }

  child.kill("SIGTERM");
  const exit = await waitForExit(child, 8_000);
  child = undefined;
  const stoppedAsRequested = exit.code === 0 && exit.signal === null;
  const terminatedAsRequestedOnWindows = process.platform === "win32"
    && exit.code === null
    && exit.signal === "SIGTERM";
  if (!stoppedAsRequested && !terminatedAsRequestedOnWindows) {
    throw new Error(`The packaged Hub did not stop cleanly (${JSON.stringify(exit)}).`);
  }
  // Exercise the shortcut after the immutable Hub-read and maintenance checks.
  // Only checkout-local state may change; Git, knowledge, Members and Activity stay exact.
  const beforeQuickSave = snapshotProtectedProjectState(project, {
    includeRuntimeState: false,
    includeGraphIndex: true,
  });
  const quickDraftFile = join(work, "relay-quick-draft.json");
  const quickSummary = "Resume the packed-install investigation when a teammate joins.";
  writeFileSync(quickDraftFile, JSON.stringify({ summary: quickSummary }));
  const quickSave = JSON.parse(run(process.execPath, [
    cli, "relay", "draft", "save", "--from", quickDraftFile,
    "--operation-id", "packed-relay-quick-save", "--json",
  ], project));
  const savedLocal = quickSave?.data?.localChanges?.[0];
  if (
    quickSave?.ok !== true
    || quickSave?.command !== "relay.draft.save"
    || quickSave?.mode !== "apply"
    || quickSave?.data?.applied !== true
    || quickSave?.data?.localChanges?.length !== 1
    || savedLocal?.namespace !== "relay-draft"
    || savedLocal?.beforeRevision !== null
    || typeof savedLocal?.id !== "string"
    || !/^[a-f0-9]{64}$/.test(savedLocal?.afterRevision ?? "")
    || JSON.stringify(quickSave?.data?.changes) !== "[]"
    || JSON.stringify(quickSave?.data?.relays) !== "[]"
    || JSON.stringify(quickSave?.data?.events) !== "[]"
  ) {
    throw new Error("The packed Relay shortcut did not save exactly one local draft without publication.");
  }
  const savedDraft = JSON.parse(run(process.execPath, [
    cli, "relay", "draft", "show", savedLocal.id, "--json",
  ], project));
  if (
    savedDraft?.ok !== true
    || savedDraft?.data?.id !== savedLocal.id
    || savedDraft?.data?.revision !== savedLocal.afterRevision
    || savedDraft?.data?.summary !== quickSummary
    || savedDraft?.data?.input?.audience !== "team"
    || JSON.stringify(savedDraft?.data?.input?.recipients) !== "[]"
    || JSON.stringify(snapshotProtectedProjectState(project, {
      includeRuntimeState: false,
      includeGraphIndex: true,
    })) !== JSON.stringify(beforeQuickSave)
  ) {
    throw new Error("The packed Relay shortcut lost its draft or changed protected project state.");
  }
  process.stdout.write("Packed Project Hub and official agent-skills smoke test passed.\n");
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}

function parsePackResult(output) {
  let parsed;
  const trimmed = output.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  const candidate = jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1);
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error("npm pack --json did not emit strict JSON.", { cause: error });
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (
    !result
    || typeof result.filename !== "string"
    || result.filename.length === 0
    || typeof result.version !== "string"
    || !Array.isArray(result.files)
  ) {
    throw new Error("npm pack --json omitted its filename, version, or file inventory.");
  }
  return result;
}

async function verifyFreshCodeRepoSetup(tarball, workRoot, cache, version) {
  const project = join(workRoot, "fresh-setup-project");
  mkdirSync(join(project, "src", "setup"), { recursive: true });
  writeFileSync(join(project, "package.json"), [
    "{",
    '  "name": "mex-agent",',
    '  "private": true,',
    '  "bin": { "mex": "src/index.ts" }',
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  writeFileSync(join(project, "src", "index.ts"), [
    "export function freshSetupValue(): number {",
    "  return 42;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, "src", "setup", "index.ts"), [
    "export function setupFixtureValue(): number {",
    "  return 8;",
    "}",
    "",
  ].join("\n"));
  run("git", ["init", "--quiet"], project);
  run("git", ["config", "user.name", "Fresh Setup"], project);
  run("git", ["config", "user.email", "fresh-setup@example.test"], project);
  run("git", ["add", ".gitignore", "package.json", "src"], project);
  run("git", ["commit", "--quiet", "-m", "initial fixture"], project);

  runNpm([
    "install",
    tarball,
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--cache",
    cache,
  ], project);
  if (existsSync(join(project, ".mex")) || existsSync(join(project, "AGENTS.md"))) {
    throw new Error("Plain packed install mutated the fresh setup project.");
  }

  const installed = join(project, "node_modules", "mex-agent");
  const installedVersion = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
  if (installedVersion !== version) throw new Error("Fresh setup installed the wrong packed version.");
  const cli = join(installed, "dist", "cli.js");
  const agentBin = join(workRoot, "fresh-setup-agent-bin");
  mkdirSync(agentBin, { recursive: true });
  installFakeCodex(agentBin, workRoot);

  const beforeHead = run("git", ["rev-parse", "HEAD"], project).trim();
  const output = await runFreshCodeRepoSetup(cli, project, agentBin);
  const normalized = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  for (const expected of [
    "Codex finished the population session",
    "Wiki migration and index are ready.",
    "Graph and Wiki are ready. Setup is ready to commit.",
  ]) {
    if (!normalized.includes(expected)) {
      throw new Error(`Packed fresh setup omitted: ${expected}\n${normalized}`);
    }
  }
  if (
    run("git", ["rev-parse", "HEAD"], project).trim() !== beforeHead
    || run("git", ["diff", "--cached", "--name-only"], project).trim().length !== 0
  ) {
    throw new Error("Fresh packed setup staged or committed changes automatically.");
  }

  const config = JSON.parse(readFileSync(join(project, ".mex", "config.json"), "utf8"));
  if (JSON.stringify(config.aiTools) !== JSON.stringify(["codex"])) {
    throw new Error("Fresh packed setup did not persist the selected Codex client.");
  }
  for (const file of [
    "AGENTS.md",
    "ROUTER.md",
    "context/architecture.md",
    "context/stack.md",
    "context/conventions.md",
    "context/decisions.md",
    "context/setup.md",
  ]) {
    const content = readFileSync(join(project, ".mex", file), "utf8");
    if (content.includes("[Project Name]") || content.includes("[YYYY-MM-DD]")) {
      throw new Error(`Fake Codex population left a required placeholder in ${file}.`);
    }
  }
  for (const database of ["graph.db", "wiki.db"]) {
    if (!existsSync(join(project, ".mex", database))) {
      throw new Error(`Fresh packed setup omitted .mex/${database}.`);
    }
  }
  verifySetupIgnoreProtection(project);
  const wiki = JSON.parse(run(process.execPath, [cli, "wiki", "list", "--json"], project));
  if (wiki?.ok !== true || !Array.isArray(wiki?.data?.entities) || wiki.data.entities.length === 0) {
    throw new Error("Fresh packed setup did not publish a readable Wiki index.");
  }

  run("git", ["add", ".mex", "AGENTS.md", ".agents"], project);
  const staged = run("git", ["diff", "--cached", "--name-only"], project);
  if (/\.mex\/(?:graph|wiki)\.db|\.mex\/local\//u.test(staged)) {
    throw new Error(`Fresh packed setup staged checkout-local state:\n${staged}`);
  }
  run("git", ["commit", "--quiet", "-m", "initialize MEX"], project);
  const committedConfig = run("git", ["show", "HEAD:.mex/config.json"], project);
  if (committedConfig !== readFileSync(join(project, ".mex", "config.json"), "utf8")) {
    throw new Error("Fresh packed setup config does not match current HEAD.");
  }
  const capabilities = JSON.parse(run(process.execPath, [cli, "capabilities", "--json"], project));
  for (const id of ["project_hub", "code_graph", "wiki"]) {
    const capability = capabilities?.data?.capabilities?.find((entry) => entry?.id === id);
    if (capability?.availability !== "available") {
      throw new Error(`Fresh packed setup left ${id} unavailable after the canonical commit.`);
    }
  }
}

function installFakeCodex(directory, workRoot) {
  const script = join(workRoot, "fake-codex-populate.mjs");
  writeFileSync(script, [
    'import { readFileSync, readdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const root = join(process.cwd(), ".mex");',
    'const visit = (directory) => {',
    '  for (const entry of readdirSync(directory, { withFileTypes: true })) {',
    '    const path = join(directory, entry.name);',
    '    if (entry.isDirectory()) visit(path);',
    '    else if (entry.isFile() && entry.name.endsWith(".md")) {',
    '      const content = readFileSync(path, "utf8")',
    '        .replaceAll("[Project Name]", "Packed First Run")',
    '        .replaceAll("[YYYY-MM-DD]", "2026-09-02");',
    '      writeFileSync(path, content, "utf8");',
    '    }',
    '  }',
    '};',
    'visit(root);',
    'process.stdout.write("fake Codex populated the scaffold\\n");',
    '',
  ].join("\n"), "utf8");
  if (process.platform === "win32") {
    writeFileSync(join(directory, "codex.cmd"), `@"${process.execPath}" "${script}" %*\r\n`, "utf8");
  } else {
    const command = join(directory, "codex");
    writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
    chmodSync(command, 0o755);
  }
}

function runFreshCodeRepoSetup(cli, project, agentBin) {
  const env = {
    ...process.env,
    MEX_TELEMETRY: "0",
    NO_COLOR: "1",
    PATH: `${agentBin}${delimiter}${process.env.PATH ?? ""}`,
  };
  return new Promise((resolveOutput, reject) => {
    const setup = spawn(process.execPath, [cli, "setup", "--cli"], {
      cwd: project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let selected = false;
    let settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveOutput(output);
    };
    const timer = setTimeout(() => {
      if (setup.exitCode === null) setup.kill("SIGKILL");
      finish(new Error(`Timed out running packed fresh setup.\n${stdout}\n${stderr}`));
    }, 120_000);
    setup.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!selected && stdout.includes("Choice [1-8] (default: 1):")) {
        selected = true;
        setup.stdin.end("6\n");
      }
    });
    setup.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    setup.on("error", (error) => finish(error));
    setup.on("close", (code, signal) => {
      if (code !== 0 || signal !== null || !selected) {
        finish(new Error(
          `Packed fresh setup failed (exit ${String(code)}, signal ${String(signal)}).\n${stdout}\n${stderr}`,
        ));
        return;
      }
      finish(null, stdout);
    });
  });
}

function runInteractiveAgentSetup(cli, project, workRoot) {
  const emptyPath = join(workRoot, "empty-agent-path");
  mkdirSync(emptyPath, { recursive: true });

  // This fixture exercises the code Hub after setup, so persist code-repo intent.
  // Keep the packed smoke independent from developer-machine agent installs.
  // Launch Node by absolute path and restrict PATH to Git, then prove the
  // selected agent CLIs are absent before exercising manual population.
  const env = { ...process.env, MEX_TELEMETRY: "0", NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = installGitOnlyPath(emptyPath);
  verifyManualSetupEnvironment(project, env);

  return new Promise((resolveOutput, reject) => {
    const setup = spawn(process.execPath, [cli, "setup", "--cli", "--mode", "code-repo"], {
      cwd: project,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let choseMultiple = false;
    let choseClients = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (setup.exitCode === null) setup.kill("SIGKILL");
      reject(error);
    };
    const answer = (value) => {
      if (setup.stdin.destroyed || !setup.stdin.writable) {
        fail(new Error(`The packed setup closed stdin before all prompts were answered.\n${stderr}`));
        return;
      }
      setup.stdin.write(`${value}\n`);
    };
    const drivePrompts = () => {
      if (!choseMultiple && stdout.includes("Choice [1-8] (default: 1):")) {
        choseMultiple = true;
        answer("7");
      }
      if (!choseClients && stdout.includes("Enter tool numbers separated by spaces")) {
        choseClients = true;
        answer("1 6");
        setup.stdin.end();
      }
    };
    const timer = setTimeout(() => {
      fail(new Error(`Timed out driving the packed interactive setup.\n${stdout}\n${stderr}`));
    }, 60_000);

    setup.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      drivePrompts();
    });
    setup.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    setup.on("error", (error) => {
      fail(new Error(`The packed interactive setup could not start: ${error.message}`, {
        cause: error,
      }));
    });
    setup.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (
        code !== 0
        || signal !== null
        || !choseMultiple
        || !choseClients
      ) {
        reject(new Error(
          `The packed interactive setup did not complete all expected prompts `
          + `(exit ${String(code)}, signal ${String(signal)}).\n${stdout}\n${stderr}`,
        ));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

function installGitOnlyPath(directory) {
  const executable = locateSmokeExecutable(process.platform === "win32" ? "git.exe" : "git");
  if (process.platform === "win32") {
    // Direct spawn cannot execute git.cmd. Keep native Git in its installation
    // directory so its runtime and helper paths remain valid.
    return dirname(executable);
  }
  symlinkSync(executable, join(directory, "git"));
  return directory;
}

function locateSmokeExecutable(command) {
  const located = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  const executable = located.status === 0
    ? located.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim()
    : undefined;
  if (!executable) throw new Error(`The packed setup smoke could not locate ${command}.`);
  return resolve(executable);
}

function verifyManualSetupEnvironment(project, env) {
  const options = { cwd: project, env, encoding: "utf8", timeout: 5_000, windowsHide: true };
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], options);
  if (git.error || git.status !== 0) {
    throw new Error("The packed setup smoke cannot run native Git in its restricted PATH.", {
      cause: git.error,
    });
  }
  // Locate the probe before restricting its environment. A missing `where` or
  // `which` must never count as evidence that Claude/Codex are unavailable.
  const locator = locateSmokeExecutable(process.platform === "win32" ? "where.exe" : "which");
  for (const command of ["claude", "codex"]) {
    const found = spawnSync(locator, [command], options);
    if (found.status === 0) {
      throw new Error(`The packed setup smoke unexpectedly exposes ${command} in its restricted PATH.`);
    }
    if (found.error || found.status !== 1) {
      throw new Error(`The packed setup smoke could not verify that ${command} is unavailable.`, {
        cause: found.error,
      });
    }
  }
}

function verifyPackedSetupOutput(output) {
  const normalized = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const expectedActions = [
    "Install the packaged mex-inbox skill at .claude/skills/mex-inbox.",
    "Install the packaged mex-relay skill at .claude/skills/mex-relay.",
    "Append the MEX-managed instruction block to CLAUDE.md without changing its existing bytes.",
    "Install the packaged mex-inbox skill at .agents/skills/mex-inbox.",
    "Install the packaged mex-relay skill at .agents/skills/mex-relay.",
    "Append the MEX-managed instruction block to AGENTS.md without changing its existing bytes.",
  ];
  const sessionGuarantee = "Start a new Claude Code and Codex session to guarantee the new skills and project instructions are loaded.";
  if (
    !normalized.includes("Choice [1-8] (default: 1):")
    || !normalized.includes("Enter tool numbers separated by spaces")
    || !expectedActions.every((message) => normalized.includes(message))
    || !normalized.includes(sessionGuarantee)
  ) {
    throw new Error("The packed interactive setup omitted its two-client install actions or new-session guarantee.");
  }
}

function verifySetupConfig(project) {
  const config = JSON.parse(readFileSync(join(project, ".mex", "config.json"), "utf8"));
  if (
    config.setupMode !== "code-repo"
    || JSON.stringify(config.aiTools) !== JSON.stringify(["claude", "codex"])
    || config.scaffold_id !== "11111111-1111-4111-8111-111111111111"
    || config.scaffold_name !== "packed-hub-smoke"
    || JSON.stringify(config.wiki) !== JSON.stringify({
      exclude: ["excluded/**"],
      readOnly: ["context/read-only/**"],
    })
  ) {
    throw new Error("The packed interactive setup did not persist code-repo intent and both clients while preserving existing config.");
  }
}

function verifySetupIgnoreProtection(project) {
  const content = readFileSync(join(project, ".mex", ".gitignore"), "utf8");
  for (const rule of ["graph.db*", "wiki.db*", "local/"]) {
    if (!content.split(/\r?\n/u).includes(rule)) {
      throw new Error(`Packed setup omitted ${rule} from .mex/.gitignore.`);
    }
  }
  for (const path of [".mex/graph.db-wal", ".mex/wiki.db-shm", ".mex/local/team.db"]) {
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", path], {
      cwd: project,
    });
    if (ignored.status !== 0) throw new Error(`Packed setup left ${path} trackable.`);
  }
}

function verifyPackedSkillTrees(packResult) {
  const packedFiles = new Set(packResult.files.map((file) => file?.path).filter((path) => (
    typeof path === "string"
  )));
  for (const skill of OFFICIAL_SKILLS) {
    const source = join(root, "skills", skill);
    const sourceFiles = collectTreeFiles(source);
    const expected = sourceFiles.map((file) => `skills/${skill}/${file.path}`);
    const actual = [...packedFiles]
      .filter((path) => path.startsWith(`skills/${skill}/`))
      .sort((left, right) => left.localeCompare(right, "en"));
    expected.sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`The npm pack tarball did not contain the complete ${skill} tree.`);
    }
    for (const required of ["SKILL.md", "agents/openai.yaml"]) {
      if (!sourceFiles.some((file) => file.path === required)) {
        throw new Error(`The canonical ${skill} source omitted ${required}.`);
      }
    }
    if (!sourceFiles.some((file) => file.path.startsWith("references/"))) {
      throw new Error(`The canonical ${skill} source omitted its progressive references.`);
    }
  }
}

function verifyInstalledPackageSkillTrees(installed) {
  for (const skill of OFFICIAL_SKILLS) {
    assertTreesEqual(
      join(root, "skills", skill),
      join(installed, "skills", skill),
      `installed package ${skill}`,
    );
  }
}

function parseSkillSyncReport(output, packageVersion, dryRun) {
  let report;
  try {
    report = JSON.parse(output.trim());
  } catch (error) {
    throw new Error("mex skills sync --json did not emit one strict JSON object.", { cause: error });
  }
  if (
    !report
    || Array.isArray(report)
    || report.schemaVersion !== 1
    || report.packageVersion !== packageVersion
    || report.dryRun !== dryRun
    || !Array.isArray(report.clients)
    || !Array.isArray(report.actions)
    || !Array.isArray(report.warnings)
    || typeof report.applied !== "boolean"
    || typeof report.changed !== "boolean"
    || typeof report.conflicted !== "boolean"
  ) {
    throw new Error("mex skills sync --json emitted an invalid agent-assets report.");
  }
  return report;
}

function verifyInstalledAgentAssets(project, installed, packageVersion) {
  const clients = [
    {
      name: "claude",
      skillsRoot: join(project, ".claude", "skills"),
      instructions: join(project, "CLAUDE.md"),
      originalInstructions: "# Consumer Claude instructions\n\nKeep this line byte-for-byte.\n",
      explicit: ["/mex-inbox", "/mex-relay"],
      foreignExplicit: ["$mex-inbox", "$mex-relay"],
    },
    {
      name: "codex",
      skillsRoot: join(project, ".agents", "skills"),
      instructions: join(project, "AGENTS.md"),
      originalInstructions: "# Consumer Codex instructions\n\nKeep this line byte-for-byte.\n",
      explicit: ["$mex-inbox", "$mex-relay"],
      foreignExplicit: ["/mex-inbox", "/mex-relay"],
    },
  ];

  for (const client of clients) {
    for (const skill of OFFICIAL_SKILLS) {
      const source = join(installed, "skills", skill);
      const destination = join(client.skillsRoot, skill);
      assertTreesEqual(source, destination, `${client.name} ${skill}`, {
        ignoredDestinationFiles: new Set([".mex-managed.json"]),
      });
      verifyOwnershipSidecar(destination, skill, packageVersion, source);
    }

    const instructions = readFileSync(client.instructions, "utf8");
    if (!instructions.startsWith(client.originalInstructions)) {
      throw new Error(`The ${client.name} setup did not preserve hand-written root instructions byte-for-byte.`);
    }
    if (
      countOccurrences(instructions, "<!-- mex-agent:skills:start -->") !== 1
      || countOccurrences(instructions, "<!-- mex-agent:skills:end -->") !== 1
      || !client.explicit.every((invocation) => instructions.includes(invocation))
      || client.foreignExplicit.some((invocation) => instructions.includes(invocation))
      || !instructions.includes("mention MEX and the relevant finding naturally in your explanation")
      || !instructions.includes("Skill activation is not approval for canonical actions.")
      || !instructions.includes("mex logging --json")
      || !instructions.includes('mex timeline --query "subject phrase" --file src/example.ts --limit 10 --json')
      || !["significant", "checkpoints", "manual"].every((mode) => instructions.includes(mode))
      || !instructions.includes("historical evidence")
    ) {
      throw new Error(`The ${client.name} setup instruction block was missing or not client-specific.`);
    }
  }

  const expectedConsumerOwned = {
    claude: "description: A consumer-owned Claude skill that MEX must never inspect or rewrite.",
    codex: "description: A consumer-owned Codex skill that MEX must never inspect or rewrite.",
  };
  for (const [client, expectedLine] of Object.entries(expectedConsumerOwned)) {
    const rootName = client === "claude" ? ".claude" : ".agents";
    const bytes = readFileSync(
      join(project, rootName, "skills", "consumer-owned", "SKILL.md"),
      "utf8",
    );
    if (!bytes.includes(expectedLine)) {
      throw new Error(`The ${client} setup rewrote an unrelated consumer-owned skill.`);
    }
  }
}

function verifyOwnershipSidecar(destination, skill, packageVersion, source) {
  const sidecarPath = join(destination, ".mex-managed.json");
  const bytes = readFileSync(sidecarPath, "utf8");
  if (!bytes.endsWith("\n")) {
    throw new Error(`${skill} ownership metadata was not deterministic newline-terminated JSON.`);
  }
  const metadata = JSON.parse(bytes);
  const sourceFiles = collectTreeFiles(source);
  const expectedFiles = Object.fromEntries(sourceFiles.map((file) => [
    file.path,
    createHash("sha256").update(file.bytes).digest("hex"),
  ]));
  const recordedPaths = Object.keys(metadata.files ?? {}).sort();
  const expectedPaths = Object.keys(expectedFiles).sort();
  if (
    metadata.schemaVersion !== 1
    || metadata.owner !== "mex-agent"
    || metadata.skill !== skill
    || metadata.packageVersion !== packageVersion
    || JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)
    || expectedPaths.some((path) => metadata.files[path] !== expectedFiles[path])
    || JSON.stringify(Object.keys(metadata))
      !== JSON.stringify(["schemaVersion", "owner", "skill", "packageVersion", "files"])
  ) {
    throw new Error(`${skill} ownership metadata did not exactly describe the deployed payload.`);
  }
}

function assertTreesEqual(source, destination, label, { ignoredDestinationFiles = new Set() } = {}) {
  const sourceFiles = collectTreeFiles(source);
  const destinationFiles = collectTreeFiles(destination).filter((file) => (
    !ignoredDestinationFiles.has(file.path)
  ));
  const sourcePaths = sourceFiles.map((file) => file.path);
  const destinationPaths = destinationFiles.map((file) => file.path);
  if (JSON.stringify(destinationPaths) !== JSON.stringify(sourcePaths)) {
    throw new Error(`The ${label} file inventory did not match its packaged source.`);
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    if (!sourceFiles[index].bytes.equals(destinationFiles[index].bytes)) {
      throw new Error(`The ${label} changed ${sourceFiles[index].path} while copying it.`);
    }
  }
}

function collectTreeFiles(directory, relativeRoot = "") {
  if (!existsSync(directory)) throw new Error(`Expected directory is missing: ${directory}`);
  const result = [];
  for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"))) {
    const absolute = join(directory, name);
    const relativePath = relativeRoot.length === 0 ? name : `${relativeRoot}/${name}`;
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`Packaged and managed skill trees must not contain symlinks: ${absolute}`);
    }
    if (stats.isDirectory()) {
      result.push(...collectTreeFiles(absolute, relativePath));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Packaged and managed skill trees must contain regular files: ${absolute}`);
    }
    result.push({ path: relativePath, bytes: readFileSync(absolute) });
  }
  return result;
}

function snapshotAgentSurfaces(project) {
  const files = [];
  for (const path of [
    join(project, "CLAUDE.md"),
    join(project, "AGENTS.md"),
    join(project, ".claude"),
    join(project, ".agents"),
    join(project, ".mex"),
  ]) {
    collectSnapshotFiles(project, path, files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return files;
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

function writeActivityFixture(project) {
  const eventId = "event_01K3Q080000000000000000001";
  const activityRoot = join(project, ".mex", "events", "activity", "2026-08");
  mkdirSync(activityRoot, { recursive: true });
  writeFileSync(join(activityRoot, `${eventId}.md`), [
    "---",
    "schema_version: 1",
    `id: ${JSON.stringify(eventId)}`,
    "timestamp: \"2026-08-23T01:02:03.000Z\"",
    "actor: {\"email\":\"packed@example.test\",\"kind\":\"git\",\"name\":\"Packed Ada\"}",
    "action: \"activity.packed\"",
    "subjects: [{\"kind\":\"file\",\"path\":\"src/packed.ts\"},{\"hash\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"kind\":\"commit\"}]",
    "repo_state: {\"branch\":\"main\",\"dirty\":false,\"head\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"observedAt\":\"2026-08-23T01:02:02.000Z\"}",
    "metadata: {\"internal_note\":\"fixture must stay private\"}",
    "---",
    "",
  ].join("\n"));
  writeFileSync(join(project, ".mex", "events", "decisions.jsonl"), `${JSON.stringify({
    timestamp: "2026-08-22T01:02:03.000Z",
    kind: "decision",
    message: "Packed legacy decision",
    files: ["src/packed.ts", "../outside.ts"],
    cwd: "/Users/alice/private-project",
    trace: ".mex/traces/private.md",
    source: "private-agent",
    status: "private-status",
  })}\n`);
}

function writeWikiFixture(project, grounding) {
  const topicId = "mx_01J00000000000000000000001";
  const decisionId = "mx_01J00000000000000000000002";
  const patternId = "mx_01J00000000000000000000003";
  const topics = join(project, ".mex", "topics");
  const context = join(project, ".mex", "context");
  const excluded = join(project, ".mex", "excluded");
  mkdirSync(topics, { recursive: true });
  mkdirSync(context, { recursive: true });
  mkdirSync(excluded, { recursive: true });
  writeFileSync(join(topics, "payments.md"), [
    "<!-- mex:entity",
    `id: ${topicId}`,
    "type: topic",
    "status: promoted",
    "revision: 1",
    "summary: Reliable payment processing knowledge.",
    "metadata:",
    "  aliases: [payments, checkout]",
    "  private_note: packed-topic-private-metadata",
    "-->",
    "## Payments",
    "",
    "Payment processing must remain recoverable and idempotent.",
    "",
  ].join("\n"));
  writeFileSync(join(context, "packed-knowledge.md"), [
    "<!-- mex:entity",
    `id: ${decisionId}`,
    "type: decision",
    "status: promoted",
    "revision: 2",
    "summary: Retry packed service calls with the original request key.",
    `topics: [${topicId}]`,
    "relations:",
    "  - type: implements",
    `    target: ${patternId}`,
    "sources:",
    "  - type: symbol",
    `    ref: ${JSON.stringify(grounding.nodeId)}`,
    "    note: Exact packed service declaration.",
    "    metadata:",
    "      private_source_note: packed-source-private-metadata",
    "grounds_to:",
    `  - node: ${JSON.stringify(grounding.nodeId)}`,
    `    fingerprint: ${JSON.stringify(grounding.fingerprint)}`,
    `    bodyHash: ${JSON.stringify(grounding.bodyHash)}`,
    "    reason: Exact packed service grounding.",
    "provenance:",
    "  createdBy: { kind: agent, id: packed-fixture-agent }",
    "  createdAt: 2026-08-23T00:00:00.000Z",
    "  agentSessionId: packed-private-session",
    "metadata:",
    "  private_note: packed-entity-private-metadata",
    "-->",
    "## Preserve packed retries",
    "",
    "The packed service retries only with the original stable request key.",
    "",
    "<!-- mex:entity",
    `id: ${patternId}`,
    "type: pattern",
    "status: in_flight",
    "revision: 1",
    "summary: Wrap packed calls in a bounded retry envelope.",
    `topics: [${topicId}]`,
    "relations:",
    "  - type: depends_on",
    `    target: ${decisionId}`,
    "sources:",
    "  - type: manual",
    "    note: Maintainer reviewed.",
    "-->",
    "## Packed retry envelope",
    "",
    "Retry transient failures without duplicating the underlying operation.",
    "",
  ].join("\n"));
  writeFileSync(join(excluded, "private.md"), [
    "<!-- mex:entity",
    "id: mx_01J00000000000000000000004",
    "type: fact",
    "status: promoted",
    "revision: 1",
    "summary: excluded-only-sentinel",
    "-->",
    "## Configured exclusion",
    "",
    "excluded-only-private-body",
    "",
  ].join("\n"));
}

function snapshotProtectedProjectState(
  project,
  {
    includeRuntimeState = true,
    includeGraphIndex = includeRuntimeState,
    includeWikiIndex = true,
  } = {},
) {
  const status = run("git", [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ], project);
  const candidates = [
    join(project, ".mex", "events"),
    join(project, ".mex", "team"),
    join(project, ".mex", "context"),
    join(project, ".mex", "excluded"),
    join(project, ".mex", "topics"),
    join(project, ".mex", "ROUTER.md"),
    join(project, ".mex", "config.json"),
    join(project, "src"),
  ];
  if (includeRuntimeState) {
    const localRoot = join(project, ".mex", "local");
    if (existsSync(localRoot)) {
      for (const name of readdirSync(localRoot)) {
        if (name.startsWith("team.db")) candidates.push(join(localRoot, name));
      }
    }
  }
  for (const name of readdirSync(join(project, ".mex"))) {
    if (
      (includeWikiIndex && name.startsWith("wiki.db"))
      || (includeGraphIndex && name.startsWith("graph.db"))
    ) {
      candidates.push(join(project, ".mex", name));
    }
  }
  candidates.push(
    join(project, ".git", "HEAD"),
    join(project, ".git", "index"),
    join(project, ".git", "refs", "heads"),
  );

  const files = [];
  for (const candidate of candidates) collectSnapshotFiles(project, candidate, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    files,
    status,
  };
}

function collectSnapshotFiles(project, path, files) {
  if (!existsSync(path)) return;
  const stats = statSync(path, { bigint: true });
  if (stats.isDirectory()) {
    for (const name of readdirSync(path)) collectSnapshotFiles(project, join(path, name), files);
    return;
  }
  if (!stats.isFile()) return;
  files.push({
    path: path.slice(project.length + 1),
    bytes: readFileSync(path).toString("base64"),
    mtimeNs: stats.mtimeNs.toString(),
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new Error(
      `${command} ${args.join(" ")} could not start: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${String(result.status)}`
      + `${result.signal === null ? "" : ` (signal ${result.signal})`}:\n`
      + `${result.stderr || result.stdout || "The command produced no output."}`,
    );
  }
  return result.stdout;
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

function readBootstrapUrl(processHandle) {
  return new Promise((resolveUrl, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Hub startup.\n${stderr}`));
    }, 30_000);
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/https?:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_%~-]+/);
      if (match) {
        cleanup();
        resolveUrl(match[0]);
      }
    };
    const onStderr = (chunk) => { stderr += chunk.toString("utf8"); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Hub exited before startup (${code ?? signal}).\n${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      processHandle.stdout.off("data", onStdout);
      processHandle.stderr.off("data", onStderr);
      processHandle.off("exit", onExit);
    };
    processHandle.stdout.on("data", onStdout);
    processHandle.stderr.on("data", onStderr);
    processHandle.once("exit", onExit);
  });
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    if (processHandle.exitCode !== null) {
      resolveExit({ code: processHandle.exitCode, signal: processHandle.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("Timed out waiting for the packaged Hub to stop."));
    }, timeoutMs);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitForJob(origin, cookie, id) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/v1/jobs/${encodeURIComponent(id)}`, {
      headers: { cookie },
      redirect: "error",
    });
    const job = await response.json();
    if (!response.ok) throw new Error(`Reading packaged Hub job ${id} failed.`);
    if (job.state !== "queued" && job.state !== "running") return job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Packaged Hub job ${id} did not finish before the deadline.`);
}

async function startJob(origin, cookie, csrfToken, kind, forbiddenValues = []) {
  const response = await fetch(`${origin}/api/v1/jobs`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-mex-csrf": csrfToken,
    },
    body: JSON.stringify({ kind }),
    redirect: "error",
  });
  const body = await response.json();
  if (response.status !== 202 || typeof body.id !== "string") {
    throw new Error(`The packaged Hub could not start ${kind}.`);
  }
  const terminal = await waitForJob(origin, cookie, body.id);
  const events = await fetch(`${origin}/api/v1/jobs/${encodeURIComponent(body.id)}/events`, {
    headers: { cookie },
    redirect: "error",
  });
  const stream = await events.text();
  if (
    !events.ok
    || !events.headers.get("content-type")?.startsWith("text/event-stream")
    || !stream.includes("event: terminal")
    || !stream.includes(`\"kind\":\"${kind}\"`)
    || stream.includes("packed-private-session")
    || stream.includes("excluded-only-private-body")
    || forbiddenValues.some((value) => stream.includes(value))
  ) {
    throw new Error(`The packaged Hub did not replay a safe terminal SSE event for ${kind}.`);
  }
  return terminal;
}
