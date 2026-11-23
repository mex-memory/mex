# Learn deeper

Learn deeper is setup's second step. It turns a team's written judgment into rules a coding agent gets at the
moment it matters: the review comments that led to a change, pull requests the team closed with a reason, reverts,
commits that name what caused a bug, decision records and contributor docs. It reads human judgment, not the code:
the code comes in only to anchor a lesson and to prove it.

Every learned rule carries the proof that made it. A code rule's pattern must match the code a reviewer objected
to and not the fix the author made, and it stays quiet on today's code. The rule then fires when an agent's edit
repeats the mistake, with the team's fix, and is withheld when the code no longer supports it.

## What it reads

| Source | Where it comes from | What it can teach |
| --- | --- | --- |
| Review threads from people with write access, with the code as reviewed, the merged fix and today's code | the forge (GitHub in 0.9.0) | team rules, where code belongs, how to use the repo's own APIs |
| Pull request descriptions by people with write access that say what was chosen or ruled out | the forge | the decision behind a change. Any description is context for the review threads of its change |
| Closed, unmerged pull requests with a maintainer's reason | the forge | what the team tried and ruled out |
| Reverts, joined to the reverted change and any re-land | local git history | what broke, and the fixed approach |
| Commits that say "regression from", "caused by" or "broken by", whose diff changes production code | local git history | pitfalls with a known cause |
| Decision records ("considered options", "rejected", "consequences") | the repository | decisions and the alternatives they beat |
| Contributor docs (CONTRIBUTING, development and architecture guides) | the repository | written team policy |
| Closed issues with a maintainer's explanation (off by default, `learning.deep.issues`) | the forge | ruled-out requests |

Agent rule files (`AGENTS.md`, `CLAUDE.md` and the other formats MEX imports) are never read as docs: setup's
first step already imports them. Docs are at most a quarter of a run's rules unless the repository has no review
history. Bot comments, minimised comments, authors without write access and anything that looks like a secret are
dropped. Reviewers are counted by a hashed key, never by name. A change's own author is not one of its reviewers: their
replies are context, and a note on their own lines counts only when it says what was chosen.

Of a description only what its author wrote is read: not hidden comments, ticked boxes, the repository's own template
or a block a program put there. A checklist's link to CONTRIBUTING is nobody's argument, and a template repeated in a
hundred descriptions is one statement. Nobody reviewed a description, so on its own it is strong only under a Decisions
heading, and descriptions take at most a quarter of the token budget. A closed change counts only with a reason in the
maintainer's own words ("superseded by" is a status), next to the first 512 bytes of what was proposed.

Each source is weighted, in code: whether the commented lines changed before merge (acted on), whether the
reviewer knows that path (listed in CODEOWNERS, or reviewed it before), a link to a guideline, generalising
wording ("always", "we don't", "instead use"), and a small pull request.

## The pipeline

| Stage | Model | What happens |
| --- | --- | --- |
| Harvest | none | Newest first, spread across the review window, until the run's token budget is reached. A change the search shows nobody discussed is not fetched. A cursor is saved, so weekly learning reads only what is newer |
| Triage | cheap | Keep or drop each item from its comment text alone, with a category and a one-line lesson. Nits, one-offs, questions, status and generic advice are dropped |
| First rules | best | The strongest items of the first batch are written right away, so the first rules arrive within minutes |
| Cluster | none | Lessons that say the same thing, in the same direction, are grouped across the whole window. A shared code identifier is only a hint: two comments about one API are usually two lessons. A cluster is led by its strongest item, so unrelated lessons don't chain together. In doubt two lessons stay apart, because a missed repeat costs a duplicate and a wrong one gives a rule support it doesn't have |
| Write | best | Several clusters per call. The writer sees each thread with the code as reviewed, the author's fix and today's code. It keeps only what this team decided, ruled out or got burned by, that a capable newcomer couldn't tell from the code |
| Prove | none | Every clause must quote its evidence verbatim. Support, reviewers, label and sources come only from the members quoted for the claim; the others get one round of their own, and a claim resting on one pull request without a strong signal is dropped. A pattern is kept only if it matches reviewed code in at least one before/after pair, matches no fixed code and not its own "ok" example, is rare today (at most 3 occurrences in scope, and not in 2 or more files that are over 1% of it), and later commits on the default branch didn't keep adding it anyway. Every text file in scope up to 512 KB is read; a scope that can't be read in full is unknown, not rare |
| Repair | best | One turn for the entries that failed, with each failure's reason. A pattern that still fails is removed; the rule stays as text. A weak pattern is never kept |
| Route and save | none | Each lesson becomes one entry through the producer gate, with the checks below |

Single-signal lessons (one pull request with a strong signal) are saved as waiting for a tick: they are listed,
never delivered, until the person keeps them.

## What a learned rule carries

- `when` patterns: the anti-pattern (the code reviewers objected to) and, where the fix has one, the required form.
- `fix`: a verbatim slice of the merged fix, at most 10 lines, shown when the rule stops an edit.
- A kept quote: at most 25 words of the source, secret-scanned, in the person's own copy only. `mex recall` shows
  it. It is never pushed to an agent, and `mex share` and every team write strip it.
- Checks (see [knowledge-checks](knowledge-checks.md)):
  - `fixture` (complete): the before and after code the rule was proven on, re-run against its current patterns.
  - the fix target, a `pattern` check with `expect: present` (complete): the literal the fix relies on must still be
    in scope. If the team removes it, the rule is withheld.
  - the anti-pattern's count today, a `pattern` check with `expect: at-most` (supporting): a rise sends the rule to
    the judge; a fall (the team cleaning up) changes nothing.
  - `scope` (complete): the rule governs at least one file.
  - the cited review comments, `source` with a URL (supporting): re-fetched weekly; an edited or deleted comment
    sends the rule to the judge.
  - `quote` for a doc-backed rule: its passage is relocated, not the whole file hashed; an unrelated doc edit costs
    nothing, a reworded passage goes to the judge, a removed one withholds the rule.
  - `until` for a time-bound decision ("removed in v5"): the rule is withheld once the version is reached.

## Where learned rules reach the agent

| Learned thing | When the agent gets it |
| --- | --- |
| A code rule with a proven pattern | At the edit that adds the anti-pattern in scope: the speed bump stops it once, with the team's fix |
| A rejected approach | At the edit that brings it back, in scope or in a manifest |
| A rule, decision or pitfall with a scope and no pattern | At the first read or edit of a file it governs, or through path-scoped rule files where the agent has them |
| A process rule (branches, commit and PR text, releases) | In the agent's rule files, every session |
| Anything learned | On `mex recall <id>`, with its reason, fix, source and current verdict |

Nothing learned goes into the session-start brief.

## Staying true

Personal and shared learned rules follow the same table: a broken rule is withheld, and a changed one is replaced
by a pointer ("MEX is re-checking a learned rule: `mex recall <id>`"), never served in full. The judge can confirm
a rule and renew its baselines. When a symbol a rule names moves, the entry follows it.

Agents can report a wrong rule with `mex wrong <id> "<reason>"`, and every rule file says so. A reason can be typed:
`contradicted <file>:<line>` (a line in this checkout), `rejected-by-ci`, `not-applicable`, or free text. From an
agent this never retires anything: it asks MEX to re-check the rule and puts a proposed correction in Review. From a
person's own terminal it retires the rule, as before.

A learned pattern whose stops are pushed through or reported wrong more than 10% of the time, over at least 20 stops,
stops firing and stays as text, with a Review item saying why. The entry, its pattern and its proof are kept, and
restoring it from Review starts the count again.

The cited review comments are re-fetched weekly, 100 per request, within the automatic allowance. An edited or
deleted comment makes the rule changed: it goes to the judge, and agents get a pointer instead of the rule until then.
A comment that can't be read this week is skipped, not counted as deleted.

A rule with no check that reads the repository (URL sources alone don't count) goes to Review after 90 days without
a tick, a judge confirmation or a recorded follow. Nothing records a follow for a prose rule, because a delivery can't
show that it was followed. Anchored rules have no time limit. When the team retires a rule on the default
branch, the person's copy is retired too: by id, by the source both were learned from, or by exactly the same claim.

## The review list

At the end of a run, bare `mex` in a terminal lists everything that was learned, a page at a time: each rule's claim,
why, fix and source, corroborated or proven rules pre-ticked, single-signal ones waiting. A number toggles one, Enter
goes to the next page and on the last one saves every decision together, `d` there drops the unticked, and `q` leaves
without saving anything. If an entry changed meanwhile, nothing is saved and the list is shown again next time.

A dropped rule is retired and its drop recorded in one step, so nothing delivers it again. A later lesson that is
clearly the same is refused before the writer is paid, and one with the same trigger under other words is never
saved. A lesson that is only about the same thing may be a different one: it is written with the dropped rules in
view and waits for a tick, even when the code proves it. A rule the person unticked is never switched on by later
evidence; a single-signal rule left waiting is listed again once a second pull request supports it.

`v` then a number offers to have the person's own agent read the checkout, read-only, and say whether a waiting rule
holds; the estimate is shown first. It stops after 8 tool calls or two minutes, and a stopped run gives no answer.

The list also replays the person's last 20 commits in the repository, by their git email, through delivery's own
matching, at no cost: up to three lines on which rules would have stopped an edit, then which would have been shown
when a file was touched.

Without a terminal (an agent, a script, CI) nothing is asked; the next `mex` in a terminal asks.

## Cost, consent and privacy

- `mex learn --dry-run` shows the estimate, ceiling, source counts and gaps. It reads review history and git, spends no
  tokens, and saves and queues nothing.
- The estimate is shown before anything starts; Enter starts it, one key skips it. It runs through the person's own
  Claude Code or Codex with no tools, in an empty private folder, and never from an agent, a script or CI. The
  ceiling is 1.5 times the estimate.
- Weekly learning runs within the automatic 3% allowance, only when no agent session is active.
- Everything the run reads (comments, code regions, pull request text) is deleted when the run ends, however it
  ends; the rules, their proofs and the kept quote remain. Learned rules stay personal ("learned, not shared")
  until `mex share`, which needs two pull requests' evidence for a review rule.
- Past-session learning is not part of learn deeper.

## Trials

Change the project trials with `mex config set <key> on|off --project`. The learning receipt keeps trial totals
and the IDs of entries the trials saved. Delivery outcomes are counted separately from proposals.

| Trial | Setting and default | Cost | How outcomes are counted |
| --- | --- | --- | --- |
| Prose checks after Stop | `learning.stopCheck`, off | One cheap call for up to three scoped rules and up to 12 KiB of diff. Runs when agents are idle, within the 3% automatic allowance | The next prompt gets each pointer once. Recall or a change to the flagged line counts as followed. A delivered pointer with neither counts as ignored when the observation ends |
| Procedures from Git history | `learning.procedures`, off | Up to five cheap calls within the 3% automatic allowance. The estimate includes them when enabled | A procedure waits for a tick. After it fires on file creation, the delivery receipt counts a successful edit in another role as followed. A settled delivery without one counts as ignored |
| Rejected alternatives | Included in learn deeper | Part of the writer call | The learning receipt counts alternatives present in the saved text. Speed bump receipts distinguish edits that heed the bump from explicit overrides by entry ID |
| PR Decisions section | `learning.prDecisions`, off | No extra model call. The instruction adds one line to local generated rule files | Among PR descriptions read, count those with and without a nonempty Decisions section. The count describes adoption in that sample |
| Linter suggestions | Included in learn deeper | Part of the writer call | The receipt counts saved suggestions to enable a linter rule. Speed bump outcomes can be read by entry ID when a bump fires |
| Closed issues | `learning.deep.issues`, off | Qualifying issues spend from the learning estimate | The receipt counts issue sources kept after sorting. For saved entries with issue evidence, read the usual delivery receipts by entry ID |

Stop records paths and rule IDs and returns before the background job runs. The job checks the diff in an empty
private directory and keeps diff text in memory for the call. Each pointer stores the rule ID, location and line
hash and reaches the agent on prompt submission.
