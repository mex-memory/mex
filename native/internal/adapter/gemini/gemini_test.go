package gemini

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/adaptertest"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestFixtures(t *testing.T) { adaptertest.CheckFixtures(t, Profile{}) }

func TestFailedToolIsAFailure(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "AfterTool-failed")
	if ev.Kind != contract.PostToolFailure || ev.Tool.Output.OK || ev.Tool.Output.Text != "Command exited with code 1" {
		t.Fatalf("got %+v", ev.Tool.Output)
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "BeforeTool-run_shell_command"},
		{Name: "session-start-context", Fixture: "SessionStart", Reply: contract.Reply{Context: "[mex brief]\nbrief", PersonLine: "mex: ready"}},
		{Name: "prompt-context", Fixture: "BeforeAgent", Reply: contract.Reply{Context: "[mex p1]\nnote"}},
		{Name: "prompt-consumed", Fixture: "BeforeAgent", Reply: contract.Reply{ConsumePrompt: true, PersonLine: "MEX is paused for this session."}},
		{Name: "pre-tool-deny", Fixture: "BeforeTool-replace", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "pre-tool-context-dropped", Fixture: "BeforeTool-replace", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "post-tool-context", Fixture: "AfterTool-read_file", Reply: contract.Reply{Context: "[mex m1]\nmoment"}},
		{Name: "post-tool-replace-output-dropped", Fixture: "AfterTool-read_file", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "x", OK: true}}, Dropped: []string{"replace_output"}},
		{Name: "failure-context", Fixture: "AfterTool-failed", Reply: contract.Reply{Context: "[mex fix-1]\nrun npm i"}},
		{Name: "pre-compress-person-line", Fixture: "PreCompress", Reply: contract.Reply{PersonLine: "mex: saving notes"}},
		{Name: "pre-compress-context-dropped", Fixture: "PreCompress", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "stop-deny", Fixture: "AfterAgent", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex proof]\nrun the tests first"}},
		{Name: "session-end-dropped", Fixture: "SessionEnd", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
	})
}

func TestCommand(t *testing.T) {
	cmd := Profile{}.Command("/home/dev/.mex/bin/mex-hook", "AfterTool")
	if strings.Join(cmd.Args, " ") != "gemini AfterTool" {
		t.Errorf("got %+v", cmd)
	}
}

func TestRegistered(t *testing.T) {
	if _, ok := adapter.Lookup(Agent); !ok {
		t.Fatal("gemini profile not registered")
	}
}
