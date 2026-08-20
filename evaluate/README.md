# MEX graph evaluation

The default MEX evaluation now measures the product problem directly: whether the built CLI can
retrieve exact, answer-bearing graph evidence for natural-language questions.

The evaluation has two layers:

1. `evaluate/graph/` is deterministic, cheap, and the primary development/CI loop.
2. `evaluate/compare/` is an optional repeated agent experiment using a locally authenticated
   headless Claude or Codex CLI. It never requires a direct model API key.

The older compactness and scripted-agent scripts remain available as historical benchmarks under
`npm run eval:legacy` and `npm run eval:e2e`. They are not evidence that natural-language graph
retrieval works.

## Deterministic graph evaluation

Build the CLI, then run the native MEX suite:

```bash
npm run build
npm run eval
```

`npm run eval` is equivalent to `npm run eval:graph -- --all` and creates an immutable timestamped
run under `.mex/eval-results/graph/`. This location is deliberate: graph scanning does not consult
`.gitignore`, while `.mex/**` is excluded by the scanner. The harness rejects an output directory
inside the subject if archived source there could contaminate the graph.

Useful commands:

```bash
# Validate suite structure and exact source gold without building a graph.
npm run eval:graph -- --validate

# Run the multilingual synthetic fixture.
npm run eval:graph -- --all \
  --suite evaluate/suites/native/graph/synthetic.json \
  --repo evaluate/fixtures/repositories/graph-synthetic

# Prepare and run into a named output directory.
npm run eval:graph -- --all \
  --output .mex/eval-results/graph/my-run

# Continue an interrupted run only when its full identity is unchanged.
npm run eval:graph -- --all \
  --output .mex/eval-results/graph/my-run \
  --resume

# Rebuild a report from an existing run.
npm run eval:graph -- --report \
  --output .mex/eval-results/graph/my-run
```

Modes are `--validate`, `--prepare`, `--run`, `--report`, and `--all`. `--all` is the default.
Preparation and execution can be separated when artifact building is expensive.

### Suites

- `evaluate/suites/native/graph/mex.json` evaluates the active CLI against MEX.
- `evaluate/suites/native/graph/synthetic.json` covers TypeScript, Python, Rust, duplicate symbol
  names, multi-symbol flows, relationships, negative queries, and paraphrases.
- `evaluate/suites/native/graph/mex-branches.json` builds `main`,
  `feat/code-graph-retrieval`, and `origin/fix/graph-symbol-lookup` from local Git objects and runs
  the same task file against all three.
- `evaluate/suites/native/graph/mex-tasks.json` is the single reusable MEX gold task set. The
  current and branch suites do not copy it.

Run the three-branch comparison with:

```bash
npm run eval:graph -- --all \
  --suite evaluate/suites/native/graph/mex-branches.json \
  --repo . \
  --output .mex/eval-results/graph/branch-comparison
```

Branch artifacts are produced with `git archive` into the ignored output directory. The active
worktree is not switched, reset, or overwritten. Existing `node_modules` may be shared read-only by
the archived builds.

### Source-grounded task evidence

Every non-negative task uses exact evidence:

```json
{
  "id": "budget-enforcement",
  "category": "natural-language-symbol",
  "operation": "scope",
  "query": "What prevents a retrieval payload from overflowing its allowance?",
  "gold": [
    {
      "symbol": "BudgetLedger",
      "kind": "class",
      "path": "src/graph/agent-protocol.ts",
      "startLine": 174,
      "endLine": 213
    }
  ]
}
```

Preparation fails for missing files, stale source spans, duplicate task IDs, ambiguous declarations,
empty fixtures, absolute paths, or paths escaping the subject repository. Evidence identity is the
exact symbol, normalized repository-relative path, and source span. Extractor node kind is retained
as an advisory diagnostic but cannot make valid source evidence impossible.

Supported task operations are:

- `scope` for exact-symbol, natural-language, paraphrase, multi-symbol, ambiguity, and language
  retrieval;
- `query` for `where-defined`, `who-calls`, and `what-calls`; and
- `impact` for hand-labeled blast-radius results.

Negative tasks declare `expect.noResult` and, where appropriate, accepted structured error codes.
Unexpected error records, malformed JSONL, empty output, nonzero exit, timeout, and output overflow
make a run invalid rather than an empty successful result.

### Metrics and gates

The report includes:

- first-response top-five file hit rate and file MRR;
- returned required source-span recall and directed-flow coverage;
- graph-construction coverage, reported separately from retrieval misses;
- source-identity Recall@1, Recall@5, and Recall@10 for covered graph evidence;
- MRR with every miss scored as zero;
- nDCG@10, Precision@5, irrelevant-result rate, and complete-evidence rate;
- negative-query accuracy and prohibited-result hits;
- worst paraphrase-family recall, rank, and miss count;
- output size, approximate tokens, latency, truncation, hard-budget compliance, and relevant facts
  per 1,000 tokens;
- extracted declarations versus stored nodes;
- likely node overwrite/loss, dangling edges, duplicate identities, FTS row mismatch, call edges,
  unresolved call references, callable-node isolation, and extraction errors; and
- normalized graph-content hashes across repeated rebuilds.

Quality gates run before efficiency gates. The branch suite applies overall, per-category,
critical-task, and graph-integrity no-regression checks, so exact lookup cannot hide a
natural-language regression.

### Reproducibility and output

Each prepared run records:

- subject Git identity, dirty entries, and exact worktree/tree hash;
- suite and shared task-file hashes;
- CLI command and complete runtime-bundle hash;
- graph database byte and normalized-content hashes;
- build summary, integrity report, and repeated-rebuild hashes;
- Node/platform/runtime details and an environment allowlist; and
- immutable preparation and run identities.

Each task stores its result row plus raw stdout and stderr. Reports are written as:

- `prepare.json`
- `run-manifest.json`
- `runs/*.json`
- `raw/builds/*`
- `raw/queries/*`
- `report.json`
- `report.md`
- `rows.csv`

Resume validates the suite, tasks, subject tree, CLI bundle, graph snapshots, timeout, and schedule.
Partial or stale rows cannot silently attach to a new run.

## Repeated headless-agent comparison

The controlled agent suite has three matched arms:

1. repository files only;
2. graph built by `main`; and
3. graph built by the active checkout.

Prepare it once:

```bash
npm run eval:compare -- --prepare \
  --suite evaluate/compare/suites/mex-graph.json \
  --repo . \
  --output .mex/eval-results/compare/mex-graph-pilot
```

Run through the locally authenticated Claude CLI:

```bash
npm run eval:compare -- --run \
  --suite evaluate/compare/suites/mex-graph.json \
  --repo . \
  --output .mex/eval-results/compare/mex-graph-pilot \
  --agent claude \
  --model <model-name> \
  --policy forced-first \
  --repetitions 3
```

For a tuning pilot that compares only repository files with the active candidate, select the same
two arms during preparation and execution:

```bash
npm run eval:compare -- --prepare \
  --suite evaluate/compare/suites/mex-graph.json \
  --repo . \
  --output .mex/eval-results/compare/mex-graph-two-arm \
  --arms files,candidate

npm run eval:compare -- --run \
  --suite evaluate/compare/suites/mex-graph.json \
  --repo . \
  --output .mex/eval-results/compare/mex-graph-two-arm \
  --arms files,candidate \
  --agent claude \
  --model <model-name> \
  --policy forced-first \
  --repetitions 1
```

The run manifest records the selected arms, and `--report` reads that selection automatically.
Use a fresh output directory when changing the arm set. With the six-task MEX and Hono suites,
one repetition of `files,candidate` is 12 sessions per suite, or 24 sessions total. This two-arm
report computes the candidate-versus-files efficiency and correctness gate but remains a
descriptive tuning pilot; the final release decision still uses all three arms.

Or use the locally authenticated Codex CLI:

```bash
npm run eval:compare -- --run \
  --suite evaluate/compare/suites/mex-graph.json \
  --repo . \
  --output .mex/eval-results/compare/mex-graph-pilot-codex \
  --agent codex \
  --model <model-name> \
  --policy forced-first \
  --repetitions 3
```

No API SDK or direct API key is used. The adapters execute `claude -p` or `codex exec` and reuse the
CLI's existing local authentication. Codex non-interactive JSONL behavior is documented in the
[official Codex non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode).

Use a separate output directory for each agent, model, and policy. `--resume` is accepted only when
all run-identity fields match.

### Agent policies

- `--policy forced-first` requires each graph arm to begin with `graph scope`. This diagnoses what
  happens after a known graph attempt.
- `--policy optional` makes graph retrieval available without forcing it. This measures whether the
  agent naturally selects it.

Report the policies separately; they answer different questions.

Each session starts in a fresh neutral temporary directory. The subject repository is added as a
readable directory, graph commands pass through a fixed wrapper into the prepared subject index,
and the agent never inherits conversation state. Claude uses empty user/project/local setting
sources, one harness-owned Bash guard, and no session persistence; Codex uses ephemeral/read-only
mode. Policy validation distinguishes attempted, executed, failed, and denied tool calls and rejects
executed raw SQLite, cross-arm binaries, shell composition, or an invalid forced-first sequence.
Run the evaluation as the sole graph writer for its subject repository: preparation and execution
temporarily swap `.mex/graph.db` and restore the startup copy, so a concurrent external `mex graph`
process is outside the supported execution model. Source, evaluator, CLI-bundle, snapshot, prepare,
or active-manifest drift aborts the run instead of persisting a graded row.
Claude runs in isolated `dontAsk` mode: both arms receive the same
Read/Grep/Glob capabilities, while graph arms additionally pre-approve only their own fixed graph
wrapper. The PreToolUse guard denies every other Bash command before Claude's built-in read-only
auto-allow can run. A denied, read-only file-shell attempt is recorded separately and may recover through
Read/Grep/Glob; an executed file-shell fallback or any unexplained denial invalidates the row.

### Token and prompt-cache accounting

The two CLIs expose different usage fields. Every row preserves the raw provider/CLI usage object
and maps only established fields into:

```json
{
  "uncachedInput": 0,
  "cacheWrite": 0,
  "cacheRead": 0,
  "output": 0,
  "reportedInput": 0,
  "reportedTotal": 0,
  "reportedCostUsd": null,
  "newTokens": 0,
  "cacheUseRatio": 0,
  "accountingValid": true,
  "accountingReason": null,
  "terminal": {},
  "perMessage": {},
  "raw": []
}
```

Unavailable fields remain `null`. In particular, Codex does not currently expose a cache-write
count in its JSONL usage event, so the adapter preserves `cacheWrite: null` while computing new
tokens from uncached input plus output. Claude reports cache creation/write separately.

Claude stream-json can repeat the same assistant message. The harness deduplicates usage by
`message.id`, sums the unique messages, and accepts the terminal cumulative token totals only when
terminal uncached input, cache-write, and cache-read values exactly agree with those unique-message
totals. A mismatch remains available for correctness review and preserves both observations, but is
marked accounting-invalid and excluded from every paired token decision.

The primary comparison is paired within the same task and repetition:

```text
deltaNewTokens = newTokens(candidate) - newTokens(baseline)
deltaCacheRead = cacheRead(candidate) - cacheRead(baseline)
deltaTotal     = reportedTotal(candidate) - reportedTotal(baseline)
deltaCost      = reportedCost(candidate) - reportedCost(baseline), when available
```

Absolute uncached input, cache writes, cache reads, output, totals, cost, and cache-use ratio remain
visible per arm. Reports include distributions, totals, paired means, and deterministic bootstrap
95% intervals. Missing fields never become zero-cost claims.

Arm order is balanced across tasks and repetitions using both two-arm orders or all six three-arm
permutations. This prevents one arm from always running after another has warmed a provider cache.
Shared prompt text appears in the same prefix where the experiment permits, but the report does not
assume cache reads cancel between arms.

### Agent outcomes

The agent report records:

- exact structured answer symbols and evidence paths;
- first-response file rank/hit rate, returned source-span recall, and directed-flow coverage;
- per-arm graph-construction coverage, kept separate from retrieval misses;
- scope calls, semantically distinct scope retries, graph follow-ups, file-search fallbacks, tool
  errors, denials, turns, latency, and tool-result characters;
- complete absolute cache/token composition; and
- all paired task/repetition deltas.

`blind-review.json` and `blind-reveal.json` carry a review identity tied to the run and answer set.
A stale review file cannot attach to new results. When manual review is complete and disagreements
are adjudicated, manual correctness becomes the final decision label instead of merely unlocking a
decision based on the old automatic label.

## Harness tests

Run all harness self-tests without invoking a model:

```bash
npm run eval:test
```

The tests use fake graph, Claude, and Codex processes. They cover nonzero exits, timeouts, malformed
and empty JSONL, stale/ambiguous gold, exact identity matching, partial multi-symbol evidence,
miss-preserving MRR, terminal-versus-unique-message cache accounting, balanced repetitions, resume identity, stale
manual reviews, graph loss metrics, index restoration, the exact-wrapper Bash guard, denial recovery,
and policy violations.

## Historical scripts

These commands remain for comparison with old reports but are not graph-fix gates:

```bash
npm run eval:legacy
npm run eval:e2e
node evaluate/agent-e2e-model.mjs
```

Their original fixtures, thresholds, and reports are intentionally preserved. Do not combine their
numbers with the strict graph-suite results without explicitly labeling the protocol difference.
