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

// The lines a session's edits changed, for the card before a full test run.
// One small file per session in <record directory>/changed/<agent>/, written
// on edits and read before shell commands. It is not lever state: it is kept
// whether or not the output levers are on, and like noteEdit it never opens a
// database. Files a week old go at the next session start.

const changedMaxAge = 7 * 24 * time.Hour

func changedPath(recordDirectory string, ev contract.Event) string {
	name := safeName(ev.SessionID)
	if ev.AgentID != "" {
		name += "." + safeName(ev.AgentID)
	}
	return filepath.Join(recordDirectory, "changed", safeName(ev.Agent), name+".json")
}

func loadChanged(file string) delivery.ChangedLines {
	c := delivery.ChangedLines{}
	if data, err := os.ReadFile(file); err == nil && len(data) <= 1<<20 {
		_ = json.Unmarshal(data, &c)
	}
	return c
}

// noteChanged adds placed edits to the session's changed lines. Only edits
// in an indexed checkout arrive here, so nothing else is kept. Two edits at
// once can lose one update; the card then names fewer tests, never wrong ones.
func noteChanged(ev contract.Event, recordDirectory string, edits []fileEdit) {
	if len(edits) == 0 || recordDirectory == "" || ev.SessionID == "" {
		return
	}
	file := changedPath(recordDirectory, ev)
	changed := loadChanged(file)
	for _, edit := range edits {
		changed.Apply(edit.path, edit.ranges, edit.placed)
	}
	data, err := json.Marshal(changed)
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

// sessionChanged is what delivery needs before a shell command: the lines
// this session changed. Nil for anything else, so nothing is read.
func sessionChanged(ev contract.Event, recordDirectory string) delivery.ChangedLines {
	if ev.Kind != contract.PreTool || ev.Tool == nil || ev.Tool.Name != contract.ToolShell || recordDirectory == "" || ev.SessionID == "" {
		return nil
	}
	return loadChanged(changedPath(recordDirectory, ev))
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
