package hook

import (
	"crypto/sha256"
	"encoding/binary"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
)

func ledgerHoldoutCandidate(trial, agent, session string) bool {
	sum := sha256.Sum256([]byte(trial + "\x00" + agent + "\x00" + session))
	return binary.BigEndian.Uint64(sum[:8])%10 == 0
}

func safeLedgerDatabase(directory string) bool {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if !safeTelemetryFile(filepath.Join(directory, "hooks.db"+suffix)) {
			return false
		}
	}
	return true
}

func ledgerHoldout(ev contract.Event, h home, directory, trial string, canEnroll bool, now time.Time) bool {
	if trial == "" || ev.SessionID == "" || len(ev.SessionID) > 256 || (ev.Agent != "codex" && ev.Agent != "claude-code") {
		return false
	}
	candidate := ledgerHoldoutCandidate(trial, ev.Agent, ev.SessionID)
	start := canEnroll && ev.Kind == contract.SessionStart && ev.Source == "startup" && ev.AgentID == "" && !capture.Scripted(ev.Agent, h.env)
	if !candidate && !start {
		return false
	}
	if !safeLedgerDatabase(directory) {
		return candidate
	}
	if start {
		hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
		if err == nil {
			s := hookSession(ev)
			s.StartedAt = now.UTC().Format(time.RFC3339Nano)
			s.LastSeenAt = s.StartedAt
			held, err := hooks.EnrollLedgerTrial(s, trial, candidate)
			hooks.Close()
			if err == nil {
				return held
			}
		}
	}
	held, err := localrecord.ReadLedgerHoldout(filepath.Join(directory, "hooks.db"), ev.SessionID, ev.Agent, trial)
	// A failed read for a candidate cannot safely rule out an assignment.
	return held || err != nil && candidate
}

func recordLedgerContext(ev contract.Event, h home, directory string, now time.Time, context string, first bool) {
	if ev.AgentID != "" || capture.Scripted(ev.Agent, h.env) || (ev.Agent != "codex" && ev.Agent != "claude-code") ||
		!safeLedgerDatabase(directory) {
		return
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return
	}
	defer hooks.Close()
	tokens := 0
	if context != "" {
		tokens = entries.EstimateTokens(contract.EnsureMarked(context))
	}
	_ = hooks.RecordLedgerContext(hookSession(ev), now, tokens, first)
}
