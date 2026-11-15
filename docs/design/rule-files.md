# Rule files in

MEX reads the rule files a repository already has and turns each section into
an entry, so an agent can be given what it doesn't load itself.

## Files read

| File | Format | Loaded by | Scope |
| --- | --- | --- | --- |
| `CLAUDE.md`, `CLAUDE.local.md` (any folder) | claude | Claude Code | Its folder |
| `.claude/rules/**/*.md` | claude-rules | Claude Code | `paths:`, else all |
| `AGENTS.md`, `AGENTS.override.md` (any folder) | agents | Codex, Cursor, Copilot; OpenCode at the root only; Claude Code where the folder has no `CLAUDE.md` | Its folder |
| `.cursor/rules/**/*.mdc`, `.cursorrules` | cursor | Cursor | `globs:` unless `alwaysApply` |
| `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | copilot | Copilot | `applyTo:` |
| `GEMINI.md` (any folder) | gemini | Gemini CLI | Its folder |

Files are what git lists, so ignored files are skipped. A file containing
`<!-- mex:generated` is MEX's own output and is never read back. MEX's managed
blocks (`<!-- mex-agent:…:start -->` … `end`) inside a file are left out.

## Entries

Each section with its own text becomes one entry: kind `recipe` when it is
mostly commands or code, else `rule`; source `rule-file` with the file path;
evidence `docs`; the file's scope. The one-line form is the heading plus the
section's first sentence. The id is derived from the path, heading and
occurrence, so it stays the same when the text changes.

Each entry has one check. A section with a unique heading gets a complete
`section` check (the hash the Go evaluator computes for that heading). Text
before the first heading, or a repeated heading, gets a supporting `source`
check on the whole file.

## Review

Plain text for now, in `mex rules`:

- **conflict:** two files have a section with the same heading and different
  text.
- **stale:** a section names `npm`/`pnpm`/`yarn`/`bun` scripts or `make`
  targets the repo doesn't define (checked against `package.json` and the
  `Makefile` only, never against the rule files themselves), or a path in
  code quotes that doesn't exist, or it is too long to be one entry.

## Where it is kept

`mex rules` scans and saves the result to
`<MEX home>/projects/<project id>/rule-files.json`. It is derived: rebuilt on
every scan, never edited, never in git. `readRuleFiles` reads it without
scanning.
