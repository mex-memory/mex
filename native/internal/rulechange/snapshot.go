// Package rulechange reads Node's derived free-evidence snapshot. It cannot
// authorize a write, certify a rule or create a database.
package rulechange

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

type Input struct {
	Path string `json:"path"`
	Hash string `json:"hash"`
}
type Signal struct {
	ID          string   `json:"id"`
	EntryHash   string   `json:"entry_hash"`
	Reasons     []string `json:"reasons"`
	Files       []Input  `json:"files"`
	Directories []Input  `json:"directories"`
	// Pending keeps the claim out of full delivery when this invocation's
	// proof budget is exhausted. It cannot authorize judging or publication.
	Pending bool `json:"-"`
}
type Snapshot struct {
	Version     int               `json:"version"`
	Checkout    string            `json:"checkout"`
	Position    gitstate.Position `json:"position"`
	Entries     []Signal          `json:"entries"`
	readBytes   int64
	readNames   int
	files       map[string]string
	directories map[string]string
	byID        map[string]*Signal
}

// Read is the live hook's read: a record it can't read in time is no evidence.
func Read(directory, project, checkout string) *Snapshot {
	snapshot, _ := read(directory, project, checkout, record.OpenRecord)
	return snapshot
}

// ReadForEvaluation is an explicit check's read. A record it can't read is an
// error: treating it as no evidence would report a wrong verdict as a result.
func ReadForEvaluation(directory, project, checkout string) (*Snapshot, error) {
	return read(directory, project, checkout, record.OpenEvaluationRecord)
}

func read(directory, project, checkout string, open func(record.Location) (*record.Reader, error)) (*Snapshot, error) {
	if directory == "" || project == "" || !safefile.Regular(filepath.Join(directory, "record.db")) {
		return nil, nil
	}
	r, err := open(record.Location{Directory: directory, Record: filepath.Join(directory, "record.db")})
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil // MEX isn't set up here: there is no evidence to read
	}
	if err != nil {
		return nil, err
	}
	defer r.Close()
	raw, ok, err := r.BoundedSetting(project, "rule-change."+place.ShortHash(checkout), 512<<10)
	if err != nil || !ok {
		return nil, err
	}
	var s Snapshot
	if json.Unmarshal([]byte(raw), &s) != nil || s.Version != 1 || s.Checkout != checkout || len(s.Entries) > 10_000 {
		return nil, nil
	}
	at, ok := gitstate.Read(checkout)
	if !ok || at != s.Position {
		return nil, nil
	}
	return &s, nil
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func safe(path string) bool {
	return path != "" && !filepath.IsAbs(path) && !strings.ContainsAny(path, "\\\x00\r\n") && path != ".." && !strings.HasPrefix(path, "../") && !strings.Contains(path, "/../")
}

// For re-proves the entry and every source/inventory used by the free scan.
// A new/deleted file invalidates counts even when existing file bytes agree.
func (s *Snapshot) For(id, entryHash string) *Signal {
	if s == nil {
		return nil
	}
	if s.byID == nil {
		s.byID = map[string]*Signal{}
		for i := range s.Entries {
			item := &s.Entries[i]
			if _, duplicate := s.byID[item.ID]; duplicate {
				s.byID[item.ID] = nil
			} else {
				s.byID[item.ID] = item
			}
		}
		s.files = map[string]string{}
		s.directories = map[string]string{}
	}
	found := s.byID[id]
	if found == nil || found.EntryHash != entryHash || len(found.Reasons) == 0 || len(found.Reasons) > 5 || len(found.Files) > 128 || len(found.Directories) > 128 {
		return nil
	}
	for _, reason := range found.Reasons {
		if len(reason) > 512 {
			return nil
		}
	}
	at, ok := gitstate.Read(s.Checkout)
	if !ok || at != s.Position {
		return nil
	}
	root, err := os.OpenRoot(s.Checkout)
	if err != nil {
		return nil
	}
	defer root.Close()
	pending := func() *Signal { copy := *found; copy.Pending = true; return &copy }
	var total int64
	for _, input := range found.Files {
		if !safe(input.Path) {
			return nil
		}
		// Like the evaluator's file cache, proofs share one observed file view
		// only within this hook/evaluation invocation, never across invocations.
		if got, ok := s.files[input.Path]; ok {
			if got != input.Hash {
				return nil
			}
			continue
		}
		f, err := root.Open(input.Path)
		if err != nil {
			return nil
		}
		info, e := f.Stat()
		if e != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
			f.Close()
			return nil
		}
		if s.readBytes+info.Size() > 8<<20 {
			f.Close()
			return pending()
		}
		data, e := io.ReadAll(io.LimitReader(f, (64<<10)+1))
		f.Close()
		total += int64(len(data))
		s.readBytes += int64(len(data))
		if e != nil || total > 8<<20 || digest(data) != input.Hash {
			return nil
		}
		s.files[input.Path] = input.Hash
	}
	for _, input := range found.Directories {
		if !safe(input.Path) {
			return nil
		}
		if got, ok := s.directories[input.Path]; ok {
			if got != input.Hash {
				return nil
			}
			continue
		}
		f, err := root.Open(input.Path)
		if err != nil {
			return nil
		}
		rows, e := f.ReadDir(1001)
		f.Close()
		s.readNames += len(rows)
		if e != nil && e != io.EOF || len(rows) > 1000 {
			return nil
		}
		if s.readNames > 10_000 {
			return pending()
		}
		names := make([]string, len(rows))
		for i, row := range rows {
			names[i] = row.Name()
		}
		sort.Strings(names)
		if digest([]byte(strings.Join(names, "\n"))) != input.Hash {
			return nil
		}
		s.directories[input.Path] = input.Hash
	}
	return found
}
