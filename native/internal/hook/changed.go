package hook

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/internal/contract"
)

// The lines a session's edits changed, for the card after a full test run.
// One small file per session in <record directory>/changed/<agent>/, written
// on edits and read for signature and test cards. It is kept whether or not
// the output levers are on. Files a week old go at the next session start.

const (
	changedMaxAge  = 7 * 24 * time.Hour
	maxShellMtimes = 64
)

type changeState struct {
	Lines       delivery.ChangedLines `json:"lines"`
	ShellMtimes map[string]int64      `json:"shell_mtimes,omitempty"`
}

func changedPath(recordDirectory string, ev contract.Event) string {
	name := safeName(ev.SessionID)
	if ev.AgentID != "" {
		name += "." + safeName(ev.AgentID)
	}
	return filepath.Join(recordDirectory, "changed", safeName(ev.Agent), name+".json")
}

func loadChanged(file string) changeState {
	var state changeState
	if data, err := os.ReadFile(file); err == nil && len(data) <= 1<<20 {
		if json.Unmarshal(data, &state) == nil && state.Lines != nil {
			return state
		}
		// Older hooks wrote the line map without a session state wrapper.
		var legacy delivery.ChangedLines
		if json.Unmarshal(data, &legacy) == nil && legacy != nil {
			return changeState{Lines: legacy}
		}
	}
	return changeState{Lines: delivery.ChangedLines{}}
}

// noteChanged adds placed edits to the session's changed lines. Only edits
// in an indexed checkout arrive here, so nothing else is kept. Two edits at
// once can lose one update; the card then names fewer tests, never wrong ones.
func noteChanged(ev contract.Event, recordDirectory string, edits []fileEdit) {
	if len(edits) == 0 || recordDirectory == "" || ev.SessionID == "" {
		return
	}
	file := changedPath(recordDirectory, ev)
	state := loadChanged(file)
	for _, edit := range edits {
		state.Lines.Apply(edit.path, edit.ranges, edit.placed)
	}
	writeChanged(file, state)
}

func noteShellChanged(file string, changes delivery.ChangedLines, mtimes map[string]int64) {
	state := loadChanged(file)
	state.Lines.RecordWorktreeDiff(changes)
	if state.ShellMtimes == nil {
		state.ShellMtimes = map[string]int64{}
	}
	for path, mtime := range mtimes {
		state.ShellMtimes[path] = mtime
	}
	for len(state.ShellMtimes) > maxShellMtimes {
		var oldest string
		for path, mtime := range state.ShellMtimes {
			if oldest == "" || mtime < state.ShellMtimes[oldest] {
				oldest = path
			}
		}
		delete(state.ShellMtimes, oldest)
	}
	writeChanged(file, state)
}

func writeChanged(file string, state changeState) {
	data, err := json.Marshal(state)
	if err != nil || os.MkdirAll(filepath.Dir(file), 0o700) != nil {
		return
	}
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	tmp := file + "." + hex.EncodeToString(suffix[:]) + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil {
		return
	}
	if os.Rename(tmp, file) != nil {
		_ = os.Remove(tmp)
	}
}

// sessionChanged loads edits only for events that can use them in a card.
func sessionChanged(ev contract.Event, recordDirectory string) changeState {
	if recordDirectory == "" || ev.SessionID == "" {
		return changeState{}
	}
	usesChanged := func(tool contract.Tool) bool {
		switch tool.Name {
		case contract.ToolShell, contract.ToolEdit, contract.ToolWrite, contract.ToolPatch:
			return true
		}
		return false
	}
	switch ev.Kind {
	case contract.PostTool, contract.PostToolFailure:
		if ev.Tool != nil && usesChanged(*ev.Tool) {
			return loadChanged(changedPath(recordDirectory, ev))
		}
	case contract.PostToolBatch:
		for _, tool := range ev.Batch[:min(len(ev.Batch), 64)] {
			if usesChanged(tool) {
				return loadChanged(changedPath(recordDirectory, ev))
			}
		}
	}
	return changeState{}
}

// pruneChanged removes week-old session files at a new session's start.
func pruneChanged(ev contract.Event, recordDirectory string, now time.Time) {
	if ev.Kind != contract.SessionStart || (ev.Source != "" && ev.Source != "startup") || recordDirectory == "" {
		return
	}
	dir := filepath.Dir(changedPath(recordDirectory, ev))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for i, e := range entries {
		if i >= 256 {
			return
		}
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > changedMaxAge {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
