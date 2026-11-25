package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/record/place"
)

const claudeChoiceInput = `{"questions":[{"header":"Store","question":"Use which stores?","multiSelect":true,"options":[{"label":"SQLite","description":"Keep the index local","preview":"index.db"},{"label":"Postgres","description":"Use the project database"},{"label":"Memory","description":"unused alternative"}]}]}`
const claudeChoiceResult = `{"questions":[{"header":"Store","question":"Use which stores?","multiSelect":true,"options":[{"label":"SQLite","description":"Keep the index local","preview":"index.db"},{"label":"Postgres","description":"Use the project database"},{"label":"Memory","description":"unused alternative"}]}],"answers":{"Use which stores?":"SQLite, Postgres"}}`
const codexChoiceInput = `{"questions":[{"id":"index","header":"Index","question":"Choose an index","options":[{"label":"Keep local (Recommended)","description":"Use a local search index"},{"label":"Remote","description":"Use a remote search index"}]}]}`
const codexChoiceResult = `{"answers":{"index":{"answers":["Keep local (Recommended)"]}}}`

func TestCompletedChoicesStayPrivateAndWeak(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	checkout, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(h.mex, "filter-approvals", place.ShortHash(projectID+"\x00"+checkout))
	controls := filepath.Join(h.mex, "controls.json")
	invoke := func(agent, event, call, tool, input, result, subagent string) {
		t.Helper()
		response := any(json.RawMessage(result))
		if agent == "codex" {
			response = result
		} // Codex sends the function's JSON as a string.
		b, err := json.Marshal(map[string]any{"session_id": "session", "hook_event_name": event, "cwd": root,
			"agent_id": subagent, "tool_use_id": call, "tool_name": tool, "tool_input": json.RawMessage(input), "tool_response": response})
		if err != nil {
			t.Fatal(err)
		}
		if code, _ := run(t, []string{agent, event}, bytes.NewReader(b), env); code != 0 {
			t.Fatal(code)
		}
	}
	read := func(agent, call string) string {
		t.Helper()
		file := filepath.Join(folder, place.ShortHash(strings.Join([]string{projectID, checkout, agent, "session", call}, "\x00"))+".json")
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	invoke("claude-code", "PostToolUse", "disabled", "AskUserQuestion", claudeChoiceInput, claudeChoiceResult, "")
	if _, err := os.Stat(folder); !os.IsNotExist(err) {
		t.Fatal("a choice was captured before consent")
	}
	write(t, controls, `{"version":1,"off":false,"capture":true,"clicked_approvals":true}`)
	invoke("claude-code", "PostToolUse", "question", "AskUserQuestion", claudeChoiceInput, claudeChoiceResult, "")
	invoke("claude-code", "PostToolUse", "plan", "ExitPlanMode", `{"plan":"# Plan\nKeep files local"}`, `{"plan":"# Plan\nKeep files local","isAgent":false,"filePath":"/ignored/path"}`, "")
	invoke("codex", "PostToolUse", "question", "request_user_input", codexChoiceInput, codexChoiceResult, "")
	question := read("claude-code", "question")
	for _, value := range []string{`"question":1,"option":1,"label":"SQLite","text":"Keep the index local","preview":"index.db"`, `"option":2,"label":"Postgres"`,
		`"kind":"approval"`, `"level":"personal"`, `"strength":"weak"`, `"author":"agent"`} {
		if !strings.Contains(question, value) {
			t.Errorf("choice record misses %s: %s", value, question)
		}
	}
	if strings.Contains(question, "unused alternative") || strings.Contains(question, "Use which stores?") {
		t.Fatalf("choice retained the rest of the tool payload: %s", question)
	}
	if plan := read("claude-code", "plan"); !strings.Contains(plan, `# Plan\nKeep files local`) || strings.Contains(plan, "ignored/path") {
		t.Fatal(plan)
	}
	if codex := read("codex", "question"); !strings.Contains(codex, "Keep local (Recommended)") || strings.Contains(codex, "remote search") {
		t.Fatal(codex)
	}
	invoke("claude-code", "PostToolUse", "question", "AskUserQuestion", claudeChoiceInput, strings.Replace(claudeChoiceResult, "SQLite, Postgres", "Memory", 1), "")
	if got := read("claude-code", "question"); got != question {
		t.Fatal("replayed hook changed the original approval")
	}
	invoke("claude-code", "PostToolUseFailure", "rejected", "ExitPlanMode", `{}`, `{"plan":"Declined","isAgent":false}`, "")
	invoke("claude-code", "PostToolUse", "subagent", "AskUserQuestion", claudeChoiceInput, claudeChoiceResult, "child")
	invoke("claude-code", "PostToolUse", "awaiting", "ExitPlanMode", `{}`, `{"plan":"Queued","isAgent":false,"awaitingLeaderApproval":true}`, "")
	invoke("claude-code", "PostToolUse", "secret", "ExitPlanMode", `{}`, `{"plan":"password=fixture-secret-123","isAgent":false}`, "")
	invoke("claude-code", "PostToolUse", "freeform", "AskUserQuestion", claudeChoiceInput, strings.Replace(claudeChoiceResult, `"answers":`, `"response":"Free-form answer","answers":`, 1), "")
	invoke("claude-code", "PostToolUse", "unknown", "AskUserQuestion", claudeChoiceInput, strings.Replace(claudeChoiceResult, "SQLite, Postgres", "SQLite, unknown", 1), "")
	invoke("claude-code", "PostToolUse", "changed", "AskUserQuestion", claudeChoiceInput, strings.Replace(claudeChoiceResult, "Keep the index local", "Do something else", 1), "")
	invoke("codex", "PostToolUse", "freeform", "request_user_input", codexChoiceInput, `{"answers":{"index":{"answers":["Some other option"]}}}`, "")
	invoke("codex", "PostToolUse", "cancelled", "request_user_input", codexChoiceInput, `{"answers":{}}`, "")
	run(t, []string{"claude-code", "UserPromptSubmit"}, promptPayload("session", root, "mex pause"), env)
	invoke("claude-code", "PostToolUse", "paused", "AskUserQuestion", claudeChoiceInput, claudeChoiceResult, "")
	write(t, filepath.Join(h.mex, "hook-capture", projectID+".json"), `{"version":1,"enabled":false}`)
	invoke("codex", "PostToolUse", "capture-off", "request_user_input", codexChoiceInput, codexChoiceResult, "")
	entries, err := os.ReadDir(folder)
	if err != nil || len(entries) != 3 {
		t.Fatalf("unexpected choice records: %v %v", entries, err)
	}
	if rows := journalOf(t, h, "session"); len(rows) != 0 {
		t.Fatalf("choices must not enter the typed journal: %+v", rows)
	}
}
