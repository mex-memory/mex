// Package opencode is the OpenCode profile.
//
// OpenCode has no command hooks; it runs JavaScript plugins. MEX installs one
// small plugin (src/install/opencode-plugin.ts) that starts mex-hook for each
// plugin hook below and passes a JSON payload it builds from the hook's
// arguments, so the payload shape here is MEX's own. The plugin catches every
// error, so a broken MEX never stops OpenCode.
//
// There is no prompt hook. Context reaches the model appended to a tool's
// output (tool.execute.after) and through the compaction prompt
// (experimental.session.compacting), which keeps MEX's ids across compaction.
// A plugin blocks a tool by throwing from tool.execute.before. Session idle
// can't continue a turn, so the Stop check isn't available.
package opencode

import (
	"encoding/json"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
)

const Agent = "opencode"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "session.created", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.Prompt, NativeEvent: "chat.message", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.PreTool, NativeEvent: "tool.execute.before", Context: adapter.ChannelNone, Deny: true, TimeoutSeconds: 10},
		{Kind: contract.PostTool, NativeEvent: "tool.execute.after", Context: adapter.ChannelToolResult, ReplaceOutput: true, TimeoutSeconds: 10},
		{Kind: contract.PostToolFailure, NativeEvent: "tool.execute.after", Context: adapter.ChannelToolResult, TimeoutSeconds: 10},
		{Kind: contract.PreCompact, NativeEvent: "experimental.session.compacting", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.PostCompact, NativeEvent: "session.compacted", Context: adapter.ChannelNone, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "session.idle", Context: adapter.ChannelNone, TimeoutSeconds: 10},
	},
	FailureBlocks: false,
	SubagentID:    "parent_session_id",
	SettingsFile:  ".config/opencode/plugin/mex.js",
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

// payload is what MEX's plugin sends.
type payload struct {
	SessionID       string          `json:"session_id"`
	ParentSessionID string          `json:"parent_session_id"`
	Cwd             string          `json:"cwd"`
	Prompt          *string         `json:"prompt"`
	FinalReply      *string         `json:"final_reply"`
	Tool            string          `json:"tool"`
	Args            json.RawMessage `json:"args"`
	Output          *string         `json:"output"`
	Error           *string         `json:"error"`
	Metadata        struct {
		Exit *int `json:"exit"`
	} `json:"metadata"`
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
	ev := contract.Event{Agent: Agent, Kind: kind, SessionID: p.SessionID, AgentID: p.ParentSessionID, Cwd: p.Cwd}
	if p.ParentSessionID != "" {
		// A child session is OpenCode's subagent; keep the parent's session.
		ev.SessionID, ev.AgentID = p.ParentSessionID, p.SessionID
	}
	switch kind {
	case contract.Prompt:
		if p.Prompt == nil {
			return contract.Event{}, adapter.ErrSkip
		}
		ev.Prompt = &contract.PromptIn{Text: *p.Prompt, Typed: true}
	case contract.Stop:
		ev.FinalReply = p.FinalReply
	case contract.PreTool:
		t := parseTool(p.Tool, p.Args, p.Cwd)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.Tool, p.Args, p.Cwd)
		out := contract.ToolOutput{OK: true, ExitCode: p.Metadata.Exit}
		if p.Output != nil {
			out.Text = *p.Output
		}
		if p.Error != nil {
			out.OK = false
			if out.Text == "" {
				out.Text = *p.Error
			}
		}
		if p.Metadata.Exit != nil && *p.Metadata.Exit != 0 {
			out.OK = false
		}
		t.Output = &out
		ev.Tool = &t
		if !out.OK {
			ev.Kind = contract.PostToolFailure
		}
	}
	return ev, nil
}

type args struct {
	FilePath  string  `json:"filePath"`
	Offset    *int    `json:"offset"`
	Limit     *int    `json:"limit"`
	OldString *string `json:"oldString"`
	NewString *string `json:"newString"`
	Content   *string `json:"content"`
	Command   string  `json:"command"`
	Pattern   string  `json:"pattern"`
	Path      string  `json:"path"`
}

func parseTool(name string, raw json.RawMessage, cwd string) contract.Tool {
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: raw}
	var in args
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
	case "read":
		t.Name = contract.ToolRead
		t.Input = contract.ToolInput{Path: abs(in.FilePath), Offset: in.Offset, Limit: in.Limit}
	case "edit":
		t.Name = contract.ToolEdit
		t.Input = contract.ToolInput{Path: abs(in.FilePath), Old: in.OldString, New: in.NewString}
	case "write":
		t.Name = contract.ToolWrite
		t.Input = contract.ToolInput{Path: abs(in.FilePath), Content: in.Content}
	case "bash":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: in.Command}
	case "grep":
		t.Name = contract.ToolSearch
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: abs(in.Path)}
	case "glob":
		t.Name = contract.ToolGlob
		t.Input = contract.ToolInput{Pattern: in.Pattern, Path: abs(in.Path)}
	}
	return t
}

// reply is what MEX's plugin reads: deny throws from tool.execute.before,
// output replaces the tool output, append is added after it, and context is
// pushed into the compaction prompt.
type reply struct {
	Deny    string  `json:"deny,omitempty"`
	Output  *string `json:"output,omitempty"`
	Append  string  `json:"append,omitempty"`
	Context string  `json:"context,omitempty"`
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	if r.Empty() {
		return pr.EmptyReply(""), nil
	}
	r, dropped := adapter.Narrow(caps, ev.Kind, r)
	out := reply{}
	switch ev.Kind {
	case contract.PreTool:
		if r.Decision == contract.Deny {
			out.Deny = r.Reason
			if out.Deny == "" {
				out.Deny = "[mex] blocked"
			}
		}
	case contract.PostTool, contract.PostToolFailure:
		if r.ReplaceOutput != nil {
			text := r.ReplaceOutput.Text
			out.Output = &text
		}
		if r.Context != "" {
			out.Append = contract.EnsureMarked(r.Context)
		}
	case contract.PreCompact:
		if r.Context != "" {
			out.Context = contract.EnsureMarked(r.Context)
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return pr.EmptyReply(""), append(dropped, "all")
	}
	return append(b, '\n'), dropped
}
