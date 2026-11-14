package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
)

func TestDeliveryLifecycleBehindConsentAndStatusUnion(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	_, out := run(t, []string{"claude-code", "SessionStart"}, bytes.NewBufferString(sessionStart(root)), env)
	assertEmptyReply(t, 0, out)
	beats, err := localrecord.HookHeartbeats(localrecord.Location{Hooks: filepath.Join(h.mex, "hooks.db")}, time.Now().Add(-time.Hour))
	if err != nil || len(beats["claude-code"]) != 1 {
		t.Fatal(beats, err)
	}
	var output bytes.Buffer
	status(&output, h, "windows")
	var report statusReport
	if json.Unmarshal(output.Bytes(), &report) != nil {
		t.Fatal(output.String())
	}
	for _, a := range report.Agents {
		if a.Agent == "claude-code" && (a.Sessions != 1 || a.LastHeartbeat == nil) {
			t.Fatal(a)
		}
	}
	// Database-only sessions also show up; the same session's file never doubles it.
	os.Remove(filepath.Join(h.heartbeatDir("claude-code"), "s1"))
	output.Reset()
	status(&output, h, "windows")
	json.Unmarshal(output.Bytes(), &report)
	for _, a := range report.Agents {
		if a.Agent == "claude-code" && a.Sessions != 1 {
			t.Fatal(a)
		}
	}
}
func TestDeliveryNoSQLiteForNoMomentOrOffRepo(t *testing.T) {
	for _, state := range []string{"on", "off"} {
		t.Run(state, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, state, "")
			event := "Stop"
			if state == "off" {
				event = "SessionStart"
			}
			body, _ := json.Marshal(map[string]any{"session_id": "s", "hook_event_name": event, "source": "startup", "cwd": root})
			_, out := run(t, []string{"claude-code", event}, bytes.NewReader(body), env)
			assertEmptyReply(t, 0, out)
			if _, err := os.Stat(filepath.Join(h.mex, "hooks.db")); !os.IsNotExist(err) {
				t.Fatal("no-op opened SQLite")
			}
		})
	}
}
