# MEX 0.9.0-beta.1.1

A fix release for 0.9.0-beta.1, on npm's `next` tag. MEX 0.8.5 remains on `latest`.

- A note that names a real command and goes on ("Run the tests with npm run test from the repo root") is saved whole, not as `[unverified command removed]`.
- `mex upgrade` keeps entries whose 0.8 fingerprints were too long for one line.
- The first screen suggests a note only you can write; the install screen drops the Codex-on-Windows timing line.
- The `mex upgrade` preview is shorter and says that applying pushes nothing unless you add `--pr`.
- New sessions get your notes again. On a busy machine the session-start brief ran out of time before reading any note and sent almost nothing; your own notes are now always considered.
- A note you save reaches your hidden rule files within seconds, even with a session open, instead of after every session in the repo has been closed for 10 minutes.
- In a repository with its own `AGENTS.md`, Codex gets all your notes at session start, not one.
- A note that names a file ("never cache it in .env files") still reaches every new session; before, it was sent only while that file was being worked on.
- `mex recall` finds notes by a word they all share.
- `mex forget <id>` works without a reason, as MEX tells you after an agent saves a note.
- `mex install` finds Claude Code and Codex when you use only the desktop app or an editor extension.

Update with `npm i -g mex-agent@next`.

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
- A live first screen in a colour terminal. Each step ticks as it runs and settles
  into one list. Out-of-date rule lines show as a small table under their file. At
  the end, the MEX mascot sums up the run. Agents, pipes and `NO_COLOR` keep the
  plain screen.
- Agents keep what you ask them to. Each session tells the agent to save a lasting
  fact, rule or decision you state, or anything you ask it to remember, with
  `mex note` in your words. A rule stated in passing ("we always use pnpm here") is
  quoted back to the agent for that turn. Such notes read `[Claude Code noted, …]`
  or `[Codex noted, …]` until you `mex edit` them. Typing `mex note:` yourself
  saves your own words.
- MEX picks up additions on its own. New package scripts, rule-file sections and
  agent memory reach the agents from the next session, without running `mex`
  again. A session start asks for a background re-read, at most every 30 minutes
  per repo, with no model call.

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
- With MEX off, the same six questions got "unknown" for five of them.
- Claude Code (Sonnet) was told "we always use pnpm in this repo" in passing,
  inside another question. It saved the rule with `mex note`, and a new Codex
  session then answered "pnpm" with no tools.
- In a repo with a `CLAUDE.md`, Claude was asked to add a field to a generated
  type. It changed the schema, citing MEX's note that the folder is generated.

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
- In a repo with a `CLAUDE.md`, Claude Code gets folder notes and commands. Claude
  reads no `AGENTS.md` there, so MEX writes Claude its own rule files.
- Every package's test and build commands are kept, up to 120, not the first 20.
  A repo's own root `AGENTS.md` no longer keeps the root commands from that agent.
- Imported rule lines keep identifiers such as `NODE_ENV`, and a code block's
  language tag is never taken for a rule.
- The command check no longer cuts a tool named in a sentence ("use pnpm in this
  repo"). Commands the repo doesn't define are still removed.
- Notes saved in one agent reach the other agent's rule files as soon as the
  session ends, not up to 10 minutes later.
- A `mex handoff` can be committed: MEX's ignore block no longer hides
  `.mex/handoffs/`.
- `mex install` finds Claude Code and Codex on PATH directly. A slow `where.exe`
  on Windows could skip an agent's hooks.
- Run through `npx`, MEX no longer installs hooks pointing into npm's temporary
  cache. It asks for `npm i -g mex-agent@next` instead.

## Known limits

- The session-start brief holds about 300 bytes; more notes reach the agent
  through MEX's rule files.
- A note scoped to some paths is corrected at its next delivery, not at session start.
- Agents keep what you state. Something an agent works out on its own, such as an
  environment variable the tests need, isn't saved yet. On smaller models, Claude
  may save a rule to its own memory instead; MEX offers that to Codex as a hint.
- On Windows, Codex starts each hook through PowerShell, which adds about 0.45 s
  per hook call.
- Learning from pull requests, review comments, CI and commit history comes in a
  later beta.
- The 0.9 Hub arrives in 0.9.0. More agents arrive in 0.9.0.
