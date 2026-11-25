// Package cursor is the Cursor profile (Cursor IDE agent and the `agent` CLI).
//
// Payload and reply shapes follow the Cursor hooks reference
// (https://cursor.com/docs/agent/hooks, read 15 Nov 2026). No payload here was
// recorded from a real session yet; release-03-T1 records them.
//
// What Cursor can't do, and so MEX doesn't declare:
//   - No prompt moment: beforeSubmitPrompt can only let a prompt through or
//     block it, so context there is dropped. Typed controls still work.
//   - No compaction event after the fact: the recovery block waits for the
//     next tool result (postToolUse additional_context).
//   - A subagent can only be allowed or denied: subagentStart takes no context.
package cursor

import (
	"encoding/json"
	"strings"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
)

const Agent = "cursor"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		// sessionStart takes additional_context; Cursor's schema accepts
		// user_message there but doesn't show it, so no person line.
		{Kind: contract.SessionStart, NativeEvent: "sessionStart", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		// continue:false blocks the prompt and user_message tells the person why.
		{Kind: contract.Prompt, NativeEvent: "beforeSubmitPrompt", Context: adapter.ChannelNone, ConsumePrompt: true, PersonLine: true, TimeoutSeconds: 10},
		// updated_input exists, but MEX never rewrites input it can't show the
		// person, as on Codex.
		{Kind: contract.PreTool, NativeEvent: "preToolUse", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		// additional_context is added to the tool result the model reads.
		// updated_mcp_tool_output only works for MCP tools, so no ReplaceOutput.
		{Kind: contract.PostTool, NativeEvent: "postToolUse", Context: adapter.ChannelToolResult, TimeoutSeconds: 10},
		{Kind: contract.PostToolFailure, NativeEvent: "postToolUseFailure", Context: adapter.ChannelToolResult, TimeoutSeconds: 10},
		// preCompact is observational: user_message only.
		{Kind: contract.PreCompact, NativeEvent: "preCompact", Context: adapter.ChannelNone, PersonLine: true, TimeoutSeconds: 10},
		// A subagent can only be allowed or denied; there is no brief.
		{Kind: contract.SubagentStart, NativeEvent: "subagentStart", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		// followup_message continues the turn with text the model reads.
		{Kind: contract.Stop, NativeEvent: "stop", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "afterAgentResponse", Context: adapter.ChannelNone, TimeoutSeconds: 5},
		{Kind: contract.SessionEnd, NativeEvent: "sessionEnd", Context: adapter.ChannelNone, TimeoutSeconds: 5},
	},
	// Crashes and timeouts fail open unless failClosed is set, which MEX never
	// sets. Invalid JSON on a permission hook (preToolUse, subagentStart) blocks,
	// so the shim must always print valid JSON there.
	FailureBlocks: false,
	SubagentID:    "subagent_id",
	SettingsFile:  ".cursor/hooks.json",
	PolicySwitches: []string{
		"/etc/cursor/hooks.json (enterprise, Linux): replaces user hooks by priority",
		"/Library/Application Support/Cursor/hooks.json (enterprise, macOS)",
		`C:\ProgramData\Cursor\hooks.json (enterprise, Windows)`,
	},
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

// nativeName accepts Claude Code's event names too: Cursor runs Claude's
// hooks by default, so a payload can arrive on a "PreToolUse" command line.
func nativeName(ev string) string {
	switch ev {
	case "UserPromptSubmit":
		return "beforeSubmitPrompt"
	case "PostToolUseFailure":
		return "postToolUseFailure"
	}
	if ev == "" {
		return ev
	}
	return strings.ToLower(ev[:1]) + ev[1:]
}

type payload struct {
	ConversationID string          `json:"conversation_id"`
	SessionID      string          `json:"session_id"`
	CursorVersion  string          `json:"cursor_version"`
	Model          string          `json:"model"`
	TranscriptPath json.RawMessage `json:"transcript_path"`
	WorkspaceRoots []string        `json:"workspace_roots"`
	Cwd            string          `json:"cwd"`
	Prompt         string          `json:"prompt"`
	Response       *string         `json:"text"`
	ToolName       string          `json:"tool_name"`
	ToolInput      json.RawMessage `json:"tool_input"`
	ToolOutput     json.RawMessage `json:"tool_output"`
	ErrorMessage   string          `json:"error_message"`
	SubagentID     string          `json:"subagent_id"`
	SubagentType   string          `json:"subagent_type"`
	ComposerMode   string          `json:"composer_mode"`
}

func (Profile) Parse(nativeEvent string, raw []byte) (contract.Event, error) {
	kind, ok := caps.KindFor(nativeName(nativeEvent))
	if !ok {
		return contract.Event{}, adapter.ErrUnknownEvent
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return contract.Event{}, err
	}
	ev := contract.Event{
		Agent:        Agent,
		AgentVersion: p.CursorVersion,
		Kind:         kind,
		SessionID:    p.ConversationID,
		Cwd:          p.Cwd,
	}
	if ev.SessionID == "" {
		ev.SessionID = p.SessionID
	}
	if ev.Cwd == "" && len(p.WorkspaceRoots) > 0 {
		ev.Cwd = p.WorkspaceRoots[0]
	}
	if len(p.TranscriptPath) != 0 {
		ev.TranscriptDisabled = string(p.TranscriptPath) == "null"
		if !ev.TranscriptDisabled {
			if err := json.Unmarshal(p.TranscriptPath, &ev.Transcript); err != nil {
				return contract.Event{}, err
			}
		}
	}
	if nativeName(nativeEvent) == "afterAgentResponse" {
		ev.FinalReply, ev.CaptureOnly, ev.AgentID = p.Response, true, p.SubagentID
		return ev, nil
	}
	switch kind {
	case contract.SessionStart:
		// Cursor has no resume or compact source: every start is a startup.
		ev.Source = "startup"
		ev.Model = p.Model
	case contract.Prompt:
		ev.Prompt = &contract.PromptIn{Text: p.Prompt, Typed: true}
	case contract.PreTool:
		t := parseTool(p.ToolName, p.ToolInput)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.ToolName, p.ToolInput)
		t.Output = &contract.ToolOutput{Text: outputText(p.ToolOutput), OK: true}
		ev.Tool = &t
	case contract.PostToolFailure:
		t := parseTool(p.ToolName, p.ToolInput)
		t.Output = &contract.ToolOutput{Text: p.ErrorMessage, OK: false}
		ev.Tool = &t
	case contract.SubagentStart:
		ev.AgentID = p.SubagentID
		ev.AgentType = p.SubagentType
	}
	return ev, nil
}

type toolInput struct {
	Command   string  `json:"command"`
	FilePath  string  `json:"file_path"`
	Path      string  `json:"path"`
	Target    string  `json:"target_file"`
	Content   *string `json:"content"`
	Contents  *string `json:"contents"`
	OldString *string `json:"old_string"`
	NewString *string `json:"new_string"`
	Pattern   string  `json:"pattern"`
	Glob      string  `json:"glob_pattern"`
	Offset    *int    `json:"offset"`
	Limit     *int    `json:"limit"`
}

func (in toolInput) path() string {
	for _, p := range []string{in.FilePath, in.Path, in.Target} {
		if p != "" {
			return p
		}
	}
	return ""
}

// parseTool maps Cursor's tool names (the values its matcher tests: Shell,
// Read, Write, ...) to contract tools. Unknown tools stay "other".
func parseTool(name string, raw json.RawMessage) contract.Tool {
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: raw}
	var in toolInput
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &in)
	}
	switch name {
	case "Shell", "Bash", "run_terminal_cmd":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: in.Command}
	case "Read", "read_file":
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: in.path(), Offset: in.Offset, Limit: in.Limit}
	case "Write", "write":
		content := in.Content
		if content == nil {
			content = in.Contents
		}
		t.Name = contract.ToolWrite
		t.Input = contract.ToolInput{Path: in.path(), Content: content}
	case "Edit", "StrReplace", "search_replace", "edit_file":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: in.path(), Old: in.OldString, New: in.NewString}
	case "Grep", "grep":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: in.path()}
	case "Glob", "glob_file_search":
		pattern := in.Pattern
		if pattern == "" {
			pattern = in.Glob
		}
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: pattern, Path: in.path()}
	}
	return t
}

// outputText reads tool_output, which is a string for built-in tools and
// may be JSON for MCP tools.
func outputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

type output struct {
	Permission        string `json:"permission,omitempty"`
	Continue          *bool  `json:"continue,omitempty"`
	UserMessage       string `json:"user_message,omitempty"`
	AgentMessage      string `json:"agent_message,omitempty"`
	AdditionalContext string `json:"additional_context,omitempty"`
	FollowupMessage   string `json:"followup_message,omitempty"`
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
			return marshal(output{Continue: &stop, UserMessage: r.PersonLine}), nil
		}
		dropped = append(dropped, "consume_prompt")
	}
	out := output{}
	if r.Context != "" {
		if support.Context == adapter.ChannelNone {
			dropped = append(dropped, "context")
		} else {
			out.AdditionalContext = contract.EnsureMarked(r.Context)
		}
	}
	if r.Decision == contract.Deny {
		switch {
		case !support.Deny:
			dropped = append(dropped, "decision")
		case ev.Kind == contract.PreTool:
			// agent_message reaches the model; user_message the person.
			out.Permission = "deny"
			out.AgentMessage = r.Reason
		case ev.Kind == contract.SubagentStart:
			out.Permission = "deny"
			out.UserMessage = r.Reason
		case ev.Kind == contract.Stop:
			out.FollowupMessage = r.Reason
		}
	}
	if r.ReplaceInput != nil {
		dropped = append(dropped, "replace_input")
	}
	if r.ReplaceOutput != nil {
		dropped = append(dropped, "replace_output")
	}
	if r.PersonLine != "" {
		if support.PersonLine && out.UserMessage == "" {
			out.UserMessage = r.PersonLine
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
