# mex 0.8.4 — Terminal setup and clearer knowledge checks

Prepared October 9, 2026. This release is unpublished until the reviewed changes
are merged, tagged, and published.

MEX 0.8.4 makes terminal setup the default, adds a native interactive agent
handoff, and reports setup progress and failures more clearly. It also includes
the graph, Wiki search, and grounding improvements merged since 0.8.3.

## Terminal setup by default

Run `mex setup` to open the keyboard-driven HUD and ASCII banner. Choose a tool
with the arrow keys and Enter; Space selects additional integrations. Selection
happens before setup writes. An available selected Claude Code or Codex CLI
receives the real terminal, including normal keyboard interaction. Exit the
agent to return to MEX; incomplete population offers retry, a manual prompt,
file checks, or Finish later.

Graph work shows actual phase/file counts and elapsed time. Setup distinguishes
complete, paused, failed, and cancelled outcomes. Expected failures carry
recovery instructions; bounded worker diagnostics remain available in the
terminal, while browser errors expose only safe messages. Completing or checking
setup without agent output no longer creates an empty background-session panel.

After interactive preparation, the browser handles setup-file review, the
explicit local commit checkpoint, and completion. MEX never pushes. Use
`mex setup --browser` to select browser setup directly; `--cli` remains an alias
for terminal setup. Bare `mex` opens terminal setup for an incomplete project
and Hub for an established code project. `mex hub` and `mex tui` remain explicit
browser and terminal-dashboard entry points.

For scripts, use `mex setup --yes --tool <name>` or `--tool none`. Piped input/output
and CI also use plain output, reuse saved choices where available, and never
launch an agent or long-lived Hub. Exit codes are `0` for completed preparation
or a successful dry run, `2` for pending population, `1` for failure, and
`130`/`143` for interruption. `--dry-run` remains read-only.

## Faster graphs, smaller fingerprints

- Refresh avoids re-extracting importers whose dependency declaration signatures
  did not change and shares compiler resolution work across projects. The first
  refresh after upgrading re-extracts the corpus once for the new internal cache
  format; subsequent work can reuse it. The inferred-program fallback now agrees
  with a clean build after changes outside every `tsconfig`.
- Scope tokenizes each node once per query, avoiding repeated work on large type
  signatures while preserving the output.
- New grounding fingerprints use lossless `mh2:` encoding, substantially reducing
  committed Markdown size. Existing `mh:` values remain readable and are not
  rewritten by reads. `mex graph compact-fingerprints --dry-run` previews an
  optional explicit conversion; omit `--dry-run` to apply it.

**Upgrade every collaborator before committing `mh2:` groundings. MEX 0.8.3 and
earlier cannot read that encoding.**

## Knowledge checks and Wiki maintenance

- `mex check`, Wiki queries, and Hub views share fact-aware grounding verdicts.
  Proven comment-only and formatting-only edits stay fresh; changes away from
  everything a fact names are distinguished from changes that may invalidate it.
  Missing or ambiguous links remain flagged. Class properties and fields now
  receive body hashes and fingerprints too.
- `mex sync` reviews flagged Wiki facts in the same agent session. After review,
  `mex wiki reground <id> --apply` can re-record a still-valid fact's links;
  changed text or uncertain links require the corresponding review. Index
  rebuild and another check follow. Baselines are not silently accepted.
- `mex wiki validate` checks structure. Use `mex check` for code-link health.
  Graph-aware Wiki maintenance uses a fresh, revalidated snapshot and reports
  unavailable evidence instead of treating it as a trustworthy graph.
- Natural-language Wiki queries ignore question/stop words, rank exact-term
  answers ahead of broader matches, and explain partial or empty results. Hub
  search uses the same ranking and identifies unchecked health.
- Migration adopts `context/stack.md` and knowledge files with an explicit usable
  entity type. Check and validate name eligible or untyped files left outside
  the Wiki; pattern creation joins an existing Wiki through migration.
- `mex wiki link-sections` previews missing section-to-parent relationships;
  `--apply` records them. `mex wiki upgrade` previews a bounded review of broad
  code-linked facts, with an agent or manual prompt for explicit application.
  It requires a fresh graph and refuses flagged candidate links.
- Staleness counts commits affecting referenced paths, and script/dependency
  checks avoid brace-expansion and command-prose false positives. CLI discovery
  verifies MEX rather than trusting an executable's name. Hub groups repeated
  Wiki diagnostics with expandable detail.

## Upgrade an existing project

After publication, install the pinned release and preserve your existing graph:

```bash
npm install -g mex-agent@0.8.4
mex graph refresh
mex check
mex sync
mex wiki rebuild-index
```

Review grounding decisions and scaffold changes before committing through Git.
Do not delete a working graph as the first upgrade step. For a damaged or
incompatible store, follow `mex graph status`'s explicit recovery action. Projects
skipping 0.8.3 must also follow its one-time TypeScript identity guidance in the
[compatibility guide](COMPATIBILITY.md#upgrading-to-084).

Use `mex wiki migrate --dry-run` to preview newly adoptable knowledge, review
its proposed changes, and run `mex wiki migrate` when ready to apply them.
For MEX-managed integrations, preview with `mex skills sync --dry-run`, resolve
conflicts, then run `mex skills sync` and start a new agent session. Standalone
skills are an alternative installer; do not overlay them on managed copies.
A completed setup does not need to run again solely for this package upgrade.

Node.js 22.5 or newer with SQLite FTS5 remains required. Graph schema stays v4;
Wiki and canonical Relay artifact versions are unchanged. Public `DriftIssue`
adds optional fields and `IssueCode` adds cases; exhaustive consumers should
review [the API compatibility notes](COMPATIBILITY.md#additive-api-changes-in-084).

## Known limitations

Dependency-rich TypeScript/JavaScript builds can still exhaust Node's heap. A
924-source disposable MEX copy with installed dependencies failed, and a
compiler-only probe reproduced exhaustion during signature rendering before
persistence. Progress, diagnostics, and process isolation contain and explain
that failure; they do not fix its memory requirement.

The browser's completion readiness still uses limited placeholder and
index-presence checks after restart, so a failed final validation can later
appear commit-ready. Oversized population prompts can exceed the Hub run-response
contract. These are separate follow-ups; this release does not claim every
setup or completion path is reliable.

**Full changelog:** [v0.8.3…v0.8.4](https://github.com/mex-memory/mex/compare/v0.8.3...v0.8.4).
The comparison becomes available when the release tag is published.
