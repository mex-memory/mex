package check

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/pattern"
)

// builtAt is an index that knows the commit its files were listed at.
type builtAt interface{ Head() string }

// indexBehindHead reports whether HEAD moved since the index was built: a
// commit, checkout or pull made outside a session that no edit hook saw. It
// reads two small Git files once per evaluator and never runs Git. An index
// or checkout whose HEAD can't be read counts as current.
func (ev *Evaluator) indexBehindHead() bool {
	if ev.behind == 0 {
		ev.behind = 1
		if ix, ok := ev.index.(builtAt); ok && ix.Head() != "" && ev.files != nil && ev.files.root != nil {
			if now, ok := gitstate.Read(ev.files.root.Name()); ok && now.Head != ix.Head() {
				ev.behind = 2
			}
		}
	}
	return ev.behind == 2
}

// Index is the part of the file index the code checks use. *index.Reader
// satisfies it; without one, symbol, pattern and relation checks fall back
// to the file hashes.
type Index interface {
	Outline(path string) (*index.OutlineAnswer, *index.Miss)
	FileInfo(path string) (*index.FileInfoAnswer, *index.Miss)
	SymbolsNamed(name string) ([]index.SymbolHit, error)
	PatternCounts(scope string, ids []string) (map[string]int, error)
	ImportsFrom(glob string) (*index.ImportsAnswer, error)
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
	fp, res, ok := ev.fingerprint(file, symbol, want)
	if ok {
		if fp == want {
			return CheckResult{Status: Pass, Now: fp}
		}
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("%s in %s changed", symbol, file), Now: fp}
	}
	if res.Status != Gone || ev.deliveryScopes != nil {
		return res
	}
	if where, found := ev.relink(file, symbol, want); found {
		return CheckResult{Status: Pass, Reason: fmt.Sprintf("%s moved to %s:%s", symbol, where.File, where.Symbol), Now: want, Relink: &where}
	}
	return res
}

// fingerprint finds a symbol in a file through the index and fingerprints
// its current text. A fingerprint recorded in a checkout with CRLF line endings
// before they were left out still matches there.
func (ev *Evaluator) fingerprint(file, symbol, want string) (string, CheckResult, bool) {
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
	start, end := overloadSpan(outline.Symbols, at)
	if matchesFingerprint(data, languageOf(file), start, end, s.Kind, s.Name, want) {
		return want, CheckResult{}, true
	}
	return fingerprintSpan(data, languageOf(file), start, end, s.Kind, s.Name), CheckResult{}, true
}

// overloadSpan widens a symbol's span over every declaration with the same
// name and parent: TypeScript overload signatures come before the body, and
// fingerprinting only the first signature would never see the body change.
// A symbol declared once keeps its own span, so its fingerprint is unchanged.
func overloadSpan(symbols []index.Symbol, at int) (start, end int) {
	s := symbols[at]
	start, end = s.Start, s.End
	sameParent := func(a, b *int) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
	for i, o := range symbols {
		if i == at || o.Name != s.Name || o.Kind != s.Kind || !sameParent(o.Parent, s.Parent) {
			continue
		}
		start, end = min(start, o.Start), max(end, o.End)
	}
	return start, end
}

// spanTrusted guards against an index older than the file: when the hashes
// differ, the symbol's first line must still carry its name.
func (ev *Evaluator) spanTrusted(file string, data []byte, start int, name string) bool {
	info, miss := ev.index.FileInfo(file)
	if miss == nil && strings.HasPrefix(strings.TrimPrefix(hashBytes(data), "sha256:"), info.Hash) && info.Hash != "" {
		return true
	}
	if ev.deliveryScopes != nil {
		return false
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
func (ev *Evaluator) relink(file, symbol, want string) (SymbolRelink, bool) {
	kind := fingerprintKind(want)
	name := symbol[strings.LastIndex(symbol, ".")+1:]
	tried := 0
	try := func(path string, start, end int, symKind, symName string) bool {
		if tried >= maxCandidates || symKind != kind {
			return false
		}
		tried++
		r := ev.files.read(path)
		return r.err == nil && matchesFingerprint(r.data, languageOf(path), start, end, symKind, symName, want)
	}
	if hits, err := ev.index.SymbolsNamed(name); err == nil {
		for _, h := range hits {
			if h.Path != file && try(h.Path, h.Start, h.End, h.Kind, name) {
				if outline, miss := ev.index.Outline(h.Path); miss == nil {
					for i, s := range outline.Symbols {
						if s.Start == h.Start && s.Name == name {
							return SymbolRelink{File: h.Path, Symbol: qualifiedSymbol(outline.Symbols, i)}, true
						}
					}
				}
				return SymbolRelink{File: h.Path, Symbol: name}, true
			}
		}
	}
	if outline, miss := ev.index.Outline(file); miss == nil {
		for i, s := range outline.Symbols {
			if s.Name != name && try(file, s.Start, s.End, s.Kind, s.Name) {
				return SymbolRelink{File: file, Symbol: qualifiedSymbol(outline.Symbols, i)}, true
			}
		}
	}
	return SymbolRelink{}, false
}

func qualifiedSymbol(symbols []index.Symbol, i int) string {
	name := symbols[i].Name
	for depth, parent := 0, symbols[i].Parent; parent != nil && depth < len(symbols); depth++ {
		if *parent < 0 || *parent >= len(symbols) {
			break
		}
		name = symbols[*parent].Name + "." + name
		parent = symbols[*parent].Parent
	}
	return name
}

// fingerprintSpan hashes lines start..end as tokens. The symbol's own name
// is left out so a rename keeps the fingerprint; the kind is kept in the
// clear so re-linking compares like with like.
func fingerprintSpan(data []byte, lang language, start, end int, kind, name string) string {
	// A string or comment over several lines must read the same however git checked the file out.
	return fingerprintText(bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n")), lang, start, end, kind, name)
}

func matchesFingerprint(data []byte, lang language, start, end int, kind, name, want string) bool {
	return fingerprintSpan(data, lang, start, end, kind, name) == want ||
		bytes.Contains(data, []byte("\r\n")) && fingerprintText(data, lang, start, end, kind, name) == want
}

func fingerprintText(data []byte, lang language, start, end int, kind, name string) string {
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

// An exact scope can retain the file provenance the judge needs. Globs keep
// their index-backed scope semantics and do not expand into unbounded reads.
func exactPatternFile(target map[string]any) string {
	scope := str(target, "scope")
	if safeRelative(scope) && !strings.ContainsAny(scope, "*?[]{}") {
		return scope
	}
	return ""
}

// pattern: how often a literal pattern occurs in scope, from the file
// index's counts (re-counted when the index refreshes).
func (ev *Evaluator) patternCheck(c Check) CheckResult {
	count, res, ok := ev.patternCount(c.Target)
	if !ok {
		return res
	}
	want, _ := normalize(c.Saw["count"])
	baseline, valid := want.(float64)
	var fails bool
	switch str(c.Target, "expect") {
	case "", "exact":
		fails = !valid || baseline != float64(count)
	case "at-most":
		fails = !valid || baseline < float64(count)
	case "present":
		fails = count == 0
	default:
		return CheckResult{Status: Floor, Reason: "unknown pattern expectation"}
	}
	if fails {
		return CheckResult{Status: Fail, Reason: fmt.Sprintf("%q now occurs %d times in %s", str(c.Target, "pattern"), count, str(c.Target, "scope")), Now: count}
	}
	return CheckResult{Status: Pass, Now: count}
}

func (ev *Evaluator) patternCount(target map[string]any) (int, CheckResult, bool) {
	match, expect := str(target, "match"), str(target, "expect")
	file := exactPatternFile(target)
	if file != "" && (expect == "present" || expect == "at-most") {
		data, res, ok := ev.readTarget(file)
		if !ok {
			return 0, res, false
		}
		if match == "" {
			match = "literal"
		}
		if _, err := pattern.Matcher(match, str(target, "pattern")); err != nil {
			return 0, CheckResult{Status: Floor, Reason: "the code pattern doesn't compile"}, false
		}
		return pattern.CodeCount(match, str(target, "pattern"), string(data)), CheckResult{}, true
	}
	if match != "" && match != "literal" {
		return 0, CheckResult{Status: Floor, Reason: "structural counts need an exact file"}, false
	}
	if ev.deliveryScopes != nil && file != "" {
		return ev.liveLiteralCount(file, str(target, "pattern"))
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
	// A folder or glob count can't be re-read here without walking the scope. After a commit
	// made outside a session it may be stale until the background refresh lands (queued when
	// HEAD moves), so it is being checked, never held: a rule must not deny an edit on it.
	if file == "" && ev.indexBehindHead() {
		return 0, CheckResult{Status: Floor, Reason: "the file index is catching up with a new commit"}, false
	}
	if file != "" {
		data, res, ok := ev.readTarget(file)
		if !ok {
			return 0, res, false
		}
		info, miss := ev.index.FileInfo(file)
		if miss != nil || info.Hash == "" || !strings.HasPrefix(strings.TrimPrefix(hashBytes(data), "sha256:"), info.Hash) {
			return 0, CheckResult{Status: Floor, Reason: file + " changed since the last parse"}, false
		}
	}
	return count, CheckResult{}, true
}
