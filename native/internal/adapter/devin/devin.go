// Package devin is the Devin CLI and Desktop profile.
//
// Devin's hooks take Claude Code's shape (PascalCase events, hookSpecificOutput
// replies) and Devin also runs the hooks in ~/.claude. So this profile parses
// and renders through the Claude Code profile, and declares only what the
// Devin docs (checked 15 Nov 2026) describe. Devin has PostCompaction (after
// compaction, not before), so recovery arrives with the next tool result.
// Tool names, subagent ids and prompt consumption are not documented; the
// live test confirms them or they stay off.
package devin

import (
	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/adapter/claude"
	"github.com/mex-memory/mex/native/internal/contract"
)

const Agent = "devin"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "SessionStart", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.Prompt, NativeEvent: "UserPromptSubmit", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.PreTool, NativeEvent: "PreToolUse", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		{Kind: contract.PostTool, NativeEvent: "PostToolUse", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.PostCompact, NativeEvent: "PostCompaction", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "Stop", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
	},
	FailureBlocks: false,
	SettingsFile:  ".claude/settings.json",
}

// claudeEvent is the Claude Code event with the same payload and reply shape.
var claudeEvent = map[string]string{"PostCompaction": "PostCompact"}

func native(event string) string {
	if c, ok := claudeEvent[event]; ok {
		return c
	}
	return event
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

func (Profile) Parse(nativeEvent string, raw []byte) (contract.Event, error) {
	kind, ok := caps.KindFor(nativeEvent)
	if !ok {
		return contract.Event{}, adapter.ErrUnknownEvent
	}
	ev, err := claude.Profile{}.Parse(native(nativeEvent), raw)
	if err != nil {
		return contract.Event{}, err
	}
	ev.Agent = Agent
	if ev.Kind == contract.PostToolFailure {
		// Devin has no failure event; keep the failure Claude's parser found
		// only when the payload carried it.
		kind = contract.PostToolFailure
	}
	ev.Kind = kind
	return ev, nil
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	if r.Empty() {
		return pr.EmptyReply(""), nil
	}
	kind := ev.Kind
	if kind == contract.PostToolFailure {
		kind = contract.PostTool
	}
	r, dropped := adapter.Narrow(caps, kind, r)
	if r.Empty() {
		return pr.EmptyReply(""), dropped
	}
	out, more := claude.Profile{}.Render(ev, r)
	return out, append(dropped, more...)
}
