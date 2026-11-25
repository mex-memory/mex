package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHookRecordsClaudeParseError(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")

	const event = "PreCompact"
	// A numeric session_id fails decoding into Claude Code's string field.
	payload, err := json.Marshal(map[string]any{
		"hook_event_name": event,
		"session_id":      123,
		"cwd":             root,
	})
	if err != nil {
		t.Fatal(err)
	}
	code, out := run(t, []string{"claude-code", event}, bytes.NewReader(payload), env)
	// Claude Code treats PreCompact stdout as compaction instructions.
	if code != 0 || out != "" {
		t.Fatalf("PreCompact reply = %q with exit code %d, want empty stdout and exit code 0", out, code)
	}

	record := readHookErrorRecord(t, h.mex)
	if record.Counts["parse"] != 1 || len(record.Recent) != 1 {
		t.Fatalf("want one parse error, got counts %v and recent errors %+v", record.Counts, record.Recent)
	}
	if got := record.Recent[0]; got.Agent != "claude-code" || got.Event != event || got.Kind != "parse" {
		t.Fatalf("recent error = %+v, want a claude-code PreCompact parse error", got)
	}
}

func TestHookIgnoresUnknownClaudeEvent(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")

	const event = "UnknownEvent"
	payload, err := json.Marshal(map[string]string{
		"hook_event_name": event,
		"session_id":      "s1",
		"cwd":             root,
	})
	if err != nil {
		t.Fatal(err)
	}
	code, out := run(t, []string{"claude-code", event}, bytes.NewReader(payload), env)
	assertEmptyReply(t, code, out)

	if _, err := os.Stat(filepath.Join(h.mex, "hook-errors.json")); !os.IsNotExist(err) {
		t.Fatalf("want no hook-errors.json for an unknown event, stat error = %v", err)
	}
}

func TestClaudeShowsNewHookErrorsAtSessionStart(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")

	start := func(sessionID string, wantNotice bool) {
		t.Helper()
		payload, err := json.Marshal(map[string]string{
			"hook_event_name": "SessionStart",
			"session_id":      sessionID,
			"cwd":             root,
			"source":          "startup",
		})
		if err != nil {
			t.Fatal(err)
		}
		code, out := run(t, []string{"claude-code", "SessionStart"}, bytes.NewReader(payload), env)
		assertHookErrorNotice(t, code, out, wantNotice)
	}

	noteHookError(h.mex, "claude-code", "Stop", errPanic, "test panic", time.Now().Add(-time.Minute))
	start("first", true)
	start("second", false)

	noteHookError(h.mex, "claude-code", "Stop", errPanic, "another test panic", time.Now())
	start("third", true)
}

func assertHookErrorNotice(t *testing.T, code int, out string, wantNotice bool) {
	t.Helper()
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 (reply %q)", code, out)
	}
	var reply struct {
		SystemMessage string `json:"systemMessage"`
	}
	if err := json.Unmarshal([]byte(out), &reply); err != nil {
		t.Fatalf("decode reply %q: %v", out, err)
	}
	if !wantNotice {
		if strings.Contains(out, " hook error") {
			t.Fatalf("unexpected hook error notice in reply %q", out)
		}
		return
	}
	if !strings.Contains(reply.SystemMessage, "MEX · 1 hook error ") || !strings.Contains(reply.SystemMessage, "`mex doctor`") {
		t.Fatalf("systemMessage = %q, want a notice for one hook error with the mex doctor command", reply.SystemMessage)
	}
}

func readHookErrorRecord(t *testing.T, recordDirectory string) hookErrors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(recordDirectory, "hook-errors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var record hookErrors
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatalf("decode hook-errors.json: %v", err)
	}
	return record
}
