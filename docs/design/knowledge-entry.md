# Knowledge entry file, version 0

One entry is one fact and its reason, stored in one UTF-8 Markdown file.
The file contains a YAML `mex:` block and the text. Location decides whether
the entry is personal, a team entry, or a hint; location is not a field.

| Level | Location |
| --- | --- |
| Personal | `<MEX home>/projects/<project-id>/notes/<id>.md` |
| Team | `<repo>/.mex/learned/<id>.md`, optionally grouped by kind |
| Hint | `<MEX home>/projects/<project-id>/hints/<id>.md` |

The MEX home follows the local-record contract: `.mex` inside `MEX_HOME` when
set, otherwise `.mex` inside the user's home. Project identity and registered
checkout identity come from the local record. Personal notes are shared by
worktrees and full clones with the same registered project identity on the
machine. They are never written inside the repository.

## File and fields

```markdown
---
mex:
  id: mx_7f3k2a
  kind: recipe
  scope: ["test/**"]
  source:
    type: person
    ref: mex note 2026-11-13
    quote: Tests use fixtures because fixed data makes failures reproducible.
  evidence: person
  one_line: Tests use fixtures because fixed data makes failures reproducible.
  checks: []
  status: active
  created: 2026-11-13
---
Tests use fixtures because fixed data makes failures reproducible.
```

`id` is `mx_` followed by at least six lowercase letters/digits. IDs are random,
stable, never reused, and match the filename. The implementation accepts up to
64 letters/digits and mints 24 hexadecimal digits.

Required fields are `id`, `kind`, `scope`, `source`, `evidence`, `one_line`,
`checks`, `status` and `created`. `kind` is recipe, rule, decision, pitfall,
procedure, fact or hint. Scope is one or more repository-relative globs; `**`
means the whole repository. Absolute paths and parent traversal are refused.

Source has a `type` (person, docs, review, ci, config, rule-file, mined,
observed or agent-memory) and a `ref` (a path, link or session reference).
A person source also needs its exact `quote`; a writer claiming a person
source must verify that quote against the supplied typed text. `mex note`
retains the text passed explicitly to the command, without model inference.
Evidence is person, docs, review, ci, mined or observed.

`one_line` is the complete claim in one line, never an automatic truncation.
`when` optionally contains `{type, match, pattern}` items: type is anti,
required, rejected or creates; match is literal or structural. Optional
`companions` are entry IDs. Unknown metadata is refused.

Status is active, proposed or retired. A proposed entry was written by an agent
and isn't in force yet: it is never delivered as accepted knowledge, never
written into a rule file, and can be read, retired or given aliases, but its
claim can't be edited. A retired entry keeps the same ID and file, with
`retired: {reason, by, at}`. `created` and `retired.at` are calendar dates, without
clock times. The body is an authored fact and reason, normally one or two
sentences. Structural validation does not judge the truth or wording of prose.

Verdicts, last-used values, delivery counts, and other per-checkout observations
never belong in this file. They belong in the local record. Legacy Wiki
metadata (`triggers`, `edges`, `last_updated`) is not accepted.

## Check syntax

The internal `src/knowledge/entry.ts` exports `EntrySchema`, `CheckSchema` and
their inferred TypeScript types, plus parse/serialize helpers. These are not
new package-root exports. Checks are stored observations, not executed code.
Evaluation is implemented by the checks ticket.

Each check is `{kind, role, target, saw, files}`. Role is `complete` or
`supporting`; only a complete check can prove the whole claim broken. `saw`
is the observation at authoring time. A check must hold when authored; the
codec validates its shape, while an evaluator establishes that it holds.
`files` maps every file read to its `sha256:<64 lowercase hex digits>` hash.

| Kind | Target | Saw |
| --- | --- | --- |
| key | `{file, pointer}` (JSON Pointer) | `{value}` |
| command | `{run, file, pointer}` | `{exists}` |
| section | `{file, heading}` | `{hash}` |
| source | `{file}` or `{url}` | `{hash}` |
| value | `{file, symbol}` | `{value}` |
| symbol | `{file, symbol}` | `{fingerprint}` |
| legacy-grounding | `{node, file?}` | `{fingerprint, bodyHash?, codeHash?}` (original 0.8 evidence) |
| pattern | `{scope, pattern, match?}` | `{count}` |
| relation | `{query, from, to}` | `{count}` |

Values are bounded JSON. Source URLs use HTTP(S). Relation checks are encoded
now for consumers; their evaluator belongs to later graph work.

`legacy-grounding` is an import-only compatibility check. Its role is always
`supporting`, `files` is exactly `{}`, and it retains the original Graph node
ID and MinHash (`mh:` or `mh2:`) without translating or renewing them. Optional
historical hashes and file paths stay absent when absent from the source.
Unlike newly authored checks, it is deliberately unresolved: evaluation returns
`floor` ("legacy grounding needs review"), giving `unknown` unless another
check proves a worse verdict. A passing documentation check cannot certify it.
Normal check recording cannot mint this kind. Explicit review replaces it with
a current native check; unresolved code facts remain pointers or are withheld,
and entries whose checks have not held stay out of generated rule files.

## Commands in the first slice

`mex note "fact and reason"` saves a personal entry. Optional `--kind`,
repeatable `--scope`, and `--one-line` specify authored metadata. Empty checks
are explicit. `mex log` is the same command for one release; its old event
options are replaced by note options.

`mex recall "words"` requires every normalized word to occur in the text,
short form, kind or scope. It uses Unicode word matching, without stemming,
embeddings or a model call. Results include their ID, source label and complete
one-line form. `--limit` is 1–100, default 20. `mex expand <id>` returns the full
entry. Every command supports `--json`; runtime failures exit nonzero with
`{ok:false,error:{code,message}}`. Successful reads use `ok:true`. Argument
usage errors retain the CLI parser's normal diagnostics.

Recall and expand do not create directories, register checkouts, migrate
databases, refresh indexes or record usage. Registered project identity takes
precedence over a new fallback identity computed from the current branch.
Explicit note writes open the Node-owned record and publish complete bytes
with an exclusive staging file and a no-overwrite link. Redirected directories,
links and non-regular note files are refused.

Headless setup does not pre-approve `note` or `log`: the former event-log
permission no longer applies now that `log` saves a personal knowledge entry.

## Aliases and asks

`aliases` (at most 8, each at most 40 characters) and `asks` (at most 5 example
requests, each at most 120 characters) are optional lists of trimmed one-line
phrases, unique ignoring case. They are the words a person would type when the
entry matters and who doesn't know it exists: symptoms, error text, task
phrasing. They are retrieval aids only: never delivered text, never evidence,
never written into rule files.

Every candidate passes a deterministic filter before it is kept (`src/knowledge/aids.ts`),
using the delivery ranker and its prompt gate over the project's own entries:

1. Typed alone as a prompt, it must not already make the gate send a different
   entry. Keeping it would steal that prompt.
2. Added to its entry, it must rank that entry first, ahead of the next by at
   least 25% of its score.
3. An alias another entry already keeps goes to Review instead of being kept
   twice.

The rule has no parameters learned from any repository. Every verdict, kept or
dropped, is recorded with its reason in `aid_verdicts`. The background process
reruns the filter when a checkout's entries or HEAD change: a personal note
loses an alias that no longer passes, and a team entry's goes to Review.

Writers: `mex alias <id> add|remove <text>` and `mex ask ...` by hand (team entries
take the usual preview and `--apply --expect`), and `mex entries enrich`, an
opt-in backfill: the bare command shows what one call would cover at no cost,
`--run` makes one batched call inside the model cap and saves a filtered
preview, and `--apply --expect <revision>` writes exactly that preview. Later AI
writers use `applyCandidateAids`. `mex note` itself makes no model call.

## Decisions that cite a commit

`mex note --decision --commit <rev>` records `commit: {sha, patch_id, subject, files}`
and saves the decision as proposed. `--quote <text>` adds a line of the commit
the decision rests on, kept only if grounding finds it in the commit message or
diff (exact x1.0, fuzzy x0.85, not found x0.6, on a restatement's starting 0.9;
below 0.6 it is left out). `--supersedes <id>` names a decision it replaces.

The decision comes into force when the commit, or a copy of it, is reachable
from the default branch (origin's HEAD, else main, else master): the same sha,
else the same patch id, else the same subject over the same files, among recent
default-branch commits that touch those files. A revert of the commit, or of
the merge that brought it in, withdraws it. Acceptance and withdrawal are
events in the append-only `decision_events` log; the entry file never changes.
`mex decisions` runs the check and shows each decision's state and history; the
background process runs it when HEAD or the default branch moves, and mirrors
the in-force ids to `<home>/projects/<project>/decisions-in-force.json` for the
hook. Whether a decision is still true in code stays the job of its checks.

## Bounds and remaining work

Files are at most 64 KiB; text is at most 8,192 characters; the one-line form
is at most 1,024 characters. Entries have at most 32 scopes/checks/companions,
and a check reads at most 128 files. Reads inspect at most 10,000 directory
entries and 8 MiB of file bytes. Exceeding a scan bound is an explicit error,
not a claim that the search found everything. Result truncation is explicit.
YAML duplicate keys, aliases and custom tags are refused.

This first slice implements personal creation and reads. It does not implement
editing, wrong-entry feedback, forgetting, team-store publication, store gates,
host-memory imports, hint expiry, check evaluation or delivery. The entry
format already represents retirement and all check kinds for those consumers.
