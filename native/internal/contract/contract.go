// Package contract holds the normalized hook event and reply that everything
// behind the shim works with. Each agent profile translates its own payloads
// into an Event and turns a Reply back into its own output format.
package contract

import "encoding/json"

// Version of the event and reply shapes.
const Version = 1

type Kind string

const (
	SessionStart    Kind = "session_start"
	Prompt          Kind = "prompt"
	PreTool         Kind = "pre_tool"
	PostTool        Kind = "post_tool"
	PostToolFailure Kind = "post_tool_failure"
	PostToolBatch   Kind = "post_tool_batch"
	PreCompact      Kind = "pre_compact"
	PostCompact     Kind = "post_compact"
	SubagentStart   Kind = "subagent_start"
	Stop            Kind = "stop"
	SessionEnd      Kind = "session_end"
)

// Kinds lists every kind, in the order of the contract table.
var Kinds = []Kind{
	SessionStart, Prompt, PreTool, PostTool, PostToolFailure, PostToolBatch,
	PreCompact, PostCompact, SubagentStart, Stop, SessionEnd,
}

type ToolName string

const (
	ToolRead   ToolName = "read"
	ToolEdit   ToolName = "edit"
	ToolWrite  ToolName = "write"
	ToolPatch  ToolName = "patch"
	ToolShell  ToolName = "shell"
	ToolSearch ToolName = "search"
	ToolGlob   ToolName = "glob"
	ToolOther  ToolName = "other"
)

type Event struct {
	Agent        string    `json:"agent"`
	AgentVersion string    `json:"agent_version"`
	Kind         Kind      `json:"kind"`
	SessionID    string    `json:"session_id"`
	AgentID      string    `json:"agent_id"`
	Cwd          string    `json:"cwd"`
	ProjectID    string    `json:"project_id"`
	Checkout     string    `json:"checkout"`
	Source       string    `json:"source,omitempty"`
	Model        string    `json:"model,omitempty"`
	AgentType    string    `json:"agent_type,omitempty"` // subagent_start: the subagent's type, where the agent says
	Prompt       *PromptIn `json:"prompt,omitempty"`
	Tool         *Tool     `json:"tool,omitempty"`
	Batch        []Tool    `json:"batch,omitempty"`
	Transcript   string    `json:"transcript"`
	// Summary is the compaction summary on post_compact, where the agent gives it.
	Summary    string `json:"summary,omitempty"`
	Background bool   `json:"background"`
	// Learning hooks use these adapter-private fields. The normalized wire contract is unchanged.
	FinalReply         *string `json:"-"`
	CaptureOnly        bool    `json:"-"`
	IncompleteTurn     bool    `json:"-"`
	TranscriptDisabled bool    `json:"-"`
}

type PromptIn struct {
	Text  string `json:"text"`
	Typed bool   `json:"typed"`
}

type Tool struct {
	Name    ToolName    `json:"name"`
	RawName string      `json:"raw_name"`
	Input   ToolInput   `json:"input"`
	Output  *ToolOutput `json:"output,omitempty"`

	// RawInput is the agent's own tool input, kept so a profile can rebuild
	// it when a reply replaces part of the input. Not part of the contract.
	RawInput json.RawMessage `json:"-"`
	// UseID deduplicates native receipts when the host identifies a tool use.
	UseID string `json:"-"`
}

// ToolInput is a union: which fields are set depends on Tool.Name.
type ToolInput struct {
	Path    string      `json:"path,omitempty"`    // read, edit, write, search, glob
	Offset  *int        `json:"offset,omitempty"`  // read
	Limit   *int        `json:"limit,omitempty"`   // read
	Old     *string     `json:"old,omitempty"`     // edit
	New     *string     `json:"new,omitempty"`     // edit
	Content *string     `json:"content,omitempty"` // write
	Files   []PatchFile `json:"files,omitempty"`   // patch
	Command string      `json:"command,omitempty"` // shell
	Pattern string      `json:"pattern,omitempty"` // search, glob
	// Filter is a search's file filter (a glob, or "type:<name>"), when it has one.
	Filter string `json:"filter,omitempty"` // search
}

type PatchFile struct {
	Path  string `json:"path"`
	Kind  string `json:"kind,omitempty"` // "add", "update" or "delete"; empty when unknown
	Hunks []Hunk `json:"hunks"`
}

type Hunk struct {
	Old string `json:"old"`
	New string `json:"new"`
}

type ToolOutput struct {
	// ReadTotalLines is renderer-only metadata for a recovered Read prefix.
	// It never changes the normalized event or reply wire format.
	ReadTotalLines int    `json:"-"`
	Text           string `json:"text"`
	OK             bool   `json:"ok"`
	ExitCode       *int   `json:"exit_code,omitempty"`
	// Interrupted is set on a failure the person caused by stopping the tool.
	Interrupted bool `json:"interrupted,omitempty"`
	// Background is set when the host moved a shell command to the
	// background: OK then only says it started, not how it ended.
	Background bool `json:"-"`
}

type Decision string

const (
	Allow Decision = "allow"
	Deny  Decision = "deny"
)

type Reply struct {
	ConsumePrompt bool        `json:"consume_prompt,omitempty"`
	Context       string      `json:"context,omitempty"`
	Decision      Decision    `json:"decision,omitempty"`
	Reason        string      `json:"reason,omitempty"`
	ReplaceInput  *ToolInput  `json:"replace_input,omitempty"`
	ReplaceOutput *ToolOutput `json:"replace_output,omitempty"`
	PersonLine    string      `json:"person_line,omitempty"`
}

// Empty reports whether the reply asks for nothing. Most replies are empty.
func (r Reply) Empty() bool {
	return !r.ConsumePrompt && r.Context == "" && r.Decision != Deny && r.ReplaceInput == nil &&
		r.ReplaceOutput == nil && r.PersonLine == ""
}
