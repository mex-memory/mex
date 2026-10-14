/**
 * Small scaffolds for the context tests: a temporary project with a `.mex`
 * Wiki, optionally a real code graph, and no network or model.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphEngine } from "../../graph/engine-impl.js";
import { openSqlite } from "../../graph/db/sqlite.js";
import { generateEntityId } from "../../wiki/model/ids.js";
import type { ContextRoot } from "../root.js";
import type { Embedder } from "../dense.js";

export interface FixtureGrounding {
  node: string;
  bodyHash?: string;
  file?: string;
}

export interface FixtureEntity {
  id?: string;
  type?: string;
  title: string;
  body: string;
  aliases?: string[];
  groundings?: FixtureGrounding[];
}

export interface Fixture {
  root: string;
  context: ContextRoot;
  /** Write (or rewrite) a Markdown file under `.mex/`. */
  writeScaffoldFile(relative: string, text: string): void;
  /** Write a source file under the project root. */
  writeSource(relative: string, text: string): void;
  cleanup(): void;
}

const roots: string[] = [];

export function createProject(prefix = "mex-context-"): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const scaffold = join(root, ".mex");
  mkdirSync(join(scaffold, "context"), { recursive: true });
  writeFileSync(join(scaffold, "ROUTER.md"), "# Router\n");
  return {
    root,
    context: { projectRoot: root, scaffoldRoot: scaffold, localDir: join(scaffold, "local") },
    writeScaffoldFile(relative, text) {
      const path = join(scaffold, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    },
    writeSource(relative, text) {
      const path = join(root, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function cleanupProjects(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** One `<!-- mex:entity -->` block with its heading and body. */
export function entityBlock(entity: FixtureEntity): { id: string; text: string } {
  const id = entity.id ?? generateEntityId();
  const lines = ["<!-- mex:entity", `id: ${id}`, `type: ${entity.type ?? "fact"}`, "status: promoted", "revision: 1"];
  if (entity.aliases && entity.aliases.length > 0) {
    // Authored aliases live in the entity's free-form `metadata` map.
    lines.push("metadata:", "  aliases:", ...entity.aliases.map((alias) => `    - ${JSON.stringify(alias)}`));
  }
  if (entity.groundings && entity.groundings.length > 0) {
    lines.push("grounds_to:");
    for (const g of entity.groundings) {
      lines.push(`  - node: ${JSON.stringify(g.node)}`, '    fingerprint: "mh:1:00"');
      if (g.file) lines.push(`    file: ${JSON.stringify(g.file)}`);
      if (g.bodyHash) lines.push(`    bodyHash: ${JSON.stringify(g.bodyHash)}`);
    }
  }
  lines.push("-->", `### ${entity.title}`, "", entity.body, "");
  return { id, text: lines.join("\n") };
}

/** A scaffold file of entity blocks; returns the minted ids in order. */
export function writeEntities(fixture: Fixture, relative: string, entities: readonly FixtureEntity[]): string[] {
  const blocks = entities.map(entityBlock);
  fixture.writeScaffoldFile(relative, `# Notes\n\n${blocks.map((b) => b.text).join("\n")}`);
  return blocks.map((b) => b.id);
}

/** Build the real code graph for the project (`.mex/graph.db`). */
export async function buildGraph(fixture: Fixture): Promise<void> {
  const engine = createGraphEngine({ rootDir: fixture.root });
  await engine.build();
  engine.close();
}

export interface GraphSymbol {
  id: string;
  name: string;
  bodyHash: string;
  file: string;
}

export function graphSymbol(fixture: Fixture, name: string): GraphSymbol {
  const db = openSqlite(join(fixture.context.scaffoldRoot, "graph.db"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT id, name, body_hash AS bodyHash, file_path AS file FROM nodes WHERE name = ? AND kind IN ('function','method') LIMIT 1")
      .get(name) as GraphSymbol | undefined;
    if (!row) throw new Error(`The fixture graph has no symbol ${name}.`);
    return row;
  } finally {
    db.close();
  }
}

/**
 * A deterministic stand-in for the model: hashed bag-of-words, unit length.
 * Texts that share words have a high cosine; unrelated texts are near zero.
 */
export function fakeEmbedder(calls: string[] = []): Embedder {
  const dims = 128;
  return {
    modelId: "fake-bow:test",
    async embed(text: string): Promise<Float32Array> {
      calls.push(text);
      const v = new Float32Array(dims);
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i += 1) h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0;
        v[h % dims]! += 1;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    },
  };
}

/** Facts about unrelated subjects, so each one has a distinct vocabulary. */
export const STANDARD_FACTS: FixtureEntity[] = [
  {
    title: "Invoice totals round tax per line before summing",
    body: "Invoice totals compute the tax of every line item separately and round each to whole cents before the lines are summed, so a recalculated discount can shift the invoice total by one cent compared with rounding once at the end.",
  },
  {
    title: "Session tokens refresh only inside the grace window",
    body: "A session token is refreshed by the gateway only during the final five minutes of its lifetime; an expired token is rejected outright and the client must sign in again instead of refreshing.",
  },
  {
    title: "Webhook delivery retries with exponential backoff",
    body: "Failed webhook deliveries are retried up to six times with exponential backoff starting at thirty seconds; after the last attempt the delivery is parked in the dead letter queue for manual replay.",
  },
  {
    title: "Search cache entries are invalidated by tenant version",
    body: "Search results are cached per tenant and keyed by a tenant version counter that every catalogue write increments, which invalidates all cached result pages for that tenant at once.",
  },
  {
    title: "Image thumbnails are generated lazily on first request",
    body: "Thumbnails are not produced at upload time; the first request for a size renders it from the original, stores it beside the original and serves every later request from storage.",
  },
  {
    title: "Feature flags default to off for unknown tenants",
    body: "A feature flag lookup for a tenant that has no stored flag record returns off regardless of the global rollout percentage, so new tenants never see an unreleased feature by accident.",
  },
];
