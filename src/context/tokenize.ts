/**
 * The frozen tokenizer and identifier extraction.
 *
 * Ported unchanged from the reference scorer. The tokenizer is shared by the
 * document side and the query side, so changing it changes every score.
 */

import { QUERY_FILLER, STOP_WORDS } from "./frozen.js";

export function stem(word: string): string {
  let w = word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map(stem);
}

/** Words of a symbol name, for the dense document text. */
export function symbolWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase().trim();
}

/** A symbol name as the exact-match boost compares it. */
export const wholeIdentifier = (name: string): string => name.replace(/^#/, "").toLowerCase();

export type IdentifierKind = "backtick" | "path" | "dotted" | "code";

export interface QueryIdentifier {
  raw: string;
  kind: IdentifierKind;
}

/** Code-looking words in a prompt: backticks, paths, dotted names, camelCase, snake_case, `f()`. */
export function extractIdentifiers(prompt: string): QueryIdentifier[] {
  const out = new Map<string, QueryIdentifier>();
  const add = (raw: string, kind: IdentifierKind): void => {
    const l = raw.replace(/^[./\\]+/, "").replace(/\(\)$/, "");
    if (l.length >= 3) {
      const key = l.toLowerCase();
      if (!out.has(key)) out.set(key, { raw: l, kind });
    }
  };
  for (const m of prompt.matchAll(/`([^`\n]{2,80})`/g)) {
    const s = m[1]!.trim();
    for (const p of s.split(/[\s,;]+/)) {
      if (/^[A-Za-z_#$][\w#$./\\-]*(\(\))?$/.test(p)) add(p, "backtick");
    }
  }
  for (const m of prompt.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,5}|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|json|md)\b/g)) {
    add(m[0], "path");
  }
  for (const m of prompt.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g)) {
    const p = m[0];
    if (!/\.(?:ts|tsx|js|mjs|cjs|json|md)$/i.test(p)) {
      for (const q of p.split(".")) {
        if (/[a-z][A-Z]|_/.test(q) || /^[A-Z][a-z]+[A-Z]/.test(q)) add(q, "dotted");
      }
      add(p, "dotted");
    }
  }
  for (const m of prompt.matchAll(
    /\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b|\b#?[A-Za-z_$][\w$]*\(\)/g,
  )) {
    add(m[0], "code");
  }
  return [...out.values()];
}

/** Query words after dedup and filler removal. */
export function queryWords(prompt: string): string[] {
  const words = [...new Set(tokens(prompt))];
  return words.filter((w) => !QUERY_FILLER.has(w) && !QUERY_FILLER.has(w.replace(/e$/, "")));
}
