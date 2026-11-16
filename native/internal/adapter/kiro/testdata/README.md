Hand-written from the Kiro CLI agent-hooks reference (checked 15 Nov 2026);
none are recorded yet. `session_id` and the `tool_response` shape are read
when present and are confirmed by the live test. Kiro reads
plain stdout, so reply goldens are text, and empty for "do nothing".
Regenerate `*.event.json` with `go test ./internal/adapter/kiro -update`.
