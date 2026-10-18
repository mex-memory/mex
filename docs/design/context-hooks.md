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

- **Primary (R3)**: candidates are `fact` entities (since the long-prompt work, every typed section with a body as well; see Long prompts below). Field-weighted BM25 over title (×3), body, linked-code tokens and aliases (×3), with stop words and an exact identifier/backtick/path boost. It is fused by RRF (k=60) with an `all-MiniLM-L6-v2` (q8) dense channel over `title. aliases. symbol words. body[0:900]`.
  - Gate: normalised floor 0.2591; exact identifier hit or at least 5 query-term groups; cosine at least 0.6; at most 2 facts; a second fact only at a ratio of at least 0.2 of the first.
  - Test half: helped 17/24, 3 of 20 injected wrong, 0/10 false injections.
- **Fallback (R2w)**: lexical only, used when the semantic extra is not installed. Candidates are all typed Wiki sections (fact, convention, decision, guide, pattern, component) with body text. Floor 0.4186, G 5, ratio 0.5, margin 0.45.
  - Test half: 17/24, 5 of 22 wrong, 0/10.
- **Stop words**: the tokenizer drops common English function words and a short list of conversational filler ("please, explain, describe, show, want, need, really…"), plus the project's own name (root directory name and `package.json` name, derived at index time). Words about code ("error", "issue", "update", "test", "function"…) are *not* stop words in the frozen recipes: that list only feeds the segment channel, which is disabled.
- **Abstention is logged**, with a reason (`no-index`, `below-floor`, `uncorroborated`, …).

The semantic channel is opt-in. Its library and model are installed under a MEX-managed directory on request: about 68 MB on Windows, of which the model is 23 MB. A stock install is about 500 MB, because the library hard-depends on native runtimes for every platform plus a second, web runtime; the installer stubs `sharp`, removes the web runtime and keeps only this platform's CPU binaries. (The WebAssembly runtime would be about 56 MB, but its quantised kernels differ from the native ones enough to move one held-out injection across the cosine threshold, so it is not used.) When the extra is absent, R2w is used, with no error.

### Long prompts (windows)

The recipes above were calibrated on one- and two-sentence questions. Real task prompts run from 5 words to pasted pages. The normalised score divides by the weight of every query word, so a 55-word task description scored below the floor even when its one matching sentence scored 0.64 alone: with the thresholds above, all six pilot prompts abstained. The fix keeps the frozen recipes for prompts that fit in one window and changes only how a longer prompt is scored and gated. Parameters are frozen in `frozen.ts` (`WINDOWING`, `RECIPES[*].windowed`) and recorded, with the evidence, in the evaluation folder as `ablation\frozen-v3.json`.

- **One window = unchanged.** A prompt of at most 40 words (the window size) ranks and gates exactly as before. `scripts/context-window-parity.mjs` compares a baseline build with the current one on the lexical recipe: all 65 prompts of the 70-question set that have at most 40 words give identical injected ids, scores, normalised scores, corroboration counts and gate decisions (the 5 longer ones differ by design).
- **Prose only.** Fenced blocks, stack frames, test-runner summaries and runs of at least three code-like lines are removed before scoring (`proseOf`). A paste says what the user is looking at, not what they ask, and its identifiers belong to the pasted file. Measured on dev, treating identifiers found in pasted blocks as exact-match evidence made the very long bucket worse (more wrong sends, fewer hits). With under 10 words of prose, the whole text is scored.
- **Windows.** The prose is cut into sentences (a sentence under 10 words is merged into its neighbour, one over 40 words is cut), and overlapping runs of consecutive sentences of at most 40 words become windows (at most 12; a window contained in another is dropped). Each window is scored by the frozen scorer against its own query-word weight, with its own identifiers and its own corroboration count; a candidate keeps its best window. Because the best window does not depend on the other windows, the score of the sentence that carries the question does not depend on how much is pasted around it. The dense channel embeds each window and takes the best cosine.
- **Gate for a windowed prompt.** The maximum over many windows flatters the runner-up too, so the lead over the fourth candidate carries the weight. Both recipes use the same lexical gate: floor 0.293, at least 4 (lexical) or 3 (semantic) query-word groups in one window (or an identifier hit), a second entry only at 0.9 of the first, lead over the fourth 0.45 (lexical) or 0.6 (semantic), at most 2 entries. The semantic recipe adds its cosine as a veto: candidates with a best-window cosine under 0.5 are dropped before the gate, and the fusion only orders the rest.
- **R3 candidates** are now the same typed sections as the lexical recipe plus every fact, so a convention or decision can be sent by the primary recipe too. The dense text of a non-fact is unchanged (title, aliases, symbol words, first 900 characters); a file-context prefix and 350-character chunks were measured on dev and did not improve precision.

Measured on the development half (24 with-fact and 12 without-fact questions per bucket; "correct" is the share of injections that carry a gold entry; false sends are injections on questions without a fact):

| Dev | Old R2w | New R2w | Old R3 | New R3 |
|---|---|---|---|---|
| Short (original) | 14/24, 14/18, 1/12 | 15/24, 15/19, 1/12 | 13/24, 13/17, 1/12 | 13/24, 13/16, 1/12 |
| Medium (60-96 words) | 4/24, 4/6, 0/12 | 14/24, 14/16, 0/12 | 9/24, 9/13, 1/12 | 16/24, 16/20, 1/12 |
| Very long (305-1,500 words) | 0/24 | 10/24, 10/15, 3/12 | 0/24 | 11/24, 11/14, 1/12 |

Methods tried on dev (lexical recipe, thresholds searched per method under the same rule; the rule needed at least 70% of the short bucket's helped in the medium and very long buckets):

| Method | Medium helped | Very long helped | Verdict |
|---|---|---|---|
| Whole prompt, normalised as before | 4 | 0 | the bug |
| Truncate to the first 500 or 1,000 characters | 4 | 0 to 1 | fails whenever the question is not at the start: with the question at the start, middle or end of the very long prompts, 500 characters found 3 of 16, 0 of 15 and 0 of 17 hits (dev and test pooled, lexical) against 7, 7 and 7 for windows | 
| Keep only the 8 to 16 rarest query words (whole prompt) | 0 to 2 | 0 | loses the corroboration that separates a match from a coincidence |
| Rare-word reduction inside each window | 10 | 7 | worse than plain windows |
| Length-aware sigmoid of the raw score (five length tiers) | 0 to 2 | 0 | the raw scores here sit far from the tier midpoints; no setting passed |
| Evidence gate (resolved identifier, two words in one entry's title, aliases and symbol names, or one rare word of at least 5 letters present in 2 to 25 entries) in place of the corroboration count | 14 | 10 | the same as the corroboration count once the lead rule is in place, so the simpler count stays |
| Windows, pasted blocks kept | 11 to 12 | 1 to 5 | many wrong sends from pasted identifiers |
| Windows over prose (shipped) | 14 to 16 | 10 to 11 | |

A rising floor with the number of windows and a rule that drops a second entry coming from a distant window were also searched and gave no gain, so neither is in the gate. The false-send growth that many windows could cause is bounded instead by prose-only scoring, the cap of 12 windows, the 0.9 second-entry ratio and the lead rule. A one-line "may apply" pointer tier for a rejected-but-clear leader was not built.

Test half (v3 is a second look; the single one-shot run used v2, which differed only by keeping prompts up to 56 words whole and gave R2w 17/24 on the short bucket instead of 16/24, and the same numbers elsewhere):

| Test | Old R2w | New R2w | Old R3 | New R3 |
|---|---|---|---|---|
| Short | 17/24, 17/22, 0/10 | 16/24, 16/19, 0/10 | 17/24, 17/20, 0/10 | 17/24, 17/21, 0/10 |
| Medium | 15/24, 15/15, 0/10 | 15/24, 15/17, 0/10 | 15/24, 15/16, 0/10 | 17/24, 17/21, 0/10 |
| Very long | 0/24 | 11/24, 11/25, 4/10 | 0/24 | 12/24, 12/26, 4/10 |

The very long bucket does not meet the precision rule on test. In that set one unrelated paragraph, taken from another question's prompt, is pasted into every prompt; it is a real question about another topic, so the entry it matches is sent. 10 of the 14 wrong R2w injections (and 8 of 14 for R3) and 3 of the 4 R2w false sends (2 of 4 for R3) match only that paragraph. Without them R2w is 11 of 15 correct and R3 12 of 18. Nothing in a prompt's content separates a pasted paragraph from the question, so this is reported, not tuned away: the gate is precision-first for one coherent question, and a prompt about two topics may get the wrong one.

Corroboration 4 for the lexical recipe (2026-10-18; it was 3 when the tables above were measured). On the agent-run task prompts (54 to 271 words with the run's instruction suffix), the lexical recipe sent two unrelated entries, each picked with no identifier hit and exactly 3 matching words in one window, all ordinary prose ("SQLite", "settings", "objects"): a setup guide on environment variables for a SQLite literal bug, and a QuerySet caching fact for an admin delete trace. Requiring a fourth word (the same as requiring an identifier hit when only three words match) changes nothing on the length buckets: dev and test injections are identical for both recipes in every bucket, so the tables above stand; on dev the gate decision moved only for unsent runner-up candidates of 19 lexical prompts, all over 40 words. On all 33 agent-run prompts (Hono 10, TypeScript 13, Django 10; both recipes, through the hook entry point) those two entries are the only change: the two prompts now inject nothing, the graph tier stays silent for them, and the other 64 outputs are byte-identical, including a QuerySet cloning entry matched by 4 words and an identifier. The one-window parity check still gives 65 of 65 identical. The semantic recipe keeps 3: its cosine veto already rejected both coincidences, and a fourth word dropped a correct dev entry (`ts-09`, medium and very long). Also measured: corroboration 5 for the lexical recipe lost two correct medium dev entries; a floor of 0.4 for three-word picks removed one of the two entries, and 0.5 removed both only because one scored 0.496, at the cost of a second threshold.

Latency (cold process per prompt, Windows): hook entry point, lexical 220 to 260 ms and semantic 770 to 850 ms on short, medium and very long prompts alike, including the 1,500-word prompt; `mex context prompt`, lexical about 440 ms and semantic 900 to 1,000 ms.

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
- **Recipe selection**: R3 when an embedder loads and the scaffold has candidates (facts or typed sections with a body), otherwise R2w. A failing model falls back to R2w with a `CONTEXT_SEMANTIC_FAILED` warning. Entry vectors are cached in the index by model id and document-text hash.
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


## Graph tier (offline pilot replay, 2026-10-18)

Knowledge remains first. The light graph reader also supplies prepared, read-only
exact-name, enclosing-symbol, range, caller, callee and caller-count queries.
Call edges rank production paths before tests **before** applying their row limit;
this includes `testRunner` and `unittests`. Graph hints never index or refresh code.

Rules frozen after replaying the 18 pilot sessions:

- **Prompt:** only after knowledge abstains. Verify code-shaped identifiers
  (camel case, snake case, or a bare name in backticks) by exact case-sensitive
  lookup. Send callable definitions only, with their indexed location. A name
  resolving to more than three declarations abstains. Plain prose, member calls
  such as `items.push(...)`, and task notifications provide no independent gate.
  Segment matches and unverified prose words do not trigger a note.
- **Grep/search:** require at least one verified identifier in the search pattern,
  at most 60 returned hits in at most five files. Inspect the first 12 hits,
  prepend exact definitions, then enclosing symbols and up to three production
  callers. A file-name-only result can identify a verified definition. Single-file
  `line:content` results use the tool's explicit path. Bash accepts only a simple
  search command's pattern; compound commands and pipelines abstain.
- **Edit:** match base-side diff ranges to an enclosing indexed symbol, and send
  its other production callers to check. At most five files and 20 hunks per file;
  no note without a production caller. Multi-symbol hunks or locations that no
  longer enclose a complete hunk can abstain. Existing knowledge diff handling
  and Stop/settle rules remain unchanged.
- **Read:** no graph injection. The offline candidate required a range of at most
  200 lines inside one symbol and listed callers. It added no useful notes.
- **Caps:** 1,200 graph characters per event, three primary symbols, three callers
  per symbol, at most 12 named node ids. One-line declarations are omitted. Graph
  lines are atomic; an oversized note is dropped. Knowledge and graph together
  remain under 4,000 event characters. Graph fits only in the remaining 12,000
  character session budget; it never displaces knowledge or becomes a pointer.
- **Memory/ablation:** every named graph node gets a `graph:<id>` session key,
  including callers. Undelivered nodes are not remembered. `MEX_HOOK_GRAPH=0`
  disables graph notes while retaining knowledge. Delivered graph notes log
  `kind: "graph"`, `graphNodes`, and `graphChars` separately from knowledge ids;
  `chars` remains the complete packet length. Existing event logs count silence.

### Replay method and limits

`scripts/context-graph-replay.mjs` calls the production event and graph composers,
not a second implementation. It copies each cache's database and context index
before opening them, joins transcript tool uses/results, and replays all 18 prompts,
61 Reads, 48 Greps, 70 Bash calls and 11 Edit/Write calls. All explicit edits had
structured patch ranges or an original file from which to recover their ranges.
Shell edits without transcript diff ranges are not synthesized. The source
checkouts, cache inputs and indexes are never maintained. No API, model or paid
sessions are used.

Existing arms retain their observed prompt knowledge gates, including semantic
abstentions, from the pilot logs. The files arm gets a lexical counterfactual
knowledge gate, using the harness's actual prompt builder (including JSON and
concise-answer suffixes). Tool knowledge uses the real composer on each copied base graph.
This preserves the base snapshot, not an exact replay of later graph refreshes;
source positions after repeated edits can differ. The pilot never triggered settle.

A useful note names an unopened gold file/symbol **or verified definition location**
that appears in a later Read/search. Read ranges determine whether a symbol was
opened; reading another part of the same file does not open every symbol. Noise
has neither a gold target nor any later use. The remaining notes are neutral
(often a gold target already read). The detailed JSON records both gold usefulness
and definition usefulness, node locations, opened status and the first later use.
`Lead` is the largest number of intervening tool calls for one eligible target in
a session. It is a navigation opportunity, not measured causal turns saved; leads
are not summed because their intervals overlap. Same-tool hits do not count as a
future use.

The wider 60-hit/five-file gate recovered useful notes without adding noise versus
30/three or 10/two. Callable-only prompt hints and excluding one-line declarations
removed option-property and enum-member noise. Bare member calls were rejected:
`items.push(...)` otherwise resolved to an unrelated indexed `push` function.
The Read candidate added only neutral/noise output, so silence remains the default.
All tuning used these same sessions; this is development evidence, not a held-out
quality estimate.

| Task | Arm | Useful | Noise | Neutral | Graph chars | Total chars | Lead |
|---|---|---:|---:|---:|---:|---:|---:|
| error-convention | files | 0 | 0 | 0 | 0 | 1035 | 0 |
| error-convention | mex-r2w | 0 | 0 | 1 | 387 | 2461 | 0 |
| error-convention | mex-r3 | 0 | 0 | 0 | 0 | 1192 | 0 |
| lambda-edge-binary | files | 1 | 0 | 0 | 360 | 2346 | 2 |
| lambda-edge-binary | mex-r2w | 1 | 0 | 0 | 308 | 2404 | 1 |
| lambda-edge-binary | mex-r3 | 2 | 0 | 0 | 332 | 1481 | 1 |
| ts-evolving-array-type | files | 1 | 0 | 0 | 438 | 5491 | 1 |
| ts-evolving-array-type | mex-r2w | 2 | 0 | 0 | 1170 | 6194 | 3 |
| ts-evolving-array-type | mex-r3 | 2 | 0 | 0 | 741 | 6755 | 3 |
| ts-change-refproj-default-import | files | 3 | 0 | 0 | 1694 | 2829 | 21 |
| ts-change-refproj-default-import | mex-r2w | 3 | 0 | 1 | 1995 | 3989 | 3 |
| ts-change-refproj-default-import | mex-r3 | 1 | 1 | 1 | 1138 | 1898 | 2 |
| dj-view-exception-to-response | files | 2 | 0 | 0 | 551 | 2503 | 2 |
| dj-view-exception-to-response | mex-r2w | 2 | 0 | 0 | 663 | 3026 | 1 |
| dj-view-exception-to-response | mex-r3 | 1 | 0 | 0 | 378 | 3770 | 0 |
| dj-change-exclude-in-none | files | 0 | 1 | 0 | 92 | 1017 | 0 |
| dj-change-exclude-in-none | mex-r2w | 0 | 0 | 1 | 269 | 1194 | 0 |
| dj-change-exclude-in-none | mex-r3 | 0 | 0 | 1 | 269 | 269 | 0 |

TypeScript freshness investigation: both task caches use scaffold commit
`125ebae0970d`, whose source history is based at `968d5deb8b5`. Task bases are
`b465fdbfe175` (question) and `114327939c93` (change). The former has 106 fresh,
22 changed and eight missing facts; the latter has 110 fresh, 19 changed and seven
missing, before the agent edits anything. These are actual stored-versus-current
body-hash mismatches, not commit-id inequality or a cached health verdict. For
example, `bindInStrictMode` changed from `getStrictOptionValue(opts, "alwaysStrict")`
to `getAlwaysStrict(opts)` between scaffold source and task base; its grounding
hash is `c7e7a558...` while the question graph records `e186e67d...`. The old prose
still names the old helper. The label is correct; no product freshness change or
automatic regrounding is warranted.

Across the selected replay: **21 useful, two noise, five neutral**, 10,785 graph
characters. Eighteen useful notes reach gold targets; three reach other verified
definitions later used. Files: 7 useful / 1 noise / 3,135 graph chars; lexical:
8 / 0 / 4,792; semantic: 6 / 1 / 2,858. The 30-hit/three-file cap gives
14 useful / 2 noise / 8,201 chars; 10-hit/two-file gives 10 / 2 / 5,701.
Enabling the Read candidate gives 21 useful / 3 noise / 15 neutral / 13,379 chars:
zero additional useful notes, 2,594 additional characters. The two remaining
noise notes concern an emit-format helper (semantic bug-fix session) and a class
definition from a Django search (files session). Caller trails are structural,
not proof that a caller needs changing.

### Latency and verification

An isolated warm full-runner replay (one warmup then three timed invocations per
Read/Grep payload, copied graph/index, no session dedup) measured:

| Path | Samples | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|
| Read runner | 183 | 12.3 | 17.1 | 20.5 |
| Grep runner | 144 | 12.9 | 62.6 | 84.0 |
| Read composer | 61 | 1.0 | 2.8 | 4.7 |
| Grep composer | 48 | 2.2 | 42.7 | 57.2 |

Runner timing includes index load, graph open, selection and bounded log writes;
process startup is excluded. A preliminary run concurrent with typecheck had
scheduling outliers up to 1.7 seconds, including Read where graph injection is
disabled; it is retained in scratch evidence and is not used as the warm budget
estimate. Repeat with `--warm-latency --label isolated` on an otherwise idle machine.

The context suite passes 164 tests. Typecheck passes. The normal build command is
blocked in this checkout by sandbox ancestor-directory traversal in the config
bundler; the same source/configuration builds in an isolated scratch copy with
local workspace-package links. Git staging is blocked by `.git/index.lock`
permissions, so implementation, tests and evidence remain uncommitted. No push.

Final checks also passed 14 rebuilt-entry, graph-delivery and budget tests after
copying the successful scratch build into ignored `dist/`; emitted public
`index.d.ts` is byte-for-byte unchanged. `MEX_HOOK_GRAPH=0` replay sends zero
graph notes/chars while retaining 39,043 knowledge characters over the sessions.
