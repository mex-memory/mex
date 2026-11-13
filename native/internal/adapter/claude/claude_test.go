package claude

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
)

var update = flag.Bool("update", false, "rewrite golden files")

func eventName(file string) string {
	name := strings.TrimSuffix(filepath.Base(file), ".json")
	ev, _, _ := strings.Cut(name, "-")
	return ev
}

func golden(t *testing.T, path string, got []byte) {
	t.Helper()
	if *update {
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", path, err)
	}
	want = bytes.ReplaceAll(want, []byte("\r\n"), []byte("\n"))
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs\n--- got\n%s\n--- want\n%s", path, got, want)
	}
}

func payloadFiles(t *testing.T) []string {
	t.Helper()
	all, err := filepath.Glob(filepath.Join("testdata", "payloads", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, f := range all {
		if !strings.HasSuffix(f, ".event.json") {
			files = append(files, f)
		}
	}
	if len(files) == 0 {
		t.Fatal("no payload fixtures")
	}
	return files
}

// Every fixture parses, and its normalized event matches the golden file.
func TestParseFixtures(t *testing.T) {
	p := Profile{}
	for _, f := range payloadFiles(t) {
		t.Run(filepath.Base(f), func(t *testing.T) {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			ev, err := p.Parse(eventName(f), raw)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			got, _ := json.MarshalIndent(ev, "", "  ")
			golden(t, strings.TrimSuffix(f, ".json")+".event.json", append(got, '\n'))
		})
	}
}

// Every kind the profile declares has at least one fixture.
func TestEveryDeclaredKindHasAFixture(t *testing.T) {
	seen := map[string]bool{}
	for _, f := range payloadFiles(t) {
		seen[eventName(f)] = true
	}
	for _, s := range caps.Kinds {
		if !seen[s.NativeEvent] {
			t.Errorf("no fixture for %s", s.NativeEvent)
		}
	}
}

// The profile covers every kind in the contract.
func TestCoversEveryContractKind(t *testing.T) {
	for _, k := range contract.Kinds {
		if _, ok := caps.Support(k); !ok {
			t.Errorf("Claude Code profile has no %s", k)
		}
	}
}

func TestParseRejectsUnknownEventAndBadJSON(t *testing.T) {
	p := Profile{}
	if _, err := p.Parse("Notification", []byte(`{}`)); err == nil {
		t.Error("unknown event should fail")
	}
	if _, err := p.Parse("PreToolUse", []byte(`{`)); err == nil {
		t.Error("bad JSON should fail")
	}
}

func TestExitCode(t *testing.T) {
	cases := map[string]int{"Exit code 1\nboom": 1, "Exit code 127": 127}
	for in, want := range cases {
		if got := exitCode(in); got == nil || *got != want {
			t.Errorf("exitCode(%q) = %v, want %d", in, got, want)
		}
	}
	for _, in := range []string{"", "File not found", "Exit code x"} {
		if got := exitCode(in); got != nil {
			t.Errorf("exitCode(%q) = %d, want none", in, *got)
		}
	}
}

func parseFixture(t *testing.T, name string) contract.Event {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "payloads", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	ev, err := Profile{}.Parse(eventName(name), raw)
	if err != nil {
		t.Fatal(err)
	}
	return ev
}

func ptr[T any](v T) *T { return &v }

// Reply-format tests: each reply renders to the exact output Claude Code expects.
func TestRenderReplies(t *testing.T) {
	cases := []struct {
		name    string
		fixture string
		reply   contract.Reply
		dropped []string
	}{
		{"empty", "PreToolUse-Read", contract.Reply{}, nil},
		{"allow-is-empty", "PreToolUse-Read", contract.Reply{Decision: contract.Allow}, nil},
		{"session-start-context", "SessionStart-startup", contract.Reply{Context: "[mex brief]\nbrief"}, nil},
		{"prompt-context-and-line", "UserPromptSubmit", contract.Reply{Context: "[mex p1]\nnote", PersonLine: "mex: 1 note"}, nil},
		{"pre-tool-deny", "PreToolUse-Edit", contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}, nil},
		{"pre-tool-context", "PreToolUse-Read", contract.Reply{Context: "[mex n2]\nlinked note"}, nil},
		{"pre-tool-replace-shell", "PreToolUse-Bash", contract.Reply{ReplaceInput: &contract.ToolInput{Command: "mex-run npm test"}}, nil},
		{"pre-tool-replace-read", "PreToolUse-Read", contract.Reply{ReplaceInput: &contract.ToolInput{Offset: ptr(1), Limit: ptr(20)}}, nil},
		{"pre-tool-replace-other-dropped", "PreToolUse-mcp", contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, []string{"replace_input"}},
		{"post-tool-context", "PostToolUse-Write", contract.Reply{Context: "[mex m1]\nmoment"}, nil},
		{"post-tool-replace-shell-output", "PostToolUse-Bash", contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "12 passed (trimmed)", OK: true}}, nil},
		{"post-tool-replace-write-output-dropped", "PostToolUse-Write", contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x"}}, []string{"replace_output"}},
		{"post-tool-deny-dropped", "PostToolUse-Bash", contract.Reply{Decision: contract.Deny, Reason: "no"}, []string{"decision"}},
		{"failure-context", "PostToolUseFailure-Bash", contract.Reply{Context: "[mex fix-1]\nrun npm i"}, nil},
		{"batch-context", "PostToolBatch", contract.Reply{Context: "[mex m2]\nbatch"}, nil},
		{"pre-compact-context-dropped", "PreCompact", contract.Reply{Context: "[mex s]\nsteer"}, []string{"context"}},
		{"post-compact-all-dropped", "PostCompact", contract.Reply{Context: "x", PersonLine: "y"}, []string{"context", "person_line"}},
		{"subagent-context", "SubagentStart", contract.Reply{Context: "[mex sub]\nbrief"}, nil},
		{"stop-deny", "Stop", contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}, nil},
		{"stop-context", "Stop", contract.Reply{Context: "[mex proof]\nrun the tests"}, nil},
		{"session-end-dropped", "SessionEnd", contract.Reply{Context: "x"}, []string{"context"}},
	}
	p := Profile{}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, dropped := p.Render(parseFixture(t, c.fixture), c.reply)
			if !json.Valid(out) {
				t.Fatalf("invalid JSON: %s", out)
			}
			if strings.Join(dropped, ",") != strings.Join(c.dropped, ",") {
				t.Errorf("dropped = %v, want %v", dropped, c.dropped)
			}
			golden(t, filepath.Join("testdata", "replies", c.name+".json"), out)
		})
	}
}

func TestCommandIsExecForm(t *testing.T) {
	cmd := Profile{}.Command(`C:\Users\dev\.mex\bin\mex-hook.exe`, "PreToolUse")
	if cmd.Path != `C:\Users\dev\.mex\bin\mex-hook.exe` {
		t.Errorf("path = %q", cmd.Path)
	}
	if strings.Join(cmd.Args, " ") != "claude-code PreToolUse" {
		t.Errorf("args = %q", cmd.Args)
	}
}

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("claude-code profile not registered")
	}
}
