import { reject, succeed, type Validator } from "./validate.js";

/**
 * Aliases: the short phrases someone would actually type when they hit the
 * problem a fact answers or want the outcome it describes.
 *
 * They live under the entity's `metadata.aliases`, the key topics already use
 * for their alternative names, and feed the full-text index and the context
 * ranker. They are search hints, never identity: nothing resolves an entity
 * through one, so a duplicate across two entities is harmless.
 *
 * Validation is light on purpose. Aliases are optional so older scaffolds stay
 * valid, and the bounds only keep a payload from stuffing the ranker.
 */
export const MAX_ALIASES = 8;
export const MAX_ALIAS_CHARS = 80;

/** Trim, collapse inner whitespace and drop repeats (case-insensitively), keeping first-seen order. */
export function normalizeAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const value = alias.replace(/\s+/g, " ").trim();
    const key = value.toLowerCase();
    if (value === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * An array of non-empty strings, normalized. More than {@link MAX_ALIASES}
 * entries, or an entry longer than {@link MAX_ALIAS_CHARS}, is rejected rather
 * than truncated, so the author sees the limit instead of losing a phrase.
 */
export const validateAliases: Validator<string[]> = (value, context) => {
  if (!Array.isArray(value)) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "`aliases` must be an array of short phrases.");
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== "string" || entry.trim() === "") {
      return reject(context, "INVALID_OPERATION_PAYLOAD", `aliases[${index}] must be a non-empty string.`);
    }
    if (entry.replace(/\s+/g, " ").trim().length > MAX_ALIAS_CHARS) {
      return reject(context, "INVALID_OPERATION_PAYLOAD", `aliases[${index}] is longer than ${MAX_ALIAS_CHARS} characters; use a short phrase.`);
    }
  }
  const normalized = normalizeAliases(value as string[]);
  if (normalized.length > MAX_ALIASES) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", `At most ${MAX_ALIASES} aliases are accepted; 3 to 6 is enough.`);
  }
  return succeed(normalized);
};

/**
 * What an authoring agent is told about aliases. One text, so setup, sync and
 * upkeep guidance cannot drift apart. It names kinds of phrase and derives
 * every phrase from the fact itself; it carries no example questions.
 */
export const ALIAS_AUTHORING_GUIDANCE = `Give every code-linked fact 3 to 6 short \`aliases\` (at most ${MAX_ALIASES}, each under ${MAX_ALIAS_CHARS}
characters). They are the words a developer would type to find the fact without knowing
what it is called, so write them from what the fact itself says:
- the symptom someone would observe when this behavior goes wrong or is misunderstood;
- the outcome someone would want that this fact explains how to get;
- plain-word synonyms for the fact's own jargon;
- the likely mistake the fact helps avoid.
Do not restate the title, list code identifiers or file paths (the code links already
carry them), pad with vague words, or describe behavior the fact does not state.`;
