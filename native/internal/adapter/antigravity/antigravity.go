// Package antigravity is the Antigravity profile (the `agy` CLI; the IDE and
// app read the same hooks.json).
//
// Payload and reply shapes follow the Antigravity hooks reference
// (https://antigravity.google/docs/hooks, read 15 Nov 2026). No payload here
// was recorded from a real session yet; release-03-T1 records them.
//
// Context goes in injectSteps as an ephemeralMessage: the channel closest to
// a background fact. MEX never uses userMessage, which would speak as the
// person, nor errorMessage, which marks a `-p` run as failed.
//
// Antigravity has no compaction events, no subagent ids, no session end, and
// PostToolUse carries no tool output and accepts no reply fields.
package antigravity

import (
	"encoding/json"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
)

const Agent = "antigravity"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "SessionStart", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		// PreInvocation runs before every model call. The first call of a turn
		// (invocationNum 0) is the prompt moment; later ones are skipped.
		// terminationBehavior "terminate" stops the call before the model.
		{Kind: contract.Prompt, NativeEvent: "PreInvocation", Context: adapter.ChannelSystem, ConsumePrompt: true, TimeoutSeconds: 10},
		// "overwrite" can rewrite args, but MEX doesn't rewrite input.
		{Kind: contract.PreTool, NativeEvent: "PreToolUse", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		// PostToolUse has no output in or out: it is observed only.
		{Kind: contract.PostTool, NativeEvent: "PostToolUse", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.PostToolFailure, NativeEvent: "PostToolUse", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		// decision "continue" keeps the turn going; reason reaches the model
		// as a system message.
		{Kind: contract.Stop, NativeEvent: "Stop", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
	},
	// Not documented. Treated as fail-open until release-03-T1 checks it.
	FailureBlocks: false,
	SubagentID:    "",
	SettingsFile:  ".gemini/config/hooks.json",
	PolicySwitches: []string{
		`hooks.json: "enabled": false on the MEX hook`,
		"Settings > Customizations > Hooks (app and IDE toggle)",
	},
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

// EmptyReply: PreToolUse and Stop require a decision. "allow" lets a tool run
// through the normal approval flow (auto_approve would skip it), and any Stop
// decision other than "continue" lets the turn end.
func (Profile) EmptyReply(nativeEvent string) []byte {
	switch nativeEvent {
	case "PreToolUse", "Stop":
		return []byte(`{"decision":"allow"}` + "\n")
	}
	return []byte("{}\n")
}

type toolCall struct {
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

type payload struct {
	ConversationID string    `json:"conversationId"`
	WorkspacePaths []string  `json:"workspacePaths"`
	TranscriptPath string    `json:"transcriptPath"`
	ModelName      string    `json:"modelName"`
	LastUserInput  string    `json:"lastUserInput"`
	ToolCall       *toolCall `json:"toolCall"`
	Error          string    `json:"error"`
	InvocationNum  *int      `json:"invocationNum"`
	FullyIdle      bool      `json:"fullyIdle"`
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
	ev := contract.Event{
		Agent:      Agent,
		Kind:       kind,
		SessionID:  p.ConversationID,
		Transcript: p.TranscriptPath,
	}
	// No cwd: the first workspace path stands in for it.
	if len(p.WorkspacePaths) > 0 {
		ev.Cwd = p.WorkspacePaths[0]
	}
	switch kind {
	case contract.SessionStart:
		ev.Source = "startup"
		ev.Model = p.ModelName
	case contract.Prompt:
		if p.InvocationNum != nil && *p.InvocationNum > 0 {
			return contract.Event{}, adapter.ErrSkip
		}
		ev.Prompt = &contract.PromptIn{Text: p.LastUserInput, Typed: true}
	case contract.Stop:
		ev.IncompleteTurn = !p.FullyIdle
	case contract.PreTool:
		t := parseTool(p.ToolCall)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.ToolCall)
		// No tool output is sent; an empty error means success.
		t.Output = &contract.ToolOutput{Text: p.Error, OK: p.Error == ""}
		ev.Tool = &t
		if p.Error != "" {
			ev.Kind = contract.PostToolFailure
		}
	}
	return ev, nil
}

type args struct {
	CommandLine        string  `json:"CommandLine"`
	Command            string  `json:"command"`
	AbsolutePath       string  `json:"AbsolutePath"`
	TargetFile         string  `json:"TargetFile"`
	FilePath           string  `json:"file_path"`
	CodeContent        *string `json:"CodeContent"`
	Content            *string `json:"content"`
	TargetContent      *string `json:"TargetContent"`
	ReplacementContent *string `json:"ReplacementContent"`
	Query              string  `json:"Query"`
	Pattern            string  `json:"Pattern"`
	SearchPath         string  `json:"SearchPath"`
	SearchDirectory    string  `json:"SearchDirectory"`
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstPtr(s ...*string) *string {
	for _, v := range s {
		if v != nil {
			return v
		}
	}
	return nil
}

// parseTool maps Antigravity's tool names (run_command, view_file, ...) to
// contract tools. Argument names are PascalCase in Antigravity's tools; the
// snake_case ones are accepted in case a release changes them.
func parseTool(c *toolCall) contract.Tool {
	if c == nil {
		return contract.Tool{Name: contract.ToolOther}
	}
	t := contract.Tool{Name: contract.ToolOther, RawName: c.Name, RawInput: c.Args}
	var a args
	if len(c.Args) > 0 {
		_ = json.Unmarshal(c.Args, &a)
	}
	path := first(a.TargetFile, a.AbsolutePath, a.FilePath)
	switch c.Name {
	case "run_command":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: first(a.CommandLine, a.Command)}
	case "view_file":
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: path}
	case "write_to_file":
		t.Name = contract.ToolWrite
		t.Input = contract.ToolInput{Path: path, Content: firstPtr(a.CodeContent, a.Content)}
	case "replace_file_content":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: path, Old: a.TargetContent, New: a.ReplacementContent}
	case "multi_replace_file_content":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: path}
	case "grep_search":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: first(a.Query, a.Pattern), Path: first(a.SearchPath, a.SearchDirectory)}
	case "find_by_name":
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: a.Pattern, Path: first(a.SearchDirectory, a.SearchPath)}
	}
	return t
}

type step struct {
	EphemeralMessage string `json:"ephemeralMessage"`
}

type output struct {
	Decision            string `json:"decision,omitempty"`
	Reason              string `json:"reason,omitempty"`
	InjectSteps         []step `json:"injectSteps,omitempty"`
	TerminationBehavior string `json:"terminationBehavior,omitempty"`
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	support, ok := caps.Support(ev.Kind)
	if !ok || r.Empty() {
		return pr.EmptyReply(support.NativeEvent), nil
	}
	var dropped []string
	if r.ConsumePrompt {
		if ev.Kind == contract.Prompt && support.ConsumePrompt {
			// No channel shows the person a line without failing a -p run.
			out := output{TerminationBehavior: "terminate"}
			if r.PersonLine != "" {
				return marshal(out), []string{"person_line"}
			}
			return marshal(out), nil
		}
		dropped = append(dropped, "consume_prompt")
	}
	out := output{}
	switch ev.Kind {
	case contract.PreTool, contract.Stop:
		out.Decision = "allow"
	}
	if r.Context != "" {
		if support.Context == adapter.ChannelNone {
			dropped = append(dropped, "context")
		} else {
			out.InjectSteps = []step{{EphemeralMessage: contract.EnsureMarked(r.Context)}}
		}
	}
	if r.Decision == contract.Deny {
		switch {
		case !support.Deny:
			dropped = append(dropped, "decision")
		case ev.Kind == contract.PreTool:
			out.Decision = "deny"
			out.Reason = r.Reason
		case ev.Kind == contract.Stop:
			out.Decision = "continue"
			out.Reason = r.Reason
		}
	}
	if r.ReplaceInput != nil {
		dropped = append(dropped, "replace_input")
	}
	if r.ReplaceOutput != nil {
		dropped = append(dropped, "replace_output")
	}
	if r.PersonLine != "" {
		dropped = append(dropped, "person_line")
	}
	return marshal(out), dropped
}

func marshal(o output) []byte {
	b, err := json.Marshal(o)
	if err != nil {
		return []byte("{}\n")
	}
	return append(b, '\n')
}
