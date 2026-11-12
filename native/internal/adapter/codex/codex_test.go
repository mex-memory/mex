package codex

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestCoversContractKinds(t *testing.T) {
	// Codex has no batch event; everything else is covered.
	for _, k := range contract.Kinds {
		if _, ok := caps.Support(k); !ok && k != contract.PostToolBatch {
			t.Errorf("Codex profile has no %s", k)
		}
	}
}

func TestFailedCommandIsAFailure(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "PostToolUse-Bash-failed")
	if ev.Kind != contract.PostToolFailure || ev.Tool.Output.OK || *ev.Tool.Output.ExitCode != 1 {
		t.Fatalf("got %+v", ev.Tool.Output)
	}
	if strings.HasPrefix(ev.Tool.Output.Text, "Exit code") {
		t.Errorf("header not stripped: %q", ev.Tool.Output.Text)
	}
}

func TestRecordedPatchIsParsed(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "PostToolUse-apply_patch-recorded")
	if ev.Tool.Name != contract.ToolPatch || len(ev.Tool.Input.Files) != 1 {
		t.Fatalf("got %+v", ev.Tool)
	}
	if !strings.HasSuffix(strings.ReplaceAll(ev.Tool.Input.Files[0].Path, `\`, "/"), "math.js") {
		t.Errorf("path = %q", ev.Tool.Input.Files[0].Path)
	}
	if !ev.Tool.Output.OK || *ev.Tool.Output.ExitCode != 0 {
		t.Errorf("output = %+v", ev.Tool.Output)
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "PreToolUse-Bash"},
		{Name: "session-start-context", Fixture: "SessionStart-recorded", Reply: contract.Reply{Context: "[mex brief]\nbrief", PersonLine: "mex: ready"}},
		{Name: "prompt-context", Fixture: "UserPromptSubmit-recorded", Reply: contract.Reply{Context: "[mex p1]\nnote"}},
		{Name: "unmarked-context-gets-marked", Fixture: "UserPromptSubmit-recorded", Reply: contract.Reply{Context: "note"}},
		{Name: "pre-tool-deny", Fixture: "PreToolUse-apply_patch", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-context", Fixture: "PreToolUse-Bash", Reply: contract.Reply{Context: "[mex n2]\nlinked note"}},
		{Name: "pre-tool-replace-input-dropped", Fixture: "PreToolUse-Bash", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, Dropped: []string{"replace_input"}},
		{Name: "pre-tool-person-line-dropped", Fixture: "PreToolUse-Bash", Reply: contract.Reply{PersonLine: "x"}, Dropped: []string{"person_line"}},
		{Name: "post-tool-context", Fixture: "PostToolUse-Bash-recorded", Reply: contract.Reply{Context: "[mex m1]\nmoment"}},
		{Name: "post-tool-replace-output", Fixture: "PostToolUse-Bash-recorded", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "3 lines (trimmed)", OK: true}}},
		{Name: "failure-context", Fixture: "PostToolUse-Bash-failed", Reply: contract.Reply{Context: "[mex fix-1]\nrun npm i"}},
		{Name: "failure-replace-output-dropped", Fixture: "PostToolUse-Bash-failed", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x"}}, Dropped: []string{"replace_output"}},
		{Name: "pre-compact-context-dropped", Fixture: "PreCompact", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "subagent-context", Fixture: "SubagentStart", Reply: contract.Reply{Context: "[mex sub]\nbrief"}},
		{Name: "stop-deny", Fixture: "Stop-recorded", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
		{Name: "stop-context-dropped", Fixture: "Stop-recorded", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "session-end-dropped", Fixture: "SessionEnd", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
	})
}

func TestCommand(t *testing.T) {
	cmd := Profile{}.Command("/home/dev/.mex/bin/mex-hook", "Stop")
	if cmd.Path != "/home/dev/.mex/bin/mex-hook" || strings.Join(cmd.Args, " ") != "codex Stop" {
		t.Errorf("got %+v", cmd)
	}
}

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("codex profile not registered")
	}
}
