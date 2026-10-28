# Agent-arm test

## Codex on a small machine

`suites/novu-codex.json` pins 13 change tasks, one repetition, and the three
`files`, `mex-r2w`, `mex-r3` arms. It defaults to `agent: "codex"`,
`model: "gpt-6.1-sol"`, `effort: "high"`, `sandbox: "workspace-write"` and no
warm-up. `--agent`, `--model`, `--effort`, `--sandbox`, `--warmup` and
`--no-warmup` override suite settings. Preparation pins the agent, model,
effort and sandbox; run refuses a mismatch. Existing suites default to Claude.
Use the frozen Codex CLI version whose offline feature list has been checked
(the recorded probe used 0.163.0). The seven disabled feature names were
confirmed with `codex features list`; `codex exec --help` confirms the launch
flags. No model is needed for these preflight commands.

The serial `--pipeline` mode combines preparation, sessions, hidden grading,
reporting and cleanup one base at a time. Use a private subject clone holding
the task objects and scaffold refs. Run only one harness per output directory.
The launcher example contains one subject to fit a 16 GB machine:

```sh
node evaluate/arm/parallel.mjs --plan --config evaluate/arm/novu-codex.run.example.json
node evaluate/arm/parallel.mjs --pipeline --resume --config /path/to/run.json
```

First capture the finished setup and sync workspaces into the private subject:

```sh
node evaluate/arm/capture-scaffold.mjs --workspace /path/to/setup --subject /path/to/subject --ref refs/eval/scaffold-aug
node evaluate/arm/capture-scaffold.mjs --workspace /path/to/sync --subject /path/to/subject --ref refs/eval/scaffold-sep
```

Capture writes a local Git ref with canonical `.mex/` files and root AGENTS.md /
CLAUDE.md. It excludes local state, databases and symlinks, uses a temporary Git
index, leaves the subject's HEAD and index intact, and refuses replacement
unless `--replace` is explicit. No Git sharing happens automatically.
Keep the corresponding setup T0 and sync T1 graphs separately; the capture
does not include generated indexes. Write their paths to `seed-graphs.json`:

```json
{ "aug": "/path/to/T0/graph.db", "sep": "/path/to/T1/graph.db" }
```

Supply it through `--seed-graphs` (or the run config's `seedGraphs`). The
suite requires a seed at each chain boundary. Bases run in commit-time order.
Each refresh copies its seed, records JSON refresh mode/fallback reason and
time, then builds Wiki/context indexes. After every row for a base is valid,
the next graph link is published atomically and the old cache, repositories,
temporary directories and previous link are deleted. Only one link is retained
between bases; the last is deleted on completion. The seed inputs are never
modified. Rows, small manifests, reports and artifacts remain.

`pipeline.json` pins the suite, scaffold commits, CLI hash, seed hashes, model,
effort, sandbox and selected schedule. `--resume` skips finished rows, retries
invalid rows and removes interrupted workspaces, templates, copied credential
homes and obsolete links. A finished current cache survives a failure, so it
need not rebuild. Configuration changes require a new output directory.
Do not move the output or its inputs during a run. A crash before a completed
cache is checkpointed can require rebuilding that cache. A hard crash leaves
the isolated credential copy until the next resume cleanup.

For the pilot, use `--pilot-tasks`, which selects PR 12875 and PR 12774:

```sh
node evaluate/arm/index.mjs --pipeline --resume --suite evaluate/arm/suites/novu-codex.json --subject /path/to/subject --cli-bin /path/to/frozen/node_modules/.bin --deps /path/to/deps/node_modules --seed-graphs /path/to/seed-graphs.json --pilot-tasks --effort high --output /path/to/pilot-high
# Repeat with --effort xhigh and a separate --output for the top-effort comparison.
```

Use one model and effort in all arms of each comparison. Confirm that the
selected model accepts `xhigh` in the director's real pilot. Add
`--compare-base <base-SHA-or-task-ID>` to full-build that base too and save
an exact comparison of every SQLite table. Equality includes metadata and FTS
storage rows; operational timestamp differences can therefore make it false.
The artifact lists each table's row count and hash, and retains both outcomes.
For Graph databases it also records the existing graph evaluator's normalized
semantic hash comparison, with operational timestamps/Git coordinates and
storage bookkeeping excluded by that evaluator's established policy.

### Codex isolation, validity and resources

Each session gets a new `CODEX_HOME`, copied `auth.json` only, and a generated
config pinning model/effort. It disables `memories`, `plugins`, `apps`,
`browser_use`, `multi_agent`, `goals`, `skill_search`, and configures
`web_search = "disabled"`. It copies no user AGENTS.md, settings, skills,
plugins or sessions. API-key/provider environment overrides are removed.
Rollouts are copied to `<run>.rollout/`, and the home is removed in `finally`.
The source home is never modified. CLI feature/help probes do not establish
that a real session exposes no web tool; the director verifies that boundary.

Subject-authored AGENTS.md and CLAUDE.md prose is checked for parity, and
subject `.agents/` content is retained in every arm as on the Claude path. For
Codex, `.codex/` and `.claude/` executable project configuration
is excluded uniformly in every arm. Only the chosen frozen product installer
adds back Codex hook configuration in MEX arms. Setup's skills block is removed
from root instruction files. The files arm has no `.mex`, Codex hooks or MEX
managed block. R2w sets `MEX_HOOK_LEXICAL=1` during both installation and session;
the installer must persist `--lexical` in its commands. R3 never inherits that
variable. Missing/wrong recipe evidence in the hook log invalidates a row.
Only hooks arms receive `--dangerously-bypass-hook-trust`.

Every workspace has an independent ancestor-only object store, no alternate,
remote, other ref or future reflog. Scaffold files are copied as blobs without
importing scaffold commit objects. The harness checks all commit objects as
well as reachable commits and rejects a task's fix commit. Hidden tests are
restored from the private subject only after the session. Transcript Git
probes using `--all`, `cat-file`, `fsck`, `reflog`, or `show`/`log` of a
non-ancestor SHA invalidate the row. Command detection is heuristic and cannot
prove the absence of concealed probes inside arbitrary scripts.

Before graph preparation, sessions and grading, the resource guard waits for
4 GiB available RAM and 5 GiB free disk (override with `--min-ram-gb` and
`--min-disk-gb`, or suite `resources`). It logs and never kills for pressure.
RAM uses macOS free+inactive+speculative pages, Linux MemAvailable, and Windows
os.freemem. An independent sampler records the harness tree, descendants and
settle-lock PIDs every five seconds, including while synchronous maintenance
or test commands run. Each step has a resource CSV and sampled peak RSS.
Short-lived processes can fall between samples. Sampling failures are explicit
and invalidate measured rows. Windows sampling uses Toolhelp through a small
native adapter because CIM can be denied; macOS/Linux use `ps`.

`workspace-write` grants the workspace, the session temp directory and the
supplied writable dependency directory (`--add-dir`) so test caches can work.
Hidden commands support `{node}`, `{workspace}` and `{harness}` placeholders;
the suite preserves the original targeted vitest files and 512 MiB Node cap,
and replaces the unavailable machine-specific network helper with Node.
Use `danger-full-access` only if a real targeted-test pilot proves that needed
package-manager caches or executables remain inaccessible. Apply the same
sandbox to every arm. No fake run can verify actual sandbox behavior.

Codex rows sum every terminal turn's input, cached input, cache-write, output
and reasoning usage. Processed is input+output; uncached is input-cached;
reasoning is included in output. Exit 0, a terminal turn, valid accounting and
a final message matching the complete output schema are required. JSONL lines
are stamped on arrival for wall/test interval metrics. Subscription cost stays
null. Optional `--estimate-list-price` requires explicit suite `listPrices`
rates (`input`, `cachedInput`, `cacheWrite`, `output`, USD per million tokens)
and stores a separately labelled estimate; it never becomes plan cost.

### Model-free verification

`test/fake-codex.mjs` replays the recorded probe, honors stdin / schema / output /
workspace / home options, and executes the fake installer's Codex hooks with
the recorded payload shapes. It verifies switch and environment propagation;
it does not demonstrate that a real host fires the hooks or retrieves useful
semantic knowledge. No real model session is started by these commands:

```sh
node --test evaluate/arm/test/*.test.mjs
node evaluate/arm/test/codex-dry-run.mjs --source /path/to/small-scaffolded-subject --output /path/to/new-dry-output
```

The dry run clones with `--no-local`, clips two bases, builds a real seed graph
with the frozen built CLI, refreshes it in the pipeline, full-builds and compares
it, runs one synthetic change task across three fake-agent arms, grades real
Node assertions, resumes without relaunches, prints RAM/disk/RSS, then deletes
its subject, frozen CLI, seed and workspaces. Retained evidence is under output.

## Heavy-task runs

The default hooks comparison selects **files and mex-r3, three repetitions**,
alternating the first arm within each task/repetition pair. Use one repository
per invocation for comparable wall times. Explicit `--arms` retains historical
suite schedules; `--reps N` overrides repetition counts. `--plan` is read-only.

Before preparation, annotate a writable suite copy. Preparation requires all
complexity fields for calibration/default paired runs and rejects heavy tasks
whose prompts name gold files or symbols:

```powershell
node evaluate/arm/complexity.mjs --suite <candidate-suite> --subject <clone> --output <annotated-suite>
node evaluate/arm/index.mjs --validate-suite --suite <annotated-suite>
node evaluate/arm/index.mjs --plan --suite <annotated-suite>
```

Complexity uses `goldPatch` (or `gold.patch`, a patch file relative to the suite),
or a diff from `base` to `goldCommit` / `mergeCommit` / `hiddenTests.fromCommit`.
Questions without a patch use `gold.code` paths and declare zero changed lines.
Use `gold.symbols` or `gold.code[].symbol/name/symbols` to include symbols beyond
declarations visible in patch context. The stored fields include gold files,
directories, nearest manifest packages (root is `.`), added/removed lines,
prompt-named files/symbols, and source LOC. LOC counts source extensions at the
base, excluding dependencies, vendor and distribution directories. Bases are
memoized within the script; no databases or subject files are changed.

Calibration is a separate control-only pass. It does not require a MEX CLI or
scaffold. `--reps` defaults to 2; every valid repetition must meet **both**
inclusive thresholds. Missing/invalid repetitions never select a task:

```powershell
node evaluate/arm/index.mjs --calibrate --suite <annotated-suite> --subject <clone> --deps <shared-node_modules> --model <model> --output <output> --reps 2 --token-threshold 150000 --turn-threshold 20
```

Rows and `summary.json` / `summary.md` live under `<output>/calibration/`.
Resume with the same command plus `--resume`. Calibration includes candidate
tasks marked `fullRun: false`; `--tasks` can restrict it. Select main tasks with
`--tasks`, or write a suite copy marking unselected tasks `fullRun: false`.
Main outputs and report loaders reject calibration data.

```powershell
node evaluate/arm/index.mjs --prepare --suite <annotated-suite> --subject <clone> --cli-bin <frozen-bin> --deps <shared-node_modules> --model <model> --output <output>
node evaluate/arm/index.mjs --run --resume --suite <annotated-suite> --subject <clone> --cli-bin <frozen-bin> --deps <shared-node_modules> --model <model> --output <output>
node evaluate/arm/index.mjs --blind --suite <annotated-suite> --output <output>
# Add blind grades.json, then:
node evaluate/arm/index.mjs --report --suite <annotated-suite> --output <output>
```

Shared output/schema/targeted-test instructions and `appendPrompt` are delivered
through `--append-system-prompt`, identically in both arms. The prompt hook sees
only the task text. Both arms retain the subject's own instruction files, and
the shared system instructions require reading AGENTS.md. Preparation compares
every tracked CLAUDE.md/AGENTS.md, including nested files, after stripping only
paired `mex:*` or `mex-agent:*` managed blocks and normalizing line endings.
Any remaining difference fails preparation. Every measured workspace is checked
against that pinned snapshot again.

`workerCount` defaults to 3. A suite can set `workerConfig` to
`{ "file": "test.config", "values": { "workerCount": 3 } }`; it is installed
and committed as identical setup state before either arm starts. Hidden package
tests append `--maxWorkers=3` (2 for vitest), and shared instructions prohibit
full-suite testing. `testCommandMs` is the union of timestamped test tool
intervals; `agentMinusTestMs` subtracts it from agent wall time. A test with
missing timestamps leaves both metrics unavailable rather than implying zero.

Rows record launch/resume/restart counts in `execution` using the durable
`execution.json` attempt journal, plus `settleLaunched`, `settleOutcome` and
accounting status. A stream usage mismatch remains invalid; turn/message-count
mismatches are explicitly labelled. Process capture already waits for `close`,
including both output pipes; a regression checks a 1 MiB final write. Fake
producers flush before exit. Diffs ignore CR at EOL even for committed CRLF
blobs. `SCAFFOLD_ORPHANED` is excluded from row issue-count deltas; original
check artifacts and scores remain diagnostic evidence.

Graph packet uptake requires a path or symbol absent from all earlier tool
inputs/results and then referenced within five subsequent calls. A final-answer
citation alone does not count. `gold.knowledge` accepts entity ids or paths.

### Package-workspace subjects

Use `subjectType: "pnpm"`, `workerCount: 3`, and task-specific hidden tests:

```json
{
  "runner": "pnpm",
  "cwd": "packages/example",
  "command": ["pnpm", "exec", "jest", "test/target.test.ts"],
  "files": ["packages/example/test/target.test.ts"],
  "fromCommit": "<gold-ref>"
}
```

`command` is an argv array; paths must stay within the repository. The runner
supports jest/vitest summaries and requires actual passing tests. `pnpmEntry`
can name the package-manager JS entry when the default sibling corepack shim is
unavailable. `subjectType` also accepts `node`, `compiler` and `python`.

Install once in a separate writable dependency checkout, then pass the printed
node_modules path to every preparation/run:

```powershell
node evaluate/arm/prepare-deps.mjs --subject <clone> --base <base-ref> --output <dependency-output>
```

This uses a frozen-lockfile install; `--pnpm-entry <JS-entry>` overrides the
default package-manager shim. For package workspaces, shallow overlays
share external module directories while rebinding workspace-package links to
the measured checkout. Cleanup unlinks these overlays without following their
junctions. Other subjects retain the single dependency junction. Do not reuse
an install across incompatible lockfiles; prepare a dependency checkout per
dependency version.

### Report format and fake verification

The report includes every task's paired token wins/losses/ties and correctness,
separate heavy/light paired token and paid-cost geometric ratios, task-cluster
bootstrap 95% intervals, and task-level signed-rank checks. Task weights are
equal; repetitions are averaged in log space within each task. Nonpositive or
unavailable metrics are excluded and pair counts are shown. It also includes
four token buckets, paid dollars per correct answer/passing patch, time minus
tests, and each session's hook/settle/restart/accounting audit. Ungraded answers,
zero successes, missing timestamps and single-cluster intervals remain explicit.

```powershell
node --test evaluate/arm/test/*.test.mjs
node evaluate/arm/test/sample-run.mjs --output <new-scratch-folder>
```

The sample uses only fake executables: 18 main rows, a forced invalid-row resume,
and two isolated calibration rows. Its costs are simulated. See
[SAMPLE-REPORT.md](SAMPLE-REPORT.md) for captured output. Historical workflows
below remain available through explicit arm selection.

Runs the same Claude Code sessions on a pinned Hono checkout twice: once with
repository files only (`files`) and once with the MEX scaffold plus a frozen
MEX CLI on `PATH` (`mex`). Nothing in the prompt mentions MEX. The `mex` arm
discovers it the way a user's agent would, through `CLAUDE.md`.

## Inputs

| Flag | What it is |
|---|---|
| `--subject` | A clone of the subject repository that holds the task commits and the refs named in the suite's `scaffolds`. Never the original checkout. |
| `--cli-bin` | The `node_modules/.bin` of a private install of a packed MEX build (`npm pack`, then `npm i --prefix <dir> <tarball>`). Only the `mex` arm gets it on `PATH`, and the global npm directory is removed from both arms. |
| `--deps` | An installed `node_modules` for the subject, linked into every checkout so agents and hidden tests can run `vitest`. |
| `--model` | One model for the whole run. It is recorded in `prepare.json`, and `--run` refuses another. |

## Steps

```sh
node evaluate/arm/index.mjs --prepare --suite evaluate/arm/suites/hono.json --subject <clone> --cli-bin <bin> --deps <node_modules> --output <dir> --model <model>
node evaluate/arm/index.mjs --run --repetition 1 --tasks request-dispatch,middleware-composition ...   # pilot: 4 sessions
node evaluate/arm/index.mjs --run --repetition 1 --resume ...   # one repetition per day
node evaluate/arm/index.mjs --blind --suite ... --output <dir>  # writes blind-review.json / blind-reveal.json
node evaluate/arm/index.mjs --report --suite ... --output <dir> # reads grades.json when present
```

- **`--prepare`** resolves every commit, then builds the Graph and Wiki indexes and a clean-state `mex check` baseline once per base and scaffold. It also records the CLI hash, Claude Code version, Node version, platform and `core.autocrlf`.
- **`--run`** reuses one workspace per repository. Before each session it unlinks dependencies, checks out the pinned base/setup commit, cleans ignored artifacts, restores independent copies of cached indexes, and verifies HEAD, source identity, clean status, cache hashes and absent session state. Setup commits contain only scaffold, hooks and explicitly listed instruction patches; their ancestor is the task's original base. After the session it records the classified calls, patch, `mex check` and hidden tests.
- **Usage limits:** a usage-limit error stops the run. `--resume` skips valid rows and reruns invalid ones.

## Validity

Arms are enforced by the environment and validated from the transcript afterwards:
- any MEX use in the `files` arm invalidates the row;
- `npx mex-agent` invalidates the row in either arm;
- reading another checkout invalidates the row;
- invalid token accounting, missing structured output, a timeout or a non-zero exit invalidates the row.

Hand-edited grounding hashes are counted as a loop-close violation, not as an invalid row.

## Grading

- **Change tasks:** graded by the upstream PR's hidden tests, restored over the agent's version after the session.
- **Q&A tasks:** graded blind against each task's `answerPoints`. Record `{ correct, pointsMet, notes, labeler }` per `blindId` in `grades.json`, then rerun `--report`.

## Product hooks suites (`*-hooks.json`)

These suites compare three arms on Hono, TypeScript and Django: `files` (repository only), `mex-r2w` (scaffold plus the product hooks, prompts use the lexical recipe) and `mex-r3` (scaffold plus the product hooks, semantic extra installed). They use the product's `mex hooks install --tool claude`, `mex-hook` and `mex context`, not the prototype in `push/`.

| Suite field | Meaning |
|---|---|
| `arms.<id>.hooks` | Install the product hooks in each session checkout and commit them as setup state, so the session diff is the agent's work only. |
| `arms.<id>.lexical` | Sets `MEX_HOOK_LEXICAL=1` for the session (recipe R2w). Other arms never inherit it. |
| `arms.<id>.semantic` | Needs `mex context semantic install` (machine level); the run is invalid if a prompt used the lexical recipe. |
| `projectName` | Folder name of every checkout (`<output>/ws/<run>/<projectName>`). The context index turns the folder name into stop words, so it is the same in every arm and in the index template, and never a run id. |
| `appendPrompt` | `{ qa, change }`: shared concise-answer instructions delivered in the appended system prompt. |
| `requiresDeps`, `python` | `false` for a subject without `node_modules`; the Python used by the `django` test runner. |

Extra inputs: `--aliases <file>` (Hono and TypeScript: `{ "<entity id>": ["phrase", ...] }`, written to `.mex/local/context-aliases.json`; `--prepare` reports how many ids each scaffold has). `--deps` is optional for suites that set `requiresDeps: false`.

What changes in a hooks session:
- The scaffold's prototype hook files, prototype settings and prototype `CLAUDE.md` block are removed from the checkout (the scaffold ref is untouched); a `CLAUDE.md` block written by `mex setup` stays.
- `--prepare` builds the first graph, then seeds later task bases from the previous cache and uses incremental `graph refresh` (the product may choose a full extraction when configuration changes). Wiki/context indexes and provenance remain specific to each base/scaffold. Sessions use independent file copies, never hardlinks to mutable databases.
- The frozen CLI's bin is first on `PATH` for MEX arms, `MEX_CLI` points the settle worker at it.
- After the agent exits, the harness waits for the settle worker (`.mex/local/context-settle.lock`, cap 10 minutes, recorded as `settleWait` and not as agent time), copies `context-log.jsonl` to `artifacts/<run>.context-log.jsonl`, and stores `mex context status --json` after settle as `artifacts/<run>.context-status.json`.
- The row's `hooks` field summarises the log: events per kind (count, injected, time), injected ids and characters, whether the session budget was hit, Stop blocks and the ids they listed, each settle pass (refresh mode, reason, changed, re-extracted, regrounded ids, failures).
- A MEX arm with zero hook events is invalid; so is a `files` arm with hook entries or a context log.

### Fake runs

`test/fake-hooks-agent.mjs` (`--fake-agent`) replays a scripted session and runs the checkout's hook commands from `.claude/settings.json` with Claude Code-style payloads, so the wiring and the end-of-session work can be exercised without a model. `test/make-fake-fixes.mjs` writes the `FAKE_AGENT_FIXES` file that lets it apply the upstream fix for change tasks. `FAKE_AGENT_TOUCH_FACT=1` edits code a fact links to; `FAKE_AGENT_CONFIRM=1` answers the Stop block with `mex context confirm`; `FAKE_AGENT_CRLF=1` writes the touched file back with CRLF line ends (as a Python script does on Windows); `FAKE_AGENT_IGNORE_BLOCK=1` ends the session at a Stop block (as a headless host does after the structured answer). `FAKE_AGENT_SHELL_EDIT=1` reports the fact edit as a Bash script naming the file instead of an Edit. It cannot show that Claude Code itself calls the hooks.

Unit tests: `node --test evaluate/arm/test/arm.test.mjs evaluate/arm/test/hooks.test.mjs`.

## Full run

`full-run.example.json` pins three separate subjects, outputs and dependency copies. Review these local paths before use. The semantic model must already be installed: the harness checks its status and only reads it. Prepare never installs or updates it. On a restricted checkout, copy dependencies into the writable scratch folder first; test runners can write caches inside `node_modules`.

```powershell
node evaluate/arm/parallel.mjs --plan --config evaluate/arm/full-run.example.json
node evaluate/arm/parallel.mjs --prepare --config evaluate/arm/full-run.example.json
node evaluate/arm/parallel.mjs --run --resume --config evaluate/arm/full-run.example.json
```

The launcher defaults to `--plan`. Only explicit `--prepare` or `--run` starts children. Outputs must be distinct and non-nested, subjects distinct; each child gets its own temporary folder. Cleanup matches its own workspace path and unlinks dependency junctions before any reset or removal. Do not start two processes against the same output. Each repository's sessions remain serial; the three repositories run concurrently.

`index.mjs --plan --suite <suite> [--pilot <pilot-output>]` prints the selected sessions, repetitions, arm order and first-position counts, plus measured-cost estimates from pilot medians and a separate warm-up allowance. It does not run a CLI or create output. Heavy work may exceed these medians.

The historical explicit three-arm selection has **123 measured sessions**: Hono 30, TypeScript 51, Django 42. Hono's regular questions have `fullRun: false`; they remain available via explicit `--tasks`. For explicit arm selections, `repetitions` accepts a number or an object keyed by task id, `qa`, `change`, `heavy`, or `default`; task-level `repetitions` overrides it. In those historical schedules, questions run once, changes twice, all five heavy tasks twice. `orderOffset` staggers repository orders, including a filtered selection; both each repository and the combined full run balance first positions within one. Resuming skips completed rows without changing their intended order. Default heavy comparisons use two arms and three repetitions as described above.

### Cache and accounting

Hooks suites warm **every arm** immediately before each measured session using the same invocation, environment, workspace, tools, settings and hooks, with prompt `Reply with OK.` and `--max-turns 1`. `warmup` records usage, cost and elapsed time separately; none enters session metrics. The harness waits for settle, restores the entire original `.mex/local` snapshot (including session budget/statistics, shown ids, flags, logs and locks), requires clean Git status and rechecks index hashes. Unexpected source/database changes fail preparation for that session. `--no-warmup` disables the call, while cache validation still applies.

The measured first call needs at least `sharedPrefixTokens` cache-read tokens (default 5,656, the smallest warm pilot prefix); otherwise the row has violation `cold-start`. The suite can pin a different threshold for another model/system prompt.

Cost and model token totals come from the **last cumulative result**; continuation-local `usage` is summed only when cumulative `modelUsage` is absent. Assistant message inputs/cache totals independently audit accounting. `metrics.neutralCostUsd` reprices a zero-read first call's shared-prefix write as a read, using the median positive first-call cache read in that output and the model price table. Missing evidence or an unknown cold model produces an unavailable neutral cost. Reports recompute historical transcripts without changing source rows. Processed tokens and neutral cost are primary; actual paid cost remains visible. The pilot's exact R3 total is $0.5245082; its published $0.53 summary used rounded displayed values.

### Delivery measures and verification

Rows retain `measures`: discovery calls (Grep/Glob and shell searches), each injection's paths/symbols and bounded uptake, ignored injections, redundant symbol searches after a supplied location, off-gold prompt packets and their subsequent calls, calls until the first gold-file read/edit, wiki-show follow-ups, and graph/knowledge packet counts. Graph uptake requires a novel path or symbol within five subsequent calls; knowledge packets may also be cited in the final answer. Timestamps align hook logs with tool calls; missing timestamps are labelled partial. These are lexical uptake heuristics, not causal evidence. Legacy search-hit notes count as graph packets; explicit `kind: graph` is supported.

```powershell
node --test evaluate/arm/test/*.test.mjs
node evaluate/arm/verify-heavy.mjs --config evaluate/arm/full-run.example.json --output C:/mex-test-tmp/grader-check
```

Grader verification never runs an agent. It restores upstream tests at the base, reruns them with the upstream fix, verifies that failure is a test failure rather than a startup failure, checks question answer keys/source spans, and removes all worktrees. `--python <interpreter>` permits an explicitly recorded verification override. See [FULL-RUN-VERIFICATION.md](FULL-RUN-VERIFICATION.md) for pilot tables, measured setup timings, grader results and expected Stop-review coverage.
