// Package claude is the Claude Code profile.
//
// Payload and reply shapes follow the Claude Code hooks reference, read on
// 12 Nov 2026. Hooks are registered in exec form (command plus args, no shell).
package claude

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
)

const Agent = "claude-code"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "SessionStart", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.Prompt, NativeEvent: "UserPromptSubmit", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PreTool, NativeEvent: "PreToolUse", Context: adapter.ChannelSystem, Deny: true, ReplaceInput: true, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PostTool, NativeEvent: "PostToolUse", Context: adapter.ChannelToolResult, ReplaceOutput: true, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PostToolFailure, NativeEvent: "PostToolUseFailure", Context: adapter.ChannelToolResult, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PostToolBatch, NativeEvent: "PostToolBatch", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		// PreCompact's stdout becomes compaction instructions; MEX steers it as
		// plain text, not as reply context.
		{Kind: contract.PreCompact, NativeEvent: "PreCompact", Context: adapter.ChannelNone, PersonLine: true, TimeoutSeconds: 10},
		// PostCompact can't add context; the recovery block goes out on
		// SessionStart with source "compact".
		{Kind: contract.PostCompact, NativeEvent: "PostCompact", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.SubagentStart, NativeEvent: "SubagentStart", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "Stop", Context: adapter.ChannelSystem, Deny: true, PersonLine: true, TimeoutSeconds: 10},
		// SessionEnd hooks share a 1.5 s budget by default.
		{Kind: contract.SessionEnd, NativeEvent: "SessionEnd", Context: adapter.ChannelNone, TimeoutSeconds: 1},
	},
	FailureBlocks:  false,
	SubagentID:     "agent_id",
	SettingsFile:   ".claude/settings.json",
	PolicySwitches: []string{"managed-settings.json: allowManagedHooksOnly", "settings.json: disableAllHooks"},
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

// payload is the union of the fields MEX reads from any Claude Code hook.
type payload struct {
	SessionID      string          `json:"session_id"`
	TranscriptPath string          `json:"transcript_path"`
	Cwd            string          `json:"cwd"`
	HookEventName  string          `json:"hook_event_name"`
	AgentID        string          `json:"agent_id"`
	Source         string          `json:"source"`
	Prompt         string          `json:"prompt"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	ToolResponse   json.RawMessage `json:"tool_response"`
	Error          string          `json:"error"`
	ToolCalls      []batchCall     `json:"tool_calls"`
}

type batchCall struct {
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
	ev := contract.Event{
		Agent:      Agent,
		Kind:       kind,
		SessionID:  p.SessionID,
		AgentID:    p.AgentID,
		Cwd:        p.Cwd,
		Transcript: p.TranscriptPath,
	}
	switch kind {
	case contract.SessionStart:
		ev.Source = p.Source
	case contract.Prompt:
		// Claude Code doesn't say whether a prompt was typed or pasted.
		ev.Prompt = &contract.PromptIn{Text: p.Prompt, Typed: true}
	case contract.PreTool:
		t := parseTool(p.ToolName, p.ToolInput)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.ToolName, p.ToolInput)
		t.Output = &contract.ToolOutput{Text: responseText(p.ToolResponse), OK: true}
		ev.Tool = &t
	case contract.PostToolFailure:
		t := parseTool(p.ToolName, p.ToolInput)
		t.Output = &contract.ToolOutput{Text: p.Error, OK: false, ExitCode: exitCode(p.Error)}
		ev.Tool = &t
	case contract.PostToolBatch:
		ev.Batch = make([]contract.Tool, 0, len(p.ToolCalls))
		for _, c := range p.ToolCalls {
			t := parseTool(c.ToolName, c.ToolInput)
			t.Output = &contract.ToolOutput{Text: responseText(c.ToolResponse), OK: true}
			ev.Batch = append(ev.Batch, t)
		}
	}
	return ev, nil
}

// claudeInput is the union of the built-in tools' input fields.
type claudeInput struct {
	FilePath  string  `json:"file_path"`
	Offset    *int    `json:"offset"`
	Limit     *int    `json:"limit"`
	OldString *string `json:"old_string"`
	NewString *string `json:"new_string"`
	Content   *string `json:"content"`
	Command   string  `json:"command"`
	Pattern   string  `json:"pattern"`
	Path      string  `json:"path"`
}

func parseTool(name string, rawInput json.RawMessage) contract.Tool {
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: rawInput}
	var in claudeInput
	if len(rawInput) > 0 {
		_ = json.Unmarshal(rawInput, &in)
	}
	switch name {
	case "Read":
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: in.FilePath, Offset: in.Offset, Limit: in.Limit}
	case "Edit":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: in.FilePath, Old: in.OldString, New: in.NewString}
	case "Write":
		t.Name = contract.ToolWrite
		t.Input = contract.ToolInput{Path: in.FilePath, Content: in.Content}
	case "Bash", "PowerShell":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: in.Command}
	case "Grep":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: in.Path}
	case "Glob":
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: in.Path}
	}
	return t
}

// responseText flattens a tool response to text. PostToolUse sends the tool's
// structured result; PostToolBatch sends the serialized text the model saw.
func responseText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var shell struct {
		Stdout *string `json:"stdout"`
		Stderr string  `json:"stderr"`
	}
	if json.Unmarshal(raw, &shell) == nil && shell.Stdout != nil {
		if shell.Stderr == "" {
			return *shell.Stdout
		}
		return *shell.Stdout + "\n" + shell.Stderr
	}
	return string(raw)
}

// exitCode reads "Exit code N" from the first line of a shell failure.
func exitCode(errText string) *int {
	line, _, _ := strings.Cut(errText, "\n")
	rest, ok := strings.CutPrefix(line, "Exit code ")
	if !ok {
		return nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(rest))
	if err != nil {
		return nil
	}
	return &n
}

type output struct {
	Decision           string          `json:"decision,omitempty"`
	Reason             string          `json:"reason,omitempty"`
	SystemMessage      string          `json:"systemMessage,omitempty"`
	HookSpecificOutput *specificOutput `json:"hookSpecificOutput,omitempty"`
}

type specificOutput struct {
	HookEventName            string          `json:"hookEventName"`
	AdditionalContext        string          `json:"additionalContext,omitempty"`
	PermissionDecision       string          `json:"permissionDecision,omitempty"`
	PermissionDecisionReason string          `json:"permissionDecisionReason,omitempty"`
	UpdatedInput             json.RawMessage `json:"updatedInput,omitempty"`
	UpdatedToolOutput        json.RawMessage `json:"updatedToolOutput,omitempty"`
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	support, ok := caps.Support(ev.Kind)
	if !ok || r.Empty() {
		return pr.EmptyReply(""), nil
	}
	var dropped []string
	out := output{}
	spec := &specificOutput{HookEventName: support.NativeEvent}

	if r.Context != "" {
		if support.Context == adapter.ChannelNone {
			dropped = append(dropped, "context")
		} else {
			spec.AdditionalContext = r.Context
		}
	}

	if r.Decision == contract.Deny {
		switch {
		case !support.Deny:
			dropped = append(dropped, "decision")
		case ev.Kind == contract.PreTool:
			spec.PermissionDecision = "deny"
			spec.PermissionDecisionReason = r.Reason
		case ev.Kind == contract.Stop:
			out.Decision = "block"
			out.Reason = r.Reason
		}
	}

	if r.ReplaceInput != nil {
		if updated, ok := replaceInput(support, ev.Tool, *r.ReplaceInput); ok {
			// No permission decision on purpose: "allow" would skip the
			// person's permission prompt. Without one, Claude Code applies the
			// new input and runs its usual permission checks against it.
			spec.UpdatedInput = updated
		} else {
			dropped = append(dropped, "replace_input")
		}
	}

	if r.ReplaceOutput != nil {
		if updated, ok := replaceOutput(support, ev.Tool, *r.ReplaceOutput); ok {
			spec.UpdatedToolOutput = updated
		} else {
			dropped = append(dropped, "replace_output")
		}
	}

	if r.PersonLine != "" {
		if support.PersonLine {
			out.SystemMessage = r.PersonLine
		} else {
			dropped = append(dropped, "person_line")
		}
	}

	if spec.AdditionalContext != "" || spec.PermissionDecision != "" || spec.UpdatedInput != nil || spec.UpdatedToolOutput != nil {
		out.HookSpecificOutput = spec
	}
	b, err := json.Marshal(out)
	if err != nil {
		return pr.EmptyReply(""), append(dropped, "all")
	}
	return append(b, '\n'), dropped
}

// replaceInput rebuilds the agent's own tool input with the replaced fields.
// Claude Code replaces the whole input object, so unchanged fields are kept.
func replaceInput(support adapter.KindSupport, tool *contract.Tool, in contract.ToolInput) (json.RawMessage, bool) {
	if !support.ReplaceInput || tool == nil {
		return nil, false
	}
	fields := map[string]any{}
	if len(tool.RawInput) > 0 && json.Unmarshal(tool.RawInput, &fields) != nil {
		return nil, false
	}
	set := func(key string, v any) { fields[key] = v }
	switch tool.Name {
	case contract.ToolShell:
		if in.Command == "" {
			return nil, false
		}
		set("command", in.Command)
	case contract.ToolRead:
		if in.Path != "" {
			set("file_path", in.Path)
		}
		if in.Offset != nil {
			set("offset", *in.Offset)
		}
		if in.Limit != nil {
			set("limit", *in.Limit)
		}
	case contract.ToolEdit:
		if in.Old != nil {
			set("old_string", *in.Old)
		}
		if in.New != nil {
			set("new_string", *in.New)
		}
	case contract.ToolWrite:
		if in.Content != nil {
			set("content", *in.Content)
		}
	case contract.ToolSearch, contract.ToolGlob:
		if in.Pattern != "" {
			set("pattern", in.Pattern)
		}
		if in.Path != "" {
			set("path", in.Path)
		}
	default:
		return nil, false
	}
	b, err := json.Marshal(fields)
	return b, err == nil
}

// replaceOutput builds updatedToolOutput. Its value must match the tool's own
// output shape, which MEX only knows for the shell tools.
func replaceOutput(support adapter.KindSupport, tool *contract.Tool, out contract.ToolOutput) (json.RawMessage, bool) {
	if !support.ReplaceOutput || tool == nil || tool.Name != contract.ToolShell {
		return nil, false
	}
	b, err := json.Marshal(map[string]any{
		"stdout": out.Text, "stderr": "", "interrupted": false, "isImage": false,
	})
	return b, err == nil
}
