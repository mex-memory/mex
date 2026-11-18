package contract

import (
	"regexp"
	"strings"
	"sync"
)

// Every block of MEX's own text starts with the line "[mex <block-id>]", so
// capture can strip it and MEX never learns its own advice.

var markerLine = lazyRegexp(`^\[mex [A-Za-z0-9._:-]+\]$`)
var blockID = lazyRegexp(`[^A-Za-z0-9._:-]+`)

// Mark puts the marker line on a block of text.
func Mark(id, text string) string {
	id = blockID().ReplaceAllString(id, "-")
	if id == "" {
		id = "block"
	}
	return "[mex " + id + "]\n" + text
}

// IsMarked reports whether text starts with a marker line.
func IsMarked(text string) bool {
	first, _, _ := strings.Cut(text, "\n")
	return markerLine().MatchString(strings.TrimRight(first, "\r"))
}

// EnsureMarked marks unmarked context. Profiles call it on every context
// block they render, so nothing MEX says goes out without a marker.
func EnsureMarked(text string) string {
	if text == "" || IsMarked(text) {
		return text
	}
	return Mark("unmarked", text)
}

// StripMarked removes MEX's own blocks from text. A block runs from its marker
// line to the next marker line or the end of the text, since everything MEX
// adds to one message is its own.
func StripMarked(text string) string {
	lines := strings.Split(text, "\n")
	out := lines[:0]
	inBlock := false
	for _, l := range lines {
		if markerLine().MatchString(strings.TrimRight(l, "\r")) {
			inBlock = true
			continue
		}
		if !inBlock {
			out = append(out, l)
		}
	}
	return strings.TrimRight(strings.Join(out, "\n"), "\n")
}

func lazyRegexp(expr string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(expr) })
}
