// Package outline renders a big file read as its outline plus the slices the
// current task names (plan sheet 35, L2). Line numbers are the file's own;
// a header says how to get the full text. It only formats: whether a read is
// outlined is the hook's decision.
package outline

import (
	"fmt"
	"hash/fnv"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/tokens"
)

// Parameters start at the plan's values (sheet 35, L2).
const (
	// MinTokens keeps the tested cutoff at about 23k bytes: 10k calibrated code tokens.
	MinTokens = 10000
	// MaxSymbols listed; deeper symbols go first when there are more.
	MaxSymbols = 400
	// Slices: at most this many, of at most SliceLines each, SliceTotal in all.
	MaxSlices  = 3
	SliceLines = 60
	SliceTotal = 120
	// sliceContext lines around a line that names a term.
	sliceContext = 5
	// maxTermLines: a prompt word on more lines than this picks no slice.
	maxTermLines = 5
	// MaxShare: an outline bigger than this share of the file isn't worth it.
	MaxShare = 0.5
)

// Input is one file read.
type Input struct {
	TotalLines int             // optional full file length when Content is the host-returned prefix
	Path       string          // as the header shows it, relative to the checkout
	Content    string          // the file's text
	Symbols    []shift.Symbol  // from the file index, line shifts applied
	Dropped    int             // symbols an edit may have moved, left out
	Terms      map[uint64]bool // hashed words of the current prompt (WordHash)
}

// Result is the rendered outline.
type Result struct {
	Text   string
	Lines  int      // lines in the file
	Slices [][2]int // the file lines shown in full, inclusive
}

// WordHash is how prompt words and file identifiers are compared, without
// keeping the prompt's text.
func WordHash(w string) uint64 {
	f := fnv.New64a()
	_, _ = f.Write([]byte(strings.ToLower(w)))
	return f.Sum64()
}

// Header is the first line of an outline; the guard's messages repeat its
// instruction for the full text.
func Header(lines int, slices [][2]int) string { return headerForRead(lines, lines, slices) }

func headerForRead(lines, readLines int, slices [][2]int) string {
	shown := ""
	if len(slices) > 0 {
		parts := make([]string, len(slices))
		for i, s := range slices {
			parts[i] = fmt.Sprintf("%d–%d", s[0], s[1])
		}
		shown = " + lines " + strings.Join(parts, ", ")
	}
	label := "full text"
	if readLines < lines {
		label = "full text of this read"
	}
	return fmt.Sprintf("[MEX: %s-line file shown as outline%s · %s: Read offset=1 limit=%d]", group(lines), shown, label, readLines)
}

// Render builds the outline, or reports false when it wouldn't help: no
// symbols, a small file, or an outline nearly as big as the file.
func Render(in Input) (Result, bool) {
	lines := splitLines(in.Content)
	if len(in.Symbols) == 0 || tokens.Code(in.Content) <= MinTokens || len(lines) == 0 {
		return Result{}, false
	}
	var symbols []shift.Symbol
	var valid []int
	for i, s := range in.Symbols {
		if s.Start >= 1 && s.End >= s.Start && s.Start <= len(lines) {
			symbols = append(symbols, s)
			valid = append(valid, i)
		}
	}
	if len(symbols) == 0 {
		return Result{}, false
	}
	depth := depths(in.Symbols)
	listed, unlisted := pick(valid, in.Symbols, depth)
	slices := pickSlices(lines, symbols, in.Symbols, in.Terms)

	var b strings.Builder
	b.WriteString(headerForRead(max(in.TotalLines, len(lines)), len(lines), slices))
	b.WriteByte('\n')
	fmt.Fprintf(&b, "Outline of %s. Each entry is start-end in the file's own line numbers; this view's line numbers are not the file's.\n", in.Path)
	width := len(fmt.Sprint(len(lines)))
	for _, i := range listed {
		s := in.Symbols[i]
		span := fmt.Sprintf("%d-%d", s.Start, s.End)
		fmt.Fprintf(&b, "%-*s %s%s %s\n", width*2+1, span, strings.Repeat("  ", depth[i]), s.Kind, s.Name)
	}
	if unlisted > 0 {
		fmt.Fprintf(&b, "(%d nested symbols not listed)\n", unlisted)
	}
	if in.Dropped > 0 {
		fmt.Fprintf(&b, "(%d symbols changed by an edit since the last index and are left out)\n", in.Dropped)
	}
	for _, s := range slices {
		fmt.Fprintf(&b, "\nLines %d–%d:\n", s[0], s[1])
		for n := s[0]; n <= s[1]; n++ {
			fmt.Fprintf(&b, "%*d  %s\n", width, n, strings.TrimSuffix(lines[n-1], "\r"))
		}
	}
	text := b.String()
	if float64(len(text)) > MaxShare*float64(len(in.Content)) {
		return Result{}, false
	}
	return Result{Text: text, Lines: len(lines), Slices: slices}, true
}

func depths(all []shift.Symbol) []int {
	d := make([]int, len(all))
	for i := range all {
		seen := 0
		for p := all[i].Parent; p != nil && *p >= 0 && *p < len(all) && seen < 32; p = all[*p].Parent {
			d[i]++
			seen++
		}
	}
	return d
}

// pick lists symbols in line order, shallowest first when there are too many.
func pick(valid []int, all []shift.Symbol, depth []int) ([]int, int) {
	idx := append([]int(nil), valid...)
	unlisted := 0
	if len(idx) > MaxSymbols {
		byDepth := append([]int(nil), idx...)
		sort.SliceStable(byDepth, func(a, b int) bool { return depth[byDepth[a]] < depth[byDepth[b]] })
		keep := map[int]bool{}
		for _, i := range byDepth[:MaxSymbols] {
			keep[i] = true
		}
		unlisted = len(idx) - MaxSymbols
		filtered := idx[:0]
		for _, i := range idx {
			if keep[i] {
				filtered = append(filtered, i)
			}
		}
		idx = filtered
	}
	sort.SliceStable(idx, func(a, b int) bool { return all[idx[a]].Start < all[idx[b]].Start })
	return idx, unlisted
}

// pickSlices: symbols the prompt names first (from their first line), then
// lines that name a prompt word, with a little context. Merged and capped.
func pickSlices(lines []string, symbols, all []shift.Symbol, terms map[uint64]bool) [][2]int {
	if len(terms) == 0 {
		return nil
	}
	var want [][2]int
	total := 0
	add := func(from, to int) {
		if len(want) >= MaxSlices || total >= SliceTotal {
			return
		}
		from, to = max(1, from), min(len(lines), to)
		if to-from+1 > SliceLines {
			to = from + SliceLines - 1
		}
		if to-from+1 > SliceTotal-total {
			to = from + SliceTotal - total - 1
		}
		for _, w := range want {
			if from <= w[1] && to >= w[0] {
				return // overlaps one already shown
			}
		}
		want = append(want, [2]int{from, to})
		total += to - from + 1
	}
	// A named symbol inside another named symbol comes first (Cart.add when
	// the prompt says both), then smaller symbols.
	names := func(s shift.Symbol) int {
		n, seen := 0, 0
		for p := s.Parent; p != nil && *p >= 0 && *p < len(all) && seen < 32; p = all[*p].Parent {
			if terms[WordHash(all[*p].Name)] {
				n++
			}
			seen++
		}
		return n
	}
	var named []shift.Symbol
	for _, s := range symbols {
		if !stopword(s.Name) && terms[WordHash(s.Name)] {
			named = append(named, s)
		}
	}
	sort.SliceStable(named, func(a, b int) bool {
		if na, nb := names(named[a]), names(named[b]); na != nb {
			return na > nb
		}
		return named[a].End-named[a].Start < named[b].End-named[b].Start
	})
	for _, s := range named {
		add(s.Start, s.End)
	}
	// Then lines naming a prompt word, rarest word first: a word on many
	// lines says little about where the task is.
	where := map[uint64][]int{}
	for i, line := range lines {
		for _, w := range identifiers(line) {
			if len(w) < 3 || stopword(w) {
				continue
			}
			if h := WordHash(w); terms[h] {
				if at := where[h]; len(at) == 0 || at[len(at)-1] != i+1 {
					where[h] = append(at, i+1)
				}
			}
		}
	}
	rare := make([]uint64, 0, len(where))
	for h, at := range where {
		if len(at) <= maxTermLines {
			rare = append(rare, h)
		}
	}
	sort.Slice(rare, func(a, b int) bool {
		if len(where[rare[a]]) != len(where[rare[b]]) {
			return len(where[rare[a]]) < len(where[rare[b]])
		}
		return where[rare[a]][0] < where[rare[b]][0]
	})
	for _, h := range rare {
		for _, line := range where[h] {
			add(line-sliceContext, line+sliceContext)
		}
	}
	sort.Slice(want, func(a, b int) bool { return want[a][0] < want[b][0] })
	return want
}

// stopwords are prompt words too common to point anywhere.
var stopwords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "this": true, "that": true, "from": true, "into": true,
	"what": true, "when": true, "why": true, "how": true, "does": true, "can": true, "you": true, "please": true,
	"add": true, "fix": true, "make": true, "use": true, "file": true, "code": true, "not": true, "are": true,
	"was": true, "has": true, "have": true, "all": true, "any": true, "new": true, "get": true, "set": true,
	"return": true, "function": true, "const": true, "let": true, "var": true, "import": true, "export": true,
	"class": true, "def": true, "self": true, "true": true, "false": true, "null": true, "none": true,
	"type": true, "string": true, "number": true, "option": true, "options": true, "command": true, "test": true,
}

func stopword(w string) bool { return stopwords[strings.ToLower(w)] }

func identifiers(text string) []string {
	return strings.FieldsFunc(text, func(r rune) bool {
		return !(r == '_' || r == '$' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z')
	})
}

func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func group(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
