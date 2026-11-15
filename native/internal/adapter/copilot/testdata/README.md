Hand-written from the Copilot CLI hooks reference (checked 15 Nov 2026); none
are recorded yet. Fields the reference doesn't show (`sessionId`, `agentId`,
`agentName`, `transcriptPath`, the `postToolUseFailure` `error` object) are
read when present and are confirmed or corrected by the live test.
Record real payloads with `MEX_HOOK_RECORD=<dir>` into
`payloads/<copilot version>/`.

`*.event.json` are the expected normalized events; regenerate with
`go test ./internal/adapter/copilot -update`.
