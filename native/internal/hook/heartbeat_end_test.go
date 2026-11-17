package hook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionEndMarksTheHeartbeatAndARestartClearsIt(t *testing.T) {
	h := home{mex: t.TempDir()}
	now := time.Now()
	read := func() heartbeatFile {
		data, err := os.ReadFile(filepath.Join(h.heartbeatDir("claude-code"), "s1"))
		if err != nil {
			t.Fatal(err)
		}
		var b heartbeatFile
		if err := json.Unmarshal(data, &b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	h.beat("claude-code", "s1", "/repo", true, now)
	h.beat("claude-code", "s1", "/repo", false, now.Add(time.Second))
	if read().Ended != "" {
		t.Fatal("a running session is marked ended")
	}
	h.endBeat("claude-code", "s1", now.Add(2*time.Second))
	if read().Ended == "" {
		t.Fatal("SessionEnd did not mark the session ended")
	}
	// The file stays: a resumed session keeps its once-per-session state.
	h.beat("claude-code", "s1", "/repo", true, now.Add(time.Minute))
	if b := read(); b.Ended != "" || b.SessionID != "s1" {
		t.Fatalf("a resumed session is still marked ended: %+v", b)
	}
}
