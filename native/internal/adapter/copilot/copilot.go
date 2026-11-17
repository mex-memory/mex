// Package copilot is the GitHub Copilot CLI profile.
//
// Shapes follow the Copilot CLI hooks reference (checked 15 Nov 2026): events
// are camelCase, tool arguments arrive as a JSON string in toolArgs, and a
// postToolUse reply can replace the result the model reads (modifiedResult),
// which is how MEX's context reaches the model there. Nothing here was
// recorded from a live session yet; see testdata/README.md.
//
// The one rule that shapes everything else: in Copilot CLI a hook that
// crashes, times out or can't start DENIES the tool call. The shim always
// exits 0 with valid JSON, and the installer registers this profile only
// after the hook program passes its self-test on this machine.
package copilot

import (
	"encoding/json"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
)

const Agent = "copilot"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "sessionStart", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		// Config hooks can't block or consume a prompt; `mex pause` runs from
		// the terminal or the Hub on Copilot.
		{Kind: contract.Prompt, NativeEvent: "userPromptSubmitted", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.PreTool, NativeEvent: "preToolUse", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		// Context is appended to the tool result through modifiedResult.
		{Kind: contract.PostTool, NativeEvent: "postToolUse", Context: adapter.ChannelToolResult, ReplaceOutput: true, TimeoutSeconds: 10},
		{Kind: contract.PostToolFailure, NativeEvent: "postToolUseFailure", Context: adapter.ChannelToolResult, TimeoutSeconds: 10},
		// No post-compaction event: recovery arrives with the next tool result.
		{Kind: contract.PreCompact, NativeEvent: "preCompact", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.SubagentStart, NativeEvent: "subagentStart", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "agentStop", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		{Kind: contract.SessionEnd, NativeEvent: "sessionEnd", Context: adapter.ChannelNone, TimeoutSeconds: 5},
	},
	FailureBlocks:  true,
	SubagentID:     "agentId",
	SettingsFile:   ".copilot/hooks.json",
	PolicySwitches: []string{"config.json: disableAllHooks = true"},
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

// EmptyReply is "{}": Copilot treats an empty object as "carry on".
func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

type toolResult struct {
	ResultType       string `json:"resultType"`
	TextResultForLLM string `json:"textResultForLlm"`
}

type payload struct {
	SessionID      string          `json:"sessionId"`
	AgentID        string          `json:"agentId"`
	AgentName      string          `json:"agentName"`
	Cwd            string          `json:"cwd"`
	Source         string          `json:"source"`
	TranscriptPath string          `json:"transcriptPath"`
	Prompt         string          `json:"prompt"`
	ToolName       string          `json:"toolName"`
	ToolArgs       json.RawMessage `json:"toolArgs"`
	ToolResult     *toolResult     `json:"toolResult"`
	Error          *struct {
		Message string `json:"message"`
	} `json:"error"`
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
	ev := contract.Event{Agent: Agent, Kind: kind, SessionID: p.SessionID, AgentID: p.AgentID, Cwd: p.Cwd, Transcript: p.TranscriptPath}
	switch kind {
	case contract.SessionStart:
		ev.Source = p.Source
	case contract.SubagentStart:
		ev.AgentType = p.AgentName
	case contract.Prompt:
		ev.Prompt = &contract.PromptIn{Text: p.Prompt, Typed: true}
	case contract.PreTool:
		t := parseTool(p.ToolName, p.ToolArgs, p.Cwd)
		ev.Tool = &t
	case contract.PostTool, contract.PostToolFailure:
		t := parseTool(p.ToolName, p.ToolArgs, p.Cwd)
		out := contract.ToolOutput{OK: kind == contract.PostTool}
		if p.ToolResult != nil {
			out.Text = p.ToolResult.TextResultForLLM
			if p.ToolResult.ResultType == "failure" || p.ToolResult.ResultType == "denied" {
				out.OK = false
			}
		}
		if p.Error != nil && out.Text == "" {
			out.Text = p.Error.Message
		}
		t.Output = &out
		ev.Tool = &t
		if !out.OK {
			ev.Kind = contract.PostToolFailure
		}
	}
	return ev, nil
}

type copilotArgs struct {
	Path     string  `json:"path"`
	Command  string  `json:"command"`
	OldStr   *string `json:"old_str"`
	NewStr   *string `json:"new_str"`
	FileText *string `json:"file_text"`
	Pattern  string  `json:"pattern"`
}

// toolArgs is documented as a JSON-encoded string; accept an object as well.
func decodeArgs(raw json.RawMessage) (json.RawMessage, copilotArgs) {
	var in copilotArgs
	if len(raw) == 0 {
		return raw, in
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		raw = json.RawMessage(s)
	}
	_ = json.Unmarshal(raw, &in)
	return raw, in
}

func parseTool(name string, rawArgs json.RawMessage, cwd string) contract.Tool {
	rawInput, in := decodeArgs(rawArgs)
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: rawInput}
	switch name {
	case "view":
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: abs(cwd, in.Path)}
	case "edit", "str_replace":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: abs(cwd, in.Path), Old: in.OldStr, New: in.NewStr}
	case "create":
		t.Name = contract.ToolWrite
		t.Input = contract.ToolInput{Path: abs(cwd, in.Path), Content: in.FileText}
	case "bash", "powershell":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: in.Command}
	case "grep", "rg":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: abs(cwd, in.Path)}
	case "glob":
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: abs(cwd, in.Path)}
	}
	return t
}

func abs(cwd, p string) string {
	if p == "" {
		return ""
	}
	return shellparse.Resolve(cwd, p)
}

type output struct {
	AdditionalContext        string      `json:"additionalContext,omitempty"`
	PermissionDecision       string      `json:"permissionDecision,omitempty"`
	PermissionDecisionReason string      `json:"permissionDecisionReason,omitempty"`
	Decision                 string      `json:"decision,omitempty"`
	Reason                   string      `json:"reason,omitempty"`
	ModifiedResult           *toolResult `json:"modifiedResult,omitempty"`
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	if r.Empty() {
		return pr.EmptyReply(""), nil
	}
	r, dropped := adapter.Narrow(caps, ev.Kind, r)
	out := output{}
	switch ev.Kind {
	case contract.SessionStart, contract.SubagentStart:
		if r.Context != "" {
			out.AdditionalContext = contract.EnsureMarked(r.Context)
		}
	case contract.PreTool:
		if r.Decision == contract.Deny {
			out.PermissionDecision = "deny"
			out.PermissionDecisionReason = r.Reason
		}
	case contract.Stop:
		if r.Decision == contract.Deny {
			out.Decision = "block"
			out.Reason = r.Reason
		}
	case contract.PostTool, contract.PostToolFailure:
		text, resultType := "", "success"
		if ev.Tool != nil && ev.Tool.Output != nil {
			text = ev.Tool.Output.Text
			if !ev.Tool.Output.OK {
				resultType = "failure"
			}
		}
		if r.ReplaceOutput != nil {
			text = r.ReplaceOutput.Text
		}
		if r.Context != "" {
			text += "\n\n" + contract.EnsureMarked(r.Context)
		}
		if r.Context != "" || r.ReplaceOutput != nil {
			out.ModifiedResult = &toolResult{ResultType: resultType, TextResultForLLM: text}
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return pr.EmptyReply(""), append(dropped, "all")
	}
	return append(b, '\n'), dropped
}
