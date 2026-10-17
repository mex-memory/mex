# Agent-arm test

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
- **`--run`** creates a fresh worktree per session and adds the scaffold for the `mex` arm only. It links the dependencies and commits, so the session diff is exactly the agent's work. After the session, it records the classified calls, the patch, `mex check` (`mex` arm), and the hidden tests (change tasks).
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
| `appendPrompt` | `{ qa, change }`: one concise-answer instruction appended to the prompt in every arm. |
| `requiresDeps`, `python` | `false` for a subject without `node_modules`; the Python used by the `django` test runner. |

Extra inputs: `--aliases <file>` (Hono and TypeScript: `{ "<entity id>": ["phrase", ...] }`, written to `.mex/local/context-aliases.json`; `--prepare` reports how many ids each scaffold has). `--deps` is optional for suites that set `requiresDeps: false`.

What changes in a hooks session:
- The scaffold's prototype hook files, prototype settings and prototype `CLAUDE.md` block are removed from the checkout (the scaffold ref is untouched); a `CLAUDE.md` block written by `mex setup` stays.
- `--prepare` builds the Graph and Wiki indexes and the context index (with the alias overlay) once per base and scaffold; sessions copy them.
- The frozen CLI's bin is first on `PATH` for MEX arms, `MEX_CLI` points the settle worker at it.
- After the agent exits, the harness waits for the settle worker (`.mex/local/context-settle.lock`, cap 10 minutes, recorded as `settleWait` and not as agent time), copies `context-log.jsonl` to `artifacts/<run>.context-log.jsonl`, and stores `mex context status --json` after settle as `artifacts/<run>.context-status.json`.
- The row's `hooks` field summarises the log: events per kind (count, injected, time), injected ids and characters, whether the session budget was hit, Stop blocks and the ids they listed, each settle pass (refresh mode, reason, changed, re-extracted, regrounded ids, failures).
- A MEX arm with zero hook events is invalid; so is a `files` arm with hook entries or a context log.

### Fake runs

`test/fake-hooks-agent.mjs` (`--fake-agent`) replays a scripted session and runs the checkout's hook commands from `.claude/settings.json` with Claude Code-style payloads, so the wiring and the end-of-session work can be exercised without a model. `test/make-fake-fixes.mjs` writes the `FAKE_AGENT_FIXES` file that lets it apply the upstream fix for change tasks. `FAKE_AGENT_TOUCH_FACT=1` edits code a fact links to; `FAKE_AGENT_CONFIRM=1` answers the Stop block with `mex context confirm`. It cannot show that Claude Code itself calls the hooks.

Unit tests: `node --test evaluate/arm/test/arm.test.mjs evaluate/arm/test/hooks.test.mjs`.
