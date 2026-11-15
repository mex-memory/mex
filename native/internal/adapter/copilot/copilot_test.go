package copilot

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestToolArgsStringAndObject(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "preToolUse-edit")
	if ev.Tool.Name != contract.ToolEdit || ev.Tool.Input.Path != "/home/dev/shop/src/cart.ts" || *ev.Tool.Input.New != "b" {
		t.Fatalf("string toolArgs: %+v", ev.Tool)
	}
	ev = adaptertest.ParseFixture(t, Profile{}, "preToolUse-view-object")
	if ev.Tool.Name != contract.ToolRead || ev.Tool.Input.Path != "/home/dev/shop/src/cart.ts" {
		t.Fatalf("object toolArgs: %+v", ev.Tool)
	}
}

func TestFailedResultIsAFailure(t *testing.T) {
	for _, name := range []string{"postToolUse-bash-failure", "postToolUseFailure-bash"} {
		ev := adaptertest.ParseFixture(t, Profile{}, name)
		if ev.Kind != contract.PostToolFailure || ev.Tool.Output.OK || ev.Tool.Output.Text == "" {
			t.Errorf("%s: %+v", name, ev.Tool.Output)
		}
	}
}

func TestFailureBlocksIsDeclared(t *testing.T) {
	// The installer's self-test gate depends on this flag.
	if !caps.FailureBlocks {
		t.Fatal("Copilot denies the tool call when a hook fails; the profile must say so")
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "preToolUse-bash"},
		{Name: "session-start-context", Fixture: "sessionStart", Reply: contract.Reply{Context: "[mex brief]\nbrief", PersonLine: "mex: ready"}, Dropped: []string{"person_line"}},
		{Name: "prompt-context-dropped", Fixture: "userPromptSubmitted", Reply: contract.Reply{Context: "[mex p1]\nnote"}, Dropped: []string{"context"}},
		{Name: "prompt-consume-dropped", Fixture: "userPromptSubmitted", Reply: contract.Reply{ConsumePrompt: true, PersonLine: "paused"}, Dropped: []string{"consume_prompt", "person_line"}},
		{Name: "pre-tool-deny", Fixture: "preToolUse-edit", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-context-dropped", Fixture: "preToolUse-bash", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "pre-tool-replace-input-dropped", Fixture: "preToolUse-bash", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, Dropped: []string{"replace_input"}},
		{Name: "post-tool-context", Fixture: "postToolUse-bash", Reply: contract.Reply{Context: "[mex m1]\nrecipe: run npm run lint too"}},
		{Name: "post-tool-replace-output", Fixture: "postToolUse-bash", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "12 passed (trimmed)", OK: true}}},
		{Name: "failure-context", Fixture: "postToolUseFailure-bash", Reply: contract.Reply{Context: "[mex fix-1]\nrun npm i"}},
		{Name: "failure-replace-output-dropped", Fixture: "postToolUseFailure-bash", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x"}}, Dropped: []string{"replace_output"}},
		{Name: "pre-compact-context-dropped", Fixture: "preCompact", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "subagent-context", Fixture: "subagentStart", Reply: contract.Reply{Context: "[mex sub]\nbrief"}},
		{Name: "stop-deny", Fixture: "agentStop", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
		{Name: "session-end-dropped", Fixture: "sessionEnd", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
	})
}

func TestCommand(t *testing.T) {
	cmd := Profile{}.Command("/home/dev/.mex/bin/mex-hook", "preToolUse")
	if strings.Join(cmd.Args, " ") != "copilot preToolUse" {
		t.Errorf("got %+v", cmd)
	}
}

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("copilot profile not registered")
	}
}
