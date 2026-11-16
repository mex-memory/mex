package cursor

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestNoPromptMomentNoCompactionRecoveryNoSubagentBrief(t *testing.T) {
	for _, k := range []contract.Kind{contract.Prompt, contract.SubagentStart, contract.PreCompact} {
		if s, _ := caps.Support(k); s.Context != adapter.ChannelNone {
			t.Errorf("%s must not carry context on Cursor", k)
		}
	}
	if _, ok := caps.Support(contract.PostCompact); ok {
		t.Error("Cursor has no post-compaction event; recovery waits for the next tool result")
	}
	if s, _ := caps.Support(contract.PostTool); s.Context != adapter.ChannelToolResult {
		t.Error("recovery must ride the next tool result")
	}
}

func TestClaudeEventNamesAccepted(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "PreToolUse-claude-name")
	if ev.Kind != contract.PreTool || ev.Tool.Name != contract.ToolShell {
		t.Fatalf("got %+v", ev)
	}
}

func TestFailureIsAFailure(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "postToolUseFailure-Shell")
	if ev.Kind != contract.PostToolFailure || ev.Tool.Output.OK {
		t.Fatalf("got %+v", ev.Tool)
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "preToolUse-Shell"},
		{Name: "session-start-context", Fixture: "sessionStart", Reply: contract.Reply{Context: "[mex brief]\nbrief"}},
		{Name: "session-start-person-line-dropped", Fixture: "sessionStart", Reply: contract.Reply{PersonLine: "mex: ready"}, Dropped: []string{"person_line"}},
		{Name: "prompt-context-dropped", Fixture: "beforeSubmitPrompt", Reply: contract.Reply{Context: "[mex p1]\nnote"}, Dropped: []string{"context"}},
		{Name: "prompt-consumed", Fixture: "beforeSubmitPrompt", Reply: contract.Reply{ConsumePrompt: true, PersonLine: "MEX is paused for this session."}},
		{Name: "pre-tool-deny", Fixture: "preToolUse-Write", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-context-dropped", Fixture: "preToolUse-Edit", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "pre-tool-replace-input-dropped", Fixture: "preToolUse-Shell", Reply: contract.Reply{ReplaceInput: &contract.ToolInput{Command: "x"}}, Dropped: []string{"replace_input"}},
		{Name: "post-tool-context", Fixture: "postToolUse-Read", Reply: contract.Reply{Context: "[mex m1]\nmoment"}},
		{Name: "post-tool-unmarked-context-gets-marked", Fixture: "postToolUse-Read", Reply: contract.Reply{Context: "recovery"}},
		{Name: "post-tool-replace-output-dropped", Fixture: "postToolUse-Read", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x", OK: true}}, Dropped: []string{"replace_output"}},
		{Name: "failure-context", Fixture: "postToolUseFailure-Shell", Reply: contract.Reply{Context: "[mex fix-1]\nrun npm i"}},
		{Name: "pre-compact-person-line", Fixture: "preCompact", Reply: contract.Reply{PersonLine: "mex: saving notes before compaction"}},
		{Name: "subagent-deny", Fixture: "subagentStart", Reply: contract.Reply{Decision: contract.Deny, Reason: "MEX blocks this subagent here"}},
		{Name: "subagent-context-dropped", Fixture: "subagentStart", Reply: contract.Reply{Context: "[mex sub]\nbrief"}, Dropped: []string{"context"}},
		{Name: "stop-deny", Fixture: "stop", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
		{Name: "session-end-dropped", Fixture: "sessionEnd", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
	})
}

func TestCommand(t *testing.T) {
	cmd := Profile{}.Command("/home/dev/.mex/bin/mex-hook", "stop")
	if cmd.Path != "/home/dev/.mex/bin/mex-hook" || strings.Join(cmd.Args, " ") != "cursor stop" {
		t.Errorf("got %+v", cmd)
	}
}

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("cursor profile not registered")
	}
}
