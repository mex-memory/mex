package kiro

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

func TestToolsAndFailure(t *testing.T) {
	ev := adaptertest.ParseFixture(t, Profile{}, "preToolUse-fs_read")
	if ev.Tool.Name != contract.ToolRead || ev.Tool.Input.Path == "" {
		t.Fatalf("fs_read: %+v", ev.Tool)
	}
	ev = adaptertest.ParseFixture(t, Profile{}, "postToolUse-execute_bash-failed")
	if ev.Kind != contract.PostToolFailure || ev.Tool.Output.OK {
		t.Fatalf("failure: %+v", ev)
	}
}

func TestReplies(t *testing.T) {
	adaptertest.CheckReplies(t, Profile{}, []adaptertest.ReplyCase{
		{Name: "empty", Fixture: "preToolUse-fs_write"},
		{Name: "spawn-context", Fixture: "agentSpawn", Reply: contract.Reply{Context: "[mex brief]\nbrief"}},
		{Name: "prompt-context", Fixture: "userPromptSubmit", Reply: contract.Reply{Context: "note"}},
		{Name: "pre-tool-deny-dropped", Fixture: "preToolUse-fs_write", Reply: contract.Reply{Decision: contract.Deny, Reason: "x"}, Dropped: []string{"decision"}},
		{Name: "post-tool-context-dropped", Fixture: "postToolUse-execute_bash", Reply: contract.Reply{Context: "x"}, Dropped: []string{"context"}},
		{Name: "stop-deny-dropped", Fixture: "stop", Reply: contract.Reply{Decision: contract.Deny, Reason: "x"}, Dropped: []string{"decision"}},
	})
}
