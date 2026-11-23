const enforcing = new Set(["error", "warn", "on", "true", "1", "2"]);

function ruleEnforcing(value: unknown): boolean {
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return enforcing.has(value.toLowerCase());
  if (Array.isArray(value)) return ruleEnforcing(value[0]);
  return false;
}

function rulesTable(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rules = (value as { rules?: unknown }).rules;
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return undefined;
  return rules as Record<string, unknown>;
}

/** Strip comments so a mentioned name is not treated as a setting. */
function withoutComments(config: string): string {
  return config.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|\s)\/\/.*$/gmu, "$1").replace(/(^|\s)#.*$/gmu, "$1");
}

/**
 * Whether this config enables the named rule.
 * true: an enforcing setting. false: a rules table that does not enforce it, including an explicit off.
 * undefined: the file does not show a rules table or a setting, so a bare name is not evidence.
 */
export function linterRuleEnabled(config: string, rule: string): boolean | undefined {
  if (!rule || rule.length > 200 || /[\n\r]/u.test(rule)) return undefined;
  const text = withoutComments(config);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  const rules = rulesTable(parsed);
  if (rules) return Object.hasOwn(rules, rule) && ruleEnforcing(rules[rule]);
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:["']${escaped}["']|\\b${escaped}\\b)\\s*[:=]\\s*["']?(error|warn|on|off|true|false|0|1|2)["']?`, "iu").exec(text);
  if (!match) return undefined;
  return enforcing.has(match[1]!.toLowerCase());
}
