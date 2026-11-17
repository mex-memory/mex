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

// Compaction end to end through the hook, in each agent's own payloads:
// a pitfall given at a read, its file edited, then the agent's compaction
// signal; the reply carries the recovery block in that agent's format.
func TestCompactionRecoveryThroughTheHook(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			prepareStore(t, h)
			learned := filepath.Join(root, ".mex", "learned")
			os.MkdirAll(learned, 0o700)
			entry := "---\nmex:\n  id: mx_recovr\n  kind: pitfall\n  scope:\n    - \"src/a.ts\"\n  source:\n    type: docs\n    ref: CONTRIBUTING.md\n  evidence: docs\n  one_line: \"a.ts is shared with the worker build.\"\n  checks: []\n  status: active\n  created: 2026-11-03\n---\na.ts is shared with the worker build, so keep it free of Node imports.\n"
			p := filepath.Join(learned, "mx_recovr.md")
			os.WriteFile(p, []byte(entry), 0o600)
			past := time.Now().Add(-5 * time.Second)
			os.Chtimes(p, past, past)
			file := filepath.Join(root, "src", "a.ts")
			os.MkdirAll(filepath.Dir(file), 0o700)
			os.WriteFile(file, []byte("a"), 0o600)
			send := func(event string, body map[string]any) string {
				body["session_id"], body["cwd"], body["hook_event_name"] = "life", root, event
				if agent == "codex" {
					body["turn_id"] = "t1"
				}
				raw, _ := json.Marshal(body)
				_, out := run(t, []string{agent, event}, bytes.NewReader(raw), env)
				return out
			}
			send("SessionStart", map[string]any{"source": "startup"})
			if agent == "claude-code" {
				out := send("PostToolBatch", map[string]any{"tool_calls": []any{map[string]any{"tool_name": "Read", "tool_input": map[string]any{"file_path": file}, "tool_use_id": "1", "tool_response": "1\ta"}}})
				if !strings.Contains(out, "worker build") {
					t.Fatalf("no delivery at the read: %s", out)
				}
				send("PostToolBatch", map[string]any{"tool_calls": []any{map[string]any{"tool_name": "Edit", "tool_input": map[string]any{"file_path": file, "old_string": "a", "new_string": "b"}, "tool_use_id": "2", "tool_response": map[string]any{"filePath": file}}}})
				send("PostCompact", map[string]any{"trigger": "auto", "compact_summary": "summary"})
			} else {
				patch := "*** Begin Patch\n*** Update File: " + file + "\n@@\n-a\n+b\n*** End Patch"
				out := send("PostToolUse", map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "cat " + filepath.ToSlash(file)}, "tool_response": "a"})
				if !strings.Contains(out, "worker build") {
					t.Fatalf("no delivery at the shell read: %s", out)
				}
				send("PostToolUse", map[string]any{"tool_name": "apply_patch", "tool_input": map[string]any{"command": patch}, "tool_response": "Success. Updated the following files:\nM " + file})
			}
			out := send("SessionStart", map[string]any{"source": "compact"})
			if !strings.Contains(out, "[mex ") || !strings.Contains(out, "a.ts is shared with the worker build. (mx_recovr)") {
				t.Fatalf("no recovery block: %s", out)
			}
		})
	}
}
