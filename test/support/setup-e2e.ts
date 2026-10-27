/**
 * Shared fixture for the end-to-end setup suites (#292): a small Git
 * repository whose sources the graph indexes, and the checks every finished
 * code-repo setup must pass however it got there.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventoryScaffold } from "../../src/wiki/migration/inventory.js";

export const KNOWLEDGE_FILES = [
  "context/architecture.md",
  "context/stack.md",
  "context/conventions.md",
  "context/setup.md",
  "context/decisions.md",
] as const;

const roots: string[] = [];

/** A fresh temporary directory, removed by {@link removeScratch}. */
export function scratch(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

export function removeScratch(): void {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows can briefly retain a just-closed SQLite handle.
    }
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** A committed repository with two TypeScript files, one calling the other. */
export function fixtureRepository(): string {
  const project = scratch("mex-setup-e2e-");
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "checkout.ts"), [
    "export function calculateCheckoutTotal(items: number[]): number {",
    "  const subtotal = items.reduce((sum, item) => sum + item, 0);",
    "  return subtotal + subtotal * 0.18;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, "src", "cart.ts"), [
    'import { calculateCheckoutTotal } from "./checkout";',
    "export function cartTotal(prices: number[]): number {",
    "  return calculateCheckoutTotal(prices);",
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "checkout-fixture", private: true }, null, 2)}\n`);
  git(project, "init", "--quiet");
  git(project, "config", "user.name", "Setup E2E");
  git(project, "config", "user.email", "setup-e2e@example.test");
  git(project, "config", "commit.gpgsign", "false");
  git(project, "add", "-A");
  git(project, "commit", "--quiet", "-m", "Fixture");
  return project;
}

export interface ScaffoldEntity {
  file: string;
  kind: "frontmatter" | "comment";
  id: string;
  type: string;
  title: string;
  groundsTo: readonly unknown[];
  relations: readonly { type: string; target: string }[];
}

export function scaffoldEntities(project: string): ScaffoldEntity[] {
  return inventoryScaffold({ scaffoldRoot: join(project, ".mex") }).files.flatMap((file) =>
    file.parsed.entities.map((entry) => ({ file: file.path, kind: entry.metadataKind, ...entry.entity })));
}

export function scaffoldFiles(project: string): string[] {
  return inventoryScaffold({ scaffoldRoot: join(project, ".mex") }).files.map((file) => file.path);
}
