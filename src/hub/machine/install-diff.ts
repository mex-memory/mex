import { isDeepStrictEqual } from "node:util";
import { ownedHookGroups, parseSettings, type HookCommand } from "../../install/settings.js";
import { assertNoSecrets } from "../../knowledge/gates.js";

/** Show the installer’s hook changes without including the person’s other settings. */
export function hookChanges(before: Buffer | null, after: Buffer | null, commands: readonly HookCommand[]) {
  const oldSettings = parseSettings(before), newSettings = parseSettings(after);
  const prior = ownedHookGroups(oldSettings, commands), next = ownedHookGroups(newSettings, commands);
  const removed: Record<string, unknown> = Object.create(null), added: Record<string, unknown> = Object.create(null);
  if (oldSettings.version !== newSettings.version) {
    removed.version = oldSettings.version;
    added.version = newSettings.version;
  }
  for (const name of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    if (isDeepStrictEqual(prior[name], next[name])) continue;
    if (prior[name]) removed[name] = prior[name];
    if (next[name]) added[name] = next[name];
  }
  return { before: removed, after: added };
}

export function visibleValue(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  try { assertNoSecrets(value); } catch { return "Sensitive value hidden"; }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length > maxLength) return text.slice(0, maxLength - 14) + "\n… (shortened)";
  return text || "(empty)";
}
