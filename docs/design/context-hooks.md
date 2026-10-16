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
- **Dispatch** is by the payload (`hook_event_name`, `tool_name`): `UserPromptSubmit` is `prompt`; `PostToolUse` Read, Edit|Write|MultiEdit, Grep and Bash are `read`, `edit`, `grep` and `bash`. Any error exits 0 with no output and a line in `.mex/local/context-log.jsonl` (capped at 256 KB, newest half kept). Every event is logged with its duration, the injected ids and the text.
- **Dedup keys** share the session file: a bare id (text shown), `edit:<id>` (shown as touched by an edit, a different message) and `diff:<file>:<hash>` (this exact change was checked). A prompt that starts with `<task-notification>` is skipped.
- **read**: facts whose code links overlap the lines read (`offset`/`limit`, otherwise the file), changed ones first, at most two plus a one-line pointer. **edit/bash**: `git diff -U0 HEAD` hunks are base-side, so they are matched against where each fact's code stood at HEAD, recorded on the first event for a HEAD in `.mex/local/context-base.json` (the graph moves as code changes). An insertion counts as touching a symbol only when it falls inside it. A size-and-mtime signature per linked file (seeded at the first prompt) lets a Bash call that changed nothing skip git. **grep**: hits from the Grep tool or `path:line:` output of a Bash `rg`/`grep` map to the enclosing symbol, its fact and up to three callers by node id, tests and docs marked, in a note of at most 1200 characters; silent unless a hit sits in code with a fact not yet shown.
- **Session budget**: the injected characters per `session_id` are summed over all events (session file). Default 12,000, set with `context.sessionBudgetChars` in `.mex/config.json` (a positive integer up to 1,000,000; anything else means the default). After dedup, a packet that would push the total over the budget becomes one pointer per entry, `MEX: <title> applies (<health>) — mex wiki show <id>`, at most 120 characters; pointers count toward the total. From 1.5 times the budget nothing more is sent and the log says `budget-exhausted`.
- **Install**: `mex hooks install|status|remove --tool claude [--dry-run]` merges marked entries into `.claude/settings.json` (a command ending in `--mex-managed` is MEX's; nothing else is touched) and keeps a short block in `CLAUDE.md` under `mex-agent:hooks` markers, through the shared managed-block machinery (which gained a removal planner). The command is `mex-hook` when it resolves on PATH, otherwise `node "<abs>/dist/hook.js"`.

## Milestone 3 (implemented): stop, settle and batch reground

The rule, a product decision: after a session changes code MEX may refresh the graph, but it re-records (regrounds) **only** entities whose prose was edited in the session or that were confirmed with `mex context confirm <ids>`. Every other touched entity stays flagged "changed, re-check" in `.mex/local/context-flags.json`. Seeing a fact, or reading its code, never counts as confirmation: a complete-set claim (the Hono CORS headers) is touched by an edit that adds an item, and re-recording it would bless a claim that just became false.

- **Review** (`src/context/review.ts`): touched facts come from `git diff -U0 HEAD` against where each fact's code stood at HEAD (`findTouched`, shared with the edit event). An entity counts as *edited* when its title and body hash differs from the hash recorded in `context-base.json` for this HEAD (`prose`, written with the base locations at the first event); a hash of the prose rather than a diff of `.mex`, because MEX's own re-recording rewrites the entity block. It counts as *confirmed* by a session confirmation or by a flag a confirmation already made eligible. A change whose digest equals the one last re-recorded (`reconciled`) is not asked about again. Entities flagged by earlier sessions stay in view until vouched for.
- **Flags** (`context-flags.json`, `flags.ts`): `flagged` or `eligible` (with its basis), why, since, and the last re-record error. Packets and `mex context status` read it; `liveStateFrom` reports a flagged entity as `changed` even while the graph still says fresh.
- **`mex context confirm <id...> [--session <id>] [--note <text>]`** records the confirmation in the session file (the newest session when none is named) and makes an already-flagged entity eligible at once. Unknown ids are reported; none known is an error.
- **`mex context status`** lists flagged and eligible entities, their location and reason, whether a settle worker runs, and the last settle log entry.
- **Stop event**: reviews the session; flags every touched entity; when `context.stopReview` is `ask` (default; `off` disables) and entities touched now are neither edited nor confirmed, it blocks **once per session** with a list of at most 1,500 characters (id, title, `.mex` location, why, and the exact `mex context confirm <ids> --session <id>` command; overflow is counted and left to `status`). It does not block while Claude Code reports the stop is already continuing from a block. Then it starts the settle worker, unless the review digest equals the one the session last settled.
- **Settle worker** (`mex-hook settle --project <dir> --session <id>`, `hook/settle.ts`): started detached, `windowsHide`, retried on exit code 0xC0000142. A lock file (`context-settle.lock`, the worker's pid; a dead pid is taken over) allows one worker; a Stop while it runs leaves `context-settle.again` and the worker goes round once more (at most four passes). Each pass: review, flag, one `mex graph refresh` (timing recorded; on failure the exit code and the last 1,500 characters of stderr go to the log as `settle-refresh-failed` and nothing is re-recorded), one batch `mex wiki reground <ids> --apply --json` of the eligible ids (chunks of 80), flags cleared and `reconciled` set for each success, the error kept on each failure, then a forced rebuild of the context index. Every pass is logged as `settle` in `context-log.jsonl`.
- **Batch reground**: `mex wiki reground <id...> --apply` opens one fresh graph snapshot, runs the unchanged single-id service for each id (so every safety check holds per id), and reports a result per id; one refused entity never blocks or rolls back the others, and the exit status is nonzero when any failed. One id prints exactly as before.
- **Install**: `mex hooks install|status|remove` also manage a `Stop` entry; the `CLAUDE.md` block tells agents what to do with the end-of-session list.

## Milestone 4 (implemented): authoring and fixes

- **Agents never copy fingerprints.** An agent writes a grounding as a node id. `wiki apply` (`create-entry`, `set-grounding`) derives the fingerprint and body hash from the live graph; a frontmatter `grounds_to` entry with only a node gets its fingerprint when baselines are captured (`captureGroundingBaselines`, which setup finalize, ground migration and sync completion share), in either the root or the `mex.grounds_to` store. The provenance rule is unchanged: a node the graph does not hold fails with `GROUNDING_UNVERIFIED` (wiki) or is counted as skipped, which fails setup finalization, and a supplied fingerprint must still equal the graph's. A file naming an unknown node is left untouched rather than half written. `adopt` still requires fingerprints, because it never consults the graph. Setup, ground-migration, sync-repair and upgrade prompts and the shipped templates stop instructing `scope --fingerprint`; the flag stays.
- **Aliases at authoring.** `create-entry` and `update-entry` take `aliases`, stored under `metadata.aliases`, the key the Wiki index and the context ranker already read. The key is also what topics use for alternative names, so there is no conflict, but the bounds apply to search phrases only: a topic's aliases are not limited. Bounds: an array of non-empty strings, trimmed and de-duplicated, at most 8 of at most 80 characters; a violation is rejected, not truncated, so the author sees the limit. Aliases stay optional (no validation diagnostic when absent), so older scaffolds are valid. The guidance (`ALIAS_AUTHORING_GUIDANCE`) names kinds of phrase (symptom, goal, plain-word synonyms, the mistake avoided), forbids restating the title or listing identifiers, and says phrases come from the fact's own content.
- **Upgrade review.** `mex wiki upgrade` no longer lists entities with a blank body (a file-level overview whose claims live in sections holds only the file's grounding), and its closing line counts what the pass reviewed and what remains beyond a bounded batch instead of re-listing candidates that were judged already focused.
- **Refresh mode.** `mex graph refresh` prints `Refresh: incremental|full (<reason>), N changed, M re-extracted.` or `Refresh: nothing changed.`; `--json` already carried `refresh`. The settle worker runs the refresh with `--json` and logs `mode`, `reason`, `changed`, `reextracted` in the `settle` entry.
- **Root resolution tests.** `graphReadRoot` and `rebaseGraphTarget` are exported and covered, plus spawned-CLI checks from a subdirectory.
- **Not done here.** `maxSourceFileBytes` stays a constant; an issue is drafted separately.
