package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter/claude"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/outline"
	"github.com/mex-memory/mex/native/outline/outlinetest"
	"github.com/mex-memory/mex/native/output"
	localrecord "github.com/mex-memory/mex/native/record"
)

func TestLedgerReplayCountsSavedViews(t *testing.T) {
	reads, err := outlinetest.SavedReads()
	if err != nil {
		t.Fatal(err)
	}
	outlineTokens := 0
	for _, saved := range reads {
		tokens, _ := promptWords(saved.Prompt)
		terms := map[uint64]bool{}
		for _, word := range tokens {
			terms[word] = true
		}
		outlined, ok := outline.Render(outline.Input{Path: saved.Name, Content: saved.Content, Symbols: saved.Symbols, Terms: terms})
		if !ok {
			t.Fatalf("saved read %s should outline", saved.Name)
		}
		file := map[string]any{"filePath": "/repo/" + saved.Name, "content": saved.Content, "startLine": 1}
		body, _ := json.Marshal(map[string]any{
			"session_id": "s", "cwd": "/repo", "tool_name": "Read",
			"tool_input":    map[string]any{"file_path": file["filePath"]},
			"tool_response": map[string]any{"type": "text", "file": file},
		})
		ev, err := (claude.Profile{}).Parse("PostToolUse", body)
		if err != nil {
			t.Fatal(err)
		}
		reply := contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: outlined.Text, OK: true}}
		observation := observeLever(ev, "", &leverState{}, reply)
		if observation == nil || observation.Lever != localrecord.LeverOutline || observation.TokensRemoved <= 0 {
			t.Fatalf("saved read %s lacked a positive observation", saved.Name)
		}
		outlineTokens += observation.TokensRemoved
	}

	fixtures, err := filepath.Glob(filepath.Join("..", "..", "output", "testdata", "outputs", "*.txt"))
	if err != nil || len(fixtures) == 0 {
		t.Fatalf("saved output fixtures unavailable: %v", err)
	}
	trimTokens, wrapperTokens := 0, 0
	for _, path := range fixtures {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		cmd, err := os.ReadFile(strings.TrimSuffix(path, ".txt") + ".cmd")
		if err != nil {
			t.Fatal(err)
		}
		command := strings.TrimSpace(string(cmd))
		if !output.Noisy(command) {
			continue
		}
		trimmed, ok := output.TrimAndSave(string(data), 0, func() (int, error) { return 1, nil })
		if !ok {
			continue
		}
		ev, err := (claude.Profile{}).Parse("PostToolUse", claudeBash(t, "PostToolUse", "s", "/repo", command, string(data)))
		if err != nil {
			t.Fatal(err)
		}
		reply := contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: trimmed, OK: true}}
		observation := observeLever(ev, "", &leverState{}, reply)
		if observation == nil || observation.Lever != localrecord.LeverShellTrim || observation.TokensRemoved <= 0 {
			t.Fatalf("saved output %s lacked a positive observation", filepath.Base(path))
		}
		trimTokens += observation.TokensRemoved
		// The same view on Codex includes the executed command's printed header.
		wrapperTokens += removedTokens(len(data), len(trimmed)+len(command)+3)
	}

	t.Logf("estimated tokens removed from one view per fixture: outline=%d shell-trim=%d codex-wrapper=%d",
		outlineTokens, trimTokens, wrapperTokens)
	if outlineTokens <= 0 || trimTokens <= 0 || wrapperTokens <= 0 || wrapperTokens >= trimTokens {
		t.Fatalf("inconsistent saved-view measurements")
	}
}

func TestLedgerOffKeepsExistingOutlineGuardsAndStopsNewWork(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	write(t, filepath.Join(h.mex, "ledger-off.shell-trim"), "1\n")
	_, out := run(t, []string{"claude-code", "PostToolUse"},
		bytes.NewReader(claudeBash(t, "PostToolUse", "s", root, "npm test", longTestRun())), env)
	if parseClaude(t, out).HookSpecificOutput.UpdatedToolOutput != nil {
		t.Fatal("shell output was trimmed after the ledger stopped it")
	}

	path := filepath.Join(root, "file.ts")
	write(t, filepath.Join(h.mex, "ledger-off.outline"), "1\n")
	ev := contract.Event{Agent: "claude-code", SessionID: "s"}
	state := leverState{Outlined: map[string]*outlineMark{pathKey(path): {Lines: 400}}}
	state.save(leverStatePath(h.mex, ev))
	edit, _ := json.Marshal(map[string]any{"hook_event_name": "PreToolUse", "session_id": "s", "cwd": root,
		"tool_name": "Edit", "tool_input": map[string]any{"file_path": path, "old_string": "a", "new_string": "b"}})
	_, out = run(t, []string{"claude-code", "PreToolUse"}, bytes.NewReader(edit), env)
	if parseClaude(t, out).HookSpecificOutput.PermissionDecision != "deny" {
		t.Fatal("an already shown outline lost its edit guard")
	}

	h, env, root = codexSetup(t)
	write(t, filepath.Join(h.mex, "ledger-off.codex-wrapper"), "1\n")
	_, out = run(t, []string{"codex", "PreToolUse"}, bytes.NewReader(codexPre(t, root, map[string]any{"command": "npm test"})), env)
	if strings.Contains(out, "updatedInput") || strings.Contains(out, "\"allow\"") {
		t.Fatal("a command was wrapped after the ledger stopped it")
	}
}
