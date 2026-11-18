package adaptertest

import (
	"encoding/json"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter"
	_ "github.com/mex-memory/mex/native/internal/adapter/claude"
	_ "github.com/mex-memory/mex/native/internal/adapter/codex"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestConsumedPromptHasOnlyPersonConfirmation(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		p, _ := adapter.Lookup(agent)
		out, dropped := p.Render(contract.Event{Kind: contract.Prompt}, contract.Reply{
			ConsumePrompt: true, PersonLine: "MEX is paused for this session.", Context: "must not reach model", Decision: contract.Deny,
		})
		var value map[string]any
		if json.Unmarshal(out, &value) != nil || len(value) != 2 || value["decision"] != "block" || value["reason"] != "MEX is paused for this session." || len(dropped) != 0 {
			t.Fatalf("%s: %s dropped=%v", agent, out, dropped)
		}
		out, dropped = p.Render(contract.Event{Kind: contract.SessionStart}, contract.Reply{ConsumePrompt: true})
		if string(out) != "{}\n" || len(dropped) != 1 || dropped[0] != "consume_prompt" {
			t.Fatalf("non-prompt: %s %v", out, dropped)
		}
	}
}
