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

# Rule files out

MEX writes the few entries every session in an area needs into the agents'
own rule files, so the agents load them without MEX and so do teammates who
only pull.

## Which entries (layer A)

An entry goes into rule files when it is active; a rule, decision, pitfall,
procedure or recipe; backed by a person, docs, CI or review; scoped to the
whole repo or a folder (`**` or `dir/**`, not a file pattern); not broken or
changed; at most 600 characters; and not itself read from a rule file. Team
entries go into shared files; personal notes into local files.

## Which files (who loads what)

Only for agents the repo shows signs of using: Claude Code with `CLAUDE.md`,
`CLAUDE.local.md` or `.claude/`, or Claude hooks that ran in the checkout;
Codex with `AGENTS.md` or `.codex/`, or Codex hooks that ran here.

| Agent | File per area | Notes |
| --- | --- | --- |
| Codex | `<area>/AGENTS.md` | Only where the folder has no AGENTS.md of a person's |
| Claude Code | `.claude/rules/mex[-local][-area].md` with `paths:` | Skipped where a generated AGENTS.md covers the area and the folder has no CLAUDE.md, since Claude then reads AGENTS.md |

MEX never creates `CLAUDE.md` or `CLAUDE.local.md` and never writes into a
file it didn't generate. Every generated file starts with
`<!-- mex:generated … -->` and lists each entry's text with its id as an HTML
comment. Caps: 6 KiB for a Claude rules file, 8 KiB for a generated
AGENTS.md (Codex reads 32 KiB along a path); the weakest entries are left
out first, and the output says so.

## Writing

- Shared files are recorded in `.mex/native.json` with the hash MEX wrote.
  Local files are recorded in `<MEX home>/projects/<id>/native-local.json` and
  listed in git's exclude file inside a MEX block, so they stay out of git.
- A generated file a person edited is kept as it is, never overwritten or
  deleted. A generated file no longer needed is deleted only if unchanged.
- Nothing is written while a session runs in the checkout (a heartbeat in the
  last 10 minutes). The `native-files` background job waits for the session to
  end. `mex rules --write --now` overrides this.
- A team entry change (`mex edit`, `mex wrong`, `mex forget` with `--apply`)
  rebuilds the shared files at once, so the entry, its rule file and the
  manifest are one working-tree change. Personal note changes queue the
  background job.

# Sharing

`mex share` takes a person from solo to shared in one command.

1. **Preview** (`mex share`): your personal notes that are active, backed by
   strong evidence, not broken or changed, and not already on the default
   branch, strongest and broadest first. Notes that fail the share checks are
   held back with the reason: a possible secret, hidden characters, a folder
   on someone's machine, an email address, a private network address or host.
   `--skip <id>` leaves one out. The preview prints a revision.
2. **Apply** (`mex share --apply --expect <revision>`): only if the preview
   still matches. A branch `mex/share-YYYY-MM-DD` is made from the default
   branch (origin's HEAD, else `main`/`master`) in a temporary worktree under
   the project's MEX folder. In it MEX writes the team entries (through the same
   gates as any team write), merges `{"knowledge": {"version": 1, "shared":
   true}}` into `.mex/config.json` keeping its other keys, writes
   `.mex/sources.json` (the rule files read, with hashes, so teammates don't
   read them again) and the shared rule files, commits once, and removes the
   worktree. Your branch, your working tree and your HEAD are never touched.
3. **Push:** MEX never pushes, except with `--pr`, which pushes the share
   branch and runs `gh pr create` against the default branch.

A share is recorded in `<MEX home>/projects/<id>/share.json` before anything
is created, with its step. A share stopped partway is reported by the next
`mex share`:

- `--finish` continues from the recorded step: writes what's missing,
  commits, cleans up.
- `--discard` deletes only the files MEX wrote in the temporary worktree,
  removes the worktree, and deletes the branch only if it has no commit.

Cleanup never forces: `git worktree remove` without `--force`, and it stops,
naming the path, at any link or junction inside the worktree.
