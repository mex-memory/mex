package hook

// Token levers (plan sheet 35): smaller reads (L2), trimmed shell output (L3)
// and the Codex wrapper (L4). They change only what the model sees, never
// what runs, and every one of them hides nothing: the full text is always one
// command away.
//
// The levers keep a little state per session in
// <record directory>/levers/<agent>/<session>[.<subagent>].json:
// which files were outlined in this context, which were edited, which
// commands failed, and hashed words of the last prompt. Prompt text itself is
// never stored.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/outline"
	"github.com/mex-memory/mex/native/output"
	localrecord "github.com/mex-memory/mex/native/record"
)

const leverStateMaxAge = 7 * 24 * time.Hour

// leverState is one session's (or subagent's) lever memory.
type leverState struct {
	// Context counts compactions and clears: "once per context" rules reset
	// when it changes.
	Context  int                     `json:"context"`
	Outlined map[string]*outlineMark `json:"outlined,omitempty"`
	// Edited: files this session changed, which are never outlined.
	Edited map[string]bool `json:"edited,omitempty"`
	// Failed: hashes of shell commands that failed in this context; running
	// one again is reproducing, so its output is left whole.
	Failed map[string]bool `json:"failed,omitempty"`
	// Words: hashes of the last prompt's words, for "named in the prompt"
	// and the outline's slices. Investigating: the last prompt asked to
	// reproduce, investigate or debug, so output stays whole.
	Words         []uint64 `json:"words,omitempty"`
	Investigating bool     `json:"investigating,omitempty"`
	Topic         []uint64 `json:"topic,omitempty"`
	TopicCheckout string   `json:"topic_checkout,omitempty"`
	CompactNudged bool     `json:"compact_nudged,omitempty"`
	// Changed: the lines this session's edits changed, by file, for the card
	// before a full test run.
	Changed delivery.ChangedLines `json:"changed,omitempty"`
}

type outlineMark struct {
	Context int  `json:"context"`
	Lines   int  `json:"lines"`
	Ranged  bool `json:"ranged,omitempty"`  // the agent has read part of it since
	Stopped bool `json:"stopped,omitempty"` // an edit or full write was stopped once
	Forced  bool `json:"forced,omitempty"`  // a full read was turned into a range
}

func leverStatePath(recordDirectory string, ev contract.Event) string {
	name := safeName(ev.SessionID)
	if ev.AgentID != "" {
		name += "." + safeName(ev.AgentID)
	}
	return filepath.Join(recordDirectory, "levers", safeName(ev.Agent), name+".json")
}

func loadLeverState(file string) *leverState {
	s := &leverState{}
	if data, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(data, s)
	}
	return s
}

// save replaces the file whole. Parallel hook calls can lose an update; the
// levers only ever lose a saving that way, never evidence.
func (s *leverState) save(file string) {
	data, err := json.Marshal(s)
	if err != nil || os.MkdirAll(filepath.Dir(file), 0o700) != nil {
		return
	}
	tmp := file + "." + randomSuffix() + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil {
		return
	}
	if os.Rename(tmp, file) != nil {
		_ = os.Remove(tmp)
	}
}

func randomSuffix() string {
	return strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "")
}

func pruneLeverStates(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > leverStateMaxAge {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// leverOptions come from the environment of the agent that runs the hook.
type leverOptions struct {
	raw       bool   // MEX_RAW=1: show everything as it is
	noOutline bool   // MEX_OUTLINE=0: no outlines
	shell     string // SHELL: the shell Codex runs commands through, outside Windows
	binary    string // this program, for the Codex wrapper; "" finds it
}

// levers runs after the checkout is known to be on. Its reply is merged with
// delivery's; it never fails the call.
func levers(ev contract.Event, h home, recordDirectory string, now time.Time, captureOn bool) (reply contract.Reply, observation *localrecord.LeverObservation) {
	defer func() {
		if recover() != nil {
			reply = contract.Reply{}
			observation = nil
		}
	}()
	if recordDirectory == "" || ev.SessionID == "" {
		return contract.Reply{}, nil
	}
	switch ev.Kind {
	case contract.PostCompact:
		if ev.AgentID != "" {
			return contract.Reply{}, nil
		}
	case contract.SessionStart, contract.Prompt, contract.PreTool, contract.PostTool, contract.PostToolFailure:
	default:
		return contract.Reply{}, nil
	}
	file := leverStatePath(recordDirectory, ev)
	state := loadLeverState(file)
	changed := false
	switch ev.Kind {
	case contract.PostCompact:
		if state.CompactNudged {
			state.CompactNudged = false
			changed = true
		}
	case contract.SessionStart:
		if ev.Source == "compact" || ev.Source == "clear" {
			state.Context++
			state.Failed = nil
			state.CompactNudged = false
			if ev.Source == "clear" {
				state.Topic = nil
			}
			changed = true
		}
		if ev.Source == "" || ev.Source == "startup" {
			pruneLeverStates(filepath.Dir(file), now)
		}
	case contract.Prompt:
		if ev.Prompt != nil {
			state.Words, state.Investigating = promptWords(ev.Prompt.Text)
			if captureOn {
				reply.PersonLine = compactNudge(ev, h, state)
			}
			changed = true
		}
	case contract.PostToolFailure:
		if ev.Tool != nil && ev.Tool.Name == contract.ToolShell && ev.Tool.Input.Command != "" {
			if state.Failed == nil {
				state.Failed = map[string]bool{}
			}
			state.Failed[commandKey(ev.Tool.Input.Command)] = true
			changed = true
		}
	case contract.PostTool:
		if ev.Tool == nil || ev.Tool.Output == nil || !ev.Tool.Output.OK {
			break
		}
		for _, p := range editedPaths(*ev.Tool) {
			if state.Edited == nil {
				state.Edited = map[string]bool{}
			}
			state.Edited[pathKey(p)] = true
			changed = true
		}
		switch {
		case ev.Agent == "claude-code" && ev.Tool.Name == contract.ToolShell:
			reply = trimShell(ev, h, recordDirectory, state, now)
		case ev.Agent == "claude-code" && ev.Tool.Name == contract.ToolRead:
			var c bool
			reply, c = outlineRead(ev, h, recordDirectory, state, now)
			changed = changed || c
		}
	case contract.PreTool:
		if ev.Tool == nil {
			break
		}
		var c bool
		switch ev.Agent {
		case "claude-code":
			reply, c = outlineGuard(ev, h, recordDirectory, state)
		case "codex":
			reply = wrapCodexCommand(ev, h, recordDirectory, state)
		}
		changed = changed || c
	}
	if changed {
		state.save(file)
	}
	if captureOn {
		if measured := observeLever(ev, recordDirectory, state, reply); measured != nil && !capture.Scripted(ev.Agent, h.env) {
			observation = measured
		}
	}
	return reply, observation
}

// trimShell replaces a successful noisy command's output with its trim, after
// saving the full text. Without a saved copy nothing is trimmed.
func trimShell(ev contract.Event, h home, recordDirectory string, state *leverState, now time.Time) contract.Reply {
	if h.levers.raw || state.Investigating || ev.ProjectID == "" {
		return contract.Reply{}
	}
	command, text := ev.Tool.Input.Command, ev.Tool.Output.Text
	if len(text) <= output.MinChars || state.Failed[commandKey(command)] || !output.Noisy(command) ||
		leverOff(recordDirectory, localrecord.LeverShellTrim) {
		return contract.Reply{}
	}
	trimmed, ok := output.TrimAndSave(text, 0, func() (int, error) {
		return output.Save(recordDirectory, ev.ProjectID, text, output.SavedMeta{Command: command, Agent: ev.Agent, SessionID: ev.SessionID}, now)
	})
	if !ok {
		return contract.Reply{}
	}
	return contract.Reply{ReplaceOutput: &contract.ToolOutput{Text: trimmed, OK: true}}
}

// editedPaths lists files a successful tool call changed.
func editedPaths(tool contract.Tool) []string {
	switch tool.Name {
	case contract.ToolEdit, contract.ToolWrite:
		if tool.Input.Path != "" {
			return []string{tool.Input.Path}
		}
	case contract.ToolPatch:
		var out []string
		for _, f := range tool.Input.Files {
			if f.Path != "" {
				out = append(out, f.Path)
			}
		}
		return out
	}
	return nil
}

// pathKey compares paths the way the file system does on Windows and macOS
// (case-insensitively); a rare false match only means one outline less.
func pathKey(p string) string {
	return strings.ToLower(strings.ReplaceAll(p, `\`, "/"))
}

func commandKey(command string) string {
	return strings.Join(strings.Fields(command), " ")
}

func wordHash(w string) uint64 { return outline.WordHash(w) }

var investigating = []string{"reproduce", "reproducing", "repro", "investigate", "investigating", "debug", "debugging", "bisect", "flaky", "root cause", "full output", "whole output", "raw output"}

// promptWords hashes a prompt's words (three letters or more, and file names
// whole), and says whether it asks to reproduce or investigate.
func promptWords(text string) ([]uint64, bool) {
	lower := strings.ToLower(text)
	inv := false
	for _, w := range investigating {
		if strings.Contains(lower, w) {
			inv = true
			break
		}
	}
	seen := map[uint64]bool{}
	var out []uint64
	add := func(w string) {
		if len(w) < 3 || len(out) >= 400 {
			return
		}
		h := wordHash(w)
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	for _, field := range strings.FieldsFunc(text, func(r rune) bool {
		return r == ' ' || r == '\n' || r == '\t' || r == '\r' || r == '`' || r == '"' || r == '\'' || r == '(' || r == ')' || r == ',' || r == ';' || r == '<' || r == '>' || r == '[' || r == ']'
	}) {
		field = strings.TrimRight(field, ".:?!")
		if strings.ContainsAny(field, "./\\") {
			// A path or file name: its base name and its stem count too.
			base := field[strings.LastIndexAny(field, `/\`)+1:]
			add(base)
			if dot := strings.LastIndex(base, "."); dot > 0 {
				add(base[:dot])
			}
		}
		for _, w := range identifiers(field) {
			add(w)
		}
	}
	return out, inv
}

// identifiers splits text into identifier-like words.
func identifiers(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool {
		return !(r == '_' || r == '$' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z')
	})
}

// mergeReplies adds a lever's reply to delivery's.
func mergeReplies(a, b contract.Reply) contract.Reply {
	if b.Empty() && b.Decision == "" {
		return a
	}
	if a.Context != "" && b.Context != "" {
		a.Context += "\n\n" + b.Context
	} else if b.Context != "" {
		a.Context = b.Context
	}
	if a.Decision != contract.Deny && b.Decision != "" {
		a.Decision, a.Reason = b.Decision, b.Reason
	}
	if a.ReplaceInput == nil {
		a.ReplaceInput = b.ReplaceInput
	}
	if a.ReplaceOutput == nil {
		a.ReplaceOutput = b.ReplaceOutput
	}
	if a.PersonLine == "" {
		a.PersonLine = b.PersonLine
	}
	if a.Decision == contract.Deny {
		// A denied call runs nothing: there is no input to replace.
		a.ReplaceInput = nil
	}
	return a
}

// noteChanged adds placed edits to the session's changed lines. Only edits
// in an indexed checkout arrive here, so nothing else is kept.
func noteChanged(ev contract.Event, recordDirectory string, edits []fileEdit) {
	if len(edits) == 0 || recordDirectory == "" || ev.SessionID == "" {
		return
	}
	file := leverStatePath(recordDirectory, ev)
	state := loadLeverState(file)
	if state.Changed == nil {
		state.Changed = delivery.ChangedLines{}
	}
	for _, edit := range edits {
		state.Changed.Apply(edit.path, edit.ranges, edit.placed)
	}
	state.save(file)
}

// sessionChanged is what delivery needs before a shell command: the lines
// this session changed. Nil for anything else, so no state is read.
func sessionChanged(ev contract.Event, recordDirectory string) delivery.ChangedLines {
	if ev.Kind != contract.PreTool || ev.Tool == nil || ev.Tool.Name != contract.ToolShell || recordDirectory == "" || ev.SessionID == "" {
		return nil
	}
	return loadLeverState(leverStatePath(recordDirectory, ev)).Changed
}
