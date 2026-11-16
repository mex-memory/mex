/** Exact 0.8.5 generated hook shapes. Never guess the lost bytes of mixed hooks. */
const PATH_RUN = String.raw`mex_is_agent() {
  _out=$("$1" --help </dev/null 2>/dev/null) || return 1
  [ "$(printf '%s\n' "$_out" | grep -Ec '^  (check|sync)( |$)')" -eq 2 ]
}
MEX_BIN=$(command -v mex 2>/dev/null) || MEX_BIN=""
if [ -n "$MEX_BIN" ] && mex_is_agent "$MEX_BIN"; then
  SCORE=$("$MEX_BIN" check --quiet 2>&1) || true
else
  SCORE=$(npx mex-agent check --quiet 2>&1) || true
fi`;
const HEAD = "#!/bin/sh\n# mex-drift-check\n# Auto-installed by mex watch — runs drift check after each commit\n";
const TAIL = '# Only show output if there are issues (not a perfect score)\ncase "$SCORE" in\n  *"100/100"*) ;;\n  *) echo "$SCORE" ;;\nesac\n';

export function ownedWatchHook(text: string): boolean {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith(HEAD)) return false;
  const end = normalized.endsWith("# mex-drift-check-end\n") ? TAIL + "# mex-drift-check-end\n" : TAIL;
  if (!normalized.endsWith("\n" + end)) return false;
  const run = normalized.slice(HEAD.length, -end.length - 1);
  return (end !== TAIL && run === PATH_RUN) || (end === TAIL && run === "SCORE=$(npx mex check --quiet 2>&1) || true")
    || /^SCORE=\$\(node "[^"\n]+[\\/]dist[\\/]cli\.js" check --quiet 2>&1\) \|\| true$/u.test(run);
}
