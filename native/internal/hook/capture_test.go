package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
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
	// The write leaves its path only.
	if len(rows) != 3 || rows[0].Text != "npm test" || *rows[0].ExitCode != 1 || rows[1].Kind != "edit" || rows[1].Text != "a.txt" ||
		rows[2].Text != "npm test -- --runInBand" || *rows[2].ExitCode != 0 {
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

func TestPreCompactWakesFilterAfterSavingRequest(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			real, err := place.RealPath(root)
			if err != nil {
				t.Fatal(err)
			}
			calls := 0
			prior := startBackground
			startBackground = func(_ home, directory string) {
				calls++
				if _, err := os.Stat(filepath.Join(directory, "filter-pending", place.ShortHash(real)+".json")); err != nil {
					t.Errorf("background started before the filter request was saved: %v", err)
				}
			}
			t.Cleanup(func() { startBackground = prior })
			payload, _ := json.Marshal(map[string]any{"session_id": "compact", "hook_event_name": "PreCompact", "cwd": root, "trigger": "auto"})
			run(t, []string{agent, "PreCompact"}, bytes.NewReader(payload), env)
			if calls != 1 {
				t.Fatalf("pre-compaction background starts = %d, want 1", calls)
			}
		})
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

func TestHeldOutTypedNoteSavesAndConsumesPrompt(t *testing.T) {
	const trial = "0123456789abcdef0123456789abcdef"
	const note = "integration tests need Docker running"
	const noteID = "mx_abc123def"
	for _, fixture := range []struct{ agent, session string }{
		{"claude-code", "holdout-note-6"},
		{"codex", "holdout-note-12"},
	} {
		t.Run(fixture.agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			write(t, filepath.Join(h.mex, "controls.json"), `{"version":1,"off":false,"capture":true,"ledger_holdout":"`+trial+`"}`)
			prepareStore(t, h)

			start, _ := json.Marshal(map[string]string{
				"session_id": fixture.session, "cwd": root, "hook_event_name": "SessionStart", "source": "startup",
			})
			code, out := run(t, []string{fixture.agent, "SessionStart"}, bytes.NewReader(start), env)
			assertEmptyReply(t, code, out)
			held, err := localrecord.ReadLedgerHoldout(filepath.Join(h.mex, "hooks.db"), fixture.session, fixture.agent, trial)
			if err != nil || !held {
				t.Fatalf("expected a holdout assignment, got %t (%v)", held, err)
			}

			checkout, err := place.RealPath(root)
			if err != nil {
				t.Fatal(err)
			}
			savedNote := filepath.Join(h.mex, "fixture-notes", noteID)
			prior := runNote
			runNote = func(_ home, path, text string) noteResult {
				if path != checkout {
					t.Fatalf("note checkout = %q, want %q", path, checkout)
				}
				write(t, savedNote, text)
				return noteResult{OK: true, ID: noteID}
			}
			t.Cleanup(func() { runNote = prior })

			code, out = run(t, []string{fixture.agent, "UserPromptSubmit"}, promptPayload(fixture.session, root, "mex note: "+note), env)
			var reply map[string]string
			const confirmation = "Saved personal note " + noteID + ". It stays on this machine; `mex share` offers it to the team."
			if err := json.Unmarshal([]byte(out), &reply); code != 0 || err != nil || len(reply) != 2 ||
				reply["decision"] != "block" || reply["reason"] != confirmation {
				t.Fatalf("note hook exit %d, reply %q, error %v", code, out, err)
			}
			body, err := os.ReadFile(savedNote)
			if err != nil || string(body) != note {
				t.Fatalf("saved note = %q, error %v", body, err)
			}
			if rows := journalOf(t, h, fixture.session); len(rows) != 0 {
				t.Fatalf("consumed command also reached the journal: %+v", rows)
			}
		})
	}
}

// recordedPayload loads an adapter's recorded payload and moves it into root:
// the recorded cwd (in either slash form) becomes root, and the session id is set.
func recordedPayload(t *testing.T, agent, name, session, root string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "adapter", agent, "testdata", "payloads", name))
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]any
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	recorded := p["cwd"].(string)
	// The payloads were recorded on Windows; their slash form is rewritten
	// explicitly, since filepath.ToSlash leaves backslashes alone elsewhere.
	moved := strings.NewReplacer(recorded, root, strings.ReplaceAll(recorded, `\`, "/"), filepath.ToSlash(root))
	input := p["tool_input"].(map[string]any)
	for k, v := range input {
		if s, ok := v.(string); ok {
			input[k] = moved.Replace(s)
		}
	}
	p["cwd"], p["session_id"] = root, session
	return p
}

func send(t *testing.T, env Env, agent, event string, payload map[string]any) {
	t.Helper()
	b, _ := json.Marshal(payload)
	run(t, []string{agent, event}, bytes.NewReader(b), env)
}

// Edits leave one row per changed file: the path relative to the session's
// checkout, never the content. Only the main agent's successful edits count.
func TestEditRowsKeepRepoRelativePathsOnly(t *testing.T) {
	t.Run("claude-code", func(t *testing.T) {
		h, env := fakeHome(t, true)
		root := repo(t, t.TempDir())
		register(t, h, root, projectID, "on", "")
		edit := recordedPayload(t, "claude", "2.1.323/PostToolUse-Edit.json", "s1", root)
		send(t, env, "claude-code", "PostToolUse", edit)
		multi := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "MultiEdit",
			"tool_input": map[string]any{"file_path": "src/util.ts", "edits": []any{map[string]any{"old_string": "a", "new_string": "secret body"}}}, "tool_response": map[string]any{}}
		send(t, env, "claude-code", "PostToolUse", multi)
		write := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Write",
			"tool_input": map[string]any{"file_path": filepath.Join(root, "docs", "a.md"), "content": "secret body"}, "tool_response": map[string]any{}}
		send(t, env, "claude-code", "PostToolUse", write)
		// None of these count: a failed edit, a subagent's edit, a file outside
		// the checkout, and the batch event that repeats per-call edits.
		failed := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUseFailure", "cwd": root, "tool_name": "Edit",
			"tool_input": map[string]any{"file_path": filepath.Join(root, "failed.ts"), "old_string": "x", "new_string": "y"}, "error": "String to replace not found"}
		send(t, env, "claude-code", "PostToolUseFailure", failed)
		sub := recordedPayload(t, "claude", "2.1.323/PostToolUse-Edit.json", "s1", root)
		sub["agent_id"] = "sub-1"
		sub["tool_input"].(map[string]any)["file_path"] = filepath.Join(root, "sub.ts")
		send(t, env, "claude-code", "PostToolUse", sub)
		outside := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Write",
			"tool_input": map[string]any{"file_path": filepath.Join(filepath.Dir(root), "elsewhere.txt"), "content": "x"}, "tool_response": map[string]any{}}
		send(t, env, "claude-code", "PostToolUse", outside)
		batch := map[string]any{"session_id": "s1", "hook_event_name": "PostToolBatch", "cwd": root,
			"tool_calls": []any{map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": filepath.Join(root, "batch.ts"), "content": "x"}, "tool_response": "ok"}}}
		send(t, env, "claude-code", "PostToolBatch", batch)
		assertEdits(t, journalOf(t, h, "s1"), "math.ts", "src/util.ts", "docs/a.md")
	})
	t.Run("codex", func(t *testing.T) {
		h, env := fakeHome(t, true)
		root := repo(t, t.TempDir())
		register(t, h, root, projectID, "on", "")
		send(t, env, "codex", "PostToolUse", recordedPayload(t, "codex", "0.165.0/PostToolUse-apply_patch.json", "s1", root))
		// One patch that adds, moves and deletes files, with a relative path.
		multi := recordedPayload(t, "codex", "0.165.0/PostToolUse-apply_patch.json", "s1", root)
		multi["tool_input"] = map[string]any{"command": "*** Begin Patch\n*** Add File: pkg/new.py\n+print('secret body')\n*** Update File: calc.py\n*** Move to: lib/calc.py\n@@\n-a\n+b\n*** Delete File: old.py\n*** End Patch"}
		send(t, env, "codex", "PostToolUse", multi)
		failed := recordedPayload(t, "codex", "0.165.0/PostToolUse-apply_patch.json", "s1", root)
		failed["tool_input"] = map[string]any{"command": "*** Begin Patch\n*** Update File: broken.py\n@@\n-a\n+b\n*** End Patch"}
		failed["tool_response"] = "Exit code: 1\nWall time: 0.1 seconds\nOutput:\nverification failed\n"
		send(t, env, "codex", "PostToolUse", failed)
		assertEdits(t, journalOf(t, h, "s1"), "calc.py", "pkg/new.py", "calc.py", "lib/calc.py", "old.py")
	})
}

// Fail→pass capture reads the journal only, so a subagent's fail, edit and
// pass must leave no rows at all; the main agent's same sequence leaves three.
func TestSubagentFailPassLeavesNoRows(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	steps := func(session, agent string) {
		fail := map[string]any{"session_id": session, "hook_event_name": "PostToolUseFailure", "cwd": root, "tool_name": "Bash",
			"tool_input": map[string]any{"command": "npm test"}, "error": "Exit code 1\nFAIL"}
		edit := map[string]any{"session_id": session, "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Write",
			"tool_input": map[string]any{"file_path": filepath.Join(root, "src", "a.ts"), "content": "x"}, "tool_response": map[string]any{}}
		pass := map[string]any{"session_id": session, "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Bash",
			"tool_input": map[string]any{"command": "npm test"}, "tool_response": map[string]any{"stdout": "ok", "stderr": ""}}
		for _, p := range []map[string]any{fail, edit, pass} {
			if agent != "" {
				p["agent_id"] = agent
			}
			send(t, env, "claude-code", p["hook_event_name"].(string), p)
		}
	}
	steps("sub", "sub-1")
	if rows := journalOf(t, h, "sub"); len(rows) != 0 {
		t.Fatalf("subagent rows saved: %+v", rows)
	}
	steps("main", "")
	rows := journalOf(t, h, "main")
	if len(rows) != 3 || rows[0].Kind != "command" || *rows[0].ExitCode != 1 || rows[1].Kind != "edit" || rows[1].Text != "src/a.ts" || *rows[2].ExitCode != 0 {
		t.Fatalf("%+v", rows)
	}
}

func assertEdits(t *testing.T, rows []localrecord.JournalEntry, want ...string) {
	t.Helper()
	var got []string
	for _, r := range rows {
		if r.Kind != "edit" || r.ExitCode != nil || strings.Contains(r.Text, "secret") || strings.Contains(r.Text, "subtract") {
			t.Fatalf("unexpected row %+v", r)
		}
		got = append(got, r.Text)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("edit rows %q, want %q", got, want)
	}
}

// Session start keeps what the filter consumed: journal.consumed is a cursor.
func TestSessionStartKeepsConsumedRows(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("s1", root, "use pnpm here"), env)
	rows := journalOf(t, h, "s1")
	if len(rows) != 1 {
		t.Fatalf("%+v", rows)
	}
	db, err := sql.Open("sqlite", filepath.Join(h.mex, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS settings(scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope,key));
		INSERT INTO settings VALUES(?,'journal.consumed',?)`, projectID, rows[0].ID)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if after := journalOf(t, h, "s1"); len(after) != 1 || after[0].ID != rows[0].ID {
		t.Fatalf("consumed row pruned: %+v", after)
	}
}

// A backgrounded Claude command reports success when it starts, so its row
// keeps no exit code: a later pass must not count it.
func TestBackgroundCommandsKeepNoExitCode(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	flag := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Bash",
		"tool_input": map[string]any{"command": "TZ=UTC npm test", "run_in_background": true}, "tool_response": map[string]any{"stdout": "", "stderr": ""}}
	send(t, env, "claude-code", "PostToolUse", flag)
	task := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Bash",
		"tool_input": map[string]any{"command": "npm run build"}, "tool_response": map[string]any{"stdout": "", "stderr": "", "backgroundTaskId": "b1"}}
	send(t, env, "claude-code", "PostToolUse", task)
	done := map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": root, "tool_name": "Bash",
		"tool_input": map[string]any{"command": "npm test", "run_in_background": false}, "tool_response": map[string]any{"stdout": "ok", "stderr": ""}}
	send(t, env, "claude-code", "PostToolUse", done)
	rows := journalOf(t, h, "s1")
	if len(rows) != 3 || rows[0].ExitCode != nil || rows[1].ExitCode != nil || rows[2].ExitCode == nil || *rows[2].ExitCode != 0 {
		t.Fatalf("%+v", rows)
	}
}
