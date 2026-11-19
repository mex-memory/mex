package pattern

import (
	"errors"
	"strings"
)

// Structural is a code pattern matched on tokens, so spacing, line breaks
// and comments don't matter: `console.log($$$)` matches
// "console.log(\n  'x', y)". It runs on edit hunks only, never on whole
// files, which keeps it inside the hook's time budget.
//
// Pattern syntax (the same metavariables as ast-grep):
//   - $NAME matches one expression: the shortest run of tokens and
//     bracketed groups that lets the rest match, never past a top-level
//     comma or semicolon: `$A.then($B)` matches "fetch(u).then(r => r.json())".
//     The same name used twice must match the same text.
//   - $$$ (or $$$NAME) matches any run of tokens, possibly empty, that
//     doesn't close a bracket it didn't open.
//   - Everything else matches itself. A string matches a string with the
//     same content whichever quotes it uses.
type Structural struct {
	toks []ptok
}

type ptok struct {
	text string
	meta string // the name for $NAME, "$$$" for a run
}

// structuralBudget caps the matching steps for one text: a pattern that
// would take longer reports no match rather than slowing the agent down.
const structuralBudget = 200_000

// ErrPattern is returned for a pattern with no tokens, or unbalanced brackets.
var ErrPattern = errors.New("structural pattern is empty or unbalanced")

// CompileStructural parses a pattern.
func CompileStructural(p string) (*Structural, error) {
	var out []ptok
	depth := 0
	for _, t := range tokenize(p) {
		switch {
		case strings.HasPrefix(t, "$$$"):
			out = append(out, ptok{meta: "$$$"})
			continue
		case len(t) > 1 && t[0] == '$' && isUpperName(t[1:]):
			out = append(out, ptok{meta: t[1:]})
			continue
		}
		depth += bracketDelta(t)
		if depth < 0 {
			return nil, ErrPattern
		}
		out = append(out, ptok{text: t})
	}
	if len(out) == 0 || depth != 0 {
		return nil, ErrPattern
	}
	return &Structural{toks: out}, nil
}

// Match reports whether the pattern occurs anywhere in code.
func (s *Structural) Match(code string) bool {
	if s == nil {
		return false
	}
	toks := tokenize(code)
	m := matcher{pat: s.toks, toks: toks, budget: structuralBudget}
	for start := range toks {
		if m.at(0, start, map[string]string{}) {
			return true
		}
		if m.budget <= 0 {
			return false
		}
	}
	return false
}

type matcher struct {
	pat    []ptok
	toks   []string
	budget int
}

func (m *matcher) at(pi, ti int, bound map[string]string) bool {
	m.budget--
	if m.budget <= 0 {
		return false
	}
	if pi == len(m.pat) {
		return true
	}
	p := m.pat[pi]
	switch {
	case p.meta == "$$$":
		// Lazily: the shortest run first, extended one balanced unit at a time.
		for end := ti; ; {
			if m.at(pi+1, end, bound) {
				return true
			}
			next, ok := m.unit(end)
			if !ok {
				return false
			}
			end = next
		}
	case p.meta != "":
		// One expression: the shortest run of units that lets the rest
		// match, never past a top-level comma or semicolon.
		prev, seen := bound[p.meta]
		for end := ti; ; {
			next, ok := m.unit(end)
			if !ok || m.toks[end] == "," || m.toks[end] == ";" {
				return false
			}
			end = next
			text := strings.Join(m.toks[ti:end], " ")
			if seen {
				if text == prev && m.at(pi+1, end, bound) {
					return true
				}
				if len(text) >= len(prev) {
					return false
				}
				continue
			}
			bound[p.meta] = text
			if m.at(pi+1, end, bound) {
				return true
			}
			delete(bound, p.meta)
			if m.budget <= 0 {
				return false
			}
		}
	default:
		return ti < len(m.toks) && sameToken(p.text, m.toks[ti]) && m.at(pi+1, ti+1, bound)
	}
}

// unit returns the end of the token or bracketed group starting at i; a
// closing bracket is never a unit on its own.
func (m *matcher) unit(i int) (int, bool) {
	if i >= len(m.toks) || bracketDelta(m.toks[i]) < 0 {
		return 0, false
	}
	if bracketDelta(m.toks[i]) == 0 {
		return i + 1, true
	}
	depth := 0
	for j := i; j < len(m.toks); j++ {
		depth += bracketDelta(m.toks[j])
		if depth == 0 {
			return j + 1, true
		}
	}
	return 0, false // never closed in this text
}

func sameToken(p, t string) bool {
	if p == t {
		return true
	}
	return isString(p) && isString(t) && p[1:len(p)-1] == t[1:len(t)-1]
}

func isString(t string) bool {
	return len(t) >= 2 && (t[0] == '\'' || t[0] == '"' || t[0] == '`') && t[len(t)-1] == t[0]
}

func bracketDelta(t string) int {
	switch t {
	case "(", "[", "{":
		return 1
	case ")", "]", "}":
		return -1
	}
	return 0
}

func isUpperName(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c == '_' || i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// tokenize splits code into identifiers, numbers, strings and single
// punctuation characters. Whitespace and // and /* */ comments are dropped.
// It never fails: an unterminated string or comment runs to the end.
func tokenize(s string) []string {
	var out []string
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '/' && i+1 < len(s) && s[i+1] == '/':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			end := strings.Index(s[i+2:], "*/")
			if end < 0 {
				i = len(s)
			} else {
				i += end + 4
			}
		case c == '\'' || c == '"' || c == '`':
			j := i + 1
			for j < len(s) && s[j] != c && (c == '`' || s[j] != '\n') {
				if s[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(s) {
				j = len(s) - 1
			}
			if j < len(s) && s[j] == c {
				out = append(out, s[i:j+1])
			} else {
				out = append(out, s[i:j+1]+string(c)) // closed for comparison
			}
			i = j + 1
		case c == '$' && i+3 <= len(s) && s[i:i+3] == "$$$":
			j := i + 3
			for j < len(s) && isWord(s[j]) {
				j++
			}
			out = append(out, s[i:j])
			i = j
		case isWord(c) || c == '$':
			j := i + 1
			for j < len(s) && (isWord(s[j]) || s[j] == '$') {
				j++
			}
			out = append(out, s[i:j])
			i = j
		default:
			out = append(out, s[i:i+1])
			i++
		}
	}
	return out
}

func isWord(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c >= 0x80
}
