package hook

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func TestCompactTopicNudgeIsPersonOnlyAndOncePerContext(t *testing.T) {
	for _, test := range []struct {
		agent, transcript, count, boundary, command string
	}{
		{
			"claude-code", ".claude/projects/project/nudge.jsonl",
			`{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":40000,"cache_read_input_tokens":200000,"cache_creation_input_tokens":30000}}}`,
			`{"type":"system","subtype":"compact_boundary"}`, "/clear",
		},
		{
			"codex", ".codex/sessions/rollout-test-nudge.jsonl",
			`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":270000,"cached_input_tokens":200000},"total_token_usage":{"input_tokens":1000000}}}}`,
			`{"type":"compacted","payload":{}}`, "/new",
		},
	} {
		t.Run(test.agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			prepareStore(t, h)
			path := filepath.Join(h.user, filepath.FromSlash(test.transcript))
			write(t, path, test.count+"\n")
			send := func(event, text string) map[string]json.RawMessage {
				t.Helper()
				raw, err := json.Marshal(map[string]string{
					"hook_event_name": event, "session_id": "nudge", "cwd": root, "prompt": text,
					"transcript_path": path, "source": "startup", "trigger": "auto",
				})
				if err != nil {
					t.Fatal(err)
				}
				code, output := run(t, []string{test.agent, event}, bytes.NewReader(raw), env)
				var reply map[string]json.RawMessage
				if code != 0 || json.Unmarshal([]byte(output), &reply) != nil {
					t.Fatalf("bad hook response: %d %q", code, output)
				}
				return reply
			}
			send("SessionStart", "")
			for _, prompt := range []string{"Fix registry migration schema validation.", "Tighten registry schema validation rules."} {
				if got := send("UserPromptSubmit", prompt); got["systemMessage"] != nil {
					t.Fatalf("unexpected notice for related work: %s", got["systemMessage"])
				}
			}
			got := send("UserPromptSubmit", "Design keyboard navigation for toolbar menus.")
			person := string(got["systemMessage"])
			if !strings.Contains(person, "270k") || !strings.Contains(person, test.command) || !strings.Contains(person, "/compact") ||
				strings.Contains(string(got["hookSpecificOutput"]), "Starting a new topic") {
				t.Fatalf("expected a person-only compaction nudge: %v", got)
			}
			if got := send("UserPromptSubmit", "Investigate billing receipt currency rounding."); got["systemMessage"] != nil {
				t.Fatalf("nudge repeated in one context: %s", got["systemMessage"])
			}
			write(t, path, test.count+"\n"+test.boundary+"\n")
			send("PostCompact", "")
			if got := send("UserPromptSubmit", "Document worker queue scheduling behavior."); got["systemMessage"] != nil {
				t.Fatalf("nudge used the stale pre-compaction count: %s", got["systemMessage"])
			}
			write(t, path, test.count+"\n"+test.boundary+"\n"+test.count+"\n")
			if got := send("UserPromptSubmit", "Polish printer calibration reference charts."); !strings.Contains(string(got["systemMessage"]), "270k") {
				t.Fatalf("nudge did not reset on compaction: %s", got["systemMessage"])
			}
		})
	}
}

func TestContextCountStaysWithinTheCurrentHostSession(t *testing.T) {
	root := t.TempDir()
	const usage = `{"type":"assistant","message":{"usage":{"input_tokens":350000}}}` + "\n"
	ev := contract.Event{Agent: "claude-code", SessionID: "valid", Transcript: filepath.Join(root, "other.jsonl")}
	write(t, ev.Transcript, usage)
	if got := currentContext(root, ev); got != 0 {
		t.Fatalf("read another session's context: %d", got)
	}
	ev.Transcript = filepath.Join(t.TempDir(), "valid.jsonl")
	write(t, ev.Transcript, usage)
	if got := currentContext(root, ev); got != 0 {
		t.Fatalf("read context outside the host's directory: %d", got)
	}
}
