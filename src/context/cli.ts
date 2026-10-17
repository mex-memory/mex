/**
 * `mex context`: thin adapters over the composer.
 *
 * Each command resolves the project root from the working directory, calls one
 * composer function and renders. Output follows the Wiki CLI's contract: plain
 * text by default, one enveloped JSON object under `--json`, and a nonzero exit
 * only for a real failure. Having nothing to say is success.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildEnvelope, exitCodeOf, renderEnvelope, CONTEXT_EXIT, type ContextEnvelope } from "./envelope.js";
import { candidatePool, composePrompt } from "./compose.js";
import { RECIPES } from "./frozen.js";
import { ensureEntityVectors, pruneVectorCache, type Embedder } from "./dense.js";
import { ensureContextIndex, indexPathOf, saveContextIndex } from "./index-store.js";
import { resolveContextRoot, type ContextRoot } from "./root.js";
import {
  installSemantic,
  loadEmbedder,
  removeSemantic,
  semanticStatus,
  SemanticInstallError,
  type SemanticStatus,
} from "./semantic.js";
import { loadConfiguredContextConfig } from "../config.js";
import { loadFlags, mutateFlags, type FlagEntry } from "./flags.js";
import { HOOK_LOG_NAME } from "./hook/run.js";
import { settleRunning } from "./hook/settle.js";
import { isValidSessionId, loadShown, recordConfirmation, recordShown, type ConfirmationScope } from "./session.js";
import type { ContextDiagnostic, ContextIndex, PromptResult } from "./types.js";

export interface ContextIo {
  write: (line: string) => void;
  writeError: (line: string) => void;
  setExitCode: (code: number) => void;
  /** Where the command was launched; the root is found from here. */
  cwd: string;
}

export interface ContextFlags {
  json?: boolean;
  explain?: boolean;
  lexical?: boolean;
  session?: string;
  note?: string;
}

/** An unexpected failure becomes a typed diagnostic and a nonzero exit, never a stack trace. */
async function guarded(io: ContextIo, flags: ContextFlags, command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    const diagnostics: ContextDiagnostic[] = [
      { code: "CONTEXT_FAILED", severity: "error", message: error instanceof Error ? error.message : String(error) },
    ];
    emit(io, flags.json, buildEnvelope({}, diagnostics), () => "");
  }
}

function noScaffold(io: ContextIo, json: boolean | undefined): void {
  const diagnostics: ContextDiagnostic[] = [
    {
      code: "CONTEXT_NO_SCAFFOLD",
      severity: "error",
      message: `No MEX scaffold (.mex/) found at or above ${io.cwd}.`,
      remediation: "Run `mex setup` in the project, or run this command from inside it.",
    },
  ];
  emit(io, json, buildEnvelope({ root: null }, diagnostics), () => diagnostics[0]!.message);
}

function emit<T>(io: ContextIo, json: boolean | undefined, envelope: ContextEnvelope<T>, human: () => string): void {
  io.setExitCode(exitCodeOf(envelope));
  if (json) {
    io.write(renderEnvelope(envelope));
    return;
  }
  const text = human();
  if (text !== "") io.write(text);
  for (const d of envelope.diagnostics) {
    if (d.severity !== "info") io.writeError(`${d.severity}: ${d.message}${d.remediation ? ` ${d.remediation}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// mex context index
// ---------------------------------------------------------------------------

export interface IndexSummary {
  path: string;
  rebuilt: boolean;
  entities: number;
  facts: number;
  byType: Record<string, number>;
  linked: number;
  graph: "present" | "absent";
  vectors: { model: string; cached: number; computed: number } | null;
}

function countBy(index: ContextIndex): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const e of index.entities) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(byType).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const runContextIndex = (io: ContextIo, flags: ContextFlags = {}): Promise<void> =>
  guarded(io, flags, () => indexCommand(io, flags));

async function indexCommand(io: ContextIo, flags: ContextFlags): Promise<void> {
  const root = resolveContextRoot(io.cwd);
  if (root === null) return noScaffold(io, flags.json);

  const ensured = await ensureContextIndex(root, "force");
  const diagnostics = [...ensured.diagnostics];
  let vectors: IndexSummary["vectors"] = null;
  if (flags.lexical !== true) {
    const candidates = candidatePool(ensured.index, RECIPES.R3);
    if (candidates.length > 0 && semanticStatus(undefined, { measure: false }).state === "installed") {
      const loaded = await loadEmbedder();
      if (loaded.embedder !== null) {
        try {
          const { computed } = await ensureEntityVectors(ensured.index, candidates, loaded.embedder);
          pruneVectorCache(ensured.index, new Set(candidates.map((e) => e.id)));
          vectors = {
            model: loaded.embedder.modelId,
            cached: Object.keys(ensured.index.vectors[loaded.embedder.modelId] ?? {}).length,
            computed,
          };
          if (computed > 0) saveContextIndex(root.localDir, ensured.index);
        } catch (error) {
          diagnostics.push({
            code: "CONTEXT_SEMANTIC_FAILED",
            severity: "warning",
            message: `Entry vectors could not be computed: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          await loaded.embedder.dispose?.();
        }
      }
    }
  }
  const summary: IndexSummary = {
    path: indexPathOf(root.localDir),
    rebuilt: ensured.rebuilt,
    entities: ensured.index.entities.length,
    facts: ensured.index.entities.filter((e) => e.type === "fact").length,
    byType: countBy(ensured.index),
    linked: ensured.index.entities.filter((e) => e.groundings.length > 0).length,
    graph: ensured.index.inputs.graph.identity === null ? "absent" : "present",
    vectors,
  };
  emit(io, flags.json, buildEnvelope(summary, diagnostics), () =>
    [
      `Context index: ${summary.entities} entities (${summary.facts} facts, ${summary.linked} code-linked), graph ${summary.graph}.`,
      `Types: ${Object.entries(summary.byType).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}.`,
      vectors ? `Entry vectors: ${vectors.cached} cached for ${vectors.model} (${vectors.computed} computed now).` : "Entry vectors: none (the semantic extra is not installed).",
      `Wrote ${summary.path}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// mex context prompt
// ---------------------------------------------------------------------------

export interface PromptData {
  recipe: PromptResult["recipe"];
  channel: PromptResult["channel"];
  injected: PromptResult["injected"];
  abstention: PromptResult["abstention"];
  packet: string;
  alreadyShown: string[];
  index: { rebuilt: boolean };
  candidates?: PromptResult["candidates"];
  timingsMs?: Record<string, number>;
}

function readPromptText(text: string): string {
  return text === "-" ? readFileSync(0, "utf8") : text;
}

/** Wall time per phase of one command, for `--explain`. */
function phaseClock(): { mark: (phase: string) => void; done: () => Record<string, number> } {
  const phases: Record<string, number> = {};
  let last = performance.now();
  const started = last;
  return {
    mark(phase) {
      const now = performance.now();
      phases[phase] = Math.round((now - last) * 10) / 10;
      last = now;
    },
    done() {
      phases["total"] = Math.round((performance.now() - started) * 10) / 10;
      return phases;
    },
  };
}

function explainTable(result: PromptResult, rebuilt: boolean, timings: Record<string, number> | undefined): string {
  const lines = [
    `recipe ${result.recipe ?? "none"} (${result.channel ?? "none"}), index ${rebuilt ? "rebuilt" : "current"}, ${result.candidates.length} candidates reached the gate`,
    result.abstention ? `abstained: ${result.abstention}` : `injected: ${result.injected.map((i) => i.id).join(", ")}`,
  ];
  if (timings) lines.push(`timings ms: ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const c of result.candidates) {
    const parts = [
      `#${String(c.rank).padStart(2)}`,
      c.decision.padEnd(14),
      `norm ${c.norm.toFixed(4)}`,
      `groups ${c.groups}`,
      `exact ${c.exact}`,
      ...(c.cos === undefined ? [] : [`cos ${c.cos.toFixed(3)}`]),
      ...(c.fused === undefined ? [] : [`fused ${c.fused.toFixed(3)}`]),
      `${c.type} ${c.id} ${c.title.slice(0, 60)}`,
    ];
    lines.push(parts.join("  "));
  }
  return lines.join("\n");
}

export const runContextPrompt = (io: ContextIo, textParts: string | readonly string[], flags: ContextFlags = {}): Promise<void> =>
  guarded(io, flags, () => promptCommand(io, textParts, flags));

async function promptCommand(io: ContextIo, textParts: string | readonly string[], flags: ContextFlags): Promise<void> {
  const root = resolveContextRoot(io.cwd);
  if (root === null) return noScaffold(io, flags.json);

  const clock = phaseClock();
  const prompt = readPromptText(typeof textParts === "string" ? textParts : textParts.join(" "));
  const ensured = await ensureContextIndex(root, "if-stale");
  clock.mark("index");
  const diagnostics = [...ensured.diagnostics];

  let embedder: Embedder | null = null;
  const hasCandidates = candidatePool(ensured.index, RECIPES.R3).length > 0;
  if (flags.lexical !== true && hasCandidates && semanticStatus(undefined, { measure: false }).state === "installed") {
    const loaded = await loadEmbedder();
    embedder = loaded.embedder;
    if (embedder === null && loaded.reason !== undefined) {
      diagnostics.push({
        code: "CONTEXT_SEMANTIC_UNAVAILABLE",
        severity: "info",
        message: `The semantic extra is installed but did not load (${loaded.reason}); using the lexical recipe.`,
      });
    }
  }

  let sessionId: string | null = null;
  if (flags.session !== undefined) {
    if (isValidSessionId(flags.session)) sessionId = flags.session;
    else {
      diagnostics.push({
        code: "CONTEXT_SESSION_INVALID",
        severity: "warning",
        message: "The session id is empty, too long or contains control characters; repeat suppression is off for this prompt.",
      });
    }
  }
  const shown = sessionId === null ? new Set<string>() : loadShown(root.localDir, sessionId);
  clock.mark("embedder");

  let outcome;
  try {
    outcome = await composePrompt(ensured.index, prompt, { scaffoldRoot: root.scaffoldRoot, shown, embedder });
  } finally {
    await embedder?.dispose?.();
  }
  clock.mark("compose");
  diagnostics.push(...outcome.diagnostics);
  persistAfterPrompt(root, ensured.index, outcome.vectorsComputed, sessionId, outcome.result, diagnostics);

  const result = outcome.result;
  const data: PromptData = {
    recipe: result.recipe,
    channel: result.channel,
    injected: result.injected,
    abstention: result.abstention,
    packet: result.packet,
    alreadyShown: result.alreadyShown,
    index: { rebuilt: ensured.rebuilt },
    ...(flags.explain ? { candidates: result.candidates, timingsMs: clock.done() } : {}),
  };
  emit(io, flags.json, buildEnvelope(data, diagnostics), () =>
    flags.explain ? `${explainTable(result, ensured.rebuilt, data.timingsMs)}${result.packet ? `\n\n${result.packet}` : ""}` : result.packet,
  );
}

function persistAfterPrompt(
  root: ContextRoot,
  index: ContextIndex,
  vectorsComputed: number,
  sessionId: string | null,
  result: PromptResult,
  diagnostics: ContextDiagnostic[],
): void {
  if (vectorsComputed > 0) {
    try {
      saveContextIndex(root.localDir, index);
    } catch {
      // The vectors stay in memory for this prompt; the next one recomputes them.
    }
  }
  if (sessionId !== null && result.injected.length > 0) {
    try {
      recordShown(root.localDir, sessionId, result.injected.map((i) => i.id));
    } catch (error) {
      diagnostics.push({
        code: "CONTEXT_SESSION_INVALID",
        severity: "warning",
        message: `Session state could not be written: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// mex context confirm / status
// ---------------------------------------------------------------------------

export interface ConfirmData {
  confirmed: string[];
  unknown: string[];
  scope: ConfirmationScope | null;
}

/**
 * `mex context confirm <id...>`: the agent says these entities still hold after
 * its change. Only this (or rewriting the prose) lets the settle worker
 * re-record their code links; reading or being shown a fact never does.
 */
export const runContextConfirm = (io: ContextIo, ids: readonly string[], flags: ContextFlags = {}): Promise<void> =>
  guarded(io, flags, () => confirmCommand(io, ids, flags));

async function confirmCommand(io: ContextIo, ids: readonly string[], flags: ContextFlags): Promise<void> {
  const root = resolveContextRoot(io.cwd);
  if (root === null) return noScaffold(io, flags.json);
  const diagnostics: ContextDiagnostic[] = [];
  const wanted = [...new Set(ids)];
  const ensured = await ensureContextIndex(root, "if-stale");
  const known = new Set(ensured.index.entities.map((entity) => entity.id));
  const confirmed = wanted.filter((id) => known.has(id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    diagnostics.push({
      code: "CONTEXT_USAGE",
      severity: confirmed.length === 0 ? "error" : "warning",
      message: `Not a known entity id: ${unknown.join(", ")}.`,
      remediation: "`mex context status` lists the entities waiting for review.",
    });
  }
  let sessionId: string | null = null;
  if (flags.session !== undefined) {
    if (isValidSessionId(flags.session)) sessionId = flags.session;
    else {
      diagnostics.push({ code: "CONTEXT_SESSION_INVALID", severity: "warning", message: "The session id is empty, too long or contains control characters; the confirmation is recorded without one." });
    }
  }
  let scope: ConfirmationScope | null = null;
  if (confirmed.length > 0) {
    scope = recordConfirmation(root.localDir, sessionId, confirmed, flags.note);
    // An entity already flagged becomes eligible at once, whichever session the Stop hook runs in.
    mutateFlags(root.localDir, (stored) => {
      for (const id of confirmed) {
        const entry = stored.entities[id];
        if (entry === undefined) continue;
        entry.status = "eligible";
        entry.basis = "confirmed";
        if (flags.note !== undefined && flags.note !== "") entry.note = flags.note.slice(0, 500);
        entry.updatedAt = new Date().toISOString();
      }
    });
  }
  const data: ConfirmData = { confirmed, unknown, scope };
  emit(io, flags.json, buildEnvelope(data, diagnostics), () =>
    confirmed.length === 0
      ? ""
      : `Confirmed ${confirmed.length} ${confirmed.length === 1 ? "entity" : "entities"} still hold. MEX re-records their code links after the session.`,
  );
}

export interface StatusEntry {
  id: string;
  title: string;
  file: string;
  line: number;
  status: FlagEntry["status"];
  basis?: FlagEntry["basis"];
  why: string;
  since: string;
  error?: string;
}

export interface StatusData {
  stopReview: "ask" | "off";
  settle: { running: boolean; last: Record<string, unknown> | null };
  flagged: StatusEntry[];
  eligible: StatusEntry[];
}

function lastSettleLog(localDir: string): Record<string, unknown> | null {
  try {
    const lines = readFileSync(join(localDir, HOOK_LOG_NAME), "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry["event"] === "string" && (entry["event"] as string).startsWith("settle")) return entry;
    }
  } catch {
    // No log yet, or a damaged line: there is nothing to report.
  }
  return null;
}

/** `mex context status`: what is waiting for review and what the settle worker last did. */
export const runContextStatus = (io: ContextIo, flags: ContextFlags = {}): Promise<void> =>
  guarded(io, flags, async () => {
    const root = resolveContextRoot(io.cwd);
    if (root === null) return noScaffold(io, flags.json);
    const stored = loadFlags(root.localDir);
    const entries: StatusEntry[] = Object.entries(stored.entities).map(([id, entry]) => ({
      id,
      title: entry.title,
      file: entry.file,
      line: entry.line,
      status: entry.status,
      ...(entry.basis === undefined ? {} : { basis: entry.basis }),
      why: entry.why,
      since: entry.since,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }));
    const data: StatusData = {
      stopReview: loadConfiguredContextConfig(root.scaffoldRoot).stopReview,
      settle: { running: settleRunning(root.localDir), last: lastSettleLog(root.localDir) },
      flagged: entries.filter((entry) => entry.status === "flagged"),
      eligible: entries.filter((entry) => entry.status === "eligible"),
    };
    emit(io, flags.json, buildEnvelope(data, []), () => {
      const row = (entry: StatusEntry): string =>
        `  ${entry.id}  ${entry.title}  (.mex/${entry.file}:${entry.line})  ${entry.why}${entry.error === undefined ? "" : `  [last re-record failed: ${entry.error}]`}`;
      const lines = [`Stop review: ${data.stopReview}. Settle worker: ${data.settle.running ? "running" : "idle"}.`];
      if (data.flagged.length === 0 && data.eligible.length === 0) lines.push("Nothing is waiting for review.");
      if (data.flagged.length > 0) {
        lines.push(`Changed, re-check (${data.flagged.length}): rewrite the prose if it is now false, or run \`mex context confirm <id>\` if it holds.`);
        lines.push(...data.flagged.map(row));
      }
      if (data.eligible.length > 0) {
        lines.push(`Vouched for, waiting to be re-recorded (${data.eligible.length}):`);
        lines.push(...data.eligible.map((entry) => `${row(entry)}  [${entry.basis ?? "confirmed"}]`));
      }
      return lines.join("\n");
    });
  });

// ---------------------------------------------------------------------------
// mex context semantic
// ---------------------------------------------------------------------------

export const SEMANTIC_ACTIONS = ["install", "status", "remove"] as const;
export type SemanticAction = (typeof SEMANTIC_ACTIONS)[number];

function describeStatus(status: SemanticStatus): string {
  const size = status.bytes === null ? "not on disk" : `${(status.bytes / 1024 / 1024).toFixed(1)} MB`;
  return [
    `Semantic extra: ${status.state}`,
    `  directory ${status.directory} (${size})`,
    `  library   ${status.library.installed ? `@huggingface/transformers ${status.library.version}` : "not installed"}`,
    `  model     ${status.model.id} (${status.model.dtype}) ${status.model.cached ? "cached" : "not cached"}`,
  ].join("\n");
}

export async function runContextSemantic(io: ContextIo, action: string, flags: ContextFlags = {}): Promise<void> {
  if (!(SEMANTIC_ACTIONS as readonly string[]).includes(action)) {
    const diagnostics: ContextDiagnostic[] = [
      {
        code: "CONTEXT_USAGE",
        severity: "error",
        message: `Unknown semantic action "${action}". Use one of: ${SEMANTIC_ACTIONS.join(", ")}.`,
      },
    ];
    return emit(io, flags.json, buildEnvelope({ action }, diagnostics), () => "");
  }
  if (action === "status") {
    const status = semanticStatus();
    return emit(io, flags.json, buildEnvelope(status, []), () => describeStatus(status));
  }
  if (action === "remove") {
    try {
      const { removed } = removeSemantic();
      const status = semanticStatus();
      return emit(io, flags.json, buildEnvelope({ removed, status }, []), () =>
        removed ? "Removed the semantic extra. Prompts use the lexical recipe." : "The semantic extra was not installed.",
      );
    } catch (error) {
      const diagnostics: ContextDiagnostic[] = [
        { code: "CONTEXT_SEMANTIC_FAILED", severity: "error", message: error instanceof Error ? error.message : String(error) },
      ];
      return emit(io, flags.json, buildEnvelope({ removed: false }, diagnostics), () => "");
    }
  }
  try {
    const status = await installSemantic({ progress: flags.json ? undefined : (message) => io.writeError(message) });
    emit(io, flags.json, buildEnvelope(status, []), () => `${describeStatus(status)}\nRun \`mex context index\` to cache fact vectors.`);
  } catch (error) {
    const detail = error instanceof SemanticInstallError && error.detail ? ` ${error.detail}` : "";
    const diagnostics: ContextDiagnostic[] = [
      {
        code: "CONTEXT_SEMANTIC_FAILED",
        severity: "error",
        message: `${error instanceof Error ? error.message : String(error)}${detail}`,
        remediation: "Check your network and npm configuration, then run `mex context semantic install` again. Prompts keep working with the lexical recipe.",
      },
    ];
    emit(io, flags.json, buildEnvelope({ state: semanticStatus(undefined, { measure: false }).state }, diagnostics), () => "");
  }
}

export { CONTEXT_EXIT };
