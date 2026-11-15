Every payload here is hand-written from the Cursor hooks reference (https://cursor.com/docs/agent/hooks), read on
15 Nov 2026. None is recorded yet: release-03-T1 records real sessions into
`payloads/<agent-version>/*-recorded*.json`. `*.event.json` are the expected
normalized events; regenerate with `go test ./internal/adapter/cursor -update`.
