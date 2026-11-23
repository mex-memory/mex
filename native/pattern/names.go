package pattern

import (
	"regexp"
	"strings"
)

// What a pattern names, and where it sits in the reviewed code. A reviewer
// objects to a call, an API, a construct; a pattern that names only words
// every codebase has, or only names the reviewed change declared for itself,
// can't tell the next edit apart from any other and must not stop one.

// keywords are words that name no particular code: language keywords,
// built-in types and values across the languages MEX reads.
var keywords = setOf(`
	break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var
	bool byte rune string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 error any nil true false iota
	len cap make new append copy delete panic recover print println close min max clear
	async await catch class debugger do enum export extends finally function implements in instanceof let null private protected public static super this throw try typeof void while with yield undefined
	number boolean object symbol bigint unknown never readonly as from of keyof declare namespace module require get set
	and assert def del elif except global is lambda nonlocal not or pass raise self cls str float list dict tuple
	True False None Self String Vec Option Some Ok Err Result Box
	fn mut pub impl use mod match loop where crate trait dyn ref move unsafe extern i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64
	TODO FIXME
`)

// commonEnglish are ordinary words. One of them, with no identifier beside it,
// occurs in edits that are not the mistake a reviewer pointed at.
var commonEnglish = setOf(`
	invalid project projects package packages rejected reject
	error errors message messages value values name names type types
	file files path paths data result results request response
	user users option options default version change changes
	string object function class method config command
	output input status state item items list text line lines
	code test tests info warning note notes
	available matching environment conflict conflicts
	current previous new old true false none null
`)

func setOf(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(s) {
		out[w] = true
	}
	return out
}

var (
	metaRun  = regexp.MustCompile(`\$\$\$\w*|\$[A-Z_][A-Z0-9_]*`)
	wordRun  = regexp.MustCompile(`[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*`)
	shortVar = regexp.MustCompile(`([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=`)
	declVar  = regexp.MustCompile(`\b(?:var|let|const|val|let\s+mut)\s+([A-Za-z_]\w*)`)
	declDest = regexp.MustCompile(`\b(?:var|let|const)\s*[{\[]([^}\]]*)[}\]]`)
	forVar   = regexp.MustCompile(`\bfor\s*\(?\s*(?:const|let|var)?\s*([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))?\s*(?::=|\bin\b|\bof\b)`)
	assigned = regexp.MustCompile(`(?m)^\s*([A-Za-z_]\w*)\s*[-+*/|&]?=[^=]`)
	// Parameter lists: Go functions and methods (receiver too), function
	// literals, JavaScript functions and arrows, Python and Rust.
	params = []*regexp.Regexp{
		regexp.MustCompile(`\bfunc\s*\(([^()]*)\)\s*[A-Za-z_]`),
		regexp.MustCompile(`\bfunc\s*(?:\([^()]*\)\s*)?[A-Za-z_]\w*\s*(?:\[[^\]]*\])?\s*\(([^()]*)\)`),
		regexp.MustCompile(`\bfunc\s*\(([^()]*)\)\s*[^A-Za-z_\s]`),
		regexp.MustCompile(`\bfunction\b[^(]*\(([^()]*)\)`),
		regexp.MustCompile(`\(([^()]*)\)\s*(?::\s*[^=;{]+)?=>`),
		regexp.MustCompile(`\b([A-Za-z_]\w*)\s*=>`),
		regexp.MustCompile(`\bdef\s+\w+\s*\(([^()]*)\)`),
		regexp.MustCompile(`\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(([^()]*)\)`),
	}
)

// patternWords are the identifiers a pattern names, metavariables left out.
// Words inside strings count: `from 'moment'` names moment.
func patternWords(p string) []string {
	return wordRun.FindAllString(metaRun.ReplaceAllString(p, " "), -1)
}

// distinctive reports whether a word names something of its own: not a
// keyword or built-in, not a one- or two-letter name, not a number.
func distinctive(w string) bool {
	if len(w) < 3 || w[0] >= '0' && w[0] <= '9' {
		return false
	}
	// Case matters: Go's assert.Assert is a name, Python's assert a keyword.
	return !keywords[w]
}

// declaredNames are the local variables and parameters code declares or
// assigns: names the reviewed change made for itself. Function and type
// names, fields and imports are not in it, since a reviewer can object to
// those as such.
func declaredNames(code string) map[string]bool {
	out := map[string]bool{}
	add := func(list string) {
		for _, part := range strings.Split(list, ",") {
			part = strings.TrimSpace(part)
			part = strings.TrimLeft(part, ".*&")
			for _, w := range strings.Fields(part) {
				if w == "mut" || w == "self" || w == "ref" {
					continue
				}
				if m := wordRun.FindString(w); m != "" {
					out[m] = true
				}
				break
			}
		}
	}
	for _, m := range shortVar.FindAllStringSubmatch(code, -1) {
		add(m[1])
	}
	for _, m := range declVar.FindAllStringSubmatch(code, -1) {
		out[m[1]] = true
	}
	for _, m := range declDest.FindAllStringSubmatch(code, -1) {
		for _, part := range strings.Split(m[1], ",") {
			// `{ a: b }` binds b; `{ a }` and `[a]` bind a.
			if i := strings.LastIndex(part, ":"); i >= 0 {
				part = part[i+1:]
			}
			if w := wordRun.FindString(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(part), "..."))); w != "" {
				out[w] = true
			}
		}
	}
	for _, m := range forVar.FindAllStringSubmatch(code, -1) {
		for _, w := range m[1:] {
			if w != "" {
				out[w] = true
			}
		}
	}
	for _, m := range assigned.FindAllStringSubmatch(code, -1) {
		out[m[1]] = true
	}
	for _, re := range params {
		for _, m := range re.FindAllStringSubmatch(code, -1) {
			add(m[1])
		}
	}
	return out
}

// nameCheck says why a pattern names nothing a rule can stand on, or "".
// code is the reviewed code the pattern must describe.
func nameCheck(p, code string) string {
	var own []string
	for _, w := range patternWords(p) {
		if distinctive(w) {
			own = append(own, w)
		}
	}
	if len(own) == 0 {
		return "it names no word of its own, only keywords and short names"
	}
	local := declaredNames(code)
	for _, w := range own {
		if !local[w] {
			return plainEnglish(p, own)
		}
	}
	return "it names only " + strings.Join(own, ", ") + ", declared in the reviewed code itself"
}

// plainEnglish rejects a pattern whose only distinctive word is an ordinary
// word and that names no identifier: no field, call, private name or camelCase.
// `provider._constraints` and `this.getLayoutUsecase.execute(` stay.
func plainEnglish(p string, own []string) string {
	if len(own) != 1 || codeShaped(p) || own[0] != strings.ToLower(own[0]) || !commonEnglish[own[0]] {
		return ""
	}
	return "it names only " + own[0] + ", a common word, not an identifier"
}

func codeShaped(p string) bool {
	if strings.ContainsAny(p, "._(") {
		return true
	}
	for _, w := range patternWords(p) {
		if strings.Contains(w, "_") {
			return true
		}
		lower, upper := false, false
		for _, r := range w {
			switch {
			case r >= 'a' && r <= 'z':
				lower = true
			case r >= 'A' && r <= 'Z':
				upper = true
			}
		}
		if lower && upper {
			return true
		}
	}
	return false
}

// anchorRegions are the byte ranges of code's lines that the review comment
// is on: lines whose text, trimmed, is one of anchor's. Lines with fewer than
// three word characters (a lone brace) never anchor anything. nil when the
// anchor is empty, none of its lines is in code, or it is only a code
// comment: a review comment left on a code comment is about the code that
// comment describes, which may be anywhere in the block.
func anchorRegions(code, anchor string) [][2]int {
	want := map[string]bool{}
	onCode := false
	for _, l := range strings.Split(anchor, "\n") {
		if l = strings.TrimSpace(l); substantial(l) {
			want[l] = true
			onCode = onCode || !commentLine(l)
		}
	}
	if len(want) == 0 || !onCode {
		return nil
	}
	var out [][2]int
	start := 0
	for start <= len(code) {
		end := strings.IndexByte(code[start:], '\n')
		if end < 0 {
			end = len(code)
		} else {
			end += start
		}
		if want[strings.TrimSpace(code[start:end])] {
			if n := len(out); n > 0 && out[n-1][1] >= start-1 {
				out[n-1][1] = end
			} else {
				out = append(out, [2]int{start, end})
			}
		}
		start = end + 1
	}
	return out
}

func commentLine(l string) bool {
	for _, p := range []string{"//", "#", "/*", "*", "--", "<!--"} {
		if strings.HasPrefix(l, p) {
			return true
		}
	}
	return false
}

func substantial(line string) bool {
	n := 0
	for i := 0; i < len(line); i++ {
		if isWord(line[i]) {
			if n++; n >= 3 {
				return true
			}
		}
	}
	return false
}

// Spans returns where a pattern occurs in code, as byte ranges.
func Spans(match, p, code string) [][2]int {
	switch match {
	case "literal":
		if p == "" {
			return nil
		}
		var out [][2]int
		for at := 0; ; {
			i := strings.Index(code[at:], p)
			if i < 0 {
				return out
			}
			out = append(out, [2]int{at + i, at + i + len(p)})
			at += i + len(p)
		}
	case "structural":
		s, err := CompileStructural(p)
		if err != nil {
			return nil
		}
		return s.Spans(code)
	}
	return nil
}

func overlaps(spans, regions [][2]int) bool {
	for _, s := range spans {
		for _, r := range regions {
			if s[0] <= r[1] && r[0] <= s[1] {
				return true
			}
		}
	}
	return false
}
