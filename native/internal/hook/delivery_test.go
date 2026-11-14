package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

// A read of a file with a pitfall, through the whole hook: checkout mirror,
// light snapshot, ledger and the Claude Code reply format. Then the same read
// with a broken ledger gives the agent's empty reply, never an error.
func TestDeliveryThroughTheHook(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	learned := filepath.Join(root, ".mex", "learned")
	os.MkdirAll(learned, 0o700)
	entry := "---\nmex:\n  id: mx_hookpf\n  kind: pitfall\n  scope:\n    - \"src/**\"\n  source:\n    type: docs\n    ref: CONTRIBUTING.md\n  evidence: docs\n  one_line: \"The src folder is formatted on commit.\"\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nThe src folder is formatted on commit, so keep diffs small.\n"
	p := filepath.Join(learned, "mx_hookpf.md")
	os.WriteFile(p, []byte(entry), 0o600)
	past := time.Now().Add(-5 * time.Second)
	os.Chtimes(p, past, past)
	file := filepath.Join(root, "src", "a.ts")
	os.MkdirAll(filepath.Dir(file), 0o700)
	os.WriteFile(file, []byte("a"), 0o600)
	batch := func(session string) []byte {
		b, _ := json.Marshal(map[string]any{"session_id": session, "cwd": root, "hook_event_name": "PostToolBatch", "tool_calls": []any{map[string]any{"tool_name": "Read", "tool_input": map[string]any{"file_path": file}, "tool_use_id": "1", "tool_response": "1\ta"}}})
		return b
	}
	_, out := run(t, []string{"claude-code", "PostToolBatch"}, bytes.NewReader(batch("s1")), env)
	if !strings.Contains(out, "formatted on commit") || !strings.Contains(out, `"additionalContext":"[mex `) {
		t.Fatalf("no delivery: %s", out)
	}
	_, out = run(t, []string{"claude-code", "PostToolBatch"}, bytes.NewReader(batch("s1")), env)
	assertEmptyReply(t, 0, out)
	os.Remove(filepath.Join(h.mex, "hooks.db-wal"))
	os.Remove(filepath.Join(h.mex, "hooks.db-shm"))
	os.WriteFile(filepath.Join(h.mex, "hooks.db"), bytes.Repeat([]byte("x"), 4096), 0o600)
	code, out := run(t, []string{"claude-code", "PostToolBatch"}, bytes.NewReader(batch("s2")), env)
	assertEmptyReply(t, code, out)
}
