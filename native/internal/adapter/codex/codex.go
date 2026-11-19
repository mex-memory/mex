// Package codex is the Codex profile.
//
// Payload and reply shapes follow the Codex hooks reference (12 Nov 2026) and
// payloads recorded from a real Codex session on Windows.
package codex

import (
	"encoding/json"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	cmdoutput "github.com/mex-memory/mex/native/output"
)

const Agent = "codex"

func init() { adapter.Register(Profile{}) }

type Profile struct{}

var caps = adapter.Capabilities{
	Agent: Agent,
	Kinds: []adapter.KindSupport{
		{Kind: contract.SessionStart, NativeEvent: "SessionStart", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.Prompt, NativeEvent: "UserPromptSubmit", Context: adapter.ChannelSystem, ConsumePrompt: true, PersonLine: true, TimeoutSeconds: 10},
		// Rewriting input needs permissionDecision "allow", which would skip
		// the person's approval: a reply may only replace input together
		// with Decision allow, and the wrapper (internal/hook/wrap_lever.go)
		// only does so for commands Codex would run without asking.
		{Kind: contract.PreTool, NativeEvent: "PreToolUse", Context: adapter.ChannelSystem, Deny: true, ReplaceInput: true, TimeoutSeconds: 10},
		// decision "block" replaces the tool result the model sees.
		{Kind: contract.PostTool, NativeEvent: "PostToolUse", Context: adapter.ChannelSystem, ReplaceOutput: true, TimeoutSeconds: 10},
		// Codex has no failure event: a failed command is a PostToolUse whose
		// output reports a non-zero exit code.
		{Kind: contract.PostToolFailure, NativeEvent: "PostToolUse", Context: adapter.ChannelSystem, TimeoutSeconds: 10},
		{Kind: contract.PreCompact, NativeEvent: "PreCompact", Context: adapter.ChannelNone, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.PostCompact, NativeEvent: "PostCompact", Context: adapter.ChannelNone, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.SubagentStart, NativeEvent: "SubagentStart", Context: adapter.ChannelSystem, PersonLine: true, TimeoutSeconds: 10},
		{Kind: contract.Stop, NativeEvent: "Stop", Context: adapter.ChannelNone, Deny: true, PersonLine: true, TimeoutSeconds: 10},
		// SessionEnd defaults to 1 s and allows at most 3. On Windows Codex starts
		// every hook through PowerShell (about 0.5 s), so 1 s is too tight.
		{Kind: contract.SessionEnd, NativeEvent: "SessionEnd", Context: adapter.ChannelNone, TimeoutSeconds: 3},
	},
	FailureBlocks: false,
	SubagentID:    "agent_id",
	SettingsFile:  ".codex/hooks.json",
	PolicySwitches: []string{
		"config.toml: [features] hooks = false",
		"config.toml: allow_managed_hooks_only = true",
		"requirements.toml: allow_managed_hooks_only = true",
	},
}

func (Profile) Capabilities() adapter.Capabilities { return caps }

func (Profile) Command(binary, nativeEvent string) adapter.Command {
	return adapter.Command{Path: binary, Args: []string{Agent, nativeEvent}}
}

func (Profile) EmptyReply(string) []byte { return []byte("{}\n") }

type payload struct {
	SessionID      string          `json:"session_id"`
	TranscriptPath *string         `json:"transcript_path"`
	Cwd            string          `json:"cwd"`
	AgentID        string          `json:"agent_id"`
	Source         string          `json:"source"`
	Model          string          `json:"model"`
	AgentType      string          `json:"agent_type"`
	Prompt         string          `json:"prompt"`
	ToolName       string          `json:"tool_name"`
	ToolUseID      string          `json:"tool_use_id"`
	ToolInput      json.RawMessage `json:"tool_input"`
	ToolResponse   json.RawMessage `json:"tool_response"`
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
		Agent:     Agent,
		Kind:      kind,
		SessionID: p.SessionID,
		AgentID:   p.AgentID,
		Cwd:       p.Cwd,
	}
	if p.TranscriptPath != nil {
		ev.Transcript = *p.TranscriptPath
	}
	switch kind {
	case contract.SessionStart:
		ev.Source = p.Source
		ev.Model = p.Model
		ev.AgentType = p.AgentType
	case contract.Prompt:
		// Codex doesn't say whether a prompt was typed or pasted.
		ev.Prompt = &contract.PromptIn{Text: p.Prompt, Typed: true}
	case contract.PreTool:
		t := parseTool(p.ToolName, p.ToolInput, p.Cwd)
		ev.Tool = &t
	case contract.PostTool:
		t := parseTool(p.ToolName, p.ToolInput, p.Cwd)
		if original, _, wrapped := cmdoutput.Unwrap(t.Input.Command); wrapped && t.Name == contract.ToolShell {
			t.Input.Command = original
		}
		out := responseOutput(p.ToolResponse)
		t.Output = &out
		ev.Tool = &t
		if !out.OK {
			ev.Kind = contract.PostToolFailure
		}
	}
	if ev.Tool != nil {
		ev.Tool.UseID = p.ToolUseID
	}
	return ev, nil
}

type codexInput struct {
	Command json.RawMessage `json:"command"`
}

func parseTool(name string, rawInput json.RawMessage, cwd string) contract.Tool {
	t := contract.Tool{Name: contract.ToolOther, RawName: name, RawInput: rawInput}
	var in codexInput
	if len(rawInput) > 0 {
		_ = json.Unmarshal(rawInput, &in)
	}
	command := commandString(in.Command)
	switch name {
	case "Bash", "exec_command", "shell", "local_shell":
		t.Name = contract.ToolShell
		t.Input = contract.ToolInput{Command: command}
	case "apply_patch":
		t.Name = contract.ToolPatch
		t.Input = contract.ToolInput{Files: patchFiles(shellparse.ParsePatch(command, cwd))}
	}
	return t
}

// commandString accepts the documented string form and the older argv form
// (["bash", "-lc", "..."]), where the script is the last element.
func commandString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var argv []string
	if json.Unmarshal(raw, &argv) == nil && len(argv) > 0 {
		return argv[len(argv)-1]
	}
	return ""
}

func patchFiles(patch []shellparse.PatchFile) []contract.PatchFile {
	files := make([]contract.PatchFile, 0, len(patch))
	for _, f := range patch {
		pf := contract.PatchFile{Path: f.Path, Kind: string(f.Kind), Hunks: []contract.Hunk{}}
		for _, c := range f.Chunks {
			pf.Hunks = append(pf.Hunks, contract.Hunk{Old: joinLines(c.Before), New: joinLines(c.After)})
		}
		files = append(files, pf)
		if f.MoveTo != "" {
			files = append(files, contract.PatchFile{Path: f.MoveTo, Kind: "add", Hunks: []contract.Hunk{}})
		}
	}
	return files
}

func joinLines(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	s := lines[0]
	for _, l := range lines[1:] {
		s += "\n" + l
	}
	return s + "\n"
}

// replaceInput rebuilds Codex's tool input with a new shell command, in the
// form Codex sent it (a string, or argv whose last element is the script).
// Only a shell command can be replaced, and only with Decision allow.
func replaceInput(support adapter.KindSupport, tool *contract.Tool, in contract.ToolInput) (json.RawMessage, bool) {
	if !support.ReplaceInput || tool == nil || tool.Name != contract.ToolShell || in.Command == "" {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	if len(tool.RawInput) > 0 && json.Unmarshal(tool.RawInput, &fields) != nil {
		return nil, false
	}
	var command any = in.Command
	var argv []string
	if raw, ok := fields["command"]; ok && json.Unmarshal(raw, &argv) == nil {
		if len(argv) == 0 {
			return nil, false
		}
		argv = append([]string(nil), argv...)
		argv[len(argv)-1] = in.Command
		command = argv
	}
	encoded, err := json.Marshal(command)
	if err != nil {
		return nil, false
	}
	fields["command"] = encoded
	b, err := json.Marshal(fields)
	return b, err == nil
}

// responseOutput reads a tool response: a string for shell and patch tools,
// with Codex's "Exit code / Wall time / Output" header when it ran a process.
func responseOutput(raw json.RawMessage) contract.ToolOutput {
	var s string
	if len(raw) == 0 {
		return contract.ToolOutput{OK: true}
	}
	if json.Unmarshal(raw, &s) != nil {
		return contract.ToolOutput{Text: string(raw), OK: true}
	}
	body, code := shellparse.Output(s)
	return contract.ToolOutput{Text: body, OK: code == nil || *code == 0, ExitCode: code}
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
}

func (pr Profile) Render(ev contract.Event, r contract.Reply) ([]byte, []string) {
	support, ok := caps.Support(ev.Kind)
	if !ok || r.Empty() {
		return pr.EmptyReply(""), nil
	}
	var dropped []string
	if r.ConsumePrompt {
		if ev.Kind == contract.Prompt && support.ConsumePrompt {
			b, err := json.Marshal(output{Decision: "block", Reason: r.PersonLine})
			if err != nil {
				return pr.EmptyReply(""), []string{"consume_prompt"}
			}
			return append(b, '\n'), nil
		}
		dropped = append(dropped, "consume_prompt")
	}
	out := output{}
	spec := &specificOutput{HookEventName: support.NativeEvent}

	if r.Context != "" {
		if support.Context == adapter.ChannelNone {
			dropped = append(dropped, "context")
		} else {
			spec.AdditionalContext = contract.EnsureMarked(r.Context)
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
		if updated, ok := replaceInput(support, ev.Tool, *r.ReplaceInput); ok && r.Decision == contract.Allow && spec.PermissionDecision == "" {
			spec.PermissionDecision = "allow"
			spec.UpdatedInput = updated
		} else {
			dropped = append(dropped, "replace_input")
		}
	}

	if r.ReplaceOutput != nil {
		if support.ReplaceOutput && out.Decision == "" {
			out.Decision = "block"
			out.Reason = r.ReplaceOutput.Text
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

	if spec.AdditionalContext != "" || spec.PermissionDecision != "" || spec.UpdatedInput != nil {
		out.HookSpecificOutput = spec
	}
	b, err := json.Marshal(out)
	if err != nil {
		return pr.EmptyReply(""), append(dropped, "all")
	}
	return append(b, '\n'), dropped
}
