---
name: agents
description: Always-loaded project anchor. Read this first. Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.
last_updated: "2026-10-08"
---

# mex

## What This Is
A local-first TypeScript CLI and browser Hub that turns repository code and agent knowledge into a tracked Wiki backed by disposable Graph and Wiki indexes.

## Non-Negotiables
- Tracked Markdown is canonical; never commit `.mex/graph.db*`, `.mex/wiki.db*`, or `.mex/local/`.
- Ordinary reads never repair, migrate, or initialize state; mutations and maintenance must be explicit.
- Keep the package-root API limited to intentional exports from `src/index.ts`.
- Never weaken containment, freshness, privacy, or bounded-work checks to make a test pass.
- MEX may create a local setup commit only after the user reviews the exact setup-file diff and explicitly chooses the Hub commit action. Preserve unrelated staged work. MEX never pushes or pulls.

## Commands
- Dev: `npm run dev`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`

Use the smallest relevant structured resolver. For Inbox or Relay mutations, resolve only the intended action with `mex inbox contract --action <command-id> --json` or `mex relay contract --action <command-id> --json`; use `mex capabilities --json` only for broader capability discovery. If the user explicitly asks to create, save, or draft a checkout-local Inbox or Relay draft, preview and apply that exact draft without asking for redundant confirmation. Deleting a local draft, or publishing, approving, rejecting, withdrawing, marking stale, repairing, taking or acknowledging, or closing, requires fresh explicit confirmation after semantic preview. Treat Git commit, push, and pull as separate actions requiring their own authorization.

## Code Graph
The repo is indexed into `.mex/graph.db`. Use it as a bounded discovery tool alongside Grep/Glob.
- For an exact symbol, use `mex graph query <who-calls|what-calls|where-defined> <symbol>` and `mex graph get <id>`.
- For an unfamiliar task, start with `mex graph scope "<task>"`; treat its source as already read and inspect its evidence/status before relying on it.
- Scope matches words rather than meaning. If evidence is insufficient, use Grep/Glob instead of repeatedly rephrasing the same scope.
- Before editing a symbol, use `mex impact <symbol|file>` to inspect callers and grounded knowledge.
- Read broad, ground tight: only behavioral claims get exact node fingerprints and useful `mex://<nodeId>` anchors.
- During `mex sync`, adjudicate ambiguous grounding and verify refreshed grounding is emitted.

## Scaffold Growth
Keep section entities connected to their enclosing knowledge with `refines` using existing ids. Preview missing structural links with `mex wiki link-sections`, then apply explicitly. Semantic connections need evidence; shared words or code groundings alone do not prove a dependency.
After meaningful work, run GROW: ground what changed, record state/context updates, orient with a reusable pattern when warranted, and write updated timestamps/rationale. See `ROUTER.md`.

## Navigation
At the start of every session, read `ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.

<!-- mex-agent:skills:start -->
## MEX context policy
- Read `mex logging --json` at session start and before optional logging. Its checkout-local advisory mode is `significant` (quiet default: material decisions, risks, blockers, or durable discoveries), `checkpoints` (batch useful notes at task/session boundaries), or `manual` (no unsolicited notes). Skip routine tool calls, edits, repeated status, and empty summaries. Honor explicit user log requests in every mode; never suppress mandatory workflow Activity or recovery audit records. Report a policy read failure instead of guessing or changing the preference.
- When earlier work may inform the task, retrieve bounded relevant notes with `mex timeline --query "subject phrase" --file src/example.ts --limit 10 --json`, using the known subject or exact recorded file path, or both. Treat matches as historical evidence, not accepted current knowledge; verify conclusions before reuse or explicit promotion with their source retained.
- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.
- Do not claim an author, date, or historical event unless the retrieved data actually provides it.
- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.
- Skill activation is not approval for canonical actions.
<!-- mex-agent:skills:end -->
