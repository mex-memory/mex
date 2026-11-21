package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
)

// Card limits (sheet 49). Starting values; the plan calls them parameters.
const (
	maxCardChars     = 600
	maxSpanLines     = 300
	maxCallers       = 3
	maxUsedByShown   = 5
	maxCodeLineChars = 100
)

// Card is one graph item for delivery. It competes with knowledge for the
// same epoch budget: Tokens is what it costs, Value the tokens of the reads,
// search output or turns it replaces.
type Card struct {
	Kind   string `json:"kind"` // signature or tests
	Key    string `json:"key"`  // the same card for the same code
	Text   string `json:"text"`
	Tokens int    `json:"tokens"`
	Value  int    `json:"value"`
	AsOf   string `json:"as_of"`
}

// Seen holds the keys of cards already sent this epoch. A key includes the
// code's hash, so a card comes back only when the code changed.
type Seen map[string]bool

// Allowed reports a moment cards may go out at. Nothing is sent at session
// start: the graph only helps pick knowledge there.
func Allowed(kind contract.Kind) bool { return kind != contract.SessionStart }

// View is one read of the graph for delivery: the store, the file index,
// and the files' text as it is now.
type View struct {
	R     Reader
	Files Files
	Src   Source
}

func key(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return parts[0] + ":" + hex.EncodeToString(h[:8])
}

func finish(c *Card, seen Seen) (*Card, bool) {
	if seen[c.Key] || len(c.Text) > maxCardChars {
		return nil, false
	}
	c.Tokens = entries.EstimateTokens(c.Text)
	return c, true
}

// Unique resolves a name to the one definition it names, with its span from
// the file index. Names that resolve to several places, or to a span too
// long to be useful, get no card.
func (v View) Unique(name string) (Symbol, bool) {
	defs, err := v.R.Resolve(name)
	if err != nil || len(defs) != 1 {
		return Symbol{}, false
	}
	def, ok := Exact(v.Files, defs[0])
	if !ok || def.End-def.Start+1 > maxSpanLines {
		return Symbol{}, false
	}
	return def, true
}

func at(path string, line int) string { return fmt.Sprintf("%s:%d", path, line) }

// Code is the text of one line as it is now, trimmed, or "".
func (v View) Code(path string, line int) string {
	if v.Src == nil || line < 1 {
		return ""
	}
	lines := v.Src(path)
	if line > len(lines) {
		return ""
	}
	text := strings.TrimSpace(lines[line-1])
	if r := []rune(text); len(r) > maxCodeLineChars {
		text = string(r[:maxCodeLineChars]) + "…"
	}
	return text
}

// tokensOf sums the read cost of distinct files: what the agent would read
// without the card.
func tokensOf(files Files, paths ...string) int {
	total, done := 0, map[string]bool{}
	for _, p := range paths {
		if done[p] {
			continue
		}
		done[p] = true
		if info, miss := files.FileInfo(p); miss == nil {
			total += info.Tokens
		}
	}
	return total
}

// byOwner keeps real calls, one per named definition they're in, in path and
// line order.
func byOwner(sites []Site) []Site {
	var out []Site
	seen := map[string]bool{}
	for _, s := range sites {
		k := s.Named().ID
		if s.Kind != Call || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Line < out[j].Line
	})
	return out
}

// Shown reports a line of code the agent already has, such as a line its
// search returned: the card doesn't repeat it.
type Shown func(code string) bool

// use is one use as a card line: where, the named definition it's in, and
// its code unless the agent already has it (or there's no room for it).
func (v View) use(s Site, shown Shown) string { return v.useLine(s, shown, true) }

func (v View) useLine(s Site, shown Shown, withCode bool) string {
	line := at(s.Path, s.Line)
	if named := s.Named(); !Anonymous(named) {
		line += " " + named.Name
	}
	if !withCode {
		return line
	}
	if code := v.Code(s.Path, s.Line); code != "" && (shown == nil || !shown(code)) {
		line += " · " + code
	}
	return line
}

// SearchLines are the graph's lines for the card beside a search for name,
// whose definition (in path) the card already shows: up to 3 callers in
// code, each with the definition it's in and its code line, and the test
// that calls it, in at most room characters. A name that resolves to more
// than one place gets nothing, and so does an answer with nothing in it.
// Value is the tokens of the files the lines save opening.
func (v View) SearchLines(path, name string, room int, shown Shown) (text string, value int, ok bool) {
	def, ok := v.Unique(name)
	if !ok || def.Path != path {
		return "", 0, false
	}
	sites, err := v.R.Callers(def.ID)
	if err != nil {
		return "", 0, false
	}
	sites, _ = Recheck(sites, def.Name, v.R, v.Files, v.Src)
	// Calls from tests are said once, as the test line: a test that calls
	// the definition is a direct one. Tests reached only through a caller
	// are looked up only when there is no direct one.
	var code []Site
	var direct []TestLink
	for _, s := range sites {
		if s.Kind != Call {
			continue
		}
		if isTest(v, s.Path) {
			direct = append(direct, TestLink{Test: s.In, Line: s.Line, Reach: Direct})
		}
	}
	for _, s := range byOwner(sites) {
		if !isTest(v, s.Path) {
			code = append(code, s)
		}
	}
	tests := direct
	if len(tests) == 0 {
		via, err := v.R.Tests(def.ID)
		if err != nil {
			return "", 0, false
		}
		for _, t := range via {
			if t.Reach != ViaCaller {
				continue
			}
			if kept, _ := KeepTests([]TestLink{t}, def.Name, v.R, v.Files, v.Src); len(kept) == 1 {
				tests = kept
				break
			}
		}
	}
	testLine, testPath := v.testLine(def, tests, shown, true)
	if len(code) == 0 && testLine == "" {
		return "", 0, false // nothing the search didn't already say
	}
	bareTest, _ := v.testLine(def, tests, shown, false)
	unresolved := ""
	if n := v.R.Unresolved(def.ID); n > 0 && len(code) > 0 {
		unresolved = fmt.Sprintf("\n+%d dynamic uses not resolved", n)
	}
	// Short of room, code lines go first (the callers', then the test's),
	// then callers one by one.
	for shownN := min(len(code), maxCallers); shownN >= 0; shownN-- {
		for _, form := range []struct{ callerCode, testCode bool }{{true, true}, {false, true}, {false, false}} {
			if shownN == 0 && form.callerCode {
				continue
			}
			var b strings.Builder
			paths := []string{}
			// With no caller in code found, only the test is said: an absence
			// isn't claimed on the hook path.
			if len(code) > 0 {
				fmt.Fprintf(&b, "called by %d:", len(code))
				for _, s := range code[:shownN] {
					b.WriteString("\n  " + v.useLine(s, shown, form.callerCode))
					paths = append(paths, s.Path)
				}
				if len(code) > shownN {
					fmt.Fprintf(&b, "\n  +%d more", len(code)-shownN)
				}
			}
			test := testLine
			if !form.testCode {
				test = bareTest
			}
			if test != "" {
				b.WriteString("\n" + test)
			}
			out := strings.TrimPrefix(b.String()+unresolved, "\n")
			if len(out) <= room {
				if testPath != "" {
					paths = append(paths, testPath)
				}
				return out, tokensOf(v.Files, paths...), true
			}
		}
	}
	return "", 0, false
}

func isTest(v View, path string) bool {
	if s, ok := v.R.(*Store); ok {
		return s.test(path)
	}
	if t, ok := v.Files.(interface{ TestFlag(string) (bool, bool) }); ok {
		if is, known := t.TestFlag(path); known {
			return is
		}
	}
	return TestPath(path)
}

// testLine is the test that best covers def: a direct one, the one in the
// test file named after def's file first; else one that reaches it through
// a tested caller. "" when no test is known.
func (v View) testLine(def Symbol, tests []TestLink, shown Shown, withCode bool) (string, string) {
	var direct, via []TestLink
	for _, t := range tests {
		if t.Reach == Direct {
			direct = append(direct, t)
		} else {
			via = append(via, t)
		}
	}
	stem := strings.TrimSuffix(path.Base(def.Path), path.Ext(def.Path))
	pick := func(list []TestLink) (TestLink, int) {
		best := list[0]
		for _, t := range list {
			if strings.HasPrefix(path.Base(t.Test.Path), stem+".") || strings.HasPrefix(path.Base(t.Test.Path), stem+"_") {
				best = t
				break
			}
		}
		files := map[string]bool{}
		for _, t := range list {
			files[t.Test.Path] = true
		}
		return best, len(files) - 1
	}
	switch {
	case len(direct) > 0:
		t, others := pick(direct)
		line := "test: " + v.useLine(Site{Path: t.Test.Path, Line: t.Line, In: t.Test}, shown, withCode)
		if others > 0 {
			line += fmt.Sprintf(" (+%d more test files)", others)
		}
		return line, t.Test.Path
	case len(via) > 0:
		t, _ := pick(via)
		return "tested only through a caller: " + at(t.Test.Path, t.Line), ""
	}
	return "", ""
}

// SignatureCard goes out once on an edit that changes an exported
// signature used in at least minFiles other files: the files that use it,
// instead of a broken-callers round trip. Values passed elsewhere count:
// they break on a new signature too. declaration is the new declaration.
func (v View) SignatureCard(def Symbol, declaration string, minFiles int, seen Seen) (*Card, bool) {
	if !def.Exported {
		return nil, false
	}
	sites, err := v.R.Callers(def.ID)
	if err != nil {
		return nil, false
	}
	sites, _ = Recheck(sites, def.Name, v.R, v.Files, v.Src)
	byFile := map[string]Site{}
	for _, s := range sites {
		if s.Path == def.Path {
			continue
		}
		if prior, ok := byFile[s.Path]; !ok || s.Line < prior.Line {
			byFile[s.Path] = s
		}
	}
	if len(byFile) == 0 || len(byFile) < minFiles {
		return nil, false
	}
	paths := make([]string, 0, len(byFile))
	for p := range byFile {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	head := "`" + strings.TrimSpace(declaration) + "`"
	if len(head) > 160 {
		head = "`" + def.Name + "`"
	}
	for shown := min(len(paths), maxUsedByShown); shown > 0; shown-- {
		parts := make([]string, 0, shown)
		for _, p := range paths[:shown] {
			parts = append(parts, at(p, byFile[p].Line))
		}
		more := ""
		if shown < len(paths) {
			more = " …"
		}
		text := fmt.Sprintf("%s changed · used by %d files: %s%s", head, len(paths), strings.Join(parts, ", "), more)
		if len(text) <= maxCardChars {
			return finish(&Card{Kind: "signature", Key: key("signature", def.ID, normalize(declaration)), Text: text, Value: tokensOf(v.Files, paths[:shown]...), AsOf: v.R.AsOf()}, seen)
		}
	}
	return nil, false
}

func normalize(s string) string { return strings.Join(strings.Fields(s), " ") }

// TestsCard goes out after a full test run once the session has edited
// code: the tests that cover what changed, and a scoped command when the
// runner takes files, for the runs that follow. value is the tokens the full
// run's output cost.
func (v View) TestsCard(changed []Symbol, command string, value int, seen Seen) (*Card, bool) {
	reach := map[string]Reach{}
	var hashes []string
	for _, def := range changed {
		hashes = append(hashes, def.ID+"@"+def.Hash)
		tests, err := v.R.Tests(def.ID)
		if err != nil {
			return nil, false
		}
		tests, _ = KeepTests(tests, def.Name, v.R, v.Files, v.Src)
		for _, t := range tests {
			if reach[t.Test.Path] != Direct {
				reach[t.Test.Path] = t.Reach
			}
		}
	}
	if len(reach) == 0 {
		return nil, false
	}
	var direct, via []string
	for p, how := range reach {
		if how == Direct {
			direct = append(direct, p)
		} else {
			via = append(via, p)
		}
	}
	sort.Strings(direct)
	sort.Strings(via)
	var parts []string
	if len(direct) > 0 {
		parts = append(parts, strings.Join(direct, ", ")+" (direct)")
	}
	if len(via) > 0 {
		parts = append(parts, strings.Join(via, ", ")+" (through a tested caller)")
	}
	text := "Tests covering your changes: " + strings.Join(parts, "; ")
	if scoped, ok := ScopedCommand(command, append(append([]string{}, direct...), via...)); ok {
		text += "\nTo rerun only those: `" + scoped + "`"
	}
	if len(text) > maxCardChars {
		text = "Tests covering your changes: " + fmt.Sprintf("%d files", len(reach))
		if scoped, ok := ScopedCommand(command, direct); ok && len(text)+len(scoped) < maxCardChars-30 {
			text += "\nTo rerun the direct ones: `" + scoped + "`"
		}
	}
	sort.Strings(hashes)
	return finish(&Card{Kind: "tests", Key: key(append([]string{"tests"}, hashes...)...), Text: text, Value: value, AsOf: v.R.AsOf()}, seen)
}

// ScopedCommand narrows a full test command to the given test files, for
// runners that take files as arguments. Anything else, including commands
// that already name files or chain other commands, is left alone.
func ScopedCommand(command string, testFiles []string) (string, bool) {
	if len(testFiles) == 0 || strings.ContainsAny(command, "|;&<>`$\n") {
		return "", false
	}
	runner := false
	for _, f := range strings.Fields(command) {
		if !runner {
			switch path.Base(f) {
			case "vitest", "jest", "mocha", "pytest":
				runner = true
			}
			continue
		}
		if !strings.HasPrefix(f, "-") && strings.ContainsAny(f, "/.") {
			return "", false // already names files
		}
	}
	if !runner {
		return "", false
	}
	return command + " " + strings.Join(testFiles, " "), true
}
