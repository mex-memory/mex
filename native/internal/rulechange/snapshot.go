// Package rulechange reads Node's derived free-evidence snapshot. It cannot
// authorize a write, certify a rule or create a database.
package rulechange

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
}
type Snapshot struct {
	Version   int               `json:"version"`
	Checkout  string            `json:"checkout"`
	Position  gitstate.Position `json:"position"`
	Entries   []Signal          `json:"entries"`
	readBytes int64
	readNames int
}

func Read(directory, project, checkout string) *Snapshot {
	if directory == "" || project == "" || !safefile.Regular(filepath.Join(directory, "record.db")) {
		return nil
	}
	r, err := record.OpenRecord(record.Location{Directory: directory, Record: filepath.Join(directory, "record.db")})
	if err != nil {
		return nil
	}
	defer r.Close()
	raw, ok, err := r.BoundedSetting(project, "rule-change."+place.ShortHash(checkout), 512<<10)
	if err != nil || !ok {
		return nil
	}
	var s Snapshot
	if json.Unmarshal([]byte(raw), &s) != nil || s.Version != 1 || s.Checkout != checkout || len(s.Entries) > 128 {
		return nil
	}
	at, ok := gitstate.Read(checkout)
	if !ok || at != s.Position {
		return nil
	}
	return &s
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
	var found *Signal
	for i := range s.Entries {
		if s.Entries[i].ID == id {
			if found != nil {
				return nil
			}
			found = &s.Entries[i]
		}
	}
	if found == nil || found.EntryHash != entryHash || len(found.Reasons) == 0 || len(found.Reasons) > 4 || len(found.Files) > 128 || len(found.Directories) > 128 {
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
	var total int64
	for _, input := range found.Files {
		if !safe(input.Path) {
			return nil
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
		data, e := io.ReadAll(io.LimitReader(f, (64<<10)+1))
		f.Close()
		total += int64(len(data))
		s.readBytes += int64(len(data))
		if e != nil || total > 8<<20 || s.readBytes > 8<<20 || digest(data) != input.Hash {
			return nil
		}
	}
	for _, input := range found.Directories {
		if !safe(input.Path) {
			return nil
		}
		f, err := root.Open(input.Path)
		if err != nil {
			return nil
		}
		rows, e := f.ReadDir(1001)
		f.Close()
		s.readNames += len(rows)
		if e != nil && e != io.EOF || len(rows) > 1000 || s.readNames > 10_000 {
			return nil
		}
		names := make([]string, len(rows))
		for i, row := range rows {
			names[i] = row.Name()
		}
		sort.Strings(names)
		if digest([]byte(strings.Join(names, "\n"))) != input.Hash {
			return nil
		}
	}
	return found
}
