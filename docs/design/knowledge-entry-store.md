# Knowledge entry storage

The internal `src/knowledge/` service reads entry-file v0. Each entry is one
Markdown file containing only the `mex` metadata and its text. Runtime verdicts,
usage and observation clocks are local. The package-root API is unchanged.

## Commands and ownership

- `mex note "fact and reason"` saves a personal note. `log` is its alias for one
  release. `recall "words"` performs word search without a model, and `expand
  <id>` reads the complete entry.
- `mex edit <id> "corrected fact and reason"` preserves the entry ID and scope,
  and removes checks/trigger patterns that no longer attest to the new claim.
- `mex wrong <id> "reason"` and `mex forget <id> "reason"` retire an entry.
  A personal retirement is a durable, project-scoped local tombstone. Its old
  Markdown bytes cannot reactivate that ID when restored. It is a visibility
  and no-resurrection contract, not secure erasure of backups or old copies.
- Team entries live in `.mex/learned/<id>.md`, optionally under a kind directory.
  Team edits and retirements print an exact diff by default. Applying requires
  repeating the command with `--apply --expect <revision>`. The revision binds
  the repository, target, current bytes and proposed bytes. Changes require a
  fresh preview. Retirement keeps `status: retired` and its reason in that file.

The internal `prepareTeamWrite` / `applyTeamWrite` pair is the authoring seam
for sharing and capture consumers. It never stages, commits or pushes. The
later sharing command uses this seam; this ticket adds no automatic sharing.
Personal writes serialize through the Node-owned local record. Team changes
use the existing contained, optimistic artifact publication boundary.

## Trust and reads

Storage gates run on write and read. Hidden formatting/control characters are
stripped. Recognized Markdown and shell-command forms must be present in
repository CI runs, package scripts or documentation, or reference an existing
contained script. Unverified payload commands and HTTP links are removed while
the surrounding claim remains. Secret patterns and credential assignments,
including structured check values, are refused without echoing their contents.
Provenance references are distinct from payload links.

Only person or repository evidence qualifies a team entry. Person creation
requires its actual typed quote; repository sources must exist. Review evidence
requires two distinct PR source checks. Observed/mined/agent-memory hints cannot
be promoted by copying their metadata to the team directory. Reads recheck the
gates because a branch can edit entry files directly. Withheld entries are
reported as such. Unknown or redirected storage and incomplete bounded scans
fail closed. Secret-bearing old bytes are not included in previews.

Labels are derived: personal/person, team/evidence and hint/observation count.
Precedence is current request, personal notes, repository instructions, team
entries, hints. The store ranks its three entry levels accordingly. Current
requests and instruction-file delivery remain consumer responsibilities. Team
projections also report whether exact bytes are on the known default branch;
unknown default-branch state is never presented as shared.

## Read-only host memory

`mex hints refresh` explicitly reads supported host memory and updates local
hints. `mex hints expire` explicitly removes expired copies. `mex hints status`
reads recorded status without scanning or maintaining anything. Ordinary
`recall`/`expand` never import, expire, register or migrate storage.

Pass the recipient with `recall ... --agent codex` or `expand ... --agent
claude-code` to include hints. Without a recipient, hints are excluded. A host
never receives its own memories back; duplicate claims known to that host are
also excluded. `claude` is normalized to `claude-code`. A person may inspect
all origins using `--agent human`.

Supported source layouts are allowlisted, not recursively inferred:

- Claude: `CLAUDE_CONFIG_DIR` or `~/.claude`, then the repository/worktree-shared
  `projects/<project>/memory` directory and its Markdown topic files. An explicit
  project-directory name and a user-scoped `autoMemoryDirectory` are respected.
- Codex: `CODEX_HOME` or `~/.codex`, both `memories` and `memories_v2`.
  Consolidated task groups and generated rollout summaries need explicit cwd
  metadata that resolves to this project. Mixed/unknown project scope is skipped.
  Only learning/preference sections are candidates. Raw transcripts, raw-memory
  dumps, skills and tool-output streams are not ingested.

These are host-generated private formats. Unknown formats, unsafe links and
work caps produce explicit partial/skipped status, not an invented success.
Host files and retention settings are never changed, and no host process or
model is started. Layout references:
[Claude memory documentation](https://code.claude.com/docs/en/memory),
[Codex memory documentation](https://developers.openai.com/codex/memories), and
the [Codex memory writer](https://github.com/openai/codex/blob/main/codex-rs/memories/write/src/storage.rs).

Hints retain `agent-memory`/`observed` provenance and never count as team
evidence. Their mandatory check is local source identity/hash only. External
host paths and observation timestamps are in Node-owned `record.db.settings`,
not fabricated repository-relative checks or extra entry fields. Source refs
are opaque agent-memory locators; readers resolve them through the registry.
Changed or missing sources withhold hints until explicit refresh.

The default lifetime is six calendar months without a new observation.
`hints refresh --expiry-months N` sets a project lifetime (1–120 months), stored
under `knowledge.hint_expiry_months`. Unchanged rereads do not restart it;
distinct source observations do. At expiry, a durable tombstone is committed
before removing the disposable hint copy. Restoring it or reimporting the same
claim cannot revive it. `edit <hint-id> ...` is explicit human confirmation into
a personal note; confirmed, personal and team entries never expire by age.

Registry keys use the registered project ID as their settings scope:
`knowledge.retired.<id>`, `knowledge.hint.<id>`, `knowledge.hints_status`, and
`knowledge.hint_expiry_months`. No schema migration or Go-owned write is added.
Consumers must use the store's suppression/source checks, rather than reading
private entry files as automatically active knowledge.

## Bounds

Entry files retain the 64 KiB bound. Each entry-store scan is limited to 10,000
directory entries and 8 MiB. Reference discovery permits 4,096 paths, 1,024
source files, 8 MiB total, 1 MiB per file and 4,096 commands/links. Host discovery
permits 1,024 paths, 128 files/candidates, 4 MiB total and 1 MiB per file, with a
ten-second monotonic discovery guard. Source checks are cached per file within
one read and have a 4 MiB aggregate budget. Local state is paged and bounded;
observations cap at 128 per hint and remain weak observations, never evidence.

Evaluation/delivery, AI extraction, consolidation, public sharing UX and Hub
workbenches belong to their owning tickets. This service makes no token-saving
or release-readiness claim.
