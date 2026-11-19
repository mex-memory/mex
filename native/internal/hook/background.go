package hook

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// The background process does MEX's slow work (re-parsing edited files, jobs).
// Commands restart it when work waits; the hook starts it at session start, so
// edits made only through agents still get processed. The hook never waits:
// it starts `node <cli> __ensure-background` detached, and that process
// decides whether a background process is needed.

// launcher is <MEX home>/bin/launcher.json, written by the CLI
// (src/hooks/shim/launcher.ts).
type launcher struct {
	Version int    `json:"version"`
	Node    string `json:"node"`
	Entry   string `json:"entry"`
}

const launcherVersion = 1

func (h home) launcher() (launcher, bool) {
	path := filepath.Join(h.mex, "bin", "launcher.json")
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > 4096 {
		return launcher{}, false
	}
	f, err := os.Open(path)
	if err != nil {
		return launcher{}, false
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 4096 || !os.SameFile(before, stat) {
		return launcher{}, false
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(data) > 4096 {
		return launcher{}, false
	}
	var l launcher
	if json.Unmarshal(data, &l) != nil || l.Version != launcherVersion || !filepath.IsAbs(l.Node) || !filepath.IsAbs(l.Entry) {
		return launcher{}, false
	}
	return l, true
}

// workWaiting checks small filesystem markers without opening either database.
func workWaiting(h home, recordDirectory string) bool {
	return exists(filepath.Join(h.mex, "jobs-pending")) || weeklyLearningDue(h.mex) || (recordDirectory != "" &&
		(exists(filepath.Join(recordDirectory, "index-pending")) || exists(filepath.Join(recordDirectory, "judge-pending")) ||
			exists(filepath.Join(recordDirectory, "filter-pending")) || exists(filepath.Join(recordDirectory, "working-set-pending")) ||
			exists(filepath.Join(recordDirectory, "native-pending")) || exists(filepath.Join(recordDirectory, "refresh-pending")) ||
			exists(filepath.Join(recordDirectory, "ledger-pending")) ||
			watchingCompaction(recordDirectory) || waitingCompactOffers(recordDirectory)))
}

func watchingCompaction(recordDirectory string) bool {
	return recordDirectory != "" && exists(filepath.Join(recordDirectory, "compaction-watch"))
}

func weeklyLearningDue(home string) bool {
	marker, err := os.Lstat(filepath.Join(home, "learning-refresh-due"))
	return err == nil && marker.Mode().IsRegular() && marker.Size() == 0 && !marker.ModTime().After(time.Now())
}

// startBackground starts MEX's Node side detached when work is waiting.
// Errors are ignored: the next `mex` command restarts it anyway.
var startBackground = func(h home, recordDirectory string) {
	if !workWaiting(h, recordDirectory) {
		return
	}
	l, ok := h.launcher()
	if !ok || !exists(l.Entry) {
		return
	}
	cmd := exec.Command(l.Node, l.Entry, "__ensure-background")
	cmd.Dir = h.mex
	detach(cmd)
	if cmd.Start() == nil {
		_ = cmd.Process.Release()
	}
}
