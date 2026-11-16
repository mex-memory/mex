package output

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Saved output lives under the record directory (~/.mex, or the local cache
// folder when home is on a network drive):
//
//	projects/<project-id>/out/<n>.txt   the full output, byte for byte
//	projects/<project-id>/out/<n>.json  what it was: SavedMeta, written last
//
// n counts up per project. Node's `mex out` reads these files; only the
// native side writes them.
const (
	// MaxSaved is the largest output saved. Bigger output is left whole,
	// because a trim must always leave the full text one command away.
	MaxSaved = 32 << 20
	// keepSaved and keepFor bound the folder: older outputs are removed.
	keepSaved = 200
	keepFor   = 7 * 24 * time.Hour
	// MetaVersion must match SAVED_OUTPUT_VERSION in src/output/saved.ts.
	MetaVersion = 1
)

// SavedMeta describes one saved output.
type SavedMeta struct {
	Version   int    `json:"version"`
	N         int    `json:"n"`
	Command   string `json:"command"`
	ExitCode  int    `json:"exit_code"`
	Agent     string `json:"agent"`
	SessionID string `json:"session_id,omitempty"`
	Created   string `json:"created_at"`
	Lines     int    `json:"lines"`
	Chars     int    `json:"chars"`
}

var validProject = lazy(`^[gf]-[a-f0-9]{24}$`)

// Directory is where a project's saved outputs live.
func Directory(recordDirectory, projectID string) string {
	return filepath.Join(recordDirectory, "projects", projectID, "out")
}

var errNotSaved = errors.New("output not saved")

// Save writes text and its meta, and returns the number `mex out` knows it by.
func Save(recordDirectory, projectID string, text string, meta SavedMeta, now time.Time) (int, error) {
	if recordDirectory == "" || !validProject().MatchString(projectID) || len(text) > MaxSaved {
		return 0, errNotSaved
	}
	dir := Directory(recordDirectory, projectID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0, err
	}
	numbers := savedNumbers(dir)
	next := 1
	if len(numbers) > 0 {
		next = numbers[len(numbers)-1] + 1
	}
	var file *os.File
	for tries := 0; tries < 20; tries++ {
		f, err := os.OpenFile(filepath.Join(dir, strconv.Itoa(next)+".txt"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			file = f
			break
		}
		if !os.IsExist(err) {
			return 0, err
		}
		next++
	}
	if file == nil {
		return 0, errNotSaved
	}
	_, werr := file.WriteString(text)
	cerr := file.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(file.Name())
		return 0, errNotSaved
	}
	meta.Version, meta.N = MetaVersion, next
	meta.Created = now.UTC().Format(time.RFC3339)
	meta.Chars = len(text)
	meta.Lines = len(splitLines(text))
	data, err := json.Marshal(meta)
	if err != nil {
		return 0, err
	}
	tmp := filepath.Join(dir, "."+strconv.Itoa(next)+".json.tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		_ = os.Remove(file.Name())
		return 0, err
	}
	if err := os.Rename(tmp, filepath.Join(dir, strconv.Itoa(next)+".json")); err != nil {
		_ = os.Remove(tmp)
		_ = os.Remove(file.Name())
		return 0, err
	}
	if len(numbers) >= keepSaved || next%20 == 0 {
		prune(dir, numbers, now)
	}
	return next, nil
}

// savedNumbers lists the numbers present, ascending.
func savedNumbers(dir string) []int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".txt")
		if !ok {
			continue
		}
		if n, err := strconv.Atoi(name); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	sort.Ints(out)
	return out
}

// prune removes the oldest outputs beyond keepSaved, and any older than keepFor
// (the newest is always kept, so numbers keep counting up).
func prune(dir string, numbers []int, now time.Time) {
	for i, n := range numbers {
		if i == len(numbers)-1 {
			break
		}
		txt := filepath.Join(dir, strconv.Itoa(n)+".txt")
		old := len(numbers)-i > keepSaved
		if !old {
			if info, err := os.Stat(txt); err == nil && now.Sub(info.ModTime()) > keepFor {
				old = true
			}
		}
		if !old {
			continue
		}
		_ = os.Remove(filepath.Join(dir, strconv.Itoa(n)+".json"))
		_ = os.Remove(txt)
	}
}

// Ref is how the trimmed header names a saved output.
func Ref(n int) string { return "mex out " + strconv.Itoa(n) }
