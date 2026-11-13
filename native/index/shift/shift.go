package shift

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/mex-memory/mex/native/record/place"
)

// Line shifts keep outlines exact between an edit and the re-parse, with no
// parser in the hook. The format and rules match src/file-index/shifts.ts:
//
//	<index>/shifts/<checkout key>/<path key>/<mtime_ns, 20 digits>-<pid>-<n>.json
//	{"path":"src/a.ts","mtime_ns":"…","ranges":[{"from":10,"to":12,"delta":3}]}
//
// Ranges use the file's line numbers before that edit: lines from..to changed
// (to = from-1 for a pure insertion) and the file gained delta lines there.
// "unknown": true means the edit couldn't be placed. A shift applies while its
// mtime is newer than the one the snapshot parsed.

// Symbol is one outline entry, as the index stores it. Lines are 1-based and
// inclusive; Parent is the index of the enclosing symbol.
type Symbol struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Parent *int   `json:"parent,omitempty"`
}

// Directory is where a project's index lives, under the record's directory.
func Directory(recordDirectory, projectID string) string {
	return filepath.Join(recordDirectory, "projects", projectID, "index")
}

// Range is one changed block of an edit, in the line numbers before it. Nest
// means the change may alter structure (see changesNesting), so a symbol
// around it or right next to it may now end elsewhere.
type Range struct {
	From  int  `json:"from"`
	To    int  `json:"to"`
	Delta int  `json:"delta"`
	Nest  bool `json:"nest,omitempty"`
}

// Shift is one edit to one file.
type Shift struct {
	Path    string  `json:"path"`
	MtimeNS string  `json:"mtime_ns"`
	Ranges  []Range `json:"ranges"`
	Unknown bool    `json:"unknown,omitempty"`
}

func directoryFor(indexDirectory, checkoutKey, path string) string {
	return filepath.Join(indexDirectory, "shifts", checkoutKey, place.ShortHash(path))
}

func mtimeValue(text string) uint64 {
	value, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// Pending are the shifts for path newer than parsedMtime, oldest first.
func Pending(indexDirectory, checkoutKey, path, parsedMtime string) []Shift {
	directory := directoryFor(indexDirectory, checkoutKey, path)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	parsed := mtimeValue(parsedMtime)
	var shifts []Shift
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			continue
		}
		var shift Shift
		if json.Unmarshal(data, &shift) != nil {
			continue
		}
		if shift.Path == path && mtimeValue(shift.MtimeNS) > parsed {
			shifts = append(shifts, shift)
		}
	}
	return shifts
}

// MapLine moves one line through an edit's ranges; false when it changed.
func MapLine(line int, ranges []Range) (int, bool) {
	moved := line
	for _, r := range ranges {
		if line >= r.From && line <= r.To {
			return 0, false
		}
		if r.To < line {
			moved += r.Delta
		}
	}
	return moved, true
}

// SpanThrough moves a symbol through one edit; false when the edit may have
// changed it: a changed line is its first or last line, or a structural
// change sits inside it or right next to it. Same rule as mapSpan in shifts.ts.
func SpanThrough(start, end int, ranges []Range) (int, int, bool) {
	for _, r := range ranges {
		if (start >= r.From && start <= r.To) || (end >= r.From && end <= r.To) {
			return 0, 0, false
		}
		if r.Nest && start <= r.To+1 && end >= r.From-1 {
			return 0, 0, false
		}
	}
	from, ok := MapLine(start, ranges)
	if !ok {
		return 0, 0, false
	}
	to, ok := MapLine(end, ranges)
	return from, to, ok
}

// MapSpan moves a span through several edits in order.
func MapSpan(start, end int, shifts []Shift) (int, int, bool) {
	ok := true
	for _, shift := range shifts {
		if start, end, ok = SpanThrough(start, end, shift.Ranges); !ok {
			return 0, 0, false
		}
	}
	return start, end, true
}

// AnyUnknown reports whether an edit couldn't be placed.
func AnyUnknown(shifts []Shift) bool {
	for _, shift := range shifts {
		if shift.Unknown {
			return true
		}
	}
	return false
}

// Apply moves an outline through pending edits. Symbols whose first or
// last line changed are dropped and their children re-parented. False when an
// edit is unknown.
func Apply(outline []Symbol, shifts []Shift) ([]Symbol, int, bool) {
	if AnyUnknown(shifts) {
		return nil, 0, false
	}
	kept := make([]*Symbol, len(outline))
	for i, item := range outline {
		start, end, ok := MapSpan(item.Start, item.End, shifts)
		if ok {
			copy := item
			copy.Start, copy.End = start, end
			kept[i] = &copy
		}
	}
	position := map[int]int{}
	result := make([]Symbol, 0, len(outline))
	for i, item := range kept {
		if item == nil {
			continue
		}
		parent := outline[i].Parent
		for parent != nil && kept[*parent] == nil {
			parent = outline[*parent].Parent
		}
		out := Symbol{Name: item.Name, Kind: item.Kind, Start: item.Start, End: item.End}
		if parent != nil {
			p := position[*parent]
			out.Parent = &p
		}
		position[i] = len(result)
		result = append(result, out)
	}
	return result, len(outline) - len(result), true
}

var written atomic.Int64

// WriteShift records one edit for the readers. The file appears through a
// rename, under a name nothing else uses, so readers never see half of it.
func WriteShift(indexDirectory, checkoutKey string, shift Shift) error {
	directory := directoryFor(indexDirectory, checkoutKey, shift.Path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(shift)
	if err != nil {
		return err
	}
	mtime := shift.MtimeNS
	if len(mtime) < 20 {
		mtime = strings.Repeat("0", 20-len(mtime)) + mtime
	}
	name := fmt.Sprintf("%s-%d-g%d.json", mtime, os.Getpid(), written.Add(1))
	temporary := filepath.Join(directory, name+".tmp")
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, filepath.Join(directory, name)); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

// Checkout is an indexed checkout, found without the database.
type Checkout struct {
	ProjectID string `json:"project_id"`
	Root      string `json:"root"`
	Key       string `json:"-"`
}

// FindCheckout finds the indexed checkout holding file. The Node indexer
// writes <record directory>/index-checkouts/<key>.json for every checkout it
// indexes (key = ShortHash of the checkout's real path), so the hook walks up
// from the file's folder and stops at the first one.
func FindCheckout(recordDirectory, file string) (Checkout, bool) {
	directory, err := place.RealPath(filepath.Dir(file))
	if err != nil {
		return Checkout{}, false
	}
	for {
		key := place.ShortHash(directory)
		if data, err := os.ReadFile(filepath.Join(recordDirectory, "index-checkouts", key+".json")); err == nil {
			var found Checkout
			if json.Unmarshal(data, &found) == nil && found.Root == directory && found.ProjectID != "" {
				found.Key = key
				return found, true
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return Checkout{}, false
		}
		directory = parent
	}
}

// MarkPending tells the background process that edits wait for a re-parse
// (src/file-index/pending.ts). Best effort.
func MarkPending(recordDirectory string) {
	_ = os.WriteFile(filepath.Join(recordDirectory, "index-pending"), nil, 0o600)
}
