package hook

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

type controls struct {
	Version       int    `json:"version"`
	Off           bool   `json:"off"`
	Capture       bool   `json:"capture"`
	LedgerHoldout string `json:"ledger_holdout,omitempty"`
}

// Control files are bounded and never followed through a replaced/link leaf.
// Missing files retain the pre-controls defaults; unreadable files turn MEX off.
func readControl(file string, value any) error {
	before, err := os.Lstat(file)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() > 4096 {
		return errors.New("invalid control file")
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil {
		return err
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return errors.New("control file changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return err
	}
	if len(data) > 4096 {
		return errors.New("control file too large")
	}
	return json.Unmarshal(data, value)
}

func (h home) controls() controls {
	defaults := controls{Version: 1, Capture: true}
	if h.mex == "" {
		return defaults
	}
	var value struct {
		Version       int    `json:"version"`
		Off           *bool  `json:"off"`
		Capture       *bool  `json:"capture"`
		LedgerHoldout string `json:"ledger_holdout"`
	}
	err := readControl(filepath.Join(h.mex, "controls.json"), &value)
	if errors.Is(err, os.ErrNotExist) {
		return defaults
	}
	if err != nil || value.Version != 1 || value.Off == nil || value.Capture == nil {
		return controls{Version: 1, Off: true}
	}
	if !localrecord.ValidLedgerTrial(value.LedgerHoldout) {
		value.LedgerHoldout = ""
	}
	return controls{Version: 1, Off: *value.Off, Capture: *value.Capture, LedgerHoldout: value.LedgerHoldout}
}

func captureEnabled(recordDirectory, projectID string, global controls) bool {
	if global.Off || !global.Capture {
		return false
	}
	if projectID == "" {
		return true
	}
	if len(projectID) != 26 || (projectID[:2] != "g-" && projectID[:2] != "f-") {
		return false
	}
	for _, c := range projectID[2:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	var value struct {
		Version int   `json:"version"`
		Enabled *bool `json:"enabled"`
	}
	err := readControl(filepath.Join(recordDirectory, "hook-capture", projectID+".json"), &value)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	return err == nil && value.Version == 1 && value.Enabled != nil && *value.Enabled
}

func pausePath(directory, agent, session string) string {
	return filepath.Join(directory, "hook-paused", place.ShortHash(agent+"\x00"+session))
}

func sessionPaused(directory, agent, session string) bool {
	if session == "" {
		return false
	}
	_, err := os.Lstat(pausePath(directory, agent, session))
	return !errors.Is(err, os.ErrNotExist)
}

func publishPause(file string, paused bool) error {
	directory := filepath.Dir(file)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("pause directory redirected")
	}
	if !paused {
		err := os.Remove(file)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		if !safeTelemetryFile(file) {
			return errors.New("invalid pause marker")
		}
		return nil
	}
	if err != nil {
		return err
	}
	err = f.Sync()
	return errors.Join(err, f.Close())
}

// Recognize only a whole main-session control. Never search prose for commands.
func sessionControl(ev contract.Event) (paused bool, recognized bool) {
	if ev.Kind != contract.Prompt || ev.AgentID != "" || ev.Prompt == nil || !ev.Prompt.Typed || ev.SessionID == "" || len(ev.SessionID) > 512 {
		return false, false
	}
	switch ev.Prompt.Text {
	case "mex pause":
		return true, true
	case "mex resume":
		return false, true
	}
	return false, false
}

func changeSessionPause(ev contract.Event, directory string, paused bool) bool {
	file := pausePath(directory, ev.Agent, ev.SessionID)
	for _, path := range []string{filepath.Join(directory, "hooks.db"), filepath.Join(directory, "hooks.db-wal"), filepath.Join(directory, "hooks.db-shm")} {
		if !safeTelemetryFile(path) {
			return false
		}
	}
	hooks, err := localrecord.OpenHooks(place.Location{Directory: directory, Hooks: filepath.Join(directory, "hooks.db")})
	if err != nil {
		return false
	}
	defer hooks.Close()
	err = hooks.SetSessionPaused(localrecord.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout, Paused: paused}, func(value bool) error { return publishPause(file, value) })
	return err == nil
}

func whatPrompt(ev contract.Event) bool {
	return ev.Kind == contract.Prompt && ev.AgentID == "" && ev.Prompt != nil && ev.Prompt.Typed && ev.SessionID != "" && strings.EqualFold(strings.TrimSpace(ev.Prompt.Text), "mex what")
}
