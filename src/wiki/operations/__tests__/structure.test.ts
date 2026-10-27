/**
 * An authored entry takes its place in the Wiki's structure as it is written.
 *
 * With `deriveStructure` (what `wiki apply` sets), a section entry with no
 * `refines` of its own refines the entity enclosing it, and a file with no
 * file-level entity gets one in the same operation. Without it, every byte is
 * exactly what the caller asked for: migration and synthesis rely on that.
 */

import { afterEach, describe, expect, it } from "vitest";
import { applyOperation, type ApplyOptions } from "../apply.js";
import { checkFrontmatterCompleteness } from "../../../drift/checkers/frontmatter-completeness.js";
import { extractFrontmatter } from "../../../markdown.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { classifyFile } from "../../migration/classify.js";
import { inventoryScaffold } from "../../migration/inventory.js";
import { ARCH, GATEWAY, codesOf, envelope, makeScaffold, type Scaffold } from "./helpers.js";

const scaffolds: Scaffold[] = [];
function scaffold(files: Record<string, string> = {}): Scaffold {
  const made = makeScaffold(files);
  scaffolds.push(made);
  return made;
}
afterEach(() => {
  while (scaffolds.length > 0) scaffolds.pop()!.dispose();
});

const options = (target: Scaffold): ApplyOptions => ({ scaffoldRoot: target.root, deriveStructure: true });

function fact(file: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file,
    insertAt: { at: "end-of-file" },
    type: "fact",
    title: "Requests time out after 30 seconds",
    body: "`TIMEOUT_MS` is `30000`.",
    headingDepth: 2,
    status: "promoted",
    ...extra,
  };
}

function entitiesOf(target: Scaffold, path: string) {
  return parseWikiMarkdown({ path, text: target.read(path) }).entities;
}

const refinesOf = (target: Scaffold, id: string, path: string) =>
  target.entity(id, path).relations.filter((relation) => relation.type === "refines").map((relation) => relation.target);

describe("refines to the enclosing entity", () => {
  it("links an entry at the end of a file to the file-level entity", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/architecture.md")), options(target));
    expect(applied.ok).toBe(true);
    expect(applied.createdIds).toHaveLength(1);
    expect(refinesOf(target, applied.createdIds[0]!, "context/architecture.md")).toEqual([ARCH]);
  });

  it("links an entry nested under a section to that section", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/architecture.md", {
      insertAt: { at: "after-entity", entityId: GATEWAY },
      headingDepth: 3,
    })), options(target));
    expect(applied.ok).toBe(true);
    expect(refinesOf(target, applied.createdIds[0]!, "context/architecture.md")).toEqual([GATEWAY]);
  });

  it("leaves an entry that names its own refines alone", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/architecture.md", {
      relations: [{ type: "refines", target: GATEWAY }],
    })), options(target));
    expect(applied.ok).toBe(true);
    expect(refinesOf(target, applied.createdIds[0]!, "context/architecture.md")).toEqual([GATEWAY]);
  });

  it("adds nothing when the caller did not ask for structure", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/architecture.md")), { scaffoldRoot: target.root });
    expect(applied.ok).toBe(true);
    expect(target.entity(applied.createdIds[0]!, "context/architecture.md").relations).toEqual([]);
  });
});

describe("a file with no file-level entity", () => {
  it("is stamped from its root type declaration, which moves under mex:", () => {
    const target = scaffold({
      "context/routing.md": "---\nname: Routing\ndescription: How requests find handlers\ntype: component\n---\n\n# Routing\n\nRequests are matched by a trie.\n",
    });
    const applied = applyOperation(envelope(target, "create-entry", fact("context/routing.md")), options(target));
    expect(applied.ok).toBe(true);
    expect(applied.createdIds).toHaveLength(2);
    const [entryId, parentId] = applied.createdIds as [string, string];
    const parent = target.entity(parentId, "context/routing.md");
    expect(parent).toMatchObject({ type: "component", title: "Routing", status: "promoted" });
    expect(refinesOf(target, entryId, "context/routing.md")).toEqual([parentId]);
    const text = target.read("context/routing.md");
    expect(text).not.toMatch(/^type: component$/m);
    expect(text).toContain("Requests are matched by a trie.");
    expect(text).toContain("description: How requests find handlers");
  });

  it("takes its type from migration's path rules", () => {
    const target = scaffold({
      "context/stack.md": "---\nname: stack\n---\n\n# Stack\n\nTypeScript on Node.\n",
      "patterns/add-route.md": "# Add a route\n\nSteps.\n",
    });
    const stack = applyOperation(envelope(target, "create-entry", fact("context/stack.md")), options(target));
    const pattern = applyOperation(envelope(target, "create-entry", fact("patterns/add-route.md")), options(target));
    expect(stack.ok && pattern.ok).toBe(true);
    expect(target.entity(stack.createdIds[1]!, "context/stack.md")).toMatchObject({ type: "architecture", title: "stack" });
    expect(target.entity(pattern.createdIds[1]!, "patterns/add-route.md")).toMatchObject({ type: "pattern", title: "Add a route" });
  });

  it("is stamped as a component when it is an untyped context file", () => {
    const target = scaffold({ "context/billing.md": "---\nname: Billing\n---\n\n# Billing\n\nInvoices.\n" });
    const applied = applyOperation(envelope(target, "create-entry", fact("context/billing.md")), options(target));
    expect(applied.ok).toBe(true);
    expect(target.entity(applied.createdIds[1]!, "context/billing.md").type).toBe("component");
  });

  it("gets a frontmatter block when it has none, and keeps its prose", () => {
    const target = scaffold({ "context/queue.md": "# Job queue\n\nJobs retry three times.\n" });
    const applied = applyOperation(envelope(target, "create-entry", fact("context/queue.md")), options(target));
    expect(applied.ok).toBe(true);
    const text = target.read("context/queue.md");
    expect(text.startsWith("---\nmex:\n")).toBe(true);
    expect(text).toContain("# Job queue\n\nJobs retry three times.\n");
    expect(target.entity(applied.createdIds[1]!, "context/queue.md")).toMatchObject({ type: "component", title: "Job queue" });
  });

  it("creates a new file with a title, a file-level entity and the entry", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/api-gateway.md")), options(target));
    expect(applied.ok).toBe(true);
    const text = target.read("context/api-gateway.md");
    expect(text).toContain("# Api Gateway");
    const entities = entitiesOf(target, "context/api-gateway.md");
    expect(entities.map((entry) => entry.metadataKind).sort()).toEqual(["comment", "frontmatter"]);
    const [entryId, parentId] = applied.createdIds as [string, string];
    expect(refinesOf(target, entryId, "context/api-gateway.md")).toEqual([parentId]);
    // A later migration sees an adopted file, not one to adopt again.
    const file = inventoryScaffold({ scaffoldRoot: target.root }).files.find((entry) => entry.path === "context/api-gateway.md")!;
    expect(classifyFile(file).skipped).toBe(true);
  });

  it("is stamped once: a second entry refines the same parent", () => {
    const target = scaffold();
    const first = applyOperation(envelope(target, "create-entry", fact("context/sessions.md")), options(target));
    const second = applyOperation(envelope(target, "create-entry", fact("context/sessions.md", { title: "Sessions expire" })), options(target));
    expect(first.ok && second.ok).toBe(true);
    expect(second.createdIds).toHaveLength(1);
    expect(refinesOf(target, second.createdIds[0]!, "context/sessions.md")).toEqual([first.createdIds[1]]);
    expect(entitiesOf(target, "context/sessions.md").filter((entry) => entry.metadataKind === "frontmatter")).toHaveLength(1);
  });

  it("carries an entry at the very start of a file without frontmatter as one edit", () => {
    const target = scaffold({ "context/cache.md": "Cache entries live for a minute.\n" });
    const applied = applyOperation(envelope(target, "create-entry", fact("context/cache.md", { insertAt: { at: "start-of-file" } })), options(target));
    expect(applied.ok).toBe(true);
    const text = target.read("context/cache.md");
    expect(text).toContain("Cache entries live for a minute.");
    expect(entitiesOf(target, "context/cache.md")).toHaveLength(2);
  });
});

describe("the frontmatter of a file wiki apply creates", () => {
  const completeness = (target: Scaffold, path: string) =>
    checkFrontmatterCompleteness(extractFrontmatter(target.read(path)), `.mex/${path}`);

  it("names the file, describes it from the first entry and dates it, so mex check has nothing to report", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/api-gateway.md")), options(target));
    expect(applied.ok).toBe(true);
    const frontmatter = extractFrontmatter(target.read("context/api-gateway.md")) as Record<string, unknown>;
    expect(frontmatter["name"]).toBe("api-gateway");
    expect(frontmatter["description"]).toBe("Knowledge entries, starting with: Requests time out after 30 seconds");
    expect(String(frontmatter["last_updated"])).toContain("2026-08-24");
    expect(completeness(target, "context/api-gateway.md")).toEqual([]);
    // The entities are exactly what they were without the new keys.
    expect(entitiesOf(target, "context/api-gateway.md").map((entry) => entry.metadataKind).sort()).toEqual(["comment", "frontmatter"]);
    expect(target.read("context/api-gateway.md")).toContain("# Api Gateway");
  });

  it("takes the description from the payload when there is one", () => {
    const target = scaffold();
    const applied = applyOperation(envelope(target, "create-entry", fact("context/billing.md", { description: "How invoices are rounded and retried." })), options(target));
    expect(applied.ok).toBe(true);
    expect((extractFrontmatter(target.read("context/billing.md")) as Record<string, unknown>)["description"]).toBe("How invoices are rounded and retried.");
    expect(completeness(target, "context/billing.md")).toEqual([]);
  });

  it("gives a second entry into the same file no second frontmatter", () => {
    const target = scaffold();
    applyOperation(envelope(target, "create-entry", fact("context/sessions.md")), options(target));
    applyOperation(envelope(target, "create-entry", fact("context/sessions.md", { title: "Sessions expire" })), options(target));
    expect(target.read("context/sessions.md").match(/^---$/gm)).toHaveLength(2);
    expect(completeness(target, "context/sessions.md")).toEqual([]);
  });

  it("adds nothing to a file that already exists", () => {
    const target = scaffold({ "context/queue.md": "# Job queue\n\nJobs retry three times.\n" });
    applyOperation(envelope(target, "create-entry", fact("context/queue.md", { description: "ignored" })), options(target));
    const text = target.read("context/queue.md");
    expect(text.startsWith("---\nmex:\n")).toBe(true);
    expect(text).not.toContain("description");
  });

  it("covers a new file written without derived structure, and a new file-level entity", () => {
    const plain = scaffold();
    expect(applyOperation(envelope(plain, "create-entry", fact("patterns/retry.md")), { scaffoldRoot: plain.root }).ok).toBe(true);
    expect((extractFrontmatter(plain.read("patterns/retry.md")) as Record<string, unknown>)["name"]).toBe("retry");
    expect(entitiesOf(plain, "patterns/retry.md")).toHaveLength(1);
    expect(completeness(plain, "patterns/retry.md")).toEqual([]);

    const fileLevel = scaffold();
    const { headingDepth: _depth, ...payload } = fact("context/overview.md", { type: "component", title: "Overview" });
    expect(applyOperation(envelope(fileLevel, "create-entry", payload), { scaffoldRoot: fileLevel.root }).ok).toBe(true);
    const text = fileLevel.read("context/overview.md");
    expect(text.match(/^name: overview$/m)).not.toBeNull();
    expect(text.match(/^---$/gm)).toHaveLength(2);
    expect(completeness(fileLevel, "context/overview.md")).toEqual([]);
  });
});

describe("files that are never stamped", () => {
  for (const [path, text] of [
    ["ROUTER.md", "---\nname: router\n---\n\n# Router\n\nWhere to look.\n"],
    ["AGENTS.md", "# Agents\n\nCommands.\n"],
    ["SETUP.md", "# Setup\n\nSteps.\n"],
    ["SYNC.md", "# Sync\n\nSteps.\n"],
    ["patterns/INDEX.md", "# Index\n\n| a | b |\n"],
    ["patterns/README.md", "# Patterns\n\nHow to write one.\n"],
    ["context/decisions.md", "# Decisions\n\n## Decision log\n"],
  ] as const) {
    it(`writes into ${path} without a parent and says so`, () => {
      const target = scaffold({ [path]: text });
      const applied = applyOperation(envelope(target, "create-entry", fact(path)), options(target));
      expect(applied.ok).toBe(true);
      expect(applied.createdIds).toHaveLength(1);
      expect(entitiesOf(target, path).filter((entry) => entry.metadataKind === "frontmatter")).toEqual([]);
      expect(target.entity(applied.createdIds[0]!, path).relations).toEqual([]);
      const notice = applied.diagnostics.find((entry) => entry.code === "ORPHANED_ENTITY");
      expect(notice?.severity).toBe("info");
      expect(notice?.message).toContain(path);
    });
  }

  it("refuses to choose between a declared type and a path rule", () => {
    const target = scaffold({ "context/setup.md": "---\nname: setup\ntype: component\n---\n\n# Setup\n" });
    const applied = applyOperation(envelope(target, "create-entry", fact("context/setup.md")), options(target));
    expect(applied.ok).toBe(true);
    expect(codesOf(applied.diagnostics)).toContain("ORPHANED_ENTITY");
    expect(target.read("context/setup.md")).toContain("type: component");
  });
});
