# Rule files in

MEX reads the rule files a repository already has and turns each section into
an entry, so an agent can be given what it doesn't load itself.

## Files read

| File | Format | Loaded by | Scope |
| --- | --- | --- | --- |
| `CLAUDE.md`, `CLAUDE.local.md` (any folder) | claude | Claude Code | Its folder |
| `.claude/rules/**/*.md` | claude-rules | Claude Code | `paths:`, else all |
| `AGENTS.md`, `AGENTS.override.md` (any folder) | agents | Codex, Cursor, Copilot; OpenCode at the root only; Claude Code uses `AGENTS.md` where the folder has no `CLAUDE.md` or `CLAUDE.local.md` | Its folder |
| `.cursor/rules/**/*.mdc`, `.cursorrules` | cursor | Cursor | `globs:` unless `alwaysApply` |
| `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | copilot | Copilot | `applyTo:` |
| `GEMINI.md` (any folder) | gemini | Gemini CLI | Its folder |

Files are what git lists, so ignored files are skipped. A file containing
`<!-- mex:generated` is MEX's own output and is never read back. MEX's managed
blocks (`<!-- mex-agent:…:start -->` … `end`) inside a file are left out.
Linked files and redirected parent folders are skipped. Reads have a 256 KiB
per-file bound; a scan accepts at most 200 rule files.

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

Rule files take active rules, decisions, pitfalls, procedures and recipes
backed by a person, docs, CI or review. They take whole-repo and folder scopes
(`**` or `dir/**`), with the coverage rule below for learned entries. A rule file
entry must be at most 600 characters, have no broken or changed verdict, and
come from another source. Team entries go into shared files and personal notes
go into local files.
Entries with checks need a held result from the current native evaluator;
cached verdicts do not authorize publication after the source changes. If
current checks are unavailable, checked entries are left out.

A learned rule scoped only to exact file paths stays scoped to those files.
A `**` scope always counts as repository-wide. With at least 20 indexed source
files, a rule with a glob counts as repository-wide if its scopes together
match at least 30% of those files, counting each file once. Below 20 indexed
source files, filename globs with no directory restriction, such as `**/*.go`,
also count as repository-wide.

Repository-wide learned prose is available through `mex recall` and the review
list. It loads into rule files only when the person turns on
`learning.alwaysOn` for the project (`mex config set learning.alwaysOn on --project`).
A learned rule with a proven `when:` still fires at its matching edit.
In the fresh-repo test of learn deeper on 10 repos (measured), one learned rule scoped to `**/*.go`
accounted for 74% of one grader's wrong learned deliveries. The setting
defaults to off.

When it is on, those rules go into that person's local files only, so shared
files stay the same for everyone. They share a 450 estimated token budget
across team and personal entries. This is about one MEX default rules pack.
Each whole bullet costs its UTF-8 byte length divided by four and rounded up,
including the entry ID comment and line break.

A held, complete quote check establishes a written project policy. These
rules rank first, followed by rules from multiple distinct PRs, rules with
a complete fixture, and rules from a single PR. Ties use the distinct PR
count, then kind (rule, decision, pitfall, procedure, recipe), then ID.
If both stores have the same ID and rank, the team copy goes first.
When a rule exceeds the space left, the selector tries the next rule.

Repository-wide learned rules deliver the stored claim when it matches the
body or has a sentence boundary where the body continues. The 600-character
limit applies to the delivered form. The full entry and any rules that miss
the budget remain available through `mex recall`. Folder rules use path
delivery.

## Which files (who loads what)

Only for agents the repo shows signs of using: Claude Code with `CLAUDE.md`,
`CLAUDE.local.md` or `.claude/`, or Claude hooks that ran in the checkout;
Codex with `AGENTS.md` or `.codex/`, or Codex hooks that ran here.

| Agent | File per area | Notes |
| --- | --- | --- |
| Codex | `<area>/AGENTS.md` | Only where the folder has no AGENTS.md of a person's |
| Claude Code | `.claude/rules/mex.md`, `mex-local.md`, or `mex[-local]-area-<slug>-<hash>.md` with `paths:` | Skipped where a generated AGENTS.md covers the area and the folder has no CLAUDE.md, since Claude then reads AGENTS.md |

MEX never creates `CLAUDE.md` or `CLAUDE.local.md` and never writes into a
file it didn't generate. Every generated file starts with
`<!-- mex:generated … -->` and lists each entry's text with its id as an HTML
comment (`<!-- mex:<entry id> -->`). Caps: 6 KiB for a Claude rules file, 8 KiB for a generated
AGENTS.md (Codex reads 32 KiB along a path); the weakest entries are left
out first, and the output says so.

Area filenames include a stable hash so nested folders and punctuation cannot
collide. Shared area files and personal root files use separate names. Personal
rules are hidden before publication and are never written into a tracked file.
Manifest cleanup accepts only native output paths, refuses linked parents and
files, and keeps edited generated files when their ownership cannot be verified.

## Writing

- Shared files are recorded in `.mex/native.json` with the hash MEX wrote.
  Local files are recorded in `<MEX home>/projects/<id>/native-local.json` and
  listed in git's exclude file inside a MEX block, so they stay out of git.
- A generated file a person edited is kept as it is, never overwritten or
  deleted. A generated file no longer needed is deleted only if unchanged.
- Background rebuilds wait while a session runs in the checkout (a heartbeat in
  the last 10 minutes). The `native-files` job waits for the session to end.
  `mex rules --write --now` explicitly overrides this.
- A personal note change (`mex note`, `mex edit`, `mex forget`, `mex wrong`, a
  confirmed hint, `mex note:` typed in a session) queues a `native-files` job
  marked `local`: it rewrites only the hidden local files and runs at once,
  even during a session. The session that saved the note has it already; a new
  session would otherwise not load it until every session here has ended.
  Shared files keep waiting.
- Rebuild jobs are kept apart by checkout and purpose: a request joins an
  unfinished job only for the same checkout, never a running one, and one that
  must run at once (`stale` or `local`) never joins one that waits.
- A team entry change (`mex edit`, `mex wrong`, `mex forget` with `--apply`)
  rebuilds the shared files at once, so the entry, its rule file and the
  manifest are one working-tree change, including during an active session.
  This explicit-edit exception is intentional; personal note changes queue the
  background job.

# Sharing

`mex share` takes a person from solo to shared in one command.

Notes with checks are evaluated against current files before they are offered,
then checked again against the default branch in the temporary worktree before
any entry is written. A cached verdict cannot authorize sharing. Config and
source inventories are published as complete atomic replacements.

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
The progress record binds the approved notes and exact written file hashes.
Recovery refuses changed notes or outputs and preserves extra files, including
ignored additions. Only the exact share outputs are force-added to the index,
because setup's excludes are shared between worktrees. Cleanup never uses force.

# Session-start brief and native coverage

`mex brief --agent claude-code|codex [--path apps/api/main.ts] [--json]`
previews the hook's projection without scanning, rebuilding, registering a
checkout, creating storage, or writing delivery receipts. It requires the native
check evaluator. `--path` asks about an area relative to the checkout root.

The brief starts with the priority line, then eligible personal notes, then at
most three area one-liners. Claims are kept whole or left out. The hard cap is
300 tokens, enforced using a conservative UTF-8-byte upper bound that includes
labels, ids, separators, and room for the real delivery block marker. The
reported `token_bound` is an upper bound, not a tokenizer measurement.

The person's own notes may run past that cap, up to 1,000 tokens counted the
same way. A note reaches the brief only when no rule file the agent loads
carries it: one saved since the files were last written, one scoped to files
(rule files take only repo-wide and folder scopes), or any note for Codex in a
repository whose `AGENTS.md` is the person's own, which MEX never writes into.
A note's scope only ranks it: one scoped to a file nobody is working on still
goes out, after the notes linked to the work in progress. A team entry's scope
still decides whether it is sent. Team entries and commands still stop at 300. Delivery sends these notes
outside the start lane's budget, which the carry block shares; the brief's own
cap bounds them. The hook's 100 ms deadline bounds the optional part only:
once it passes, team entries and commands wait for the moments, but up to
eight of the person's notes are still checked and sent.

Canonical entries are parsed through the delivery controller's schema-v2 codec
and evaluated against current files. Broken entries, changed team recipes, hints,
retired personal notes, and rule-file Review conflicts are withheld. Team area
claims need strong evidence. Companions travel together or wait together.

The controller records the brief and its priority marker through its existing
schema-v2 `CheckAndMark` transaction. A repeated startup in the same session
cannot introduce a new brief, including during concurrent starts. Resume and
compaction use the controller's correction and recovery paths, rather than
generating a fresh start brief.

The JSON preview includes the coverage map: actual native file path, exact hash,
entry ids, agents and scope. Generated files count only while the current bytes
match their shared or local manifest. Imported rules count only while their
cached checkout and source hashes still match. Overrides, hand edits, missing
files and path-scoped Claude rules are rechecked. Claude's `InstructionsLoaded`
event can add session-local observations for known instruction files; it never
saves instruction text or changes canonical entries.

Codex runtime coverage follows the actual session working directory and its
32 KiB cumulative ancestor instruction budget. An API-area session loads the
API's generated `AGENTS.md`; reading an API file from a root session does not
prove it loaded that nested file. Delivery therefore remains available in that
case. Preview coverage describes the requested area; the live hook additionally
applies the host CWD. Custom host instruction settings can narrow what a host
loads, so the map assumes the supported default loading behavior.

The opt-in `scripts/acceptance/start-brief.mjs --prepare` creates disposable
fixtures without model calls. After explicit live-test approval, `--run <manifest>`
checks native loading and a next-session personal note in both CLIs, verifies
receipts, and retains local transcripts and footprint bounds. `--resume` keeps
successful evidence and retries incomplete cases with a combined native/note
check. It uses existing CLI authentication, fixture-local or invocation-local
hook settings, and no user settings writes.
