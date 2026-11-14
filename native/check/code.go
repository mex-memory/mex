package check

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/mex-memory/mex/native/index"
)

// Index is the part of the file index the code checks use. *index.Reader
// satisfies it; without one, symbol and pattern checks fall back to the
// file hashes.
type Index interface {
	Outline(path string) (*index.OutlineAnswer, *index.Miss)
	FileInfo(path string) (*index.FileInfoAnswer, *index.Miss)
	SymbolsNamed(name string) ([]index.SymbolHit, error)
	PatternCounts(scope string, ids []string) (map[string]int, error)
}

// UseIndex lets symbol and pattern checks read the file index.
func (ev *Evaluator) UseIndex(ix Index) { ev.index = ix }

// maxCandidates bounds the fingerprints computed to re-link one symbol.
const maxCandidates = 64

// value: a literal list or value in code, compared as data.
func (ev *Evaluator) valueCheck(c Check) CheckResult {
	file, symbol := str(c.Target, "file"), str(c.Target, "symbol")
	now, res, ok := ev.readValue(file, symbol)
	if !ok {
		return res
	}
	if !equalValues(now, c.Saw["value"]) {
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("%s in %s changed", symbol, file), Now: now}
	}
	return CheckResult{Status: Pass, Now: now}
}

func (ev *Evaluator) readValue(file, symbol string) (any, CheckResult, bool) {
	data, res, ok := ev.readTarget(file)
	if !ok {
		return nil, res, false
	}
	if doc, err := parseConfig(file, data); err == nil {
		now, found := resolvePointer(doc, "/"+strings.ReplaceAll(strings.ReplaceAll(symbol, "~", "~0"), ".", "/"))
		if !found {
			return nil, CheckResult{Status: Gone, Reason: fmt.Sprintf("%s has no %s", file, symbol)}, false
		}
		return now, CheckResult{}, true
	}
	lang := languageOf(file)
	if lang == langOther {
		return nil, CheckResult{Status: Floor, Reason: file + " is not a language values are read from"}, false
	}
	now, found, err := findValue(data, lang, symbol)
	switch {
	case !found:
		return nil, CheckResult{Status: Gone, Reason: fmt.Sprintf("%s has no %s", file, symbol)}, false
	case err != nil:
		return nil, CheckResult{Status: Floor, Reason: fmt.Sprintf("%s in %s is no longer a plain literal", symbol, file)}, false
	}
	return now, CheckResult{}, true
}

// symbol: the code of one definition, compared as a token stream, so layout,
// comments, quotes, semicolons and trailing commas don't count. A symbol
// that moved or was renamed is found again by its fingerprint.
func (ev *Evaluator) symbolCheck(c Check) CheckResult {
	file, symbol := str(c.Target, "file"), str(c.Target, "symbol")
	want := str(c.Saw, "fingerprint")
	if ev.index == nil {
		return CheckResult{Status: Floor, Reason: "no file index for symbol checks"}
	}
	fp, res, ok := ev.fingerprint(file, symbol)
	if ok {
		if fp == want {
			return CheckResult{Status: Pass, Now: fp}
		}
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("%s in %s changed", symbol, file), Now: fp}
	}
	if res.Status != Gone {
		return res
	}
	if where, found := ev.relink(file, symbol, want); found {
		return CheckResult{Status: Pass, Reason: fmt.Sprintf("%s moved to %s", symbol, where), Now: want}
	}
	return res
}

// fingerprint finds a symbol in a file through the index and fingerprints
// its current text.
func (ev *Evaluator) fingerprint(file, symbol string) (string, CheckResult, bool) {
	data, res, ok := ev.readTarget(file)
	if !ok {
		return "", res, false
	}
	outline, miss := ev.index.Outline(file)
	if miss != nil {
		return "", CheckResult{Status: Floor, Reason: fmt.Sprintf("%s: %s", file, miss.NotIndexed)}, false
	}
	path := strings.Split(symbol, ".")
	at := findSymbol(outline.Symbols, path)
	if at < 0 {
		if outline.Dropped > 0 {
			return "", CheckResult{Status: Floor, Reason: file + " changed since the last parse"}, false
		}
		return "", CheckResult{Status: Gone, Reason: fmt.Sprintf("%s has no %s", file, symbol)}, false
	}
	s := outline.Symbols[at]
	if !ev.spanTrusted(file, data, s.Start, s.Name) {
		return "", CheckResult{Status: Floor, Reason: file + " changed since the last parse"}, false
	}
	return fingerprintSpan(data, languageOf(file), s.Start, s.End, s.Kind, s.Name), CheckResult{}, true
}

// spanTrusted guards against an index older than the file: when the hashes
// differ, the symbol's first line must still carry its name.
func (ev *Evaluator) spanTrusted(file string, data []byte, start int, name string) bool {
	info, miss := ev.index.FileInfo(file)
	if miss == nil && strings.HasPrefix(strings.TrimPrefix(hashBytes(data), "sha256:"), info.Hash) && info.Hash != "" {
		return true
	}
	lines := strings.Split(string(data), "\n")
	if start < 1 || start > len(lines) {
		return false
	}
	for _, t := range tokenize([]byte(lines[start-1]), languageOf(file)) {
		if t.kind == tIdent && t.text == name {
			return true
		}
	}
	// A decorator line starts the span; look one more line down.
	if start < len(lines) {
		for _, t := range tokenize([]byte(lines[start]), languageOf(file)) {
			if t.kind == tIdent && t.text == name {
				return true
			}
		}
	}
	return false
}

// findSymbol matches "Outer.inner" against an outline's parent chain.
func findSymbol(symbols []index.Symbol, path []string) int {
	for i, s := range symbols {
		if s.Name != path[len(path)-1] {
			continue
		}
		at, ok := s.Parent, true
		for j := len(path) - 2; j >= 0; j-- {
			if at == nil || symbols[*at].Name != path[j] {
				ok = false
				break
			}
			at = symbols[*at].Parent
		}
		if ok {
			return i
		}
	}
	return -1
}

// relink looks for the same code elsewhere: the same name in other files
// (moved), then other symbols of the same kind in the same file (renamed).
// Only these candidates are fingerprinted.
func (ev *Evaluator) relink(file, symbol, want string) (string, bool) {
	kind := fingerprintKind(want)
	name := symbol[strings.LastIndex(symbol, ".")+1:]
	tried := 0
	try := func(path string, start, end int, symKind, symName string) bool {
		if tried >= maxCandidates || symKind != kind {
			return false
		}
		tried++
		r := ev.files.read(path)
		return r.err == nil && fingerprintSpan(r.data, languageOf(path), start, end, symKind, symName) == want
	}
	if hits, err := ev.index.SymbolsNamed(name); err == nil {
		for _, h := range hits {
			if h.Path != file && try(h.Path, h.Start, h.End, h.Kind, name) {
				return h.Path + ":" + name, true
			}
		}
	}
	if outline, miss := ev.index.Outline(file); miss == nil {
		for _, s := range outline.Symbols {
			if s.Name != name && try(file, s.Start, s.End, s.Kind, s.Name) {
				return file + ":" + s.Name, true
			}
		}
	}
	return "", false
}

// fingerprintSpan hashes lines start..end as tokens. The symbol's own name
// is left out so a rename keeps the fingerprint; the kind is kept in the
// clear so re-linking compares like with like.
func fingerprintSpan(data []byte, lang language, start, end int, kind, name string) string {
	h := sha256.New()
	toks := tokenize(data, lang)
	var kept []token
	for _, t := range toks {
		if t.line >= start && t.line <= end {
			kept = append(kept, t)
		}
	}
	renamed := false
	for i, t := range kept {
		switch {
		case t.kind == tPunct && t.text == ";" && lang == langJS:
			continue
		case t.kind == tPunct && t.text == "," && i+1 < len(kept) && strings.Contains(")]}>", kept[i+1].text):
			continue
		case t.kind == tIdent && t.text == name && !renamed:
			renamed = true
			h.Write([]byte{0, 9})
			continue
		}
		h.Write([]byte{0, byte(t.kind)})
		h.Write([]byte(unquote(t.text)))
	}
	return "t1:" + kind + ":" + hex.EncodeToString(h.Sum(nil))[:32]
}

func fingerprintKind(fp string) string {
	parts := strings.SplitN(fp, ":", 3)
	if len(parts) != 3 {
		return ""
	}
	return parts[1]
}

// PatternID is the file index's id for a literal pattern.
func PatternID(pattern string) string {
	sum := sha256.Sum256([]byte("literal\n" + pattern))
	return "p" + hex.EncodeToString(sum[:])[:15]
}

// pattern: how often a literal pattern occurs in scope, from the file
// index's counts (re-counted when the index refreshes).
func (ev *Evaluator) patternCheck(c Check) CheckResult {
	count, res, ok := ev.patternCount(c.Target)
	if !ok {
		return res
	}
	want, _ := normalize(c.Saw["count"])
	if want != float64(count) {
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("%q now occurs %d times in %s", str(c.Target, "pattern"), count, str(c.Target, "scope")), Now: count}
	}
	return CheckResult{Status: Pass, Now: count}
}

func (ev *Evaluator) patternCount(target map[string]any) (int, CheckResult, bool) {
	if m := str(target, "match"); m != "" && m != "literal" {
		return 0, CheckResult{Status: Floor, Reason: "structural patterns are counted on edits, not here"}, false
	}
	if ev.index == nil {
		return 0, CheckResult{Status: Floor, Reason: "no file index for pattern checks"}, false
	}
	id := PatternID(str(target, "pattern"))
	counts, err := ev.index.PatternCounts(str(target, "scope"), []string{id})
	if err != nil {
		return 0, CheckResult{Status: Floor, Reason: "the file index can't be read"}, false
	}
	count, counted := counts[id]
	if !counted {
		return 0, CheckResult{Status: Floor, Reason: "the file index doesn't count this pattern yet"}, false
	}
	return count, CheckResult{}, true
}
