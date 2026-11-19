package capture

import (
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// StageLedgerFinish wakes the background after filter metadata has marked the
// transcript finished. The request contains scope and time, no transcript text.
func StageLedgerFinish(ev contract.Event, env Env, trial string) bool {
	if ev.Kind != contract.SessionEnd || ev.AgentID != "" || ev.SessionID == "" || ev.ProjectID == "" ||
		(ev.Agent != "claude-code" && ev.Agent != "codex") || Scripted(ev.Agent, env.Getenv) {
		return false
	}
	key := place.ShortHash(ev.Agent + "\x00" + ev.ProjectID + "\x00" + ev.Checkout + "\x00" + ev.SessionID)
	request := map[string]any{
		"version": 1, "agent": ev.Agent, "project": ev.ProjectID,
		"checkout": ev.Checkout, "session": ev.SessionID, "ended": now(env).UTC().Format(time.RFC3339Nano),
	}
	if trial != "" {
		request["trial"] = trial
	}
	return filterFile(env.RecordDirectory, "ledger-pending", key, request) == nil
}
