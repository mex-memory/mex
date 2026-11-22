package delivery

import (
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
	"sort"
	"strings"
	"unicode"
)

// Three-word shingles ignore presentation and source labels. Short texts use
// word containment; a single generic word can never suppress an entry.
func shingleSimilar(a, b string) bool {
	words := func(s string) []string {
		return strings.FieldsFunc(strings.ToLower(boundedText(s, 32768)), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	}
	x, y := words(a), words(b)
	if len(x) < 3 || len(y) < 3 {
		if len(x) < 2 || len(y) < 2 {
			return false
		}
		set := map[string]bool{}
		for _, w := range y {
			set[w] = true
		}
		hit := 0
		for _, w := range x {
			if set[w] {
				hit++
			}
		}
		return float64(hit)/float64(len(x)) >= .8 && float64(hit)/float64(len(y)) >= .6
	}
	shingles := func(ws []string) map[string]bool {
		out := map[string]bool{}
		for i := 0; i+2 < len(ws); i++ {
			out[strings.Join(ws[i:i+3], " ")] = true
		}
		return out
	}
	sx, sy := shingles(x), shingles(y)
	n := 0
	for s := range sx {
		if sy[s] {
			n++
		}
	}
	return float64(n)/float64(len(sx)+len(sy)-n) >= .6
}

// nativeSimilar says whether a rule file already says the candidate's claim.
func nativeSimilar(claim string, texts []string) bool {
	for _, text := range texts {
		// A native file can contain many independent rules; compare paragraphs
		// and individual lines instead of diluting one rule in the whole file.
		for _, part := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' }) {
			if similar(claim, part, part) {
				return true
			}
		}
	}
	return false
}

// Text containment is deliberately strict: a false merge hides a useful entry.
// The dev pair study found no labelled duplicate at .95, but also no false
// merges; looser thresholds suppressed unrelated entries. No paraphrase claim.
//
// It is directional. The candidate's claim (its one line, not its rationale)
// is a duplicate only when the prior's whole text covers the claim's words.
// A short entry contained in a longer one must not hide the longer one:
// "Lint: `pnpm run lint`" covers one of five commands in a CI procedure, not
// the procedure. Negations and numbers are compared claim to claim, so a
// prior "never X" can't hide a candidate "X".
func similar(claim, priorClaim, priorText string) bool {
	// Dropping stop words or short numbers must not erase a disagreement.
	anchors := func(s string) string {
		var out []string
		for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if w == "not" || w == "no" || w == "never" || strings.IndexFunc(w, unicode.IsDigit) >= 0 {
				out = append(out, w)
			}
		}
		sort.Strings(out)
		return strings.Join(out, " ")
	}
	if anchors(claim) != anchors(priorClaim) {
		return false
	}
	sx, sy := map[string]bool{}, map[string]bool{}
	for _, w := range rank.Tokens(boundedText(claim, 32768)) {
		sx[w] = true
	}
	for _, w := range rank.Tokens(boundedText(priorText, 32768)) {
		sy[w] = true
	}
	if min(len(sx), len(sy)) < 3 {
		return false
	}
	n := 0
	for w := range sx {
		if sy[w] {
			n++
		}
	}
	return float64(n)/float64(len(sx)) >= .95
}

// itemSimilar says whether candidate a repeats prior b; see similar.
func itemSimilar(a, b *entries.Item) bool {
	x, y := shaped{candidate: candidate{item: a}}, shaped{candidate: candidate{item: b}}
	return (a.Entry.Kind == b.Entry.Kind || overlapping(x, y)) && similar(entryClaim(a.Entry), entryClaim(b.Entry), b.Entry.OneLine+" "+b.Entry.Text)
}

// entryClaim is what an entry says, without its rationale.
func entryClaim(e *entries.Entry) string {
	if strings.TrimSpace(e.OneLine) != "" {
		return e.OneLine
	}
	return e.Text
}
