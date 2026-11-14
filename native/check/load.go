package check

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Levels: where an entry lives decides what it is.
const (
	Team     = "team"
	Personal = "personal"
	Hint     = "hint"
)

// MaxEntries bounds one store scan, as in the Node store.
const MaxEntries = 10_000

// ErrTooMany is returned when a store holds more entries than a scan reads.
var ErrTooMany = errors.New("too many entries")

// Loaded is one entry file read from a store.
type Loaded struct {
	Level string
	Path  string
	// Hash is the entry file's own hash; editing the entry re-runs its checks.
	Hash  string
	Entry *Entry
	// Err is set when the file isn't a valid entry. Entry is then nil.
	Err error
}

// TeamDirectory is where a checkout's team entries live.
func TeamDirectory(checkout string) string {
	return filepath.Join(checkout, ".mex", "learned")
}

// PersonalDirectories are the personal notes and hints of a project.
func PersonalDirectories(mexHome, projectID string) (notes, hints string) {
	project := filepath.Join(mexHome, "projects", projectID)
	return filepath.Join(project, "notes"), filepath.Join(project, "hints")
}

// LoadAll reads a checkout's team entries and its project's notes and hints.
// A missing folder holds nothing.
func LoadAll(checkout, mexHome, projectID string) ([]Loaded, error) {
	team, err := LoadStore(TeamDirectory(checkout), Team, 1)
	if err != nil {
		return nil, err
	}
	out := team
	if projectID != "" && mexHome != "" {
		notes, hints := PersonalDirectories(mexHome, projectID)
		for _, store := range []struct{ dir, level string }{{notes, Personal}, {hints, Hint}} {
			found, err := LoadStore(store.dir, store.level, 0)
			if err != nil {
				return nil, err
			}
			out = append(out, found...)
		}
	}
	if len(out) > MaxEntries {
		return nil, ErrTooMany
	}
	return out, nil
}

// LoadStore reads <id>.md files in dir, and in subfolders down to depth.
// Links and other non-regular files are skipped, never followed.
func LoadStore(dir, level string, depth int) ([]Loaded, error) {
	var out []Loaded
	var walk func(string, int) error
	walk = func(folder string, left int) error {
		children, err := os.ReadDir(folder)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		for _, child := range children {
			full := filepath.Join(folder, child.Name())
			switch {
			case child.Type()&os.ModeSymlink != 0:
				continue
			case child.IsDir():
				if left > 0 {
					if err := walk(full, left-1); err != nil {
						return err
					}
				}
				continue
			case !child.Type().IsRegular() || !strings.HasSuffix(child.Name(), ".md") || strings.HasPrefix(child.Name(), "."):
				continue
			}
			if len(out) >= MaxEntries {
				return ErrTooMany
			}
			out = append(out, readEntry(full, level))
		}
		return nil
	}
	if err := walk(dir, depth); err != nil {
		return nil, err
	}
	return out, nil
}

func readEntry(path, level string) Loaded {
	l := Loaded{Level: level, Path: path}
	file, err := os.Open(path)
	if err != nil {
		l.Err = err
		return l
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, MaxEntryBytes+1))
	if err != nil {
		l.Err = err
		return l
	}
	l.Hash = hashBytes(data)
	l.Entry, l.Err = ParseEntry(data)
	if l.Err == nil && l.Entry.ID+".md" != filepath.Base(path) {
		l.Entry, l.Err = nil, errors.New("file name doesn't match the entry id")
	}
	return l
}
