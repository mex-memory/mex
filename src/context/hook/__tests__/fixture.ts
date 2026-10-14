/**
 * A small Git project with a real code graph and grounded facts, for the hook
 * tests: three functions in one file, a caller in another file, a test file,
 * and one fact per function.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ensureContextIndex } from "../../index-store.js";
import { buildGraph, createProject, graphSymbol, writeEntities, type Fixture } from "../../__tests__/fixture.js";
import { runHook, type HookPayload } from "../run.js";

export const BILLING_V1 = [
  "export function calculateOrderTotal(items: number[]): number {",
  "  return items.length;",
  "}",
  "",
  "export function applyDiscount(total: number): number {",
  "  return total - 1;",
  "}",
  "",
  "export function formatInvoice(total: number): string {",
  "  return `Total: ${total}`;",
  "}",
  "",
].join("\n");

export const REPORT = [
  'import { calculateOrderTotal } from "./billing.js";',
  "",
  "export function buildReport(items: number[]): number {",
  "  return calculateOrderTotal(items);",
  "}",
  "",
].join("\n");

export const BILLING_TEST = [
  'import { calculateOrderTotal } from "../src/billing.js";',
  "",
  "export function checksTotal(): number {",
  "  return calculateOrderTotal([1, 2]);",
  "}",
  "",
].join("\n");

export interface HookProject {
  fx: Fixture;
  ids: { total: string; discount: string; invoice: string };
  /** Line of each fact's heading inside `.mex/context/billing.md`. */
  run: (payload: HookPayload) => Promise<string>;
  /** Parse hook stdout to the injected text ("" when silent). */
  text: (stdout: string) => string;
  git: (...args: string[]) => string;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

/** Build the project, index it, commit everything: the state a session starts from. */
export async function createHookProject(options: { extraFacts?: number } = {}): Promise<HookProject> {
  // No semantic extra anywhere: the MEX home is empty.
  vi.stubEnv("MEX_HOME", mkdtempSync(join(tmpdir(), "mex-hook-home-")));
  const fx = createProject("mex-hook-");
  fx.writeSource("src/billing.ts", BILLING_V1);
  fx.writeSource("src/report.ts", REPORT);
  fx.writeSource("tests/billing.test.ts", BILLING_TEST);
  fx.writeSource(".gitignore", ".mex/graph.db*\n.mex/local/\n");
  await buildGraph(fx);

  const total = graphSymbol(fx, "calculateOrderTotal");
  const discount = graphSymbol(fx, "applyDiscount");
  const invoice = graphSymbol(fx, "formatInvoice");
  const entities = [
    {
      title: "Order totals count the items",
      body: "The order total is the number of items in the basket and nothing else, so a discount never changes it.",
      groundings: [{ node: total.id, file: total.file, bodyHash: total.bodyHash }],
    },
    {
      title: "Discounts subtract one flat unit",
      body: "A discount always subtracts exactly one currency unit from the total whatever the basket holds.",
      groundings: [{ node: discount.id, file: discount.file, bodyHash: discount.bodyHash }],
    },
    {
      title: "Invoices print the plain total",
      body: "The invoice line is the word Total followed by the number, with no currency symbol and no rounding.",
      groundings: [{ node: invoice.id, file: invoice.file, bodyHash: invoice.bodyHash }],
    },
    ...Array.from({ length: options.extraFacts ?? 0 }, (_, i) => ({
      title: `Another fact about billing number ${i}`,
      body: `Extra fact ${i} about the order total: ${"it explains something fairly long about totals and baskets. ".repeat(20)}`,
      groundings: [{ node: total.id, file: total.file, bodyHash: total.bodyHash }],
    })),
  ];
  const ids = writeEntities(fx, "context/billing.md", entities);
  await ensureContextIndex(fx.context, "force");

  git(fx.root, "init", "-q");
  git(fx.root, "add", "-A");
  git(fx.root, "commit", "-q", "-m", "base");

  return {
    fx,
    ids: { total: ids[0]!, discount: ids[1]!, invoice: ids[2]! },
    run: async (payload) => (await runHook(JSON.stringify({ cwd: fx.root, ...payload }), { cwd: fx.root, lexical: true })).stdout,
    text: (stdout) => (stdout === "" ? "" : (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext),
    git: (...args) => git(fx.root, ...args),
  };
}

export const promptPayload = (session: string, prompt: string): HookPayload => ({
  hook_event_name: "UserPromptSubmit",
  session_id: session,
  prompt,
});

export const toolPayload = (session: string, tool: string, input: Record<string, unknown>, response: unknown = {}): HookPayload => ({
  hook_event_name: "PostToolUse",
  session_id: session,
  tool_name: tool,
  tool_input: input,
  tool_response: response,
});
