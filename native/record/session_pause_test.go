package record

import (
	"errors"
	"testing"
)

func TestSessionPauseRollsBackAndKeepsAgentOwnership(t *testing.T) {
	hooks, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	s := Session{SessionID: "s", Agent: "claude-code", ProjectID: "p", Checkout: "/repo", Paused: true}
	if err := hooks.SetSessionPaused(s, nil); err == nil {
		t.Fatal("nil publisher was accepted")
	}
	var mirrored bool
	if err := hooks.SetSessionPaused(s, func(value bool) error { mirrored = value; return nil }); err != nil {
		t.Fatal(err)
	}
	s.Paused = false
	if err := hooks.SetSessionPaused(s, func(value bool) error {
		mirrored = value
		if !value {
			return errors.New("mirror unavailable")
		}
		return nil
	}); err == nil {
		t.Fatal("failed mirror committed")
	}
	stored, err := hooks.Session("s")
	if err != nil || stored == nil || !stored.Paused || !mirrored {
		t.Fatalf("rollback: %+v mirrored=%t err=%v", stored, mirrored, err)
	}
	s.Agent = "codex"
	if err := hooks.SetSessionPaused(s, func(bool) error { t.Fatal("other agent changed the mirror"); return nil }); err == nil {
		t.Fatal("other agent changed the session")
	}
}
