package capture

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	// maxPairs bounds a project's pair store; the oldest go first.
	maxPairs = 256
	// maxStateFile bounds every plain file capture reads.
	maxStateFile = 256 << 10
)

// Pair is a failed-then-passed pair that passed the strict rule in its
// session, or a flaky rerun. Kind "hint" means the same failure returned in a
// later session where MEX hadn't delivered the fix: a hint only, never
// verified. Node turns hints into knowledge entries; the ID is the entry ID it
// uses, so delivery receipts name the pair.
type Pair struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"` // "candidate", "flaky" or "hint"
	Failed   string `json:"failed"`
	Exit     int    `json:"exit"`
	Passed   string `json:"passed"`
	Reason   string `json:"reason"`
	Agent    string `json:"agent"`
	Session  string `json:"session"`
	Seen     string `json:"seen"`
	Returned string `json:"returned,omitempty"` // the later session the failure came back in
}

type pairFile struct {
	Version int    `json:"version"`
	Pairs   []Pair `json:"pairs"`
}

// pending is the session's last failed command, while nothing else has run.
type pending struct {
	Version int    `json:"version"`
	Command string `json:"command"`
	Exit    int    `json:"exit"`
}

// PairID is the knowledge entry ID a pair becomes.
func PairID(failed string, exit int, passed string) string {
	return "mx_" + place.ShortHash("capture-pair\x00"+failed+"\x00"+itoa(exit)+"\x00"+passed)
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// PairsPath is the project's pair store: <record dir>/capture-pairs/<hash>.json.
func PairsPath(recordDirectory, projectID string) string {
	return filepath.Join(recordDirectory, "capture-pairs", place.ShortHash(projectID)+".json")
}

func pendingPath(recordDirectory, agent, session string) string {
	return filepath.Join(recordDirectory, "capture-pending", place.ShortHash(agent+"\x00"+session)+".json")
}

// ReadPairs reads a project's pairs. A missing file is an empty store.
func ReadPairs(recordDirectory, projectID string) ([]Pair, error) {
	var f pairFile
	if err := readJSON(PairsPath(recordDirectory, projectID), &f); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if f.Version != 1 {
		return nil, errors.New("unknown pair store version")
	}
	return f.Pairs, nil
}

// track follows one session's commands for the strict rule. It runs on the
// main agent's post-tool events only. Anything that isn't a shell command
// counts as "something else ran or changed".
func track(ev contract.Event, env Env, delivered func(session, entryID string) bool) error {
	if ev.AgentID != "" || (ev.Kind != contract.PostTool && ev.Kind != contract.PostToolFailure) || ev.Tool == nil {
		return nil
	}
	path := pendingPath(env.RecordDirectory, ev.Agent, ev.SessionID)
	var last pending
	err := readJSON(path, &last)
	has := err == nil && last.Version == 1 && last.Command != ""
	t := ev.Tool
	command := ""
	if t.Name == contract.ToolShell {
		command = Redact(clip(t.Input.Command, MaxCommand))
	}
	code := ExitCode(ev, t)
	switch {
	case command == "" || code == nil:
		// Another tool ran, or a command whose result is unknown.
		if has {
			return removeFile(path)
		}
		return nil
	case *code != 0:
		if err := returned(ev, env, command, *code, delivered); err != nil {
			return err
		}
		return writeJSON(path, pending{Version: 1, Command: command, Exit: *code})
	}
	if !has {
		return nil
	}
	if err := removeFile(path); err != nil {
		return err
	}
	verdict, reason := Classify(last.Command, command, last.Exit, false)
	if verdict == Rejected {
		return nil
	}
	return savePair(env, ev.ProjectID, Pair{
		ID: PairID(last.Command, last.Exit, command), Kind: string(verdict), Failed: last.Command, Exit: last.Exit,
		Passed: command, Reason: reason, Agent: ev.Agent, Session: ev.SessionID, Seen: now(env).UTC().Format(time.RFC3339),
	})
}

// returned marks candidates whose failure came back in a later session in
// which MEX didn't deliver the fix. Only then is a candidate a hint.
func returned(ev contract.Event, env Env, command string, exit int, delivered func(session, entryID string) bool) error {
	pairs, err := ReadPairs(env.RecordDirectory, ev.ProjectID)
	if err != nil || len(pairs) == 0 {
		return err
	}
	changed := false
	for i := range pairs {
		p := &pairs[i]
		if p.Kind != string(Candidate) || p.Failed != command || p.Exit != exit || p.Session == ev.SessionID {
			continue
		}
		if delivered != nil && delivered(ev.SessionID, p.ID) {
			continue
		}
		p.Kind, p.Returned = "hint", ev.SessionID
		changed = true
	}
	if !changed {
		return nil
	}
	return writeJSON(PairsPath(env.RecordDirectory, ev.ProjectID), pairFile{Version: 1, Pairs: pairs})
}

func savePair(env Env, projectID string, pair Pair) error {
	pairs, err := ReadPairs(env.RecordDirectory, projectID)
	if err != nil {
		pairs = nil // an unreadable store is replaced, never trusted
	}
	for i := range pairs {
		if pairs[i].ID == pair.ID {
			if pairs[i].Kind == string(Flaky) && pair.Kind == string(Candidate) {
				pairs[i].Kind = pair.Kind
			}
			pairs[i].Seen = pair.Seen
			return writeJSON(PairsPath(env.RecordDirectory, projectID), pairFile{Version: 1, Pairs: pairs})
		}
	}
	pairs = append(pairs, pair)
	if len(pairs) > maxPairs {
		pairs = pairs[len(pairs)-maxPairs:]
	}
	return writeJSON(PairsPath(env.RecordDirectory, projectID), pairFile{Version: 1, Pairs: pairs})
}

func readJSON(path string, v any) error {
	before, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() > maxStateFile {
		return errors.New("invalid capture file")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return errors.New("capture file changed")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxStateFile+1))
	if err != nil || len(data) > maxStateFile {
		return errors.New("invalid capture file")
	}
	return json.Unmarshal(data, v)
}

// writeJSON replaces a file atomically: a temporary file, then a rename.
func writeJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > maxStateFile {
		return errors.New("capture file too large")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("capture folder redirected")
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return errors.New("capture file redirected")
	}
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(f.Name())
		return errors.Join(werr, cerr)
	}
	if err := os.Rename(f.Name(), path); err != nil {
		_ = os.Remove(f.Name())
		return err
	}
	return nil
}

func removeFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
