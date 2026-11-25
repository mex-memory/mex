// Package gemini is the Gemini CLI profile, for API-key and enterprise
// (Vertex AI, Code Assist Standard/Enterprise) users.
//
// Payload and reply shapes follow the Gemini CLI hooks reference
// (https://geminicli.com/docs/hooks/reference/, read 15 Nov 2026). No payload
// here was recorded from a real session yet; release-03-T1 records them.
//
// Gemini CLI has no subagent event. BeforeAgent context lasts this turn
// only; AfterTool context stays in the history. PreCompress is advisory: it
// can show the person a line but adds nothing to the model.
package gemini

import (
	"encoding/json"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
)

const Agent = "gemini"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "SessionStart", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		// continue:false with stopReason stops the turn before the model.
		{Kind: contract.Prompt, NativeEvent: "BeforeAgent", Context: adapter.ChannelSystem, ConsumePrompt: true, PersonLine: true, TimeoutSeconds: 10},
		// hookSpecificOutput.tool_input can rewrite args; MEX doesn't.
		{Kind: contract.PreTool, NativeEvent: "BeforeTool", Context: adapter.ChannelNone, Deny: true, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PostTool, NativeEvent: "AfterTool", Context: adapter.ChannelToolResult, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PostToolFailure, NativeEvent: "AfterTool", Context: adapter.ChannelToolResult, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PreCompact, NativeEvent: "PreCompress", Context: adapter.ChannelNone, PersonLine: true, TimeoutSeconds: 10},
		// decision "deny" on AfterAgent rejects the answer and retries with
		// reason as feedback the model reads.
		{Kind: contract.Stop, NativeEvent: "AfterAgent", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		{Kind: contract.SessionEnd, NativeEvent: "SessionEnd", Context: adapter.ChannelNone, TimeoutSeconds: 5},
	},
	// Exit codes other than 0 and 2 are warnings: a crash doesn't block.
	FailureBlocks: false,
	SubagentID:    "",
	SettingsFile:  ".gemini/settings.json",
	PolicySwitches: []string{
		"settings.json: hooksConfig.enabled = false",
		"settings.json: security.folderTrust.enabled with an untrusted folder (project hooks don't run)",
		"system settings.json (enterprise): hooks set by the administrator",
	},
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

type toolResponse struct {
	LLMContent json.RawMessage `json:"llmContent"`
	Error      json.RawMessage `json:"error"`
}

type payload struct {
	SessionID      string          `json:"session_id"`
	TranscriptPath *string         `json:"transcript_path"`
	Cwd            string          `json:"cwd"`
	Source         string          `json:"source"`
	Prompt         string          `json:"prompt"`
	FinalReply     *string         `json:"prompt_response"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	ToolResponse   *toolResponse   `json:"tool_response"`
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
	if p.TranscriptPath != nil {
		ev.Transcript = *p.TranscriptPath
	}
	switch kind {
	case contract.SessionStart:
		ev.Source = p.Source
	case contract.Prompt:
		ev.Prompt = &contract.PromptIn{Text: p.Prompt, Typed: true}
	case contract.Stop:
		ev.FinalReply = p.FinalReply
	case contract.PreTool:
		t := parseTool(p.ToolName, p.ToolInput)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.ToolName, p.ToolInput)
		out := responseOutput(p.ToolResponse)
		t.Output = &out
		ev.Tool = &t
		if !out.OK {
			ev.Kind = contract.PostToolFailure
		}
	}
	return ev, nil
}

type toolInput struct {
	Command      string  `json:"command"`
	FilePath     string  `json:"file_path"`
	AbsolutePath string  `json:"absolute_path"`
	Path         string  `json:"path"`
	Dir          string  `json:"dir_path"`
	Content      *string `json:"content"`
	OldString    *string `json:"old_string"`
	NewString    *string `json:"new_string"`
	Pattern      string  `json:"pattern"`
	Offset       *int    `json:"offset"`
	Limit        *int    `json:"limit"`
}

func first(s ...string) string {
	for _, v := range s {
		if v != "" {
			return v
		}
	}
	return ""
}

// parseTool maps Gemini CLI's built-in tool names to contract tools.
func parseTool(name string, raw json.RawMessage) contract.Tool {
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: raw}
	var in toolInput
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &in)
	}
	path := first(in.FilePath, in.AbsolutePath, in.Path)
	switch name {
	case "run_shell_command":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: in.Command}
	case "read_file":
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: path, Offset: in.Offset, Limit: in.Limit}
	case "write_file":
		t.Name = contract.ToolWrite
		t.Input = contract.ToolInput{Path: path, Content: in.Content}
	case "replace":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: path, Old: in.OldString, New: in.NewString}
	case "search_file_content", "grep_search":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: first(in.Dir, in.Path)}
	case "glob":
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: first(in.Dir, in.Path)}
	}
	return t
}

// responseOutput reads tool_response: llmContent is what the model saw, and a
// non-empty error marks a failure. Gemini sends no exit code.
func responseOutput(r *toolResponse) contract.ToolOutput {
	if r == nil {
		return contract.ToolOutput{OK: true}
	}
	text := ""
	if len(r.LLMContent) > 0 {
		var s string
		if json.Unmarshal(r.LLMContent, &s) == nil {
			text = s
		} else {
			text = string(r.LLMContent)
		}
	}
	failed := len(r.Error) > 0 && string(r.Error) != "null" && string(r.Error) != `""` && string(r.Error) != "{}"
	if failed {
		var e struct {
			Message string `json:"message"`
		}
		var s string
		if json.Unmarshal(r.Error, &e) == nil && e.Message != "" {
			text = e.Message
		} else if json.Unmarshal(r.Error, &s) == nil {
			text = s
		}
	}
	return contract.ToolOutput{Text: text, OK: !failed}
}

type output struct {
	Continue           *bool           `json:"continue,omitempty"`
	StopReason         string          `json:"stopReason,omitempty"`
	Decision           string          `json:"decision,omitempty"`
	Reason             string          `json:"reason,omitempty"`
	SystemMessage      string          `json:"systemMessage,omitempty"`
	HookSpecificOutput *specificOutput `json:"hookSpecificOutput,omitempty"`
}

type specificOutput struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	support, ok := caps.Support(ev.Kind)
	if !ok || r.Empty() {
		return pr.EmptyReply(""), nil
	}
	var dropped []string
	if r.ConsumePrompt {
		if ev.Kind == contract.Prompt && support.ConsumePrompt {
			stop := false
			return marshal(output{Continue: &stop, StopReason: r.PersonLine}), nil
		}
		dropped = append(dropped, "consume_prompt")
	}
	out := output{}
	if r.Context != "" {
		if support.Context == adapter.ChannelNone {
			dropped = append(dropped, "context")
		} else {
			out.HookSpecificOutput = &specificOutput{HookEventName: support.NativeEvent, AdditionalContext: contract.EnsureMarked(r.Context)}
		}
	}
	if r.Decision == contract.Deny {
		if support.Deny {
			out.Decision = "deny"
			out.Reason = r.Reason
		} else {
			dropped = append(dropped, "decision")
		}
	}
	if r.ReplaceInput != nil {
		dropped = append(dropped, "replace_input")
	}
	if r.ReplaceOutput != nil {
		dropped = append(dropped, "replace_output")
	}
	if r.PersonLine != "" {
		if support.PersonLine {
			out.SystemMessage = r.PersonLine
		} else {
			dropped = append(dropped, "person_line")
		}
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
