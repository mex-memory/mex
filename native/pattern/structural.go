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
	toks    []ptok
	needles []string // words any match must contain, checked before tokenizing
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
	s := &Structural{toks: out}
	for _, t := range out {
		// Words must appear verbatim in any code the pattern matches; strings
		// are left out because a match may use the other quote.
		if t.meta == "" && len(t.text) > 1 && isWord(t.text[0]) {
			s.needles = append(s.needles, t.text)
		}
	}
	return s, nil
}

// Words is the number of words the pattern names; a pattern of wildcards
// and punctuation alone matches too much to stop an edit.
func (s *Structural) Words() int {
	if s == nil {
		return 0
	}
	return len(s.needles)
}

// Match reports whether the pattern occurs anywhere in code.
func (s *Structural) Match(code string) bool {
	if s == nil {
		return false
	}
	// Most code lacks one of the pattern's words: reject it without
	// tokenizing.
	for _, n := range s.needles {
		if !strings.Contains(code, n) {
			return false
		}
	}
	toks := tokenize(code)
	m := matcher{pat: s.toks, toks: toks, budget: structuralBudget}
	first := s.toks[0]
	for start := range toks {
		// A pattern that starts with a literal token can only start there.
		if first.meta == "" && !sameToken(first.text, toks[start]) {
			continue
		}
		if m.at(0, start, map[string][2]int{}) {
			return true
		}
		if m.budget <= 0 {
			return false
		}
	}
	return false
}

// Spans returns the byte ranges of the pattern's matches in code, leftmost
// first and not overlapping. Used off the hook path, by the self-check.
func (s *Structural) Spans(code string) [][2]int {
	if s == nil {
		return nil
	}
	for _, n := range s.needles {
		if !strings.Contains(code, n) {
			return nil
		}
	}
	toks, offs := tokenizeAt(code)
	m := matcher{pat: s.toks, toks: toks, budget: structuralBudget}
	first := s.toks[0]
	var out [][2]int
	for start := 0; start < len(toks) && m.budget > 0; start++ {
		if first.meta == "" && !sameToken(first.text, toks[start]) {
			continue
		}
		if !m.at(0, start, map[string][2]int{}) {
			continue
		}
		lo, hi := offs[start], offs[start]
		if m.end > start {
			hi = min(len(code), offs[m.end-1]+len(toks[m.end-1]))
			start = m.end - 1
		}
		out = append(out, [2]int{lo, hi})
	}
	return out
}

type matcher struct {
	pat    []ptok
	toks   []string
	budget int
	end    int // after a match: the token index just past it
}

func (m *matcher) at(pi, ti int, bound map[string][2]int) bool {
	m.budget--
	if m.budget <= 0 {
		return false
	}
	if pi == len(m.pat) {
		m.end = ti
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
			if seen {
				// The same name again: the same tokens, so the same length.
				if n := prev[1] - prev[0]; end-ti >= n {
					return end-ti == n && m.same(prev[0], ti, n) && m.at(pi+1, end, bound)
				}
				continue
			}
			bound[p.meta] = [2]int{ti, end}
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

// same reports whether the n tokens at a and at b are the same.
func (m *matcher) same(a, b, n int) bool {
	for i := 0; i < n; i++ {
		if !sameToken(m.toks[a+i], m.toks[b+i]) {
			return false
		}
	}
	return true
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
	toks, _ := tokenizeAt(s)
	return toks
}

// tokenizeAt is tokenize with each token's byte offset in s.
func tokenizeAt(s string) ([]string, []int) {
	var out []string
	var offs []int
	for i := commentTail(s); i < len(s); {
		at, n := i, len(out)
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '/' && i+1 < len(s) && s[i+1] == '/':
			for i < len(s) && s[i] != '\n' {
				i++
			}
		case c == '#' && (i == 0 || strings.ContainsRune(" \t\n", rune(s[i-1]))):
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
		if len(out) > n {
			offs = append(offs, at)
		}
	}
	return out, offs
}

// commentTail is where code starts when s opens inside a block comment. A
// reviewed window cut from a file can begin in a doc comment's body, whose
// lines may hold backticks or quotes that would otherwise open a string. It is
// 0 unless every line before the first `*/` is blank or starts with `*`.
func commentTail(s string) int {
	for at := 0; at < len(s); {
		end := strings.IndexByte(s[at:], '\n')
		line := s[at:]
		if end >= 0 {
			line = s[at : at+end]
		}
		t := strings.TrimSpace(line)
		if t != "" && t[0] != '*' {
			return 0
		}
		if k := strings.Index(line, "*/"); k >= 0 {
			return at + k + 2
		}
		if end < 0 {
			return 0
		}
		at += end + 1
	}
	return 0
}

func isWord(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c >= 0x80
}
