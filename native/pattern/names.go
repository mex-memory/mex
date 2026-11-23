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
	// A plain word is evidence only when the reviewed code declares it as a
	// function, type or import. A local the change made for itself is not.
	if word, plain := plainWord(p); plain && namedSymbol(word, code) {
		return ""
	}
	local := declaredNames(code)
	for _, w := range own {
		if !local[w] {
			if _, plain := plainWord(p); plain && len(own) == 1 {
				return "it is only the word " + own[0] + ", not a symbol declared in the reviewed code"
			}
			return ""
		}
	}
	return "it names only " + strings.Join(own, ", ") + ", declared in the reviewed code itself"
}

// plainWord is one word of letters with no inner capital. A dot, underscore,
// parenthesis, digit or camelCase hump is a code shape and stays eligible.
func plainWord(p string) (string, bool) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", false
	}
	for i, r := range p {
		if r < 'A' || (r > 'Z' && r < 'a') || r > 'z' {
			return "", false
		}
		if i > 0 && r >= 'A' && r <= 'Z' {
			return "", false
		}
	}
	return p, true
}

var (
	declaredSymbol = regexp.MustCompile(`(?m)(?:\bfunc\s+(?:\([^)\n]*\)\s*)?|\b(?:function|fn|def|class|struct|interface|trait|enum)\s+|\btype\s+)([A-Za-z_][A-Za-z0-9_]*)`)
	importDefault  = regexp.MustCompile(`(?m)\bimport\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\b`)
	importNamed    = regexp.MustCompile(`\bimport\s*(?:type\s*)?\{([^}]*)\}`)
	importPython   = regexp.MustCompile(`(?m)^\s*(?:import|from\s+\S+\s+import)\s+([^\n#]+)`)
)

func namedSymbol(name, code string) bool {
	for _, m := range declaredSymbol.FindAllStringSubmatch(code, -1) {
		if m[1] == name {
			return true
		}
	}
	for _, m := range importDefault.FindAllStringSubmatch(code, -1) {
		if m[1] == name {
			return true
		}
	}
	for _, m := range importNamed.FindAllStringSubmatch(code, -1) {
		if binding(m[1])[name] {
			return true
		}
	}
	for _, m := range importPython.FindAllStringSubmatch(code, -1) {
		if binding(m[1])[name] {
			return true
		}
	}
	return false
}

// binding is the name a list actually introduces: `format as fmt` binds fmt.
func binding(list string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if i := strings.LastIndex(part, " as "); i >= 0 {
			part = strings.TrimSpace(part[i+4:])
		}
		if w := wordRun.FindString(part); w != "" {
			out[w] = true
		}
	}
	return out
}

var scopedCall = regexp.MustCompile(`(?:^|\s)(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\s*\(`)
var namedCall = regexp.MustCompile(`^[A-Za-z_$][\w$]{2,}\s*\(`)

func preciseCodeShape(p string) bool {
	p = strings.TrimSpace(p)
	switch p {
	case "<=", ">=", "==", "!=", "===", "!==":
		return true
	}
	if scopedCall.MatchString(p) {
		return true
	}
	words := patternWords(p)
	return len(words) > 0 && namedCall.MatchString(p) && !keywords[words[0]]
}

func matchesAnchor(before, after, anchor string, spans [][2]int) bool {
	regions := anchorRegions(before, anchor)
	if regions == nil || overlaps(spans, regions) {
		return true
	}
	// A review can point at the context directly beside the fix. Require
	// that context to survive, so a separate change on the anchor cannot
	// make a neighboring match look like the reviewed change.
	for _, r := range regions {
		line := before[r[0]:r[1]]
		left := strings.LastIndexByte(strings.TrimSuffix(before[:r[0]], "\n"), '\n') + 1
		right := min(r[1]+1, len(before))
		if end := strings.IndexByte(before[right:], '\n'); end >= 0 {
			right += end
		} else {
			right = len(before)
		}
		for _, nearby := range [][2]int{{left, r[0]}, {min(r[1]+1, right), right}} {
			if !overlaps(spans, [][2]int{nearby}) {
				continue
			}
			if len(anchorRegions(after, line)) > 0 {
				return true
			}
			// An adjacent declaration can be precisely what the review
			// objects to when the commented line uses its binding.
			adjacent := strings.TrimSpace(before[nearby[0]:nearby[1]])
			if !strings.HasPrefix(adjacent, "if ") && !strings.HasPrefix(adjacent, "for ") {
				continue
			}
			locals := declaredNames(adjacent)
			for _, word := range patternWords(line) {
				if distinctive(word) && locals[word] {
					return true
				}
			}
		}
	}
	return false
}

func codeLiteralSpans(p, code string) [][2]int {
	if !strings.Contains(code, p) {
		return nil
	}
	toks, offsets := tokenizeAt(code)
	raw := Spans("literal", p, code)
	start, end := len(p)-len(strings.TrimLeft(p, " \t\r\n")), len(strings.TrimRight(p, " \t\r\n"))
	var matched [][2]int
	for i, j, k := 0, 0, 0; i < len(raw); i++ {
		lo, hi := raw[i][0]+start, raw[i][0]+end
		for j < len(offsets) && offsets[j] < lo {
			j++
		}
		if j == len(offsets) || offsets[j] != lo {
			continue
		}
		for k = max(k, j); k < len(offsets) && offsets[k]+len(toks[k]) < hi; k++ {
		}
		if k < len(offsets) && offsets[k]+len(toks[k]) == hi {
			matched = append(matched, raw[i])
		}
	}
	return matched
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
			if s[0] < r[1] && r[0] < s[1] {
				return true
			}
		}
	}
	return false
}
