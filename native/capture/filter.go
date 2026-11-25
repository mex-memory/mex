package capture

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/mex-memory/mex/native/internal/captureprofile"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const filterFileBytes = 16 << 10

// FilterSession is metadata only. Reply text and model requests do not belong
// in the capture journal.
type FilterSession struct {
	Version    int    `json:"version"`
	Project    string `json:"project_id"`
	Checkout   string `json:"checkout"`
	Agent      string `json:"agent"`
	Session    string `json:"session_id"`
	Seen       string `json:"seen_at"`
	Finished   bool   `json:"finished"`
	Transcript string `json:"transcript"`
	Branch     string `json:"branch,omitempty"`
	Head       string `json:"head,omitempty"`
	PositionAt string `json:"position_at,omitempty"`
	Idle       bool   `json:"idle,omitempty"`
	PromptAt   string `json:"prompt_at,omitempty"`
	OutsideAt  string `json:"outside_at,omitempty"`
}

// filterMetadata records activity even on hooks that have no journal row.
// On hosts without SessionEnd, a completed turn plus inactivity can finish a batch.
func filterMetadata(ev contract.Event, env Env) error {
	profile := captureprofile.For(ev.Agent)
	legacy := ev.Agent == "claude-code" || ev.Agent == "codex"
	if ev.AgentID != "" || ev.CaptureOnly || !profile.CapturesTyped() || (!legacy && !env.SessionLearning) {
		return nil
	}
	idle := env.SessionLearning && profile.Finish == "idle" && ev.Kind == contract.Stop && !ev.IncompleteTurn
	// The hook already touches its heartbeat on every call. Do not add file
	// replacement to the no-op tool path merely to record the same activity.
	switch ev.Kind {
	case contract.SessionStart, contract.Prompt, contract.PreCompact, contract.SessionEnd:
	default:
		if !idle {
			return nil
		}
	}
	stamp := now(env).UTC()
	s := FilterSession{Version: 1, Project: ev.ProjectID, Checkout: ev.Checkout, Agent: ev.Agent, Session: ev.SessionID,
		Seen: stamp.Format(time.RFC3339Nano), Finished: ev.Kind == contract.SessionEnd, Transcript: ev.Transcript, Idle: idle}
	s.Branch = Branch(ev.Checkout)
	if s.Branch != "" {
		s.Head = Head(ev.Checkout, s.Branch)
		s.PositionAt = s.Seen
	}
	name := place.ShortHash(ev.ProjectID + "\x00" + ev.SessionID)
	var prior FilterSession
	if readJSON(filepath.Join(env.RecordDirectory, "filter-sessions", name+".json"), &prior) == nil && prior.Version == 1 && prior.Project == s.Project && prior.Checkout == s.Checkout && prior.Session == s.Session && prior.Agent == s.Agent {
		if s.Transcript == "" && !ev.TranscriptDisabled {
			s.Transcript = prior.Transcript
		}
		if prior.Branch == s.Branch && prior.Head == s.Head && prior.PositionAt != "" {
			s.PositionAt = prior.PositionAt
		}
		if env.SessionLearning && ev.Kind != contract.Prompt && (ev.Kind != contract.SessionStart || ev.Source == "compact") {
			s.PromptAt, s.OutsideAt = prior.PromptAt, prior.OutsideAt
		}
	}
	if env.SessionLearning && profile.Cache && ev.Kind == contract.Prompt {
		s.PromptAt = s.Seen
	}
	if err := filterFile(env.RecordDirectory, "filter-sessions", name, s); err != nil {
		return err
	}
	finishedRequest := env.SessionLearning && (s.Finished || idle)
	if !finishedRequest && ev.Kind != contract.SessionStart && ev.Kind != contract.PreCompact {
		return nil
	}
	request := map[string]any{
		"version": 1, "project_id": ev.ProjectID, "checkout": ev.Checkout,
		"agent": ev.Agent, "generation": s.Seen,
		"session_id": ev.SessionID,
	}
	name = place.ShortHash(ev.Checkout)
	if finishedRequest {
		name += "." + place.ShortHash(ev.Agent+"\x00"+ev.SessionID) + "." + strconv.FormatInt(stamp.UnixNano(), 10)
		request["session_learning"] = true
	}
	if idle {
		request["ready_at"] = stamp.Add(10 * time.Minute).Format(time.RFC3339Nano)
	}
	return writeFilterFile(env.RecordDirectory, "filter-pending", name, request, finishedRequest)
}

// Root-relative atomic replacement refuses symlinks and never writes Node tables.
func filterFile(directory, folder, name string, value any) error {
	return writeFilterFile(directory, folder, name, value, false)
}

func writeFilterFile(directory, folder, name string, value any, keepExisting bool) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > filterFileBytes {
		return errRedirected
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	if parent := filepath.Dir(folder); parent != "." {
		if err := root.MkdirAll(parent, 0o700); err != nil {
			return err
		}
		if info, err := root.Lstat(parent); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errRedirected
		}
	}
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
	target := filepath.Join(folder, name+".json")
	if keepExisting {
		// Crash-safe first write wins, including overlapping duplicate hooks.
		if err := root.Link(tmp, target); !errors.Is(err, os.ErrExist) {
			return err
		}
		return nil
	}
	return root.Rename(tmp, target)
}
