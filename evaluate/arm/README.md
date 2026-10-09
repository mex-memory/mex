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
