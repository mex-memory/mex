package antigravity

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestNoCompactionNoSubagentNoSessionEnd(t *testing.T) {
	for _, k := range []contract.Kind{contract.PreCompact, contract.PostCompact, contract.SubagentStart, contract.SessionEnd} {
		if _, ok := caps.Support(k); ok {
			t.Errorf("Antigravity has no %s event", k)
		}
	}
}

func TestLaterModelCallsAreSkipped(t *testing.T) {
	raw, err := os.ReadFile("testdata/skipped/PreInvocation-later.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (Profile{}).Parse("PreInvocation", raw); !errors.Is(err, adapter.ErrSkip) {
		t.Fatalf("err = %v, want ErrSkip", err)
	}
}

func TestFailedToolIsAFailure(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "PostToolUse-failed")
	if ev.Kind != contract.PostToolFailure || ev.Tool.Output.OK {
		t.Fatalf("got %+v", ev.Tool)
	}
}

// Context must never speak as the person.
func TestContextIsEphemeralNeverUserMessage(t *testing.T) {
	out, _ := Profile{}.Render(adaptertest.ParseFixture(t, Profile{}, "SessionStart"), contract.Reply{Context: "[mex brief]\nbrief"})
	if !strings.Contains(string(out), `"ephemeralMessage"`) || strings.Contains(string(out), "userMessage") {
		t.Fatalf("got %s", out)
	}
}

func TestEmptyRepliesCarryRequiredDecision(t *testing.T) {
	for _, ev := range []string{"PreToolUse", "Stop"} {
		if got := string(Profile{}.EmptyReply(ev)); got != "{\"decision\":\"allow\"}\n" {
			t.Errorf("%s: %q", ev, got)
		}
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "PreToolUse-run_command"},
		{Name: "session-start-context", Fixture: "SessionStart", Reply: contract.Reply{Context: "[mex brief]\nbrief"}},
		{Name: "session-start-person-line-dropped", Fixture: "SessionStart", Reply: contract.Reply{PersonLine: "mex: ready"}, Dropped: []string{"person_line"}},
		{Name: "prompt-context", Fixture: "PreInvocation", Reply: contract.Reply{Context: "[mex p1]\nnote"}},
		{Name: "prompt-consumed", Fixture: "PreInvocation", Reply: contract.Reply{ConsumePrompt: true, PersonLine: "MEX is paused"}, Dropped: []string{"person_line"}},
		{Name: "pre-tool-deny", Fixture: "PreToolUse-write_to_file", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-context-dropped", Fixture: "PreToolUse-run_command", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "pre-tool-replace-input-dropped", Fixture: "PreToolUse-run_command", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, Dropped: []string{"replace_input"}},
		{Name: "post-tool-context-dropped", Fixture: "PostToolUse-view_file", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "stop-deny", Fixture: "Stop", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
		{Name: "stop-context-dropped", Fixture: "Stop", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
	})
}

func TestCommand(t *testing.T) {
	cmd := Profile{}.Command("/home/dev/.mex/bin/mex-hook", "Stop")
	if strings.Join(cmd.Args, " ") != "antigravity Stop" {
		t.Errorf("got %+v", cmd)
	}
}

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("antigravity profile not registered")
	}
}
