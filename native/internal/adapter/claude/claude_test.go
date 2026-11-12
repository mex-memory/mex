package claude

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestCoversEveryContractKind(t *testing.T) {
	for _, k := range contract.Kinds {
		if _, ok := caps.Support(k); !ok {
			t.Errorf("Claude Code profile has no %s", k)
		}
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

// Reply-format tests: each reply renders to the exact output Claude Code expects.
func TestReplies(t *testing.T) {
	ptr := adaptertest.Ptr[int]
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "PreToolUse-Read"},
		{Name: "allow-is-empty", Fixture: "PreToolUse-Read", Reply: contract.Reply{Decision: contract.Allow}},
		{Name: "session-start-context", Fixture: "SessionStart-startup", Reply: contract.Reply{Context: "[mex brief]\nbrief"}},
		{Name: "prompt-context-and-line", Fixture: "UserPromptSubmit", Reply: contract.Reply{Context: "[mex p1]\nnote", PersonLine: "mex: 1 note"}},
		{Name: "unmarked-context-gets-marked", Fixture: "UserPromptSubmit", Reply: contract.Reply{Context: "note"}},
		{Name: "pre-tool-deny", Fixture: "PreToolUse-Edit", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-context", Fixture: "PreToolUse-Read", Reply: contract.Reply{Context: "[mex n2]\nlinked note"}},
		{Name: "pre-tool-replace-shell", Fixture: "PreToolUse-Bash", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "mex-run npm test"}}},
		{Name: "pre-tool-replace-read", Fixture: "PreToolUse-Read", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Offset: ptr(1), Limit: ptr(20)}}},
		{Name: "pre-tool-replace-other-dropped", Fixture: "PreToolUse-mcp", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, Dropped: []string{"replace_input"}},
		{Name: "post-tool-context", Fixture: "PostToolUse-Write", Reply: contract.Reply{Context: "[mex m1]\nmoment"}},
		{Name: "post-tool-replace-shell-output", Fixture: "PostToolUse-Bash", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "12 passed (trimmed)", OK: true}}},
		{Name: "post-tool-replace-write-output-dropped", Fixture: "PostToolUse-Write", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x"}}, Dropped: []string{"replace_output"}},
		{Name: "post-tool-deny-dropped", Fixture: "PostToolUse-Bash", Reply: contract.Reply{Decision: contract.Deny, Reason: "no"}, Dropped: []string{"decision"}},
		{Name: "failure-context", Fixture: "PostToolUseFailure-Bash", Reply: contract.Reply{Context: "[mex fix-1]\nrun npm i"}},
		{Name: "batch-context", Fixture: "PostToolBatch", Reply: contract.Reply{Context: "[mex m2]\nbatch"}},
		{Name: "pre-compact-context-dropped", Fixture: "PreCompact", Reply: contract.Reply{Context: "[mex s]\nsteer"}, Dropped: []string{"context"}},
		{Name: "post-compact-all-dropped", Fixture: "PostCompact", Reply: contract.Reply{Context: "x", PersonLine: "y"}, Dropped: []string{"context", "person_line"}},
		{Name: "subagent-context", Fixture: "SubagentStart", Reply: contract.Reply{Context: "[mex sub]\nbrief"}},
		{Name: "stop-deny", Fixture: "Stop", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
		{Name: "stop-context", Fixture: "Stop", Reply: contract.Reply{Context: "[mex proof]\nrun the tests"}},
		{Name: "session-end-dropped", Fixture: "SessionEnd", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
	})
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
