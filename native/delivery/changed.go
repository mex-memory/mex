package delivery

import (
	"math"
	"sort"

	"github.com/mex-memory/mex/native/index/shift"
)

// The lines a session changed, kept so a card before a full test run can
// name the tests that cover them. Each edit's ranges come from the same
// placement the file index uses; spans are in the file as it is now.

const (
	maxChangedFiles = 64
	maxChangedSpans = 64
)

// LineSpan is a run of changed lines, both ends included.
type LineSpan struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// ChangedLines maps an edited file's path, as the tool named it, to the
// lines changed in it this session.
type ChangedLines map[string][]LineSpan

// RecordWorktreeDiff stores the current spans of a diff against HEAD. The
// diff already includes earlier uncommitted edits in their new positions.
func (c ChangedLines) RecordWorktreeDiff(changes ChangedLines) {
	paths := make([]string, 0, len(changes))
	for path := range changes {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		_, known := c[path]
		if !known && len(c) >= maxChangedFiles {
			continue
		}
		c[path] = mergeSpans(append([]LineSpan(nil), changes[path]...))
	}
}

// Apply records one edit. ranges are in the lines before the edit, as the
// file index records them; earlier spans move with the edit. An edit that
// couldn't be placed marks the whole file.
func (c ChangedLines) Apply(path string, ranges []shift.Range, placed bool) {
	spans, known := c[path]
	if !known && len(c) >= maxChangedFiles {
		return
	}
	if !placed {
		c[path] = wholeFile()
		return
	}
	if len(ranges) == 0 {
		return
	}
	sorted := append([]shift.Range(nil), ranges...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].From < sorted[j].From })
	move := func(line int) int {
		if line == math.MaxInt32 {
			return line
		}
		moved := line
		for _, r := range sorted {
			if r.To < line {
				moved += r.Delta
			}
		}
		return max(moved, 1)
	}
	out := make([]LineSpan, 0, len(spans)+len(sorted))
	for _, s := range spans {
		out = append(out, LineSpan{From: move(s.From), To: move(s.To)})
	}
	added := 0 // lines added by earlier ranges of this edit
	for _, r := range sorted {
		from := r.From + added
		to := r.To + added + r.Delta
		if to < from {
			to = from // a deletion: mark where the lines were
		}
		out = append(out, LineSpan{From: max(from, 1), To: max(to, 1)})
		added += r.Delta
	}
	c[path] = mergeSpans(out)
}

func mergeSpans(spans []LineSpan) []LineSpan {
	sort.Slice(spans, func(i, j int) bool { return spans[i].From < spans[j].From })
	var out []LineSpan
	for _, s := range spans {
		if n := len(out); n > 0 && s.From <= out[n-1].To+1 {
			out[n-1].To = max(out[n-1].To, s.To)
			continue
		}
		out = append(out, s)
	}
	if len(out) > maxChangedSpans {
		// Too scattered to track line by line: one span over all of it.
		out = []LineSpan{{From: out[0].From, To: out[len(out)-1].To}}
	}
	return out
}

// Overlaps reports whether any changed span touches lines start..end.
func overlaps(spans []LineSpan, start, end int) bool {
	for _, s := range spans {
		if s.From <= end && s.To >= start {
			return true
		}
	}
	return false
}
