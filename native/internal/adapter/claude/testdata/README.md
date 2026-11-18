Payloads in `payloads/` follow the examples in the Claude Code hooks reference (12 Nov 2026).
Files named `<Event>[-variant].json`. `*.event.json` next to them are the expected
normalized events; regenerate with `go test ./internal/adapter/claude -update`.

To record real payloads, run a session with `MEX_HOOK_RECORD=<dir>` set for the
hook and copy the files from `<dir>/claude-code/` into a folder named after the
Claude Code version.
