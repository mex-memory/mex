// Package delivery owns context admission. Its first stage is silent: moments
// supply gated candidates later; lifecycle calls already own durable epochs.
package delivery

import (
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
)

type Environment struct {
	Home, RecordDirectory string
	Now                   time.Time
	KeepSession           func(agent, sessionID string) bool
}

// EpochBudget uses conservative window anchors. An absent or unknown model
// gets the 200k default; an explicit 1m model variant gets the larger anchor.
// Keep model/window selection isolated for future profile capability tables.
func EpochBudget(model string, subagent bool) int {
	if subagent {
		return 600
	}
	if strings.Contains(strings.ToLower(model), "[1m]") {
		return 3000
	}
	return 2000
}

// Handle must be called after checkout, consent and pause resolution. Events
// with no implemented moment return before any file read or SQLite open.
func Handle(ev contract.Event, env Environment) (contract.Reply, error) {
	req := record.DeliveryRequest{Session: record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}, AgentID: ev.AgentID, Now: env.Now, Budget: EpochBudget(ev.Model, ev.AgentID != "")}
	req.KeepSession = env.KeepSession
	if ev.Model == "" && ev.AgentID == "" {
		req.Budget = 0
	} // Preserve the known window across signals without model metadata.
	switch ev.Kind {
	case contract.SessionStart:
		switch ev.Source {
		case "", "startup":
			req.Reason = "startup"
		case "resume", "clear", "compact", "fork":
			req.Reason = ev.Source
		default:
			return contract.Reply{}, nil
		}
		if req.Reason == "compact" {
			req.CompactSignal = 1
		}
	case contract.PostCompact:
		req.Reason = "compact"
		req.CompactSignal = 2
	case contract.SubagentStart:
		if ev.AgentID == "" {
			return contract.Reply{}, nil
		}
		req.Reason = "subagent"
	default:
		return contract.Reply{}, nil
	}
	if ev.ProjectID == "" || ev.Checkout == "" || ev.SessionID == "" || env.RecordDirectory == "" {
		return contract.Reply{}, nil
	}
	for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
		if !safefile.Regular(filepath.Join(env.RecordDirectory, name)) {
			return contract.Reply{}, errors.New("redirected hooks database")
		}
	}
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: filepath.Join(env.RecordDirectory, "hooks.db")})
	if err != nil {
		return contract.Reply{}, err
	}
	defer h.Close()
	_, err = h.CheckAndMark(req)
	return contract.Reply{}, err
}
