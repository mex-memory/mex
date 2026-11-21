`payloads/*-recorded*.json` were recorded from a real Codex session on Windows.
The rest follow the Codex hooks reference (12 Nov 2026). `*.event.json` are the
expected normalized events; regenerate with `go test ./internal/adapter/codex -update`.
`payloads/0.165.0/rollout-command-items.jsonl` holds the `CommandExecution`
items from the rollout of the session that recorded the 0.165.0 payloads
(command output shortened). Their ids are the hooks' `tool_use_id`s, and they
carry the exit codes the shell payloads lack.
