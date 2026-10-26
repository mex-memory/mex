/** Preserve all non-rule bytes, including quoted constants and nested comments.
 * The result matches the pinned baseline's splitRules shape, but does not
 * collapse whitespace inside TLA+ strings when isolating per-rule checks. */
export function configurationRules(cfg: string): { cfgWithoutRules: string; rules: string[]; properties: string[] } {
  const keyword = /^(SPECIFICATION|INIT|NEXT|CONSTANTS?|INVARIANTS?|PROPERTY|PROPERTIES|SYMMETRY|VIEW|CONSTRAINTS?|ACTION_CONSTRAINTS?|CHECK_DEADLOCK|POSTCONDITION|ALIAS)$/u;
  const tokens: { word: string; start: number }[] = [];
  let i = 0;
  while (i < cfg.length) {
    if (/\s/u.test(cfg[i]!)) { i++; continue; }
    if (cfg.startsWith("\\*", i)) { const end = cfg.indexOf("\n", i); i = end < 0 ? cfg.length : end + 1; continue; }
    if (cfg.startsWith("(*", i)) {
      let depth = 1; i += 2;
      while (i < cfg.length && depth) { if (cfg.startsWith("(*", i)) { depth++; i += 2; } else if (cfg.startsWith("*)", i)) { depth--; i += 2; } else i++; }
      if (depth) throw new Error("Unterminated configuration comment.");
      continue;
    }
    const start = i;
    if (cfg[i] === '"') {
      i++; let closed = false;
      while (i < cfg.length) { if (cfg[i] === "\\") i += 2; else if (cfg[i++] === '"') { closed = true; break; } }
      if (!closed) throw new Error("Unterminated configuration string.");
    } else while (i < cfg.length && !/\s/u.test(cfg[i]!) && !cfg.startsWith("\\*", i) && !cfg.startsWith("(*", i)) i++;
    tokens.push({ word: cfg.slice(start, i), start });
  }
  const rules: string[] = [], properties: string[] = [], cuts: { start: number; end: number }[] = [];
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n]!, target = /^INVARIANTS?$/u.test(t.word) ? rules : /^PROPERT(Y|IES)$/u.test(t.word) ? properties : null;
    if (!target) continue;
    let next = n + 1;
    while (next < tokens.length && !keyword.test(tokens[next]!.word)) {
      const name = tokens[next++]!.word;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("Unsupported configured rule identity.");
      if (!target.includes(name)) target.push(name);
    }
    cuts.push({ start: t.start, end: tokens[next]?.start ?? cfg.length }); n = next - 1;
  }
  let at = 0, cfgWithoutRules = "";
  for (const cut of cuts) { cfgWithoutRules += cfg.slice(at, cut.start) + "\n"; at = cut.end; }
  cfgWithoutRules += cfg.slice(at);
  return { cfgWithoutRules, rules, properties: properties.filter(p => !rules.includes(p)) };
}
