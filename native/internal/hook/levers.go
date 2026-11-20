package hook

// Token levers (plan sheet 35): smaller reads (L2), trimmed shell output (L3)
// and the Codex wrapper (L4). They change only what the model sees, never
// what runs, and every one of them hides nothing: the full text is always one
// command away.
//
// The levers keep transactional state per session and subagent in hooks.db:
// which files were outlined in this context, which were edited, which
// commands failed, and hashed words of the last prompt. Prompt text itself is
// never stored.

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/outline"
	"github.com/mex-memory/mex/native/output"
	localrecord "github.com/mex-memory/mex/native/record"
)

// leverState is one session's (or subagent's) lever memory.
type leverState struct {
	guard *localrecord.OutlineGuard
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
	// and outline slices. WholeOutput is an explicit presentation instruction.
	Words         []uint64 `json:"words,omitempty"`
	WholeOutput   bool     `json:"whole_output,omitempty"`
	Reproducing   bool     `json:"-"`
	Topic         []uint64 `json:"topic,omitempty"`
	TopicCheckout string   `json:"topic_checkout,omitempty"`
	CompactNudged bool     `json:"compact_nudged,omitempty"`
}

type outlineMark struct {
	Hash    string `json:"hash,omitempty"`
	Full    bool   `json:"full,omitempty"`
	Context int    `json:"context"`
	Lines   int    `json:"lines"`
	Ranged  bool   `json:"ranged,omitempty"`  // the agent has read part of it since
	Stopped bool   `json:"stopped,omitempty"` // an edit or full write was stopped once
	Forced  bool   `json:"forced,omitempty"`  // a full read was turned into a range
}

// leverOptions come from the environment of the agent that runs the hook.
type leverOptions struct {
	enabled   *bool
	raw       bool   // MEX_RAW=1: show everything as it is
	noOutline bool   // MEX_OUTLINE=0: no outlines
	noBump    bool   // MEX_SPEED_BUMP=0: no speed bump
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
	enabled := h.outputLevers()
	nudgeEvent := nudgeEligible(ev, h, captureOn)
	if !enabled && !nudgeEvent {
		return
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, recordDirectory))
	if err != nil {
		return
	}
	defer hooks.Close()
	prune := ev.Kind == contract.SessionStart && (ev.Source == "" || ev.Source == "startup")
	// Nudge memory is separate from presentation, including while output is off.
	if nudgeEvent {
		err = hooks.UpdateLeverState(ev.Agent, ev.SessionID, ev.AgentID, now, prune, true, func(data []byte, _ *localrecord.OutlineGuard) ([]byte, error) {
			state := &leverState{}
			if len(data) > 0 {
				if err := json.Unmarshal(data, state); err != nil {
					return nil, err
				}
			}
			if ev.Kind == contract.PostCompact || ev.Kind == contract.SessionStart && (ev.Source == "compact" || ev.Source == "clear") {
				state.CompactNudged = false
				if ev.Source == "clear" {
					state.Topic = nil
				}
			}
			if ev.Kind == contract.Prompt && captureOn {
				reply.PersonLine = compactNudge(ev, h, state)
			}
			return json.Marshal(state)
		})
		if err != nil {
			reply.PersonLine = ""
		}
	}
	if !enabled {
		return
	}
	nudgeLine := reply.PersonLine
	intent, intentErr := hooks.Intent(ev.SessionID, ev.AgentID)
	err = hooks.UpdateLeverState(ev.Agent, ev.SessionID, ev.AgentID, now, prune, false, func(data []byte, guard *localrecord.OutlineGuard) ([]byte, error) {
		state := &leverState{guard: guard, Reproducing: intentErr != nil || intent == "reproducing"}
		if len(data) > 0 {
			if err := json.Unmarshal(data, state); err != nil {
				return nil, err
			}
		}
		rearmed, _ := ledgerOff(recordDirectory, localrecord.LeverOutline)
		if rearmed > guard.RearmedAt {
			store := guard.StoreOriginal
			*guard = localrecord.OutlineGuard{RearmedAt: rearmed, StoreOriginal: store}
		}
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
				guard.ClearOriginals = true
				state.Outlined = nil
				state.Failed = nil
				state.CompactNudged = false
				if ev.Source == "clear" {
					state.Topic = nil
				}
				changed = true
			}

		case contract.Prompt:
			if ev.Prompt != nil && ev.Prompt.Typed {
				state.Words, state.WholeOutput = promptWords(ev.Prompt.Text)

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

		if enabled && captureOn {
			if measured := observeLever(ev, recordDirectory, state, reply); measured != nil && !capture.Scripted(ev.Agent, h.env) {
				observation = measured
			}
		}
		if changed {
			return json.Marshal(state)
		}
		return nil, nil
	})
	if err != nil {
		return contract.Reply{PersonLine: nudgeLine}, nil
	}
	if reply.PersonLine == "" {
		reply.PersonLine = nudgeLine
	}
	return reply, observation
}

// trimShell replaces a successful noisy command's output with its trim, after
// saving the full text. Without a saved copy nothing is trimmed.
func trimShell(ev contract.Event, h home, recordDirectory string, state *leverState, now time.Time) contract.Reply {
	if h.levers.raw || (state.WholeOutput || state.Reproducing) || ev.ProjectID == "" {
		return contract.Reply{}
	}
	command, text := ev.Tool.Input.Command, ev.Tool.Output.Text
	if len(text) <= output.MinChars || state.Failed[commandKey(command)] || !output.Noisy(command) ||
		leverOff(recordDirectory, localrecord.LeverShellTrim) {
		return contract.Reply{}
	}
	trimmed, ok := output.PresentAndSave(command, text, 0, func() (int, error) {
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

var wholeOutputRequests = []string{"full output", "whole output", "raw output", "untrimmed"}

// promptWords hashes a prompt's words (three letters or more, and file names
// whole), and says whether it explicitly asks for whole output.
func promptWords(text string) ([]uint64, bool) {
	lower := strings.ToLower(text)
	inv := false
	for _, w := range wholeOutputRequests {
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
