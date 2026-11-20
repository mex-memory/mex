package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompactionChecksRecordedClaudeHooks(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	prepareStore(t, h)
	const session = "compaction-check"
	send := func(name string, payload map[string]any) string {
		t.Helper()
		payload["hook_event_name"], payload["session_id"], payload["cwd"] = name, session, root
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		code, out := run(t, []string{"claude-code", name}, bytes.NewReader(raw), env)
		if code != 0 {
			t.Fatalf("%s: %d, %s", name, code, out)
		}
		return out
	}
	send("SessionStart", map[string]any{"source": "startup"})
	send("UserPromptSubmit", map[string]any{"prompt": "Keep LegacyWidget compatible with schema version 42."})
	send("UserPromptSubmit", map[string]any{"prompt": "<private>Don't repeat this private sentence.</private>"})
	send("UserPromptSubmit", map[string]any{"prompt": "Finish the registry migration."})
	send("PostToolUseFailure", map[string]any{"tool_name": "Bash", "tool_input": map[string]any{"command": "npm run ABI-check"}, "error": "Exit code 1\nprivate tool output"})
	file := filepath.Join(root, "src", "uncovered.ts")
	write(t, file, "const changed = true")
	send("PostToolBatch", map[string]any{"tool_calls": []any{map[string]any{
		"tool_name": "Edit", "tool_input": map[string]any{"file_path": file}, "tool_response": "File edited",
	}}})
	fixture := func(name string) map[string]any {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join("..", "adapter", "claude", "testdata", "payloads", "2.1.323", name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		delete(body, "transcript_path")
		return body
	}
	post := fixture("PostCompact-auto")
	post["compact_summary"] = "Finish the registry migration."
	assertEmptyReply(t, 0, send("PostCompact", post))
	restart := fixture("SessionStart-compact")
	out := send("SessionStart", restart)
	for _, expected := range []string{"additionalContext", "Keep LegacyWidget compatible", "npm run ABI-check", "src/uncovered.ts"} {
		if !strings.Contains(out, expected) {
			t.Fatalf("recovery lacks %q: %s", expected, out)
		}
	}
	for _, excluded := range []string{"private sentence", "private tool output", "Finish the registry migration"} {
		if strings.Contains(out, excluded) {
			t.Fatalf("recovery repeats or exposes %q: %s", excluded, out)
		}
	}
	assertEmptyReply(t, 0, send("SessionStart", restart))
	db, err := sql.Open("sqlite", filepath.Join(h.mex, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	var detail string
	err = db.QueryRow(`SELECT count(*),max(detail) FROM deliveries
		WHERE session_id=? AND moment='compaction-check' AND action='control' AND tokens=0`, session).Scan(&count, &detail)
	if err != nil || count != 1 || detail != `{"kept":1,"checked":4,"estimated":true}` {
		t.Fatalf("compaction estimate count=%d detail=%q err=%v", count, detail, err)
	}
	scopes, err := os.ReadDir(filepath.Join(h.mex, "compaction-pending"))
	if err != nil || len(scopes) != 0 {
		t.Fatalf("recovered text retained: %v, %v", scopes, err)
	}
}

func TestCompactionRecoversPrunedLastRequest(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	write(t, filepath.Join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
	register(t, h, root, projectID, "on", "")
	prepareStore(t, h)
	const session = "pruned"
	startSession(t, env, root, session, "startup")
	run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload(session, root, "Finish the registry migration."), env)
	rows := journalOf(t, h, session)
	if len(rows) != 1 {
		t.Fatalf("expected one capture row, got %d", len(rows))
	}
	// Retention removed the request row; recovery still has it.
	db, err := sql.Open("sqlite", hooksLocation(h, h.recordDirectory()).Hooks)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`DELETE FROM journal WHERE id <= ?`, rows[0].ID)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"session_id": session, "cwd": root, "hook_event_name": "PostCompact",
		"compact_summary": "The schema was reviewed."})
	code, out := run(t, []string{"claude-code", "PostCompact"}, bytes.NewReader(payload), env)
	assertEmptyReply(t, code, out)
	out = startSession(t, env, root, session, "compact")
	if !strings.Contains(out, "Finish the registry migration.") {
		t.Fatalf("missing last request after journal pruning: %s", out)
	}
}
