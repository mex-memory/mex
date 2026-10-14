/**
 * The JSON envelope for `mex context`.
 *
 * Same shape as the Wiki CLI's (`schemaVersion`, `ok`, `data`, `diagnostics`)
 * so an agent parses every MEX command the same way. Context diagnostics are
 * their own typed set rather than Wiki codes, and `ok` is false only when a
 * diagnostic is an error: abstaining from a prompt is a success.
 */

import type { ContextDiagnostic } from "./types.js";

export const CONTEXT_CLI_SCHEMA_VERSION = 1;

export const CONTEXT_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
} as const;

export interface ContextEnvelope<T> {
  schemaVersion: number;
  ok: boolean;
  data: T;
  diagnostics: ContextDiagnostic[];
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

export function buildEnvelope<T>(data: T, diagnostics: readonly ContextDiagnostic[] = []): ContextEnvelope<T> {
  const seen = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.code}:${d.severity}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = unique.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    schemaVersion: CONTEXT_CLI_SCHEMA_VERSION,
    ok: !sorted.some((d) => d.severity === "error"),
    data,
    diagnostics: sorted,
  };
}

export function exitCodeOf<T>(envelope: ContextEnvelope<T>): number {
  if (envelope.ok) return CONTEXT_EXIT.ok;
  return envelope.diagnostics.some((d) => d.severity === "error" && d.code === "CONTEXT_USAGE")
    ? CONTEXT_EXIT.usage
    : CONTEXT_EXIT.failed;
}

export function renderEnvelope<T>(envelope: ContextEnvelope<T>): string {
  return JSON.stringify(envelope);
}
