---
name: mex-inbox
description: >-
  Draft and review contributions to existing MEX project knowledge in the repo wiki.
  Use when the user wants to capture a team decision, convention, or architecture
  note, propose an addition or correction for team review, or invokes /mex-inbox
  or $mex-inbox. Also supports existing Spec proposals. Keywords: mex, project
  memory, CLAUDE.md, team memory, drift, inbox. Do not activate for brainstorming
  alone, routine GROW upkeep, email inboxes, session logs, or handoffs.
---

# MEX Inbox

Turn an explicit request to retain project knowledge into a focused contribution for review. Inbox proposals are review artifacts; accepted knowledge belongs in the existing Wiki Markdown. Ordinary GROW upkeep can continue directly.

## Keep the scope honest

- Create one `knowledge.create` or `knowledge.update` change per draft, for an existing kind: `architecture`, `component`, `convention`, `decision`, `pattern`, or `guide`.
- Existing Spec workflows also support `spec.create` and `spec.update` for `spec`, `requirement`, `constraint`, and `acceptance_criterion`. Choose these only for actual Spec-family intent.
- Capture durable conclusions, their rationale, and useful evidence. Do not dump the conversation or present unresolved ideas as agreed facts.
- Do not route session logs, Relays, or routine GROW edits through Inbox merely because they contain context.

## Prepare a draft

1. Distill what future agents or teammates need to know from the user's request and discussion.
2. Search existing knowledge first. Prefer correcting or extending the relevant record or section when it already covers the subject; create a new entry when the claim has no suitable home.
3. Read the exact target and current revisions before drafting a correction. Preserve unrelated knowledge when replacing its body. Never guess an ID or revision.
4. Preserve useful files, code, commits, entities, and external links as evidence only when actually available. Never invent provenance, authors, dates, events, or history.
5. Build one request against the action-scoped runtime contract.
6. Run the exact preview flow and summarize the human effect before technical details.
7. When the user already asked to create, save, or draft it, apply that exact successful checkout-local draft preview without asking again.
8. Return `/inbox?view=drafts&draft=<id>` and state that the draft is checkout-local, nothing was published or shared, and review or publication happens in Hub.

Read [references/cli-workflows.md](references/cli-workflows.md) before executing any Inbox mutation. Load only the operation being performed.

## Apply the approval policy

- Proceed with read-only list, show, and target resolution.
- Treat an explicit create/save/draft request as authorization only for the local draft preview and exact apply.
- Preview a local draft deletion, explain that the checkout-local draft will be removed, and obtain fresh confirmation before applying.
- For publish, approve, reject, withdraw, mark stale, or repair: create a semantic preview, explain the local-versus-Git-tracked effect, and wait for fresh explicit confirmation. Apply the exact preview unchanged only after confirmation.
- Keep Git commit, push, pull, and staging separate from every MEX authorization.
- Never approve or publish merely because this skill activated.

## Report effects precisely

- Lead with what the proposal means to a person. Do not expose envelopes, hashes, revision machinery, or raw diffs unless diagnosis requires them.
- After a local draft write, say exactly what changed and that it remains checkout-only.
- After a canonical write, say which Git-tracked MEX artifacts were written to the working tree and that commit/push is still required to share them. Never claim that MEX committed or pushed.
- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.
