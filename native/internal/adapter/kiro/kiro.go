// Package kiro is the Kiro CLI profile.
//
// Kiro CLI hooks live in an agent configuration (hooks: agentSpawn,
// userPromptSubmit, preToolUse, postToolUse, stop; docs checked 15 Nov 2026).
// Each hook gets a JSON payload on stdin. For agentSpawn and userPromptSubmit
// the hook's stdout is added to the model's context as plain text; the other
// events ignore stdout. A preToolUse hook blocks the tool only by exiting 2,
// with stderr as the reason. The shim always exits 0 so a broken MEX never
// blocks Kiro, so MEX doesn't declare deny here: the edit check and Stop
// proof are not available on Kiro yet. Kiro's IDE hooks (.kiro/hooks) are a
// different, prompt-based format and are not used.
package kiro

import (
	"encoding/json"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
)

const Agent = "kiro"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "agentSpawn", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.Prompt, NativeEvent: "userPromptSubmit", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.PreTool, NativeEvent: "preToolUse", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.PostTool, NativeEvent: "postToolUse", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "stop", Context: adapter.ChannelNone, TimeoutSeconds: 10},
	},
	FailureBlocks: false,
	SettingsFile:  ".kiro/agents/<agent>.json",
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

// EmptyReply is no output: Kiro adds any stdout to the context.
func (Profile) EmptyReply(string) []byte { return []byte{} }

type payload struct {
	SessionID    string          `json:"session_id"`
	Cwd          string          `json:"cwd"`
	Prompt       string          `json:"prompt"`
	ToolName     string          `json:"tool_name"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
}

func (Profile) Parse(nativeEvent string, raw []byte) (contract.Event, error) {
	kind, ok := caps.KindFor(nativeEvent)
	if !ok {
		return contract.Event{}, adapter.ErrUnknownEvent
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return contract.Event{}, err
	}
	ev := contract.Event{Agent: Agent, Kind: kind, SessionID: p.SessionID, Cwd: p.Cwd}
	switch kind {
	case contract.Prompt:
		ev.Prompt = &contract.PromptIn{Text: p.Prompt, Typed: true}
	case contract.PreTool:
		t := parseTool(p.ToolName, p.ToolInput, p.Cwd)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.ToolName, p.ToolInput, p.Cwd)
		out := responseOutput(p.ToolResponse)
		t.Output = &out
		ev.Tool = &t
		if !out.OK {
			ev.Kind = contract.PostToolFailure
		}
	}
	return ev, nil
}

type kiroInput struct {
	Command    string  `json:"command"`
	Path       string  `json:"path"`
	FileText   *string `json:"file_text"`
	OldStr     *string `json:"old_str"`
	NewStr     *string `json:"new_str"`
	Pattern    string  `json:"pattern"`
	Operations []struct {
		Mode string `json:"mode"`
		Path string `json:"path"`
	} `json:"operations"`
}

func parseTool(name string, raw json.RawMessage, cwd string) contract.Tool {
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: raw}
	var in kiroInput
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &in)
	}
	abs := func(p string) string {
		if p == "" {
			return ""
		}
		return shellparse.Resolve(cwd, p)
	}
	switch name {
	case "execute_bash", "execute_cmd", "shell":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: in.Command}
	case "fs_read", "read":
		path := in.Path
		if path == "" && len(in.Operations) > 0 {
			path = in.Operations[0].Path
		}
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: abs(path)}
	case "fs_write", "write":
		if in.Command == "create" {
			t.Name = contract.ToolWrite
			t.Input = contract.ToolInput{Path: abs(in.Path), Content: in.FileText}
		} else {
			t.Name = contract.ToolEdit
			t.Input = contract.ToolInput{Path: abs(in.Path), Old: in.OldStr, New: in.NewStr}
		}
	case "grep":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: abs(in.Path)}
	case "glob":
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: abs(in.Path)}
	}
	return t
}

// responseOutput reads {"success": bool, "result": ...}; anything else is text.
func responseOutput(raw json.RawMessage) contract.ToolOutput {
	if len(raw) == 0 {
		return contract.ToolOutput{OK: true}
	}
	var r struct {
		Success *bool           `json:"success"`
		Result  json.RawMessage `json:"result"`
	}
	if json.Unmarshal(raw, &r) == nil && r.Success != nil {
		text := string(r.Result)
		var s string
		if json.Unmarshal(r.Result, &s) == nil {
			text = s
		} else {
			var lines []string
			if json.Unmarshal(r.Result, &lines) == nil && len(lines) > 0 {
				text = lines[0]
				for _, l := range lines[1:] {
					text += "\n" + l
				}
			}
		}
		return contract.ToolOutput{Text: text, OK: *r.Success}
	}
	return contract.ToolOutput{Text: string(raw), OK: true}
}

// PlainTextReplies marks Kiro's replies as text, not JSON.
func (Profile) PlainTextReplies() {}

// Render writes the context as plain text, the only reply Kiro reads.
func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	if r.Empty() {
		return pr.EmptyReply(""), nil
	}
	kind := ev.Kind
	if kind == contract.PostToolFailure {
		kind = contract.PostTool
	}
	r, dropped := adapter.Narrow(caps, kind, r)
	if r.Context == "" {
		return pr.EmptyReply(""), dropped
	}
	return []byte(contract.EnsureMarked(r.Context) + "\n"), dropped
}
