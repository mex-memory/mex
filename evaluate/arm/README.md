# Release arm harness

Run the same tasks in a baseline arm and a MEX arm. Each chain uses one agent,
one subject repo and two fresh sets of homes. Both arms keep their homes
through the chain. The baseline goes first on task 1. The order flips on each
following task.

## Dry run

Build MEX, then run the offline fixture on a disk with room for scratch data.
The fixture runs both agents as local stand-ins and uses the built MEX installer.
It sends no model requests.

```sh
npm run build
node evaluate/arm/test/demo.mjs <scratch-directory>
```

The fast token tests run in the default suite. To run the dry-chain tests too,
set `MEX_ARM_RUN_DRY=1` in the shell and run this command. On PowerShell use
`$env:MEX_ARM_RUN_DRY = "1"` and `npx.cmd`.

```sh
npx vitest run evaluate/arm/test/arm.test.mjs scripts/delivery-replay/cost.test.js src/model-runner/__tests__/codex-reference-prices.test.ts --maxWorkers=2
```

## Run a private suite

Build from the frozen MEX commit. A real chain needs MEX's native hook. Without
its platform package, MEX installs a Node fallback that fails open and delivers
nothing, and the harness refuses to start the MEX arm. In a source checkout,
build it with `node scripts/build-hook-binaries.mjs --host` and link
`npm/hook-<os>-<arch>` into `node_modules/mex-agent-hook-<os>-<arch>`. The
manifest records the hook runtime. Use the same machine and one pinned agent
version for both arms. Use a separate, private output directory for each chain.

```sh
node evaluate/arm/index.mjs --agent claude --suite <suite.json> --subject <local-git-repo> --output <new-directory> --pin <pin.json> --credentials <file>
```

The pin file has `version` (exact agent `--version` output), `model`, `effort`,
`mexVersion`, and the full `mexCommit`. An optional `command` array names the
executable and any fixed arguments. On Windows use the native executable
or a Node executable and CLI entry script when the default is a batch shim.
`--cli` can point to a different built `dist/cli.js`. The manifest also records its
hash, the Node version, OS release and architecture. `--deps` can point to an
already installed, read-only `node_modules` for the subject. Prepare dependencies
outside the run. The sampler defaults to one second. Set `--sample-ms 0` to
disable it for fixture checks. `--timeout-ms` limits each agent turn and each grader run.
It defaults to five minutes, which a long task can exceed; a timeout stops the
chain. The manifest records the limit, so use the same value for every chain
you compare.

The runner sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `MEX_HOME`, `HOME` and
`USERPROFILE` in each arm. It also gives each arm its own app data, XDG
and temp locations. The baseline preflight checks settings, rule files and
the absence of a MEX home. The MEX arm installs machine-level hooks inside
its own homes, starts the installed `SessionStart` command with a fixture event,
then runs the free repository setup at T0. Codex uses unattended hook trust
after checking the installed handlers. A checkout hook file or a change to
the checked hook settings stops the run. Arm isolation uses config paths and
environment variables. Use separate OS-level sandboxes when running untrusted
tasks or protecting data from deliberate filesystem access.

Pass a file named `.credentials.json` for Claude Code or `auth.json` for Codex.
The harness copies its bytes without parsing or logging them and unlinks the
two copies when the chain finishes or throws. On macOS, Claude Code logins in
Keychain do not provide a file for this workflow. The harness does not read,
export or modify Keychain credentials. Use a file-backed login on a separate
runner for the Claude Code arm if the login is Keychain-only. The offline
fixture needs no login.

## Suite format

`test/fixtures/dry.json` is the full small example. Keep real suites and test
files outside the checkout. Specify `schemaVersion: 1`, `id`, `subjectRepo` and
the tasks in order. Give `setupBase` for the T0 commit. If omitted, setup uses the
first task base. Each task keeps the old `id`, `base`, `prompt` and `hiddenTests`
fields. It adds `testNames` and `reviewerNotes`.

- Turn 1 appends only the names the hidden tests call. Use the same notes
  from the PR for turn 2. The runner resumes the exact native session.
  A PR with no reviewer lesson leaves `reviewerNotes` out: that task runs one
  turn, and the report counts it as one. Never write notes for the run.
- The old `hiddenTests.fromCommit` and `files` form still works.
  Use `fromDirectory` relative to the suite for an external test source.
  The harness stages either form after turn 2. Each task starts from its
  base and reachable Git history. The fix commit stays out of that task.
- `hiddenTests.command` is an executable and argument array. It runs in the
  checkout with separate grader homes. Exit zero means accepted. Include
  any rule checks in that command. For an answer-only task, use `files: []`
  without a test source and read the agent's recording through the grader's
  `MEX_ARM_TRANSCRIPT` environment variable. The old Node preload blocks networking
  for Node graders. Use an offline runner if the grader launches tools
  outside Node. Grade logs and checkouts stay in the private output.
- Before freezing a suite, verify that the base fails, the real fix passes,
  and every name the tests call is listed. Run identical tasks and reviewer
  notes for each agent. The fixture deliberately leaves one baseline task
  unfixed to exercise the failed-grade path.

## Agents

| Agent | Headless command | Harness runner |
|---|---|---|
| Claude Code | `claude -p` | `--agent claude` |
| Codex | `codex exec` | `--agent codex` |
| Copilot CLI | `copilot -p` | runner not implemented |
| OpenCode | `opencode run` | runner not implemented |
| Devin | — | runner not implemented |
| Kiro | `kiro-cli chat --no-interactive` | runner not implemented |
| Cursor | `agent -p` | runner not implemented |
| Antigravity | `agy -p` | runner not implemented |
| Gemini CLI | `gemini -p` | runner not implemented |

## Output and replay

`report.md` and `report.json` show acceptance, the four counted token classes,
list-price dollars, turns and measured turn wall time. MEX model-call rows
are read from the arm's local record and shown on their own lines. The
chain totals include those calls. Setup AI is shown separately. Call rows
are assigned to the arm's task by the record's row cursor at grading.
The sampler writes process RSS, available RAM and free disk space at each sample. Short
hook processes can finish between samples. A zero peak means no process
in that group was observed.

The delivery replay and the harness use the same [reference table](../../src/shared/delivery-prices.json).
The table records the rate source and date. The harness uses Claude's cache-write TTL split
when the transcript reports it. Aggregate-only cache writes use the
five-minute reference rate. Codex reasoning is already part of output. MEX's
record rows use aggregate context size and do not include the cache-write TTL.
A model without a rate, such as `gpt-6.2-sol`, is marked `to confirm`.
Affected dollar totals and cost per accepted task are withheld.

The run copies each native transcript or rollout into `recordings/` and
exports a replay bundle into `replay/`. To export it again to a new directory,
use this command.

```sh
node evaluate/arm/export-replay.mjs <run-manifest.json> <new-replay-directory>
```

The exporter preserves JSONL bytes and maps each session to the replay gate's
`agent`, `file`, `repo` and `commit` fields. It also keeps `arm` and `task`
and hashes each session file. The bundle is staging input for the replay
gate. Before adding a session to the public corpus, review it for private
text, add the subject snapshot and reviewed entries, and refresh the
expected replies and manifest digest using the replay gate's corpus README.
Keep private recordings and their paths outside Git.
