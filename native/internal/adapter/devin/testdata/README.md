Hand-written in Claude Code's hook shape, which the Devin hooks docs (checked
15 Nov 2026) describe; none are recorded yet. Devin's own tool names are not
documented: the live test records real payloads into
`payloads/<devin version>/` with `MEX_HOOK_RECORD=<dir>`.
Regenerate `*.event.json` with `go test ./internal/adapter/devin -update`.
