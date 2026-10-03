/**
 * §20.7 — the CLI contract, over all ten commands rather than a spot check.
 *
 * The commands are driven through their exported functions with an injected
 * `write` and `setExitCode`, not by spawning a CLI. That is deliberate: the
 * thing under test is the contract, and spawning would test commander's
 * argument parsing at ten times the cost while making the assertions about exit
 * status harder to read. `src/cli.ts` is a registration table over these
 * functions, and `test/cli.test.ts` covers that it loads.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import {
  runApply,
  runBacklinks,
  runBuild,
  runGraph,
  runList,
  runMigrate,
  runPrepare,
  runPropose,
  runQuery,
  runRebuildIndex,
  runRegenerateViews,
  runRelated,
  runShow,
  runValidate,
  filtersFrom,
  type CommandFlags,
  type CommandIo,
} from "../commands.js";
import { WIKI_EXIT } from "../envelope.js";
import { COMMAND_BINDINGS } from "../../service/surface.js";
import { wikiRebuildIndex } from "../../service/write.js";
import { locateEntity } from "../../operations/locate.js";

const ARCH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const GATEWAY = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const TOPIC = "mx_01KRMEXM00JAAVJPQVVRX8N56V";
const SPEC_ONE = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const SPEC_TWO = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const CONVENTION_ONE = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const CONVENTION_TWO = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAD";
const MISFILED_ONE = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAE";
const MISFILED_TWO = "mx_01ARZ3NDEKTSV4RRFFQ69G5FAF";

const ARCHITECTURE_MD = `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
-->
## Authentication

Everything about tokens.

<!-- mex:entity
id: ${ARCH}
type: architecture
status: promoted
revision: 1
topics: [${TOPIC}]
relations:
  - type: depends_on
    target: ${GATEWAY}
-->
## System architecture

Three services behind one gateway.

<!-- mex:entity
id: ${GATEWAY}
type: component
status: promoted
revision: 1
-->
## Gateway

Terminates TLS and routes by path prefix.
`;

const SPEC_DUPLICATES_MD = `<!-- mex:entity
id: ${SPEC_ONE}
type: spec
status: in_flight
revision: 1
-->
## Inbox owns Spec authoring

Every Spec change passes through a reviewed Inbox proposal.

<!-- mex:entity
id: ${SPEC_TWO}
type: spec
status: in_flight
revision: 1
-->
## Inbox owns all Spec authoring

Every Spec change must pass through one reviewed Inbox proposal.
`;

const CONVENTION_DUPLICATES_MD = `<!-- mex:entity
id: ${CONVENTION_ONE}
type: convention
status: in_flight
revision: 1
-->
## Tokens have one issuer

Every token is minted by the exported issuer.

<!-- mex:entity
id: ${CONVENTION_TWO}
type: convention
status: in_flight
revision: 1
-->
## Tokens use one issuer

Every token must be minted by the exported issuer.
`;

const MISFILED_DECISION_DUPLICATES_MD = `<!-- mex:entity
id: ${MISFILED_ONE}
type: decision
status: in_flight
revision: 1
-->
## Cache one authorization decision

Authorization decisions share one bounded cache.

<!-- mex:entity
id: ${MISFILED_TWO}
type: decision
status: in_flight
revision: 1
-->
## Cache authorization decisions once

Authorization decisions use one bounded cache.
`;

const roots: string[] = [];
let colourWas: boolean;

beforeEach(() => {
  // Colour forced on for the whole file. Trap 3: a test that runs with colour
  // disabled proves nothing about the JSON path, and chalk disables itself when
  // stdout is not a TTY — which is exactly what a test runner is.
  colourWas = chalk.level > 0;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = colourWas ? 3 : 0;
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed SQLite files.
    }
  }
});

interface Captured {
  io: CommandIo;
  lines: string[];
  exit: () => number;
  root: string;
}

function harness(indexed = true, files: Record<string, string> = {}): Captured {
  const root = mkdtempSync(join(tmpdir(), "mex-cli-"));
  roots.push(root);
  for (const [path, text] of Object.entries({ "context/architecture.md": ARCHITECTURE_MD, ...files })) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  if (indexed) wikiRebuildIndex({ scaffoldRoot: root });

  const lines: string[] = [];
  let code: number = WIKI_EXIT.ok;
  return {
    root,
    lines,
    exit: () => code,
    io: {
      write: (line) => lines.push(line),
      setExitCode: (next) => {
        code = next;
      },
      scaffoldRoot: root,
      projectRoot: root,
    },
  };
}

/**
 * A code graph that knows about exactly one file with one symbol.
 *
 * Enough for `build` and `prepare` to have something to cluster, and small
 * enough to write inline: the point of these cases is the envelope, not the
 * pipeline, which has its own suite.
 */
const CODE_GRAPH = {
  listFiles: () => [{ path: "src/auth/tokens.ts" }],
  nodesInFile: () => [{ id: "function:issueToken", kind: "function" }],
  describeNode: (id: string) =>
    id === "function:issueToken"
      ? {
          id,
          kind: "function",
          name: "issueToken",
          filePath: "src/auth/tokens.ts",
          startLine: 1,
          endLine: 2,
        }
      : null,
  callersOf: () => [],
  calleesOf: () => [],
  outgoingEdges: () => [],
};

/** Every command, driven the same way, so an assertion can be made over all of them. */
function allCommands(
  harnessed: Captured,
  flags: CommandFlags,
): Array<{ command: string; run: () => void | Promise<void> }> {
  const { io } = harnessed;
  return [
    { command: "list", run: () => runList(io, flags) },
    { command: "show", run: () => runShow(io, ARCH, flags) },
    { command: "query", run: () => runQuery(io, "gateway", flags) },
    { command: "related", run: () => runRelated(io, ARCH, flags) },
    { command: "backlinks", run: () => runBacklinks(io, GATEWAY, flags) },
    { command: "validate", run: () => runValidate(io, flags) },
    { command: "graph", run: () => runGraph(io, flags) },
    { command: "rebuild-index", run: () => runRebuildIndex(io, flags) },
    { command: "migrate", run: () => runMigrate(io, { ...flags, dryRun: true }) },
    { command: "apply", run: () => runApply(io, join(harnessed.root, "op.json"), flags) },
    { command: "regenerate-views", run: () => runRegenerateViews(io, { ...flags, dryRun: true }) },
    { command: "build", run: () => runBuild({ ...io, codeGraph: CODE_GRAPH }, { ...flags, print: true }) },
    {
      command: "prepare",
      run: () =>
        runPrepare({ ...io, codeGraph: CODE_GRAPH }, { ...flags, stage: "architecture_component" }),
    },
    {
      command: "propose",
      run: () => runPropose({ ...io, codeGraph: CODE_GRAPH }, join(harnessed.root, "response.json"), flags),
    },
  ];
}

describe("stable JSON envelopes", () => {
  it("every implemented command returns the §15.2 shape", async () => {
    const cases = allCommands(harness(), { json: true });
    // The count is asserted so a command dropped from the list fails here
    // rather than quietly reducing what this suite covers.
    expect(cases).toHaveLength(14);
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      COMMAND_BINDINGS.map((entry) => entry.command).sort(),
    );
  });

  it("emits exactly one enveloped object per command under --json", async () => {
    for (const { command } of allCommands(harness(), { json: true })) {
      const local = harness();
      writeFileSync(join(local.root, "op.json"), "{}", "utf-8");
      writeFileSync(join(local.root, "response.json"), "{}", "utf-8");
      const entry = allCommands(local, { json: true }).find((candidate) => candidate.command === command)!;
      await entry.run();
      expect(local.lines, command).toHaveLength(1);
      const parsed = JSON.parse(local.lines[0]!) as Record<string, unknown>;
      expect(Object.keys(parsed).sort(), command).toEqual(["data", "diagnostics", "ok", "schemaVersion"]);
      expect(parsed["schemaVersion"], command).toBe(1);
      expect(Array.isArray(parsed["diagnostics"]), command).toBe(true);
    }
  });
});

describe("no ANSI in JSON", () => {
  it("holds for all ten with colour forced on", async () => {
    // Built, never written: a literal escape byte in a source file is banned.
    const escape = String.fromCharCode(0x1b);
    expect(chalk.level).toBeGreaterThan(0);
    // The guard on the guard: chalk really would colour if asked.
    expect(chalk.red("x").includes(escape)).toBe(true);

    for (const { command } of allCommands(harness(), { json: true })) {
      const local = harness();
      writeFileSync(join(local.root, "op.json"), "{}", "utf-8");
      writeFileSync(join(local.root, "response.json"), "{}", "utf-8");
      await allCommands(local, { json: true }).find((candidate) => candidate.command === command)!.run();
      for (const line of local.lines) expect(line.includes(escape), `${command}: ${line}`).toBe(false);
    }
  });

  it("does colour the human path, so the JSON assertion is not vacuous", async () => {
    const escape = String.fromCharCode(0x1b);
    const local = harness(false);
    runList(local.io, {});
    // No index, so a diagnostic is rendered — in red.
    expect(local.lines.some((line) => line.includes(escape))).toBe(true);
  });
});

describe("typed exit statuses", () => {
  it("never pairs ok:false with exit 0, across every command", async () => {
    let checked = 0;
    for (const { command } of allCommands(harness(), { json: true })) {
      // No index and no operation file: several of the ten now fail.
      const local = harness(false);
      await allCommands(local, { json: true }).find((candidate) => candidate.command === command)!.run();
      const parsed = JSON.parse(local.lines[0]!) as { ok: boolean };
      if (!parsed.ok) expect(local.exit(), command).not.toBe(WIKI_EXIT.ok);
      else expect(local.exit(), command).toBe(WIKI_EXIT.ok);
      checked += 1;
    }
    expect(checked).toBe(14);
  });

  it("reports a missing index as its own status, distinct from a diagnostic failure", async () => {
    const local = harness(false);
    runList(local.io, { json: true });
    expect(local.exit()).toBe(WIKI_EXIT.index);
    const parsed = JSON.parse(local.lines[0]!) as { diagnostics: Array<{ code: string; remediation?: string }> };
    expect(parsed.diagnostics[0]?.code).toBe("WIKI_INDEX_MISSING");
    // The message has to say how to fix it (§15.2).
    expect(parsed.diagnostics[0]?.remediation).toContain("rebuild-index");
  });

  it("reports an unreadable operation file as a usage error, not an index one", async () => {
    const local = harness();
    writeFileSync(join(local.root, "op.json"), "{ not json", "utf-8");
    await runApply(local.io, join(local.root, "op.json"), { json: true });
    expect(local.exit()).toBe(WIKI_EXIT.usage);
  });
});

describe("missing-index behaviour", () => {
  it("never rebuilds, for any read command", async () => {
    const reads = ["list", "show", "query", "related", "backlinks", "graph"];
    for (const command of reads) {
      const local = harness(false);
      await allCommands(local, { json: true }).find((candidate) => candidate.command === command)!.run();
      expect(readdirSync(local.root), command).not.toContain("wiki.db");
    }
  });

  it("lets validate answer anyway, and still creates nothing", async () => {
    const local = harness(false);
    await runValidate(local.io, { json: true });
    const parsed = JSON.parse(local.lines[0]!) as { ok: boolean; data: { entitiesChecked: number } };
    expect(parsed.data.entitiesChecked).toBe(3);
    expect(readdirSync(local.root)).not.toContain("wiki.db");
  });

  it("delete the index, rebuild, and every read command returns — at the command level", async () => {
    const local = harness();
    runList(local.io, { json: true });
    const before = JSON.parse(local.lines[0]!) as { data: { entities: unknown[] } };
    expect(before.data.entities).toHaveLength(3);

    rmSync(join(local.root, "wiki.db"));
    local.lines.length = 0;
    runList(local.io, { json: true });
    expect((JSON.parse(local.lines[0]!) as { ok: boolean }).ok).toBe(false);

    local.lines.length = 0;
    await runRebuildIndex(local.io, { json: true });
    expect(local.exit()).toBe(WIKI_EXIT.ok);

    for (const command of ["list", "show", "query", "related", "backlinks", "graph"]) {
      const fresh = { ...local, lines: [] as string[] };
      const io: CommandIo = { ...local.io, write: (line) => fresh.lines.push(line) };
      await allCommands({ ...local, io, lines: fresh.lines }, { json: true })
        .find((candidate) => candidate.command === command)!
        .run();
      expect((JSON.parse(fresh.lines[0]!) as { ok: boolean }).ok, command).toBe(true);
    }
  });
});

describe("bounded output", () => {
  it("clamps a limit nobody should be able to ask for, and says the list was cut", async () => {
    const local = harness();
    runList(local.io, { json: true, limit: 1 });
    const parsed = JSON.parse(local.lines[0]!) as { data: { entities: unknown[]; truncated: boolean } };
    expect(parsed.data.entities).toHaveLength(1);
    // Truncation is data, never a diagnostic (invariant 7).
    expect(parsed.data.truncated).toBe(true);
    expect(JSON.stringify(parsed).includes("TRUNCATED")).toBe(false);
  });

  it("tells a user plainly that a bounded graph is a sample", async () => {
    const local = harness();
    runGraph(local.io, { limit: 1 });
    expect(local.lines.join(" ")).toContain("bounded sample");
  });
});

describe("the unverified-grounding notice", () => {
  const GROUNDED = `<!-- mex:entity
id: mx_01ARZ3NDEKTSV4RRFFQ69G5FAG
type: decision
status: promoted
revision: 1
grounds_to:
  - node: "function:deadbeefdeadbeef"
    fingerprint: "mh:64:aabbccdd"
-->
## Grounded

Body.
`;

  it("does not blame the checkout's code graph for a pass that was never given one", async () => {
    // `runValidate` builds its options from `serviceOptions`, which carries no
    // graph, so this is the branch every CLI run takes. The old wording
    // asserted there was no graph in the checkout — a fact this command does
    // not check, and one that was false on the scaffold that surfaced it.
    const local = harness(true, { "context/grounded.md": GROUNDED });
    await runValidate(local.io, {});
    const notice = local.lines.find((line) => line.includes("grounding checks did not run"));
    expect(notice).toBeDefined();
    expect(notice).toContain("this pass was given no code graph");
    expect(notice).not.toContain("no code graph in this checkout");
  });

  it("carries the discriminator in JSON, so a CI caller can tell the two causes apart", async () => {
    const local = harness(true, { "context/grounded.md": GROUNDED });
    await runValidate(local.io, { json: true });
    const parsed = JSON.parse(local.lines[0]!) as {
      data: { groundingsUnverified: boolean; codeGraphAvailable: boolean };
    };
    expect(parsed.data.groundingsUnverified).toBe(true);
    expect(parsed.data.codeGraphAvailable).toBe(false);
  });
});

describe("query filters", () => {
  it("mean the same thing wherever they apply", async () => {
    expect(filtersFrom({ limit: "25" }).limit).toBe(25);
    expect(filtersFrom({ limit: 25 }).limit).toBe(25);
    // A flag that is not a number is dropped rather than becoming NaN, which
    // would clamp to the default while looking like a deliberate choice.
    expect(filtersFrom({ limit: "lots" }).limit).toBeUndefined();
    expect(filtersFrom({ topic: TOPIC }).topicId).toBe(TOPIC);
    expect(filtersFrom({})).toEqual({});
  });

  it("filter list, query and graph identically", async () => {
    const local = harness();
    for (const run of [
      () => runList(local.io, { json: true, type: "component" }),
      () => runGraph(local.io, { json: true, type: "component" }),
    ]) {
      local.lines.length = 0;
      run();
      const parsed = JSON.parse(local.lines[0]!) as { data: { entities?: unknown[]; nodes?: unknown[] } };
      expect((parsed.data.entities ?? parsed.data.nodes)!).toHaveLength(1);
    }
  });
});

describe("mutation cannot bypass review", () => {
  function operationFile(root: string): string {
    const located = locateEntity(GATEWAY, { scaffoldRoot: root })!;
    const path = join(root, "op.json");
    writeFileSync(
      path,
      JSON.stringify({
        opId: "cli-1",
        type: "set-property",
        actor: { kind: "agent", id: "cli-tests" },
        timestamp: "2026-08-25T10:00:00.000Z",
        entityId: GATEWAY,
        baseRevision: located.entity.revision,
        baseContentHash: located.entity.location.entityContentHash,
        payload: { property: "status", value: "deprecated" },
      }),
      "utf-8",
    );
    return path;
  }

  function createOperationFile(
    root: string,
    file: string,
    type: "decision" | "spec" = "decision",
  ): string {
    const path = join(root, `create-${type}-${file.replace(/[^A-Za-z0-9]/gu, "-")}.json`);
    writeFileSync(path, JSON.stringify({
      opId: `cli-create-${type}-${file.replace(/[^A-Za-z0-9]/gu, "-")}`,
      type: "create-entry",
      actor: { kind: "agent", id: "cli-tests" },
      timestamp: "2026-08-25T10:00:00.000Z",
      payload: {
        file,
        insertAt: { at: "end-of-file" },
        type,
        title: type === "spec" ? "Direct Spec" : "Direct decision",
        body: "A direct Wiki operation used by the command boundary test.",
      },
    }), "utf-8");
    return path;
  }

  function inlineReplacementRelationOperationFile(root: string): string {
    const located = locateEntity(GATEWAY, { scaffoldRoot: root });
    if (located === null) throw new Error("Expected the non-Spec gateway fixture.");
    const path = join(root, "supersede-inline-spec-relation.json");
    writeFileSync(path, JSON.stringify({
      opId: "cli-supersede-inline-spec-relation",
      type: "supersede-entry",
      actor: { kind: "agent", id: "cli-tests" },
      timestamp: "2026-08-25T10:00:00.000Z",
      entityId: GATEWAY,
      baseRevision: located.entity.revision,
      baseContentHash: located.entity.location.entityContentHash,
      payload: {
        replacement: {
          file: "context/direct-replacement.md",
          insertAt: { at: "end-of-file" },
          type: "decision",
          title: "Direct non-Spec replacement",
          body: "Its nested relation still names a governed Spec endpoint.",
          relations: [{ type: "related_to", target: SPEC_ONE }],
        },
      },
    }), "utf-8");
    return path;
  }

  function misfiledExistingOperationFile(
    root: string,
    type: "update-entry" | "move-entry",
  ): string {
    const located = locateEntity(MISFILED_ONE, { scaffoldRoot: root });
    if (located === null) throw new Error("Expected the misfiled decision fixture.");
    const path = join(root, `misfiled-${type}.json`);
    writeFileSync(path, JSON.stringify({
      opId: `cli-misfiled-${type}`,
      type,
      actor: { kind: "agent", id: "cli-tests" },
      timestamp: "2026-08-25T10:00:00.000Z",
      entityId: MISFILED_ONE,
      baseRevision: located.entity.revision,
      baseContentHash: located.entity.location.entityContentHash,
      payload: type === "move-entry"
        ? { file: "context/moved-out.md", insertAt: { at: "end-of-file" } }
        : { body: "A direct update must not mutate a non-Spec entity physically stored under specs." },
    }), "utf-8");
    return path;
  }

  function globalGroups(local: Captured): Array<{
    groupId: string;
    type: string;
    units: Array<{ id: string }>;
  }> {
    local.lines.length = 0;
    runPrepare(
      { ...local.io, codeGraph: CODE_GRAPH },
      { json: true, stage: "global" },
    );
    const prepared = JSON.parse(local.lines[0]!) as {
      ok: boolean;
      data: { groups: Array<{ groupId: string; type: string; units: Array<{ id: string }> }> };
    };
    expect(prepared.ok).toBe(true);
    return prepared.data.groups;
  }

  it("plans and writes nothing without --apply — asserted as a negative", async () => {
    const local = harness();
    const path = operationFile(local.root);
    const before = readFileSync(join(local.root, "context/architecture.md"), "utf-8");

    await runApply(local.io, path, { json: true });
    const parsed = JSON.parse(local.lines[0]!) as { ok: boolean; data: { planned: boolean; applied: boolean } };
    expect(parsed.data.planned).toBe(true);
    expect(parsed.data.applied).toBe(false);
    expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toBe(before);
    expect(readdirSync(local.root)).not.toContain("events");
  });

  it("writes with --apply, and --dry-run overrides it", async () => {
    const local = harness();
    const path = operationFile(local.root);
    const before = readFileSync(join(local.root, "context/architecture.md"), "utf-8");

    const guardedIo = { ...local.io, enforceInboxSpecBoundary: true };
    await runApply(guardedIo, path, { json: true, apply: true, dryRun: true });
    expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toBe(before);

    local.lines.length = 0;
    await runApply(guardedIo, path, { json: true, apply: true });
    expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toContain("status: deprecated");
  });

  it("installs the direct Spec guard on real wiki apply before preview or apply can write", async () => {
    const local = harness();
    const path = createOperationFile(local.root, "context/direct-spec.md", "spec");
    const before = readFileSync(join(local.root, "context/architecture.md"), "utf-8");
    const guardedIo = { ...local.io, enforceInboxSpecBoundary: true };

    for (const flags of [{ json: true }, { json: true, apply: true }]) {
      local.lines.length = 0;
      await runApply(guardedIo, path, flags);
      const envelope = JSON.parse(local.lines[0]!) as {
        ok: boolean;
        data: { planned: boolean; applied: boolean; changedFiles: string[] };
        diagnostics: Array<{ code: string }>;
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.data).toMatchObject({ planned: false, applied: false, changedFiles: [] });
      expect(envelope.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
      expect(local.exit()).toBe(WIKI_EXIT.refused);
      expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toBe(before);
      expect(existsSync(join(local.root, "context", "direct-spec.md"))).toBe(false);
      expect(existsSync(join(local.root, "events"))).toBe(false);
    }
  });

  it("classifies physical Spec destinations through symlink and case aliases before writing", async () => {
    const local = harness();
    mkdirSync(join(local.root, "specs"), { recursive: true });
    symlinkSync("../specs", join(local.root, "context", "spec-alias"), "dir");
    const guardedIo = { ...local.io, enforceInboxSpecBoundary: true };
    const cases = ["context/spec-alias/symlink-escape.md"];
    const caseAlias = join(local.root, "SPECS");
    if (existsSync(caseAlias) && realpathSync(caseAlias) === realpathSync(join(local.root, "specs"))) {
      cases.push("SPECS/case-escape.md");
    }

    for (const destination of cases) {
      local.lines.length = 0;
      const path = createOperationFile(local.root, destination);
      await runApply(guardedIo, path, { json: true, apply: true });
      const envelope = JSON.parse(local.lines[0]!) as {
        ok: boolean;
        data: { planned: boolean; applied: boolean; changedFiles: string[] };
        diagnostics: Array<{ code: string }>;
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.data).toMatchObject({ planned: false, applied: false, changedFiles: [] });
      expect(envelope.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
      expect(local.exit()).toBe(WIKI_EXIT.refused);
      expect(existsSync(join(local.root, "specs", destination.includes("case-") ? "case-escape.md" : "symlink-escape.md"))).toBe(false);
      expect(existsSync(join(local.root, "events"))).toBe(false);
    }
  });

  it("refuses a non-Spec inline replacement whose nested relation targets a Spec", async () => {
    const local = harness(true, { "specs/direct.md": SPEC_DUPLICATES_MD });
    const path = inlineReplacementRelationOperationFile(local.root);
    const before = readFileSync(join(local.root, "context", "architecture.md"), "utf-8");

    await runApply(
      { ...local.io, enforceInboxSpecBoundary: true },
      path,
      { json: true, apply: true },
    );

    const envelope = JSON.parse(local.lines[0]!) as {
      ok: boolean;
      data: { planned: boolean; applied: boolean; changedFiles: string[] };
      diagnostics: Array<{ code: string }>;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toMatchObject({ planned: false, applied: false, changedFiles: [] });
    expect(envelope.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
    expect(local.exit()).toBe(WIKI_EXIT.refused);
    expect(readFileSync(join(local.root, "context", "architecture.md"), "utf-8")).toBe(before);
    expect(existsSync(join(local.root, "context", "direct-replacement.md"))).toBe(false);
    expect(existsSync(join(local.root, "events"))).toBe(false);
  });

  it("refuses update and move-out of non-Spec entities physically stored under specs", async () => {
    const local = harness(true, { "specs/misfiled.md": MISFILED_DECISION_DUPLICATES_MD });
    const before = readFileSync(join(local.root, "specs", "misfiled.md"), "utf-8");

    for (const type of ["update-entry", "move-entry"] as const) {
      local.lines.length = 0;
      await runApply(
        { ...local.io, enforceInboxSpecBoundary: true },
        misfiledExistingOperationFile(local.root, type),
        { json: true, apply: true },
      );
      const envelope = JSON.parse(local.lines[0]!) as {
        ok: boolean;
        data: { planned: boolean; applied: boolean; changedFiles: string[] };
        diagnostics: Array<{ code: string }>;
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.data).toMatchObject({ planned: false, applied: false, changedFiles: [] });
      expect(envelope.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
      expect(local.exit()).toBe(WIKI_EXIT.refused);
      expect(readFileSync(join(local.root, "specs", "misfiled.md"), "utf-8")).toBe(before);
      expect(existsSync(join(local.root, "context", "moved-out.md"))).toBe(false);
      expect(existsSync(join(local.root, "events"))).toBe(false);
    }
  });

  it("installs the direct Spec guard on real wiki propose and refuses a mixed batch atomically", async () => {
    const local = harness(true, {
      "specs/direct.md": SPEC_DUPLICATES_MD,
      "context/conventions.md": CONVENTION_DUPLICATES_MD,
    });
    const groups = globalGroups(local);
    const spec = groups.find((group) => group.type === "spec")!;
    const convention = groups.find((group) => group.type === "convention")!;
    expect(spec.units).toHaveLength(2);
    expect(convention.units).toHaveLength(2);
    const response = join(local.root, "mixed-global-response.json");
    writeFileSync(response, JSON.stringify({
      stage: "global",
      actions: [spec, convention].map((group) => ({
        groupId: group.groupId,
        action: "promote_one",
        winnerId: group.units[0]!.id,
        reasoning: "This is the clearest surviving duplicate in the reviewed group.",
      })),
    }), "utf-8");
    const beforeSpec = readFileSync(join(local.root, "specs", "direct.md"), "utf-8");
    const beforeConvention = readFileSync(join(local.root, "context", "conventions.md"), "utf-8");
    local.lines.length = 0;

    runPropose(
      { ...local.io, codeGraph: CODE_GRAPH, enforceInboxSpecBoundary: true },
      response,
      { json: true, apply: true, stage: "global" },
    );

    const envelope = JSON.parse(local.lines[0]!) as {
      ok: boolean;
      data: { operations: unknown[]; applied: boolean; changedFiles: string[] };
      diagnostics: Array<{ code: string }>;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toMatchObject({ operations: [], applied: false, changedFiles: [] });
    expect(envelope.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
    expect(local.exit()).toBe(WIKI_EXIT.refused);
    expect(readFileSync(join(local.root, "specs", "direct.md"), "utf-8")).toBe(beforeSpec);
    expect(readFileSync(join(local.root, "context", "conventions.md"), "utf-8")).toBe(beforeConvention);
    expect(existsSync(join(local.root, "events"))).toBe(false);
  });

  it("keeps non-Spec wiki propose available when the product guard is installed", async () => {
    const local = harness(true, { "context/conventions.md": CONVENTION_DUPLICATES_MD });
    const convention = globalGroups(local).find((group) => group.type === "convention")!;
    const response = join(local.root, "safe-global-response.json");
    writeFileSync(response, JSON.stringify({
      stage: "global",
      actions: [{
        groupId: convention.groupId,
        action: "promote_one",
        winnerId: convention.units[0]!.id,
        reasoning: "This is the clearest surviving duplicate in the reviewed group.",
      }],
    }), "utf-8");
    const before = readFileSync(join(local.root, "context", "conventions.md"), "utf-8");
    local.lines.length = 0;

    runPropose(
      { ...local.io, codeGraph: CODE_GRAPH, enforceInboxSpecBoundary: true },
      response,
      { json: true, stage: "global" },
    );

    const envelope = JSON.parse(local.lines[0]!) as {
      ok: boolean;
      data: { operations: unknown[]; applied: boolean; diff: string | null };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.operations.length).toBeGreaterThan(0);
    expect(envelope.data.applied).toBe(false);
    expect(envelope.data.diff).not.toBeNull();
    expect(local.exit()).toBe(WIKI_EXIT.ok);
    expect(readFileSync(join(local.root, "context", "conventions.md"), "utf-8")).toBe(before);
    expect(existsSync(join(local.root, "events"))).toBe(false);
  });

  it("refuses a mixed propose batch when a non-Spec mutation originates under specs", async () => {
    const local = harness(true, {
      "specs/misfiled.md": MISFILED_DECISION_DUPLICATES_MD,
      "context/conventions.md": CONVENTION_DUPLICATES_MD,
    });
    const groups = globalGroups(local);
    const decision = groups.find((group) => group.type === "decision")!;
    const convention = groups.find((group) => group.type === "convention")!;
    const response = join(local.root, "mixed-misfiled-response.json");
    writeFileSync(response, JSON.stringify({
      stage: "global",
      actions: [decision, convention].map((group) => ({
        groupId: group.groupId,
        action: "promote_one",
        winnerId: group.units[0]!.id,
        reasoning: "This is the clearest surviving duplicate in the reviewed group.",
      })),
    }), "utf-8");
    const beforeDecision = readFileSync(join(local.root, "specs", "misfiled.md"), "utf-8");
    const beforeConvention = readFileSync(join(local.root, "context", "conventions.md"), "utf-8");
    local.lines.length = 0;

    runPropose(
      { ...local.io, codeGraph: CODE_GRAPH, enforceInboxSpecBoundary: true },
      response,
      { json: true, apply: true, stage: "global" },
    );

    const envelope = JSON.parse(local.lines[0]!) as {
      ok: boolean;
      data: { operations: unknown[]; applied: boolean; changedFiles: string[] };
      diagnostics: Array<{ code: string }>;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toMatchObject({ operations: [], applied: false, changedFiles: [] });
    expect(envelope.diagnostics.map((entry) => entry.code)).toContain("WRITE_SCOPE_VIOLATION");
    expect(local.exit()).toBe(WIKI_EXIT.refused);
    expect(readFileSync(join(local.root, "specs", "misfiled.md"), "utf-8")).toBe(beforeDecision);
    expect(readFileSync(join(local.root, "context", "conventions.md"), "utf-8")).toBe(beforeConvention);
    expect(existsSync(join(local.root, "events"))).toBe(false);
  });
});

describe("no command builds its own envelope", () => {
  it("holds across the command module", async () => {
    // §20.7's parity, structurally: there is one definition, so a command that
    // assembled the shape by hand would be the second one. Comments stripped,
    // so prose about the rule is not read as a breach of it.
    const source = readFileSync(resolve(__dirname, "..", "commands.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/schemaVersion\s*:/);
    expect(source).not.toMatch(/\bok\s*:\s*(true|false)/);
    // And it does use the shared one, so the assertion above is not passing
    // because the file stopped producing envelopes at all.
    expect(source).toContain("envelopeFor(");
    expect(source).toContain("exitCodeFor(");
  });
});
