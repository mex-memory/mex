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

Status is active or retired. A retired entry keeps the same ID and file, with
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
| pattern | `{scope, pattern, match?}` | `{count}` |
| relation | `{query, from, to}` | `{count}` |

Values are bounded JSON. Source URLs use HTTP(S). Relation checks are encoded
now for consumers; their evaluator belongs to later graph work.

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
