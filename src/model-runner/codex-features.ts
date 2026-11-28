import crossSpawn from "cross-spawn";

/**
 * Codex features that add tools or instructions a text judgment never uses. Each one is passed only when the
 * installed Codex knows it, because an unknown feature name stops the command.
 */
export const LEAN_CODEX_FEATURES = ["unified_exec", "view_image", "image_generation", "browser_use", "computer_use", "goals",
  "sleep_tool", "skill_search", "tool_suggest", "code_mode_host"] as const;

const known = new Map<string, ReadonlySet<string> | undefined>();

/**
 * The feature names this Codex knows, read once per Codex home from its local `features list` (no model call).
 * An older or unreadable Codex gets undefined, and its text calls keep only the long-standing flags.
 */
export function codexFeatures(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | undefined {
  const key = env.CODEX_HOME ?? "";
  if (known.has(key)) return known.get(key);
  let names: ReadonlySet<string> | undefined;
  try {
    const result = crossSpawn.sync("codex", ["features", "list"], { env, encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (result.status === 0 && typeof result.stdout === "string") {
      const found = result.stdout.split(/\r?\n/u).map(line => line.trim().split(/\s+/u))
        .filter(parts => parts.length >= 3 && /^(?:true|false)$/u.test(parts.at(-1)!)).map(parts => parts[0]!);
      if (found.length) names = new Set(found);
    }
  } catch { names = undefined; }
  known.set(key, names);
  return names;
}
