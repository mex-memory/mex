package pattern

import "fmt"

// MaxAreaShare is the largest share of an area's files an anti or rejected
// pattern may already appear in. A pattern found in more of them describes
// the area's normal code, not the mistake a reviewer objected to. The plan
// sets "a share" without a number; this is the starting value.
const MaxAreaShare = 0.20

// Candidate is a `when:` pattern proposed for an entry, with the review it
// came from: the code the reviewer objected to and the code after the fix.
type Candidate struct {
	Type     string `json:"type"`  // anti, required, rejected, creates
	Match    string `json:"match"` // literal or structural
	Pattern  string `json:"pattern"`
	Objected string `json:"objected"`
	Fixed    string `json:"fixed"`
}

// Verdict says whether a candidate pattern is kept. A dropped pattern
// leaves the entry on its path scope alone.
type Verdict struct {
	Keep    bool   `json:"keep"`
	Reason  string `json:"reason"`
	Files   int    `json:"files"`   // area files read
	Matched int    `json:"matched"` // of those, files the pattern occurs in
}

// Area is the code of an area, file by file; nil means it couldn't be read.
type Area []string

// SelfCheck runs the $0 self-check on one candidate (plan sheet 31).
func SelfCheck(c Candidate, area Area) Verdict {
	matches, err := Matcher(c.Match, c.Pattern)
	if c.Type == "creates" {
		return Verdict{Keep: true, Reason: "a file-path glob, not code"}
	}
	if err != nil {
		return Verdict{Reason: "the pattern doesn't compile"}
	}
	switch c.Type {
	case "anti", "rejected":
		if !matches(c.Objected) {
			return Verdict{Reason: "it doesn't match the code the reviewer objected to"}
		}
		if matches(c.Fixed) {
			return Verdict{Reason: "it still matches the fixed code"}
		}
	case "required":
		if !matches(c.Fixed) {
			return Verdict{Reason: "it doesn't match the fixed code"}
		}
		if matches(c.Objected) {
			return Verdict{Reason: "the objected code already had it"}
		}
		return Verdict{Keep: true, Reason: "matches the fix only"}
	default:
		return Verdict{Reason: "unknown pattern type"}
	}
	if area == nil {
		return Verdict{Reason: "the area's files couldn't be read, so its share is unknown"}
	}
	v := Verdict{Files: len(area)}
	for _, code := range area {
		if matches(code) {
			v.Matched++
		}
	}
	if v.Files > 0 && float64(v.Matched) > MaxAreaShare*float64(v.Files) {
		v.Reason = fmt.Sprintf("already in %d of the area's %d files", v.Matched, v.Files)
		return v
	}
	v.Keep, v.Reason = true, "matches the objected code only, and is rare in the area"
	return v
}

// Matcher returns a function reporting whether one pattern occurs in code.
func Matcher(match, p string) (func(string) bool, error) {
	switch match {
	case "literal":
		if p == "" {
			return nil, ErrPattern
		}
		l := NewLiteral([]string{p})
		return func(code string) bool { return code != "" && l.Scan(code)[0] }, nil
	case "structural":
		s, err := CompileStructural(p)
		if err != nil {
			return nil, err
		}
		return s.Match, nil
	}
	return nil, ErrPattern
}
