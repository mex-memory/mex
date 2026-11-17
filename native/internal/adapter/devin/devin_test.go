package devin

import (
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("profile not registered")
	}
	if caps.FailureBlocks {
		t.Fatal("a failing MEX hook must not block this agent")
	}
}

func TestPostCompactionIsPostCompact(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "PostCompaction")
	if ev.Kind != contract.PostCompact || ev.Agent != Agent {
		t.Fatalf("got %+v", ev)
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "PreToolUse-Bash"},
		{Name: "session-start-context", Fixture: "SessionStart", Reply: contract.Reply{Context: "[mex brief]\nbrief", PersonLine: "mex: ready"}, Dropped: []string{"person_line"}},
		{Name: "prompt-context", Fixture: "UserPromptSubmit", Reply: contract.Reply{Context: "[mex p1]\nnote"}},
		{Name: "prompt-consume-dropped", Fixture: "UserPromptSubmit", Reply: contract.Reply{ConsumePrompt: true}, Dropped: []string{"consume_prompt"}},
		{Name: "pre-tool-deny", Fixture: "PreToolUse-Edit", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-replace-input-dropped", Fixture: "PreToolUse-Bash", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, Dropped: []string{"replace_input"}},
		{Name: "post-tool-context", Fixture: "PostToolUse-Bash", Reply: contract.Reply{Context: "[mex m1]\nrecipe"}},
		{Name: "post-tool-replace-output-dropped", Fixture: "PostToolUse-Bash", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x"}}, Dropped: []string{"replace_output"}},
		{Name: "post-compaction-context-dropped", Fixture: "PostCompaction", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "stop-deny", Fixture: "Stop", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
	})
}
