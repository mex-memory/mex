# Machine-wide agent installation

`mex` installs hooks for detected Claude Code and Codex CLIs, then turns MEX on
for the repository it runs in and shows the first screen (`src/repo-start/`). `mex install` retries installation or
updates it after an upgrade. `mex install --dry-run` lists destinations without
creating a home, database, runtime or settings file. JSON summaries contain
paths and actions, never settings contents or saved snapshots.

The installer owns only user-level agent hook entries, its stable runtime
under the MEX home, and explicitly owned untracked prototype hook entries in
the current repository. It never edits tracked files, grants Codex hook trust,
changes hook policy switches, or launches an agent. Codex installations show
one line directing the person to `/hooks`, on the first screen of the run that
changed the hooks.

## Repository exclude blocks

Turning a repository on adds one block to the repository's shared
`info/exclude` file (found with `git rev-parse --git-path info/exclude`, so
every worktree uses the same file). The block hides `/.mex/*` and un-hides only
what `mex share` commits: `.mex/learned/`, `.mex/config.json`,
`.mex/sources.json` and `.mex/native.json`. Tracked files are unaffected.

Blocks are fenced by named markers (`# mex: <name> begin` / `# mex: <name> end`)
so other MEX features keep separate blocks. Each change is journaled in the
record's `installs` table (`exclude-v1:<name>`) before the file is written.
`mex uninstall` restores a file that still holds exactly what MEX wrote to its
earlier bytes, and from a file the person edited since removes only MEX's
block.

## Destinations and commands

- Claude Code: `~/.claude/settings.json`, respecting an absolute
  `CLAUDE_CONFIG_DIR`. Exec-form handlers use an executable plus arguments and
  explicitly continue after hook failures.
- Codex: `~/.codex/hooks.json`, respecting an absolute `CODEX_HOME`. Commands
  quote each argument independently. Windows uses PowerShell's call operator
  and literal single-quoted arguments, including apostrophe escaping.
- Runtime: `<MEX home>/bin/mex-hook[.exe]` when an optional platform binary
  passes its self-test, a standalone `mex-hook.cjs` fallback/recovery bundle,
  and `launcher.json` naming the current Node and built CLI entry.

All events in the existing two shim profiles are registered, with a fixed
command per event. Repeat installation does not rewrite equivalent settings.
A Node fallback selection stays stable across upgrades; installing a native
package later does not silently change trusted hook definitions. The existing
Node fallback answers empty and does not implement delivery. Platform package
publication/optional-dependency wiring remains release work.

On Windows, Codex runs each hook through PowerShell. The upstream shim handoff
measured about 0.45 seconds per call on one Windows 11 laptop (30 runs after
three warmups); that is historical evidence, not a measurement of this slice.
All nine supported Codex events remain registered on Windows to preserve the
existing adapter contract and avoid new trust reviews when delivery lands.
Live validation and current Windows measurements remain required separately.

## Install records and recovery

`src/install/` uses the existing Node-owned `installs` table without changing
the record schema. Each `file-v1:settings` or `file-v1:runtime` row holds the
original and installed bytes as base64 plus file permissions. The row commits
before the filesystem write; an interrupted install can therefore be undone.
Upgrades append changes rather than replacing the original baseline.
The prepared settings edit is bound to its original snapshot. A concurrent
user edit or redirected parent aborts publication; a known failed replacement
keeps a cancelled audit record instead of becoming an active undo operation.

A bounded `<MEX home>/install-recovery.json` mirror contains only active
user-settings records. It is private local data, like the database; it must
not be copied into a repository or diagnostic output. The installer serializes
operations through the existing recoverable filesystem lock. Atomic writes
recheck file identity/content, reject redirected leaves and hardlinks, and
preserve permissions. Settings are limited to 1 MiB, runtime files to 32 MiB,
active installation history to 512 changes, and the mirror to 8 MiB.
The native hook bounds launcher metadata reads to 4 KiB before decoding it.

At session start, a native shim whose launcher names a definitely missing CLI
starts a detached native worker. That worker bounds the surviving Node bundle
to five seconds without making the foreground hook wait for cold Node startup.
Ordinary tool hooks do not read launcher metadata. The bundle also handles its
own fallback hook calls. It restores recorded user settings
without opening either database or running any repository command. Permission
errors, malformed metadata and background runs never authorize cleanup.
Recovery takes the same lock as installation/uninstall and rechecks the missing
CLI inside that lock, so a concurrent reinstall cannot lose its hook entries.
The Node CLI can reconcile the unchanged records on a later uninstall.

## Uninstall

`mex uninstall` lists its records, restores settings first, and restores or
removes runtime files afterward, with the native shim last. A file unchanged
since installation is restored byte for byte, including BOM, CRLF, whitespace,
missing final newline, and its previous permissions. Files created by MEX are
removed. Successfully restored records remain in the database under a
`restored:` key; ordinary uninstall keeps project notes and other data.

For independently edited JSON settings, restoration reverses only the recorded
delta and preserves unrelated user edits and hooks. A modified installed hook,
unreadable file, tracked file or changed runtime produces a recovery conflict.
Settings conflicts keep every runner and the install records so no registered
hook is stranded. Interrupted uninstall can be retried.

`--purge` deletes local data only after restoration succeeds and a live
background process is no longer using it. It checks the entire deletion tree
for links and junctions first and refuses redirected roots. `--dry-run` lists
records without restoring files or stopping jobs. Post-command hooks never
recreate runtime or restart jobs after uninstall.

Prototype commands carrying `--mex-managed` are inert in the shim. The
installer removes those handlers from untracked project settings, preserving
other handlers in mixed groups and recording the original bytes. Tracked
project settings are reported for reviewed Git removal; installation does not
edit them. A hook in an older, separately retained prototype bundle needs that
tracked entry removed through the repository's normal review flow.

## Verification

Deterministic tests under `src/install/__tests__/` cover exact restoration
after upgrades, repeat installs, user-hook preservation, interrupted writes,
conflicts, fallback selection, config overrides, bounds, tracked/link refusal,
legacy cleanup and purge. Built-CLI tests use disposable homes and inert
discovery executables; they run no model. They also exercise the installed
recovery bundle after a simulated package removal. Go tests cover missing-CLI
detection, session-start-only cleanup, legacy suppression and configuration
overrides. Session and off/capture controls are described in
[agent-controls.md](agent-controls.md). Interactive model-visible context, lean model
runs and current Windows timing are outside these deterministic checks.
