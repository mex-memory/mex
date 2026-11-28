package pattern

import (
	"fmt"
	"strings"
)

const (
	MaxAreaOccurrences = 3
	MaxAreaShare       = 0.01
	MinAreaMatches     = 2 // One leftover file alone does not establish a norm.
)

// Candidate is a `when:` pattern proposed for an entry, with the review it
// came from: the code the reviewer objected to and the code after the fix.
type Candidate struct {
	Type     string `json:"type"`  // anti, required, rejected, creates
	Match    string `json:"match"` // literal or structural
	Pattern  string `json:"pattern"`
	Objected string `json:"objected"`
	Fixed    string `json:"fixed"`
	// Anchor is the code the review comment is attached to: the line or
	// lines it was left on, as they read in Objected. Empty when unknown.
	Anchor string `json:"anchor,omitempty"`
}

// Verdict says whether a candidate pattern is kept. A dropped pattern
// leaves the entry on its path scope alone.
type Verdict struct {
	Keep        bool   `json:"keep"`
	Reason      string `json:"reason"`
	Common      bool   `json:"common"`      // contrast passed, but the pattern is common in scope
	Files       int    `json:"files"`       // area files read
	Matched     int    `json:"matched"`     // of those, files the pattern occurs in
	Occurrences int    `json:"occurrences"` // non-overlapping matches in those files
}

// Area is the code of an area, file by file; nil means it couldn't be read.
type Area []string

// SelfCheck runs the $0 self-check on one candidate (plan sheet 31).
func SelfCheck(c Candidate, area Area) Verdict {
	if c.Type == "creates" {
		return Verdict{Keep: true, Reason: "a file-path glob, not code"}
	}
	spans, err := codeMatcher(c.Match, c.Pattern)
	if err != nil {
		return Verdict{Reason: "the pattern doesn't compile"}
	}
	c.Objected = NormalizeCode(c.Objected)
	c.Fixed = NormalizeCode(c.Fixed)
	switch c.Type {
	case "anti", "rejected":
		if !PreciseCodePattern(c.Type, c.Match, c.Pattern) {
			return Verdict{Reason: "the pattern is too broad to stop an edit"}
		}
		if len(spans(c.Fixed)) != 0 {
			return Verdict{Reason: "it still matches the fixed code"}
		}
		reviewed := spans(c.Objected)
		if len(reviewed) == 0 {
			return Verdict{Reason: "it doesn't match the code the reviewer objected to"}
		}
		if why := nameCheck(c.Pattern, c.Objected); why != "" && !preciseCodeShape(c.Pattern) {
			return Verdict{Reason: why}
		}
		// The reviewer put the comment on a line: a pattern that matches only
		// elsewhere in the block is something the comment didn't point at.
		if !matchesAnchor(c.Objected, c.Fixed, c.Anchor, reviewed) {
			return Verdict{Reason: "it isn't on the lines the reviewer commented on"}
		}
	case "required":
		fixed := len(spans(c.Fixed))
		if fixed == 0 {
			return Verdict{Reason: "it doesn't match the fixed code"}
		}
		if fixed <= len(spans(c.Objected)) {
			return Verdict{Reason: "the objected code already had it"}
		}
		if why := nameCheck(c.Pattern, ""); why != "" && !preciseCodeShape(c.Pattern) {
			return Verdict{Reason: why}
		}
		return Verdict{Keep: true, Reason: "the fix adds it"}
	default:
		return Verdict{Reason: "unknown pattern type"}
	}
	if area == nil {
		return Verdict{Reason: "the full scope couldn't be read, so its frequency is unknown"}
	}
	v := Verdict{Files: len(area)}
	for _, code := range area {
		if n := len(spans(NormalizeCode(code))); n > 0 {
			v.Matched++
			v.Occurrences += n
		}
	}
	v.Common = v.Occurrences > MaxAreaOccurrences ||
		(v.Matched >= MinAreaMatches && float64(v.Matched) > MaxAreaShare*float64(v.Files))
	unit := "occurrences"
	if v.Occurrences == 1 {
		unit = "occurrence"
	}
	counts := fmt.Sprintf("%d %s in %d of %d scoped files", v.Occurrences, unit, v.Matched, v.Files)
	if v.Common {
		v.Reason = "common at HEAD (" + counts + ")"
	} else {
		v.Keep = true
		v.Reason = "matches the reviewed code only and is rare at HEAD (" + counts + ")"
	}
	return v
}

// Matcher returns a function reporting whether one pattern occurs in code.
func Matcher(match, p string) (func(string) bool, error) {
	spans, err := codeMatcher(match, p)
	if err != nil {
		return nil, err
	}
	return func(code string) bool { return len(spans(NormalizeCode(code))) != 0 }, nil
}

// CodeCount is used after a cheap candidate match at delivery and by checks.
func CodeCount(match, p, code string) int {
	spans, err := codeMatcher(match, p)
	if err != nil {
		return 0
	}
	return len(spans(NormalizeCode(code)))
}

func NormalizeCode(code string) string {
	return strings.ReplaceAll(code, "\r\n", "\n")
}

// PreciseCodePattern is the edit-time threshold for a learned trigger.
func PreciseCodePattern(typ, match, p string) bool {
	switch match {
	case "literal":
		p = strings.TrimSpace(p)
		// A rejected manifest key can name a dependency as a string token.
		// An anti-pattern must name code rather than a standalone string.
		return (typ != "anti" || !isString(p)) && (len(p) >= 4 || preciseCodeShape(p))
	case "structural":
		s, err := CompileStructural(p)
		return err == nil && s.Words() > 0
	}
	return false
}

func codeMatcher(match, p string) (func(string) [][2]int, error) {
	switch match {
	case "literal":
		p = NormalizeCode(p)
		if strings.TrimSpace(p) == "" {
			return nil, ErrPattern
		}
		return func(code string) [][2]int { return codeLiteralSpans(p, code) }, nil
	case "structural":
		s, err := CompileStructural(p)
		if err != nil {
			return nil, err
		}
		return s.Spans, nil
	}
	return nil, ErrPattern
}
