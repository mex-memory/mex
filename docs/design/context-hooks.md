# `mex context` and agent hooks

Status: in implementation on `feat/context-hooks`.

## Goal

Deliver the right MEX knowledge to a coding agent at the moment it is needed, without the agent having to ask, and send nothing when nothing clearly fits. Agent-arm runs showed that pull (agents calling the CLI) cost +93% tokens versus plain file search, static Markdown cost +38% to +50%, and hook-pushed knowledge was the only delivery that came out ahead (TypeScript −8%). This design moves the hook prototype's logic into MEX as one read-only composer, `mex context`, that hooks call.

## Shape

```
hook event ─► light entry (mex-hook) ─► src/context composer ─► packet (stdout JSON for the host)
                                            │
                    .mex/local/context-index.json   .mex/graph.db (read-only)   session state
```

- **Composer (`src/context/`)**: pure, in-process, read-only. Never refreshes an index, never regrounds, never writes canonical files.
- **Context index**: `.mex/local/context-index.json`, derived from the Wiki entities and the graph. It is rebuilt by `mex context index`, and lazily when its recorded inputs (Wiki index identity, graph snapshot identity, `.mex` Markdown digests) change. It is disposable and checkout-local.
- **Light entry point**: a separate small bundle that loads only the composer. Starting the full CLI costs about 0.46 s, against about 0.1 s for bare Node, which is too slow for per-file hooks.
- **Root resolution**: every context and hook command finds the project root from any working directory.

## Events

| Event | Input | Selection | Model |
|---|---|---|---|
| `prompt` | user prompt text | ranking (below) plus gate | optional MiniLM |
| `read` | file plus read range | facts whose code links overlap the range; ⚠ when the linked code changed | none |
| `edit` | edited files (Edit/Write/MultiEdit and Bash diff) | facts linked to touched lines, with the `.mex` line to update | none |
| `grep` | search results | for the top hits: enclosing symbol, linked fact, callers; tests and docs marked | none |
| `stop` | session diff | touched-but-unseen facts get one prompt; settle worker afterwards | none |

## Prompt ranking (frozen recipe)

Chosen by a sealed held-out evaluation: 70 questions over Hono and TypeScript, split into dev and test halves; thresholds were frozen on dev and the test half was run once.

- **Primary (R3)**: candidates are `fact` entities. Field-weighted BM25 over title (×3), body, linked-code tokens and aliases (×3), with stop words and an exact identifier/backtick/path boost. It is fused by RRF (k=60) with an `all-MiniLM-L6-v2` (q8) dense channel over `title. aliases. symbol words. body[0:900]`.
  - Gate: normalised floor 0.2591; exact identifier hit or at least 5 query-term groups; cosine at least 0.6; at most 2 facts; a second fact only at a ratio of at least 0.2 of the first.
  - Test half: helped 17/24, 3 of 20 injected wrong, 0/10 false injections.
- **Fallback (R2w)**: lexical only, used when the semantic extra is not installed. Candidates are all typed Wiki sections (fact, convention, decision, guide, pattern, component) with body text. Floor 0.4186, G 5, ratio 0.5, margin 0.45.
  - Test half: 17/24, 5 of 22 wrong, 0/10.
- **Stop words**: the tokenizer drops common English function words and a short list of conversational filler ("please, explain, describe, show, want, need, really…"), plus the project's own name (root directory name and `package.json` name, derived at index time). Words about code ("error", "issue", "update", "test", "function"…) are *not* stop words in the frozen recipes: that list only feeds the segment channel, which is disabled.
- **Abstention is logged**, with a reason (`no-index`, `below-floor`, `uncorroborated`, …).

The semantic channel is opt-in. Its library and model are installed under a MEX-managed directory on request: about 68 MB on Windows, of which the model is 23 MB. A stock install is about 500 MB, because the library hard-depends on native runtimes for every platform plus a second, web runtime; the installer stubs `sharp`, removes the web runtime and keeps only this platform's CPU binaries. (The WebAssembly runtime would be about 56 MB, but its quantised kernels differ from the native ones enough to move one held-out injection across the cosine threshold, so it is not used.) When the extra is absent, R2w is used, with no error.

## Packets

Packets use one compact format, since `file:line #symbol` locations halved the injected text in the prototype:

```
MEX knowledge (fresh) — <title>
<fact text, trimmed>
code: src/x.ts:120-180 #symbol · more: mex wiki show <id>
```

- At most 2 facts per prompt and at most 4K chars per event, well under the host's 10K-character limit. A session also has a total budget (12K characters by default, `context.sessionBudgetChars`); see Milestone 2.
- Facts already shown in this session are not repeated.
- Each packet says which channel selected it.

## Freshness and end of session

- Health is computed live for the entities a packet shows: graph `bodyHash` against the grounded hash. Cached Wiki-index health is never trusted after edits.
- `stop` asks the agent once about touched facts it has not seen. A detached settle worker then refreshes the graph and re-records (regrounds) **only** entities whose prose the agent edited or explicitly confirmed. Every other touched entity stays flagged "changed, re-check". The Hono complete-set CORS wrong renewal is the regression fixture.
- `wiki reground` accepts several ids in one snapshot (batch).

## Authoring

Setup, GROW and `wiki apply` write 3–6 short symptom or goal phrases per code-linked fact into the existing `aliases` field. Fingerprints and code links are recorded by MEX itself, not copied by agents.

## Installation

`mex hooks install --tool claude` (with `--dry-run` and `remove`) writes the hook entries to `.claude/settings.json` and preserves user-owned entries. Other hosts come later, through the same composer.

## Evaluation gate

- **Offline**: the frozen recipe must reproduce the evaluation's injections on the held-out set (parity), at under 0.2 s for read/edit/grep and under 1.5 s for prompt with the semantic extra.
- **Agent runs**: on Hono and TypeScript, fewer total tokens than the files arm and the files + sgrep arm, with equal correctness. Input and output tokens are reported separately, and every arm gets the same concise-answer instruction.

## Milestone 1 (implemented): composer and `mex context`

`src/context/` holds the composer; hooks, the light entry point and the other events are later milestones and attach to the seams noted below.

- **Commands**: `mex context index`, `mex context prompt "<text>" [--session <id>] [--lexical] [--explain] [--json]`, `mex context semantic install|status|remove`. The project root is the nearest ancestor with a real `.mex/` scaffold (`root.ts`), so they work from any subdirectory and from inside `.mex/`. The per-machine `~/.mex` is never taken for a project.
- **Index** (`.mex/local/context-index.json`): entities come from the Wiki parser (`parseWikiMarkdown`), graph rows from a read-only open of `.mex/graph.db`. It records the Markdown digests, a hash of the graph snapshot metadata and the alias overlay digest. Freshness is checked cheaply first (one stat per Markdown file plus the graph identity); bytes are hashed only when a file looks touched, and an identical digest keeps the index. `.mex/local/**` is never read as Wiki Markdown.
- **Aliases** come from each entity's `metadata.aliases`, plus an optional checkout-local overlay `.mex/local/context-aliases.json` (`{ "<entity id>": ["phrase", ...] }`) for tooling that must not edit tracked prose. This is the seam for authoring.
- **Recipe selection**: R3 when an embedder loads and the scaffold has facts, otherwise R2w. A failing model falls back to R2w with a `CONTEXT_SEMANTIC_FAILED` warning. Fact vectors are cached in the index by model id and document-text hash.
- **Gate decisions are reported** per candidate (`selected`, `below-floor`, `uncorroborated`, `low-cosine`, `weak-margin`, `below-ratio`, `already-shown`, ...) and as the abstention reason.
- **Session de-duplication** runs after the gate, so the frozen scores and margins are computed over the full candidate set; entries already shown are then dropped.
- **Writers**: `src/context/local-state.ts` is the only module that mutates the filesystem. It writes the index, session files (`.mex/local/context-sessions/`, bounded and pruned) and the managed semantic directory (`<MEX home>/semantic/`).
- **Parity**: `scripts/context-parity.mjs` replays the held-out question files through the built CLI and compares injected ids with the reference harness.
- **Reference details not ported**: the reference's second "code noise" stop list is consumed only by the segment channel, which the frozen recipes disable (`seg: 0`), so it never affected a result. The reference hard-coded one repository's name as a stop word; the port derives the project-name words per project (index field `projectWords`). The reference's term table was a plain object, so the query word "constructor" matched every document through the prototype chain; the port uses a `Map`.

## Milestone 2 (implemented): hooks

- **Entry point**: `mex-hook` (`dist/hook.js`, package `bin`) is its own bundle from `src/context/hook/entry.ts`. It never imports the CLI; tool events load only light modules (the graph is opened through `graph-reader.ts` rather than the graph's database module, the index file is read through `index-file.ts`), and the prompt handler, which needs the Markdown parser and the ranker, is a dynamic import. Cold wall time on Hono (Windows, bare `node -e 0` is about 65 ms): read, grep and Bash about 125-160 ms, edit about 190 ms (one `git diff` process), lexical prompt about 170-210 ms.
- **Dispatch** is by the payload (`hook_event_name`, `tool_name`): `UserPromptSubmit` is `prompt`; `PostToolUse` Read, Edit|Write|MultiEdit, Grep and Bash are `read`, `edit`, `grep` and `bash`. `Stop` is recognised and ignored: the seam for the next milestone. Any error exits 0 with no output and a line in `.mex/local/context-log.jsonl` (capped at 256 KB, newest half kept). Every event is logged with its duration, the injected ids and the text.
- **Dedup keys** share the session file: a bare id (text shown), `edit:<id>` (shown as touched by an edit, a different message) and `diff:<file>:<hash>` (this exact change was checked). A prompt that starts with `<task-notification>` is skipped.
- **read**: facts whose code links overlap the lines read (`offset`/`limit`, otherwise the file), changed ones first, at most two plus a one-line pointer. **edit/bash**: `git diff -U0 HEAD` hunks are base-side, so they are matched against where each fact's code stood at HEAD, recorded on the first event for a HEAD in `.mex/local/context-base.json` (the graph moves as code changes). An insertion counts as touching a symbol only when it falls inside it. A size-and-mtime signature per linked file (seeded at the first prompt) lets a Bash call that changed nothing skip git. **grep**: hits from the Grep tool or `path:line:` output of a Bash `rg`/`grep` map to the enclosing symbol, its fact and up to three callers by node id, tests and docs marked, in a note of at most 1200 characters; silent unless a hit sits in code with a fact not yet shown.
- **Session budget**: the injected characters per `session_id` are summed over all events (session file). Default 12,000, set with `context.sessionBudgetChars` in `.mex/config.json` (a positive integer up to 1,000,000; anything else means the default). After dedup, a packet that would push the total over the budget becomes one pointer per entry, `MEX: <title> applies (<health>) — mex wiki show <id>`, at most 120 characters; pointers count toward the total. From 1.5 times the budget nothing more is sent and the log says `budget-exhausted`.
- **Install**: `mex hooks install|status|remove --tool claude [--dry-run]` merges marked entries into `.claude/settings.json` (a command ending in `--mex-managed` is MEX's; nothing else is touched) and keeps a short block in `CLAUDE.md` under `mex-agent:hooks` markers, through the shared managed-block machinery (which gained a removal planner). The command is `mex-hook` when it resolves on PATH, otherwise `node "<abs>/dist/hook.js"`.
