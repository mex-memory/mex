package opencode

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

func TestChildSessionIsASubagent(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "tool.execute.after-read-child")
	if ev.SessionID != "ses_01" || ev.AgentID != "ses_child" {
		t.Fatalf("got session %q agent %q", ev.SessionID, ev.AgentID)
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "tool.execute.before-bash"},
		{Name: "session-context-dropped", Fixture: "session.created", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "pre-tool-deny", Fixture: "tool.execute.before-edit", Reply: contract.Reply{Decision: contract.Deny, Reason: "[mex rule-3]\nread cart.ts first"}},
		{Name: "post-tool-context", Fixture: "tool.execute.after-bash", Reply: contract.Reply{Context: "[mex m1]\nrecipe"}},
		{Name: "post-tool-replace-output", Fixture: "tool.execute.after-bash", Reply: contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: "12 passed (trimmed)", OK: true}}},
		{Name: "failure-context", Fixture: "tool.execute.after-bash-failed", Reply: contract.Reply{Context: "[mex fix-1]\nrun npm i"}},
		{Name: "compacting-context", Fixture: "experimental.session.compacting", Reply: contract.Reply{Context: "[mex keep]\nids m1 fix-1"}},
		{Name: "idle-deny-dropped", Fixture: "session.idle", Reply: contract.Reply{Decision: contract.Deny, Reason: "x"}, Dropped: []string{"decision"}},
	})
}
