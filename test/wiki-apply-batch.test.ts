/**
 * `mex wiki apply` with a batch, against a real code graph.
 *
 * The agent-facing contract end to end: an array of `create-entry` operations
 * naming code by file and symbol or line (TypeScript through the compiler
 * extractor, Python through tree-sitter) is resolved, written atomically with
 * fingerprints and body hashes, linked to its parents, and then survives setup
 * finalization on a scaffold where some files were stamped by apply and the
 * rest are still plain templates.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import { runApply, type CommandIo } from "../src/wiki/cli/commands.js";
import { parseWikiMarkdown } from "../src/wiki/markdown/codec.js";
import { inventoryScaffold } from "../src/wiki/migration/inventory.js";
import { classifyFile } from "../src/wiki/migration/classify.js";
import { wikiValidate } from "../src/wiki/service/validate.js";
import { WIKI_APPLY_HELP } from "../src/wiki/cli/apply-help.js";
import { finalizeCodeRepoSetup } from "../src/setup/index.js";
import { inspectWikiContractIndex } from "../src/wiki/query/contract-session.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ROUTER_TS = `export class Router {
  add(method: string, path: string): void {
    this.routes.push(method + " " + path);
  }
  match(path: string): string | null {
    return this.routes.find((route) => route.endsWith(path)) ?? null;
  }
  routes: string[] = [];
}

export class Group {
  add(prefix: string): string {
    return prefix.replace(/\\/$/, "");
  }
}

export function parseBody(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 1024 ? trimmed.slice(0, 1024) : trimmed;
}
`;

const APP_PY = `class Service:
    def start(self, port):
        self.port = port
        return port

    def stop(self):
        self.port = None
        return None


def start(port):
    service = Service()
    return service.start(port)
`;

/** A git repository with source, a built graph, and the shipped scaffold templates. */
async function project(): Promise<{ root: string; mex: string; io: CommandIo; lines: string[]; exit: () => number }> {
  const root = mkdtempSync(join(tmpdir(), "mex-apply-batch-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "router.ts"), ROUTER_TS);
  writeFileSync(join(root, "src", "app.py"), APP_PY);
  const mex = join(root, ".mex");
  cpSync(resolve("templates"), mex, { recursive: true, filter: (source) => !source.includes("agent-memory") && !source.includes(".tool-configs") });
  writeFileSync(join(mex, "config.json"), "{}\n");
  const port = createRepositoryGraphPort(root);
  await port.rebuild();
  const lines: string[] = [];
  let code = 0;
  const io: CommandIo = {
    projectRoot: root,
    scaffoldRoot: mex,
    groundingBridge: port,
    write: (line) => lines.push(line),
    setExitCode: (value) => { code = value; },
  };
  return { root, mex, io, lines, exit: () => code };
}

function fact(opId: string, file: string, title: string, groundsTo: unknown[]): Record<string, unknown> {
  return {
    opId,
    type: "create-entry",
    actor: { kind: "agent", id: "test-agent" },
    timestamp: "2026-10-23T10:00:00.000Z",
    reason: "Setup population",
    payload: {
      file,
      insertAt: { at: "end-of-file" },
      type: "fact",
      title,
      body: `${title}.`,
      headingDepth: 2,
      status: "promoted",
      groundsTo,
      aliases: ["route registration", "request routing", "router setup"],
    },
  };
}

const entitiesOf = (mex: string, path: string) =>
  parseWikiMarkdown({ path, text: readFileSync(join(mex, path), "utf-8") }).entities;

describe("wiki apply with a batch and a real graph", () => {
  it("resolves TypeScript and Python names and lines, and reports ambiguity with candidates", async () => {
    const { mex, io, lines, exit } = await project();
    const ops = join(mex, "local", "ops.json");
    mkdirSync(join(mex, "local"), { recursive: true });

    // Ambiguous `add` and a misspelt name: nothing is written, both reported.
    writeFileSync(ops, JSON.stringify([
      fact("t-0", "context/routing.md", "Bodies are trimmed", [{ file: "src/router.ts", symbol: "parseBody" }]),
      fact("t-1", "context/routing.md", "Routes are added", [{ file: "src/router.ts", symbol: "add" }]),
      fact("t-2", "context/routing.md", "Typo", [{ file: "src/router.ts", symbol: "parseBdy" }]),
    ]));
    await runApply(io, ops, { json: true, apply: true });
    const refused = JSON.parse(lines.at(-1)!);
    expect(refused.data.applied).toBe(false);
    expect(exit()).not.toBe(0);
    expect(existsSync(join(mex, "context", "routing.md"))).toBe(false);
    const ambiguous = refused.diagnostics.find((entry: { code: string }) => entry.code === "GROUNDING_AMBIGUOUS");
    expect(ambiguous.message).toMatch(/^Operation 1 \(t-1\): /);
    expect(ambiguous.message).toContain("Router.add (method");
    expect(ambiguous.message).toContain("Group.add (method");
    const missing = refused.diagnostics.find((entry: { code: string }) => entry.code === "GROUNDING_NOT_FOUND");
    expect(missing.message).toMatch(/^Operation 2 \(t-2\): /);
    expect(refused.data.operations.map((operation: { status: string }) => operation.status)).toEqual(["blocked", "refused", "refused"]);
    expect(missing.message).toContain("Nearest: parseBody");

    // Fixed: qualified names, a line, and Python by name and module path.
    writeFileSync(ops, JSON.stringify([
      fact("t-0", "context/routing.md", "Bodies are trimmed", [{ file: "src/router.ts", symbol: "parseBody" }]),
      fact("t-1", "context/routing.md", "Routes are added", [{ file: "src/router.ts", symbol: "Router.add" }]),
      fact("t-2", "context/routing.md", "Group prefixes lose a trailing slash", [{ file: "src\\router.ts", line: 13 }]),
      fact("t-3", "context/architecture.md", "The service starts on a port", [{ file: "./src/app.py", symbol: "app.start" }]),
      fact("t-4", "context/architecture.md", "Stopping clears the port", [{ file: "src/app.py", symbol: "Service.stop" }]),
      fact("t-5", "context/architecture.md", "Start stores the port", [{ file: "src/app.py", line: 3 }]),
    ]));
    lines.length = 0;
    await runApply(io, ops, { json: true, apply: true });
    const applied = JSON.parse(lines.at(-1)!);
    expect(applied.diagnostics.filter((entry: { severity: string }) => entry.severity === "error")).toEqual([]);
    expect(applied.data.applied).toBe(true);
    expect(applied.data.operations.map((operation: { status: string }) => operation.status)).toEqual(Array(6).fill("applied"));

    const routing = entitiesOf(mex, "context/routing.md");
    const architecture = entitiesOf(mex, "context/architecture.md");
    const byTitle = (title: string) => [...routing, ...architecture].find((entry) => entry.entity.title === title)!.entity;
    const grounding = (title: string) => byTitle(title).groundsTo[0]!;
    for (const title of ["Bodies are trimmed", "Routes are added", "Group prefixes lose a trailing slash", "The service starts on a port", "Stopping clears the port", "Start stores the port"]) {
      expect(grounding(title).fingerprint, title).toMatch(/^mh2?:/);
      expect(grounding(title).bodyHash, title).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(grounding("Bodies are trimmed").file).toBe("src/router.ts");
    expect(grounding("The service starts on a port").file).toBe("src/app.py");
    expect(grounding("Routes are added").node).not.toBe(grounding("Group prefixes lose a trailing slash").node);
    expect(grounding("Start stores the port").node).not.toBe(grounding("The service starts on a port").node);
    expect(byTitle("Routes are added").metadata?.["aliases"]).toEqual(["route registration", "request routing", "router setup"]);

    // Every fact refines its file's file-level entity, stamped by the batch.
    for (const [path, entities] of [["context/routing.md", routing], ["context/architecture.md", architecture]] as const) {
      const parent = entities.find((entry) => entry.metadataKind === "frontmatter")!.entity;
      for (const entry of entities.filter((item) => item.entity.type === "fact")) {
        expect(entry.entity.relations, `${path} ${entry.entity.title}`).toContainEqual(expect.objectContaining({ type: "refines", target: parent.id }));
      }
    }
    expect(architecture.find((entry) => entry.metadataKind === "frontmatter")!.entity.type).toBe("architecture");
    expect(routing.find((entry) => entry.metadataKind === "frontmatter")!.entity.type).toBe("component");

    // Re-running the same file is a no-op.
    const before = readFileSync(join(mex, "context", "architecture.md"), "utf-8");
    lines.length = 0;
    await runApply(io, ops, { json: true, apply: true });
    expect(JSON.parse(lines.at(-1)!).data.replayed).toBe(true);
    expect(readFileSync(join(mex, "context", "architecture.md"), "utf-8")).toBe(before);
  }, 120_000);

  it("leaves every eligible file an entity and every fact with a parent after setup finalizes", async () => {
    const { root, mex, io, lines } = await project();
    // A populated scaffold: the agent filled the templates as plain Markdown,
    // wrote two subsystem files with a declared type, and added facts with one
    // batch into architecture.md and one of the subsystem files.
    const fill = (path: string, transform: (text: string) => string) =>
      writeFileSync(join(mex, path), transform(readFileSync(join(mex, path), "utf-8")));
    fill("context/decisions.md", (text) => `${text}\n### Use a trie for routes\n**Decision:** Routes are matched with a trie.\n**Reasoning:** Prefix lookups stay linear in the path length.\n`);
    writeFileSync(join(mex, "context", "routing.md"), "---\nname: Routing\ndescription: How requests reach handlers\ntype: component\n---\n\n# Routing\n\nRequests are matched against registered routes in order of registration, and the first route whose method and path match wins.\n");
    writeFileSync(join(mex, "context", "jobs.md"), "---\nname: Jobs\ndescription: Background services\ntype: component\n---\n\n# Jobs\n\nThe service runs on one port and stops by clearing it; there is no queue between start and stop.\n");
    writeFileSync(join(mex, "patterns", "add-route.md"), "---\nname: add-route\ndescription: Add a route\n---\n\n# Add a route\n\n1. Call `Router.add` with the method and path.\n");
    mkdirSync(join(mex, "local"), { recursive: true });
    const ops = join(mex, "local", "facts.json");
    writeFileSync(ops, JSON.stringify([
      fact("s-0", "context/architecture.md", "Routes are added", [{ file: "src/router.ts", symbol: "Router.add" }]),
      fact("s-1", "context/architecture.md", "Bodies are trimmed", [{ file: "src/router.ts", symbol: "parseBody" }]),
      fact("s-2", "context/routing.md", "Matching takes the first route", [{ file: "src/router.ts", symbol: "Router.match" }]),
    ]));
    await runApply(io, ops, { json: true, apply: true });
    expect(JSON.parse(lines.at(-1)!).data.applied).toBe(true);
    // Apply stamped only the files it wrote into.
    for (const path of ["context/stack.md", "context/conventions.md", "context/decisions.md", "context/setup.md", "context/jobs.md"]) {
      expect(entitiesOf(mex, path), path).toEqual([]);
    }

    // Facts made some files canonical; the scaffold still reads as needing its
    // setup migration, so the Hub and capabilities route to finalization.
    const indexPath = join(mex, "wiki.db");
    expect(inspectWikiContractIndex({ scaffoldRoot: mex, indexPath }).state).toBe("migration_required");

    const messages: string[] = [];
    await finalizeCodeRepoSetup(root, mex, { onMessage: (message) => messages.push(message) });
    expect(inspectWikiContractIndex({ scaffoldRoot: mex, indexPath }).state).toBe("fresh");
    // A finalized scaffold whose disposable index is lost only needs a rebuild.
    rmSync(indexPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) rmSync(`${indexPath}${suffix}`, { force: true });
    expect(inspectWikiContractIndex({ scaffoldRoot: mex, indexPath }).state).toBe("missing");

    const inventory = inventoryScaffold({ scaffoldRoot: mex });
    const facts = inventory.files.flatMap((file) => file.parsed.entities).filter((entry) => entry.entity.type === "fact");
    expect(facts).toHaveLength(3);
    const ids = new Set(inventory.files.flatMap((file) => file.parsed.entities.map((entry) => entry.entity.id)));
    for (const entry of facts) {
      const parents = entry.entity.relations.filter((relation) => relation.type === "refines").map((relation) => relation.target);
      expect(parents, entry.entity.title).toHaveLength(1);
      expect(ids.has(parents[0]!), entry.entity.title).toBe(true);
    }
    // Every file migration types now holds a file-level entity, whoever stamped it.
    for (const path of ["context/architecture.md", "context/stack.md", "context/conventions.md", "context/setup.md", "context/routing.md", "context/jobs.md", "patterns/add-route.md"]) {
      const file = inventory.files.find((entry) => entry.path === path)!;
      expect(file.parsed.entities.some((entry) => entry.metadataKind === "frontmatter"), path).toBe(true);
    }
    // The decision log behaves as before: its marked entry is a decision.
    expect(entitiesOf(mex, "context/decisions.md").map((entry) => entry.entity.type)).toContain("decision");
    // Navigation files stay free of ids.
    for (const path of ["ROUTER.md", "AGENTS.md", "patterns/INDEX.md", "patterns/README.md"]) {
      expect(entitiesOf(mex, path), path).toEqual([]);
    }
    // Nothing is left for migration to adopt.
    expect(inventory.files.filter((file) => classifyFile(file).candidates.length > 0).map((file) => file.path)).toEqual([]);
    const validated = wikiValidate({ scaffoldRoot: mex, projectRoot: root });
    const orphaned = validated.diagnostics.filter((entry) => entry.code === "ORPHANED_ENTITY");
    expect(orphaned.filter((entry) => facts.some((item) => item.entity.id === entry.entityId))).toEqual([]);
    expect(validated.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  }, 180_000);

  it("documents the array form and the three reference forms in --help", () => {
    expect(WIKI_APPLY_HELP).toContain("JSON array of up to 200 envelopes");
    expect(WIKI_APPLY_HELP).toContain('{"file": "src/app.ts", "symbol": "parseBody"}');
    expect(WIKI_APPLY_HELP).toContain('{"file": "src/app.ts", "line": 120}');
    expect(WIKI_APPLY_HELP).toContain('{"node": "<graph node id>"}');
    expect(readFileSync(resolve("src/cli.ts"), "utf-8")).toContain('.addHelpText("after", WIKI_APPLY_HELP)');
  });
});
