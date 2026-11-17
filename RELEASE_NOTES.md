# MEX 0.9.0-beta.1

Pre-release on npm's `next` tag. MEX 0.8.5 remains on `latest`.

Tell your agents once; MEX keeps it true. A note you save reaches new Claude Code
and Codex sessions, and once the code makes it false, MEX holds it back or points
at the current code instead.

## Added

- Machine-wide hooks for Claude Code and Codex, native hook binaries and a Node
  fallback. Installation records allow settings to be restored on uninstall.
  (#336, #337, #338, #339, #357, #366)
- Local records for notes, sessions, jobs and usage. Background jobs resume from
  completed batches. Automatic model work uses the existing usage budget.
  (#340, #360, #362)
- Personal notes with sources, reasons and checks: `mex note`, `recall`, `expand`,
  `edit`, `wrong`, `forget` and `check --diff`. Broken complete checks hold notes
  back; changed supporting evidence can send a pointer to current code.
  (#349, #350, #351, #352, #355)
- A free first screen from bare `mex`, with repo recipes, rule-file review,
  agent-memory hints, a file index and bounded git-history findings. (#346, #370)
- Rule-file imports, generated native rule files, a session-start brief and
  reviewed git sharing. Sharing previews first and pushes only with `--pr`.
  (#363, #364, #365, #369)
- A previewed upgrade from 0.8, with recovery for interrupted work. (#372, #390)
- Session capture, a queued knowledge judge, review, search aliases, decisions
  tied to commits and delivery records. (#374, #375, #383, #391, #395)
- Hook delivery, ranking, session anchors and the `mex what` session view.
  (#368, #371, #392, #396)
- Anonymous usage counts with local inspection and an off switch. (#342)
- Beta.1 CLI polish: inline rule findings, next steps and undo instructions,
  `mex status`, the new doctor view and help ordered around the 0.9 commands.

## Changed

- Bare `mex` and `mex setup` turn MEX on for the repo. They no longer start the
  old setup wizard or open a Hub. The first screen itself makes no model calls.
- Personal notes stay local until reviewed sharing. Team notes and agent rule
  files travel through git; disposable records stay on each machine.
- `mex doctor` reads the same local status as `mex status` and adds fixes.
  `mex doctor --legacy` retains the 0.8 diagnostic.
- The Hub in a 0.9 checkout prints the rebuild notice. The 0.8 Hub remains
  available where `.mex/ROUTER.md` exists. The rebuilt Hub arrives in 0.9.0.
- Legacy graph and team commands are hidden from top-level help while retained
  compatibility commands remain runnable. Setup's old flags are hidden.

## Removed

- The old Inbox, Workstream, Spec, terminal dashboard, watcher, heartbeat,
  logging, timeline, pattern, init, export and skill-sync command entry points.
  Each removed command prints a replacement or says no replacement in 0.9.
  (#335)
- The 0.8 setup wizard and old Hub from the default first-run path.

## Try it and undo

```sh
npm i -g mex-agent@next
cd your-repo && mex
mex note "Run the tests from the repo root because the config is there"
```

Start a new Claude Code or Codex session and ask about the note. Run `mex what`
to see what reached that session. `mex off` stops MEX in this repo;
`mex uninstall` restores user settings and keeps notes.

## What we measured

Run on 17 Nov 2026, Windows 11, Claude Code 2.1.326 and Codex 0.165. These are
single runs on the samples named, not general claims; beta.1 makes no claim about
saved tokens or task success.

- Six notes saved with `mex note`, then a new session with no tools allowed:
  Claude Code answered 6 of 6 from them, and so did Codex.
- A commit changed the port a note named. On the next session neither agent was
  given the old value as fact, and MEX's rule files were rebuilt without the note.
- Hono's real history, 46 claims over six checkpoints (deterministic, no model):
  no claim the code had made false was delivered in full at any checkpoint, while
  up to 15 of them existed. At the last checkpoint 20 of 31 still-true claims went
  out in full; the rest went out as a pointer to the current code or were held.
- The upgrade from 0.8 reached a ready preview on four real 0.8 projects.

## Fixed during beta testing

- Hooks now install after a global npm install on Linux and macOS.
- The first screen reports a rule line as out of date only when it is: workspace
  scripts, `pnpm --filter` commands, scoped paths, installed dependencies, outputs
  and ignored folders no longer count.
- A note the code has made false no longer reaches the agent through MEX's rule
  files, and `mex note` is checked the moment it is saved.
- MEX keeps the words of a note you wrote. The judge proposes a new wording in
  `mex review` instead of rewriting it.
- Naming a file in a prompt no longer hides that file's pitfall.
- In a new repo, notes reach the first session through each agent's own rule files.
- `mex off` also removes MEX's rule files in that repo.
- Older 0.8 layouts and an unreadable file no longer block `mex upgrade`, and its
  preview lists files instead of printing the whole diff.
- Learning from what you type is off until you turn it on:
  `mex config set learning.statements on`.

## Known limits

- The session-start brief holds about 300 bytes; more notes reach the agent
  through MEX's rule files.
- A note scoped to some paths is corrected at its next delivery, not at session start.
- The 0.9 Hub arrives in 0.9.0. More agents arrive in 0.9.0.
