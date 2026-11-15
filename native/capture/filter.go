package capture

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// FilterSession is metadata only. Replies remain in the host transcript;
// neither replies nor model requests belong in the capture journal.
type FilterSession struct {
	Version    int    `json:"version"`
	Project    string `json:"project_id"`
	Checkout   string `json:"checkout"`
	Agent      string `json:"agent"`
	Session    string `json:"session_id"`
	Seen       string `json:"seen_at"`
	Finished   bool   `json:"finished"`
	Transcript string `json:"transcript"`
}

// filterMetadata records activity even on hooks that have no journal row.
// SessionEnd is the only finish signal; Stop fires after ordinary replies.
func filterMetadata(ev contract.Event, env Env) error {
	if ev.AgentID != "" || (ev.Agent != "claude-code" && ev.Agent != "codex") {
		return nil
	}
	// The hook already touches its heartbeat on every call. Do not add file
	// replacement to the no-op tool path merely to record the same activity.
	switch ev.Kind {
	case contract.SessionStart, contract.Prompt, contract.PreCompact, contract.SessionEnd:
	default:
		return nil
	}
	s := FilterSession{1, ev.ProjectID, ev.Checkout, ev.Agent, ev.SessionID, now(env).UTC().Format(time.RFC3339Nano), ev.Kind == contract.SessionEnd, ev.Transcript}
	name := place.ShortHash(ev.ProjectID + "\x00" + ev.SessionID)
	if s.Transcript == "" {
		var prior FilterSession
		if readJSON(filepath.Join(env.RecordDirectory, "filter-sessions", name+".json"), &prior) == nil && prior.Version == 1 && prior.Project == s.Project && prior.Checkout == s.Checkout && prior.Session == s.Session && prior.Agent == s.Agent {
			s.Transcript = prior.Transcript
		}
	}
	if err := filterFile(env.RecordDirectory, "filter-sessions", name, s); err != nil {
		return err
	}
	if ev.Kind != contract.SessionStart && ev.Kind != contract.PreCompact {
		return nil
	}
	return filterFile(env.RecordDirectory, "filter-pending", place.ShortHash(ev.Checkout), map[string]any{
		"version": 1, "project_id": ev.ProjectID, "checkout": ev.Checkout,
		"agent": ev.Agent, "generation": now(env).UTC().Format(time.RFC3339Nano),
		"session_id": ev.SessionID,
	})
}

// Root-relative atomic replacement refuses symlinks and never writes Node tables.
func filterFile(directory, folder, name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > 16<<10 {
		return errRedirected
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := root.MkdirAll(folder, 0o700); err != nil {
		return err
	}
	info, err := root.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errRedirected
	}
	tmp := filepath.Join(folder, ".request-"+rand.Text())
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(tmp, filepath.Join(folder, name+".json"))
}
