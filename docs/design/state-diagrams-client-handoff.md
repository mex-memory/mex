# Claude Code state-diagram qualification handoff

The implementation is on the `codex/state-diagrams` branch. This handoff covers
the remaining interactive Claude Code check; automated checker, portability,
browser, packaging and performance checks belong to the PR's GitHub CI.
Do not infer Claude rendering support from the Hub renderer or image input.

## Start here

Read the repository's `AGENTS.md`, `.mex/AGENTS.md` and `.mex/ROUTER.md`, then
`docs/design/state-diagrams-spec.md`, `docs/design/state-diagrams-qualification.md`
and `skills/mex-statechart/SKILL.md`. Record the tested commit, Claude Code version,
operating system, terminal and viewport width. Use a disposable project so the
test does not save generated project knowledge or touch unrelated work.

Build/install the PR normally. Confirm that `mex setup` offers `mex-statechart`
through the managed Claude integration and that its nested runtime, reference
files and attributed upstream license are installed. Installation must not
download Java or TLC. For generation, use an existing Java 11+ installation and
the checksum-verified TLC 1.7.4 jar described in the skill's toolchain reference.

## Exercise the reader's flow

1. Invoke `/mex-statechart` directly, then try a natural-language request to
   explain a small implemented workflow. Retain the checked artifact in scratch
   outside the project. Prefer its fenced Mermaid in chat; show the deterministic
   terminal projection when that client's native support is absent or incomplete.
2. Exercise a small passing chart, a broken invariant with a numbered path, an
   expected goal witness, and a temporal failure. Use the checked artifact as the
   source for every presentation. Record what the client actually displays:
   native statechart, plain fenced source, readable text, or an error. Preserve
   conditions, rule outcome, ordered paths and the full raw temporal trace.
3. Include nested states, independent regions and long human labels. Compare
   states/transitions/conditions with the artifact and the exported image.
   Report unsupported syntax and use the text fallback; do not simplify away a
   material recovery condition or call a partial display equivalent.
4. Explain MEX setup pause/recovery using current source. Answer whether files
   survive pause, whether agent exit zero is enough, whether finalization means
   committed setup, and whether Retry can replace an old process's removed lazy
   modules. Retain MEX context only where it improves a state or recovery rule.
   The earlier acceptance case in the qualification report is historical evidence,
   not proof that the current setup implementation has identical behavior.
5. Generation must work without a Hub. A preview may be registered explicitly;
   opening Hub is optional. Confirm no automatic browser launch, canonical Save,
   staging, commit, index repair or baseline renewal. In Hub, review exact writes
   before Save and reopen the immutable snapshot after restart.

## Return evidence

Record the exact version/environment/commit, artifact and input hashes, invocation,
screenshots or a redacted terminal capture, unsupported cases, fallback used and
the observed filesystem effects. Separate model-check outcome, projection validity,
code mapping, implementation reproduction and dependency freshness. A passing TLC
model alone establishes neither implementation correctness nor current evidence.

Update the client matrix in `COMPATIBILITY.md`,
`skills/mex-statechart/references/toolchain.md`, and the qualification report only
with observed results. Do not change an agreed rule to make a test pass. No
Claude-specific plugin or mod is required. No teammate has been notified by
creating this handoff.
