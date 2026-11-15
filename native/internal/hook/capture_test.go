package hook

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func promptPayload(session, cwd, text string) *bytes.Reader {
	b, _ := json.Marshal(map[string]any{"session_id": session, "hook_event_name": "UserPromptSubmit", "cwd": cwd, "prompt": text})
	return bytes.NewReader(b)
}

func journalOf(t *testing.T, h home, session string) []localrecord.JournalEntry {
	t.Helper()
	hooks, err := localrecord.OpenHooks(localrecord.Location{Directory: h.mex, Hooks: filepath.Join(h.mex, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	rows, err := hooks.JournalRows(session, 100)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

// The prompt hook saves typed text before the reply starts. A person who
// interrupts the reply, or closes the terminal mid-reply, sends no Stop and no
// SessionEnd: what they typed is already saved.
func TestInterruptsAndClosedTerminalsLoseNothing(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			run(t, []string{agent, "UserPromptSubmit"}, promptPayload("s1", root, "stop using the old parser"), env)
			// Interrupted: no Stop, no SessionEnd. The next prompt in the same
			// session says what changed.
			run(t, []string{agent, "UserPromptSubmit"}, promptPayload("s1", root, "no, not that one"), env)
			// Terminal closed mid-reply, then a new session starts.
			run(t, []string{agent, "SessionStart"}, strings.NewReader(sessionStart(root)), env)
			rows := journalOf(t, h, "s1")
			if len(rows) != 2 || rows[0].Text != "stop using the old parser" || rows[1].Text != "no, not that one" || rows[0].Kind != "typed" {
				t.Fatalf("%+v", rows)
			}
		})
	}
}

func TestCommandsAndExitCodesOnly(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	fail, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "PostToolUseFailure", "cwd": root, "tool_name": "Bash", "tool_input": map[string]any{"command": "npm test"}, "error": "Exit code 1\nFAIL private output"})
	pass, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Bash", "tool_input": map[string]any{"command": "npm test -- --runInBand"}, "tool_response": map[string]any{"stdout": "private output", "stderr": ""}})
	write, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Write", "tool_input": map[string]any{"file_path": filepath.Join(root, "a.txt"), "content": "file body"}, "tool_response": map[string]any{}})
	run(t, []string{"claude-code", "PostToolUseFailure"}, bytes.NewReader(fail), env)
	run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(write), env)
	run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(pass), env)
	rows := journalOf(t, h, "s1")
	if len(rows) != 2 || rows[0].Text != "npm test" || *rows[0].ExitCode != 1 || rows[1].Text != "npm test -- --runInBand" || *rows[1].ExitCode != 0 {
		t.Fatalf("%+v", rows)
	}
	for _, r := range rows {
		if strings.Contains(r.Text, "private") || strings.Contains(r.Text, "body") {
			t.Fatal("output or contents saved")
		}
	}
}

func TestCaptureOffSavesNothing(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	write(t, filepath.Join(h.mex, "hook-capture", projectID+".json"), `{"version":1,"enabled":false}`)
	run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("s1", root, "hello"), env)
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if rows := journalOf(t, h, "s1"); len(rows) != 0 {
		t.Fatalf("%+v", rows)
	}
}

func TestTypedNoteSavesAtOnceWithoutAI(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	var got []string
	saved := runNote
	runNote = func(_ home, checkout, text string) noteResult {
		got = append(got, checkout+"|"+text)
		return noteResult{OK: true, ID: "mx_abc123def"}
	}
	defer func() { runNote = saved }()
	for _, agent := range []string{"claude-code", "codex"} {
		_, out := run(t, []string{agent, "UserPromptSubmit"}, promptPayload("s-"+agent, root, "mex note: integration tests need Docker running"), env)
		if !strings.Contains(out, `"decision":"block"`) || !strings.Contains(out, "mx_abc123def") {
			t.Fatalf("%s: %s", agent, out)
		}
		// The note isn't also journaled for the filter.
		if rows := journalOf(t, h, "s-"+agent); len(rows) != 0 {
			t.Fatalf("%+v", rows)
		}
	}
	real, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != real+"|integration tests need Docker running" {
		t.Fatal(got)
	}
	// A secret never reaches the note writer.
	_, out := run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("s3", root, "mex note: the api_key=abcdefgh12345678 works"), env)
	if !strings.Contains(out, "secret") || len(got) != 2 {
		t.Fatalf("%s %v", out, got)
	}
	// An ordinary prompt mentioning notes goes on to the agent.
	_, out = run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("s4", root, "what does mex note: do?"), env)
	if strings.Contains(out, `"decision":"block"`) {
		t.Fatal(out)
	}
}
