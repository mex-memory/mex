package hook

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
	data, err := os.ReadFile(filepath.Join(h.mex, "bin", "launcher.json"))
	if err != nil {
		return launcher{}, false
	}
	var l launcher
	if json.Unmarshal(data, &l) != nil || l.Version != launcherVersion || l.Node == "" || l.Entry == "" {
		return launcher{}, false
	}
	return l, true
}

// workWaiting reports whether jobs or index re-parses are waiting. Both markers
// are plain files, so this costs two stats.
func workWaiting(h home, recordDirectory string) bool {
	return exists(filepath.Join(h.mex, "jobs-pending")) || (recordDirectory != "" && exists(filepath.Join(recordDirectory, "index-pending")))
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
