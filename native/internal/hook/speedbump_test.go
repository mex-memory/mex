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

// The demo through the real entry point: Claude Code types `import moment`
// in a repo whose note says date-fns; the edit stops once, with the reason.
func TestSpeedBumpThroughTheHook(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	learned := filepath.Join(root, ".mex", "learned")
	if err := os.MkdirAll(learned, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := "---\nmex:\n  id: mx_dates1\n  kind: rule\n  scope:\n    - \"apps/api/**\"\n  source:\n    type: docs\n    ref: CONTRIBUTING.md\n  evidence: docs\n  one_line: \"Dates in the API: date-fns, not moment.js.\"\n  when:\n    - {type: anti, match: literal, pattern: \"from 'moment'\"}\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nThe API uses date-fns for dates, not moment.js, because moment is no longer maintained.\n"
	p := filepath.Join(learned, "mx_dates1.md")
	if err := os.WriteFile(p, []byte(entry), 0o600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-5 * time.Second)
	_ = os.Chtimes(p, past, past)
	file := filepath.Join(root, "apps", "api", "dates.ts")
	write(t, file, "export {}\n")
	pre := func(session string) []byte {
		b, _ := json.Marshal(map[string]any{"session_id": session, "cwd": root, "hook_event_name": "PreToolUse", "tool_name": "Edit",
			"tool_input": map[string]any{"file_path": file, "old_string": "export {}", "new_string": "import m from 'moment'\nexport {}"}})
		return b
	}

	_, out := run(t, []string{"claude-code", "PreToolUse"}, bytes.NewReader(pre("s1")), env)
	r := parseClaude(t, out)
	if r.HookSpecificOutput.PermissionDecision != "deny" || !strings.Contains(r.HookSpecificOutput.PermissionDecisionReason, "date-fns") {
		t.Fatalf("not stopped: %s", out)
	}
	_, out = run(t, []string{"claude-code", "PreToolUse"}, bytes.NewReader(pre("s1")), env)
	if strings.Contains(out, `"deny"`) {
		t.Fatalf("stopped twice: %s", out)
	}

	// MEX_SPEED_BUMP=0 turns it off; MEX_RAW=1 too.
	for _, off := range []map[string]string{{"MEX_SPEED_BUMP": "0"}, {"MEX_RAW": "1"}} {
		_, out = run(t, []string{"claude-code", "PreToolUse"}, bytes.NewReader(pre("s-off")), withEnv(env, off))
		if strings.Contains(out, `"deny"`) {
			t.Fatalf("%v: %s", off, out)
		}
	}
}
