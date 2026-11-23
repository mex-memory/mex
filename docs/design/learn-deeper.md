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
| Cluster | cheap | Code nominates pairs by shared files, identifiers or words. A cheap batch judges whether each pair gives the same rule, a related rule, or a different one. The strongest member leads each cluster. An earlier learned or refused entry also needs a same-rule verdict to match |
| Write | best | Several clusters per call. The writer sees each thread with the code as reviewed, the author's fix and today's code. It keeps only what this team decided, ruled out or got burned by, that a capable newcomer couldn't tell from the code |
| Judge evidence | cheap | Each writer or repair batch gets one check of its quoted clauses. Code verifies each quote in its source and rejects explicit reversals. Only supporting verdicts count. When a draft would add support to an earlier rule, the same batch compares the finished claim with that rule |
| Prove | none | Every clause needs a supporting quote. Each counted member must support the whole claim; the others get one round of their own, and a claim resting on one pull request without a strong signal is dropped. A pattern is kept only if it matches the reviewed code in every backed before/after pair, matches no fixed code and not its own "ok" example, is rare today (at most 3 occurrences in scope, and not in 2 or more files that are over 1% of it), and later commits on the default branch didn't keep adding it anyway. Every text file in scope up to 512 KB is read; a scope that can't be read in full is unknown, not rare |
| Repair | best | One turn for the entries that failed, with each failure's reason. A pattern that still fails is removed; the rule stays as text. A weak pattern is never kept |
| Route and save | none | Each lesson becomes one entry through the producer gate, with the checks below |

Single-signal lessons from one pull request start unticked, even with a proven edit pattern. A repeated
lesson from one reviewer can start ticked once the code proves it. Written policy can also corroborate a review.

## What a learned rule carries

- `when` patterns: the anti-pattern (the code reviewers objected to) and, where the fix has one, the required form.
- `fix`: a verbatim slice of the merged fix, at most 10 lines, shown when the rule stops an edit.
- A kept quote: at most 25 words of the source, secret-scanned, in the person's own copy only. `mex recall` shows
  it. It is never pushed to an agent, and `mex share` and every team write strip it.
- Checks (see [knowledge-checks](knowledge-checks.md)):
  - `fixture` (complete): the before and after code the rule was proven on, re-run against its current patterns.
  - the fix target, a `pattern` check with `expect: present` (complete). The reviewed file must still contain the
    fixed code. Removing it or leaving it only in a comment withholds the rule.
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
| A decision with a proven rejected pattern | At the edit that brings the rejected approach back, in scope or in a manifest |
| A rule, decision or pitfall with a scope and no pattern | At the first read or edit of a file it governs, or through path-scoped rule files where the agent has them |
| A process rule (branches, commit and PR text, releases) | In the agent's rule files, every session |
| Anything learned | On `mex recall <id>`, with its reason, fix, source and current verdict |

Nothing learned goes into the session-start brief.

## Staying true

Personal and shared learned rules follow the same table: a broken rule is withheld, and a changed one is replaced
by a pointer ("MEX is re-checking a learned rule: `mex recall <id>`"), never served in full. The judge can confirm
a rule and renew the baselines of the checks that failed. When a symbol a rule names moves, the entry follows it.

Agents can report a wrong rule with `mex wrong <id> "<reason>"`, and every rule file says so. A reason can be typed:
`contradicted <file>:<line>` (a line in this checkout), `rejected-by-ci`, `not-applicable`, or free text. From an
agent this never retires anything: it asks MEX to re-check the rule and puts a proposed correction in Review. From a
person's own terminal it retires the rule, as before.

A learned pattern whose stops are pushed through or reported wrong more than 10% of the time, over at least 20 stops,
stops firing and stays as text, with a Review item saying why. The entry, its pattern and its proof are kept, and
restoring it from Review starts the count again.

The cited review comments are re-fetched weekly, 100 per request, within the automatic allowance. An edited or
deleted comment makes the rule changed: it goes to the judge, and agents get a pointer instead of the rule until then.
When a complete group cannot be read, or the reply does not include every node, the observation is `unavailable`
with the time it was attempted. An `unavailable` source is not treated as edited, and a `same` observation older
than 14 days is stale. An incomplete group is left unwritten. A shared copy can carry the node ids and optional
per-node hashes beside the manifest, without adding fields to a source a current reader already accepts. A checkout
that has no local group imports that list the next time the network pass starts.

A judge confirmation that a rule is still true re-records the baselines of the checks that failed: a pattern count,
a quote or source hash, and the file hashes the check already names. A passing check is left as it was. A required
literal is stored with its own pattern count, so a migration can be seen as the anti-pattern rising and the required
form falling.

A rule with no check that reads the repository (URL sources alone don't count) goes to Review after 90 days without
a tick, a judge confirmation or a recorded follow. Nothing records a follow for a prose rule, because a delivery can't
show that it was followed. Anchored rules have no time limit. When the team retires a rule on the default
branch, the person's copy is retired too: by id, by the source both were learned from, or by exactly the same claim.

## The review list

At the end of a run, bare `mex` in a terminal lists everything that was learned, a page at a time: each rule's claim,
why, fix and source. A lesson from one pull request waits for a tick regardless of pattern proof. A number toggles one. Enter
goes to the next page and on the last one saves every decision together, `d` there drops the unticked, and `q` leaves
without saving anything. If an entry changed meanwhile, nothing is saved and the list is shown again next time.

A person can leave an item waiting without refusing it. Enter on a row that is already proposed records a wait at
any support count. That wait is not a refusal: the claim is not tombstoned, and a different lesson is not forgotten.
Later weekly evidence may add support and list the item again, and the entry stays proposed until the person ticks
it. Dropping a rule retires it. Unticking a rule that was already in force is a refusal, and a later lesson that is
clearly the same is refused before the writer is paid. A lesson that is only about the same thing may be a different
one: it is written with the dropped rules in view and waits for a tick, even when the code proves it.

After a wait or a drop, the terminal says when a shared team copy is a separate copy and is unchanged, and that rule
text an agent has already loaded stays until that agent starts again. Generated rule files are rebuilt when no agent
session is running. Recall of a proposed or retired learned entry says the same. The Hub screen is deferred; it reads
the same `learning.deep.review.<jobId>` rows the terminal lists, including rows from a weekly, failed, or cancelled run.

`v` then a number offers to have the person's own agent read the checkout, read-only, and say whether a waiting rule
holds; the estimate is shown first, and so is the ceiling of 1.5 times that estimate. An answer over the ceiling is
discarded and is not a review decision. One response already in flight can still be billed. The check stops after 8
tool calls or two minutes, and a stopped run gives no answer. Evidence has to name a file in the checkout and a line
that file contains. Keep is staged only when the producer gate accepts the rule as active. A rewrite is staged only
when the gate accepts the new wording, and saving it leaves the rule waiting for a tick. A wording the gate rejects
stays as it was. Drop remains the person's retirement on save.

The list also replays the person's last 20 commits in the repository, by their git email, through delivery's own
matching, at no cost: up to three lines on which rules would have stopped an edit, then which would have been shown
when a file was touched. Those lines are a hypothetical replay of past commits, not an observed stop. Paths from
that replay are stored with forward slashes. On Windows, scope matching follows the checkout's spelling without
regard to case. A scope is still stored with forward slashes.

Each candidate that does not become a saved rule keeps a disposition outside the rows deleted at the end of the run:
dropped, quota, bad output, an earlier unit already written, a proof downgrade, a duplicate, or an interrupted call
whose answer was lost. The receipt stores ids and a short reason, not the source text.

A linter name in a comment, or a file that is not a rules table, is not proof the rule exists or is enabled. An
explicit off setting is not enabled. A rules table that does not list the rule can still suggest enabling it.
Follow and ignore for issues, linter suggestions, and alternatives are counted from the settled delivery of that
entry. An edit that matches more than one learned procedure is not counted as a follow for any of them. Real-agent
metrics for this beta wait until the audit's other blockers are confirmed on their own.

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
| Procedures from Git history | `learning.procedures`, off | Up to five cheap calls within the 3% automatic allowance. The estimate includes them when enabled | A procedure waits for a tick. After it fires on file creation, the delivery receipt counts a successful edit in another role as followed, and only when that edit matches this procedure alone. A settled delivery without one counts as ignored |
| Rejected alternatives | Included in learn deeper | Part of the writer call | The learning receipt counts alternatives present in the saved text. Speed bump receipts distinguish edits that heed the bump from explicit overrides by entry ID |
| PR Decisions section | `learning.prDecisions`, off | No extra model call. The instruction adds one line to local generated rule files | Among PR descriptions read, count those with and without a nonempty Decisions section. The count describes adoption in that sample |
| Linter suggestions | Included in learn deeper | Part of the writer call | The receipt counts saved suggestions to enable a linter rule. A settled delivery of that entry counts as followed or ignored. A name in a comment is not treated as enabled |
| Closed issues | `learning.deep.issues`, off | Qualifying issues spend from the learning estimate | The receipt counts issue sources kept after sorting. A settled delivery of a saved entry with issue evidence counts as followed or ignored |

Stop records paths and rule IDs and returns before the background job runs. The job checks the diff in an empty
private directory and keeps diff text in memory for the call. Each pointer stores the rule ID, location and line
hash and reaches the agent on prompt submission.
