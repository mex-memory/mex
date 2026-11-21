// Package graph reads the semantic graph (who calls what, which tests cover
// it) and turns answers into cards for delivery. The store behind Reader is
// built in the background; this package never builds or waits, and never
// says more than the graph and the file index can prove.
package graph

import (
	"strings"

	"github.com/mex-memory/mex/native/index"
)

// EdgeKind separates real calls from functions passed as values, so a test
// callback never shows as a caller.
type EdgeKind string

const (
	Call  EdgeKind = "call"
	Value EdgeKind = "value"
)

// Symbol is one definition. Spans are the graph's as built; Recheck replaces
// them with the file index's, which are exact through edits.
type Symbol struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Kind      string `json:"kind"`
	Exported  bool   `json:"exported"`
	Signature string `json:"signature,omitempty"`
	// Hash is the code hash of the definition, so a card isn't repeated
	// unless the code changed.
	Hash string `json:"hash"`
}

// Anonymous reports a definition with no name of its own: a callback such as
// a test's it() body or a function passed inline. The graph names them
// "<callback:…>".
func Anonymous(s Symbol) bool { return strings.HasPrefix(s.Name, "<") }

// Site is one use of a symbol: where it is and the definition it's inside.
type Site struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	// In is the definition the use is inside, as the graph has it.
	In Symbol `json:"in"`
	// Owner is the nearest named definition around an anonymous In: the
	// function a callback is passed in. Nil when In has a name, or when the
	// callback sits at the top of a file (a test file's describe/it bodies).
	Owner *Symbol  `json:"owner,omitempty"`
	Kind  EdgeKind `json:"kind"`
	// Through: a call through an interface or union type, whose one
	// implementation in the graph is this symbol.
	Through bool `json:"through,omitempty"`
}

// Named is the definition a person would say the use is in: In, or its
// owner when In is an anonymous callback.
func (s Site) Named() Symbol {
	if Anonymous(s.In) && s.Owner != nil {
		return *s.Owner
	}
	return s.In
}

// Reach says how a test covers a symbol.
type Reach string

const (
	Direct Reach = "direct"
	// ViaCaller: reached only through a tested caller.
	ViaCaller Reach = "via-caller"
)

// TestLink is one test that covers a symbol: the test, and the line of the
// call that makes the link (in the test for a direct one).
type TestLink struct {
	Test  Symbol `json:"test"`
	Line  int    `json:"line"`
	Reach Reach  `json:"reach"`
}

// Built is the hash each file had when the graph was built, so a reader can
// tell which answers came from files that changed since.
type Built interface {
	BuiltHash(path string) (string, bool)
}

// Reader is what the graph store answers. Every answer is as of AsOf.
type Reader interface {
	Built
	AsOf() string
	// Resolve finds the definitions a query names: a name, a file and a name
	// ("src/url.ts:getPath"), or an owner and a name ("Router.add").
	Resolve(query string) ([]Symbol, error)
	Callers(id string) ([]Site, error)
	// Callees are what a definition calls, including from the functions and
	// callbacks nested in it, but not calls into them.
	Callees(id string) ([]Site, error)
	Tests(id string) ([]TestLink, error)
	// Unresolved counts dynamic uses of the symbol's name the graph couldn't
	// tie to a definition: callers it may not show.
	Unresolved(id string) int
	// UnresolvedIn counts calls inside the definition the graph couldn't
	// resolve: callees it may not show.
	UnresolvedIn(id string) int
	// Complete reports that every file the graph would cover is indexed. It
	// is one condition of "none"; files changed since the build are another.
	Complete() bool
	// BuiltFiles is every file the graph holds, with its hash at build.
	BuiltFiles() map[string]string
}

// Files is the part of the file index reads use.
type Files interface {
	Outline(path string) (*index.OutlineAnswer, *index.Miss)
	FileInfo(path string) (*index.FileInfoAnswer, *index.Miss)
}

// Listing is the optional part of Files that can say which files changed
// since the graph was built. Without it, "none" is never said.
type Listing interface {
	// CodeFiles is every indexed code file and its hash, "" when its
	// content is unknown (edited since the parse).
	CodeFiles(disk bool) (map[string]string, error)
}

// editAware is the optional part of Files that knows a file the hook edited
// since its parse, whose FileInfo hash is still the parsed one.
type editAware interface {
	Edited(path string) bool
}

// Source gives a file's lines as they are now, or nil when it can't be read.
type Source func(path string) []string

// recheckWindow bounds the lines searched for a use that moved when no named
// definition around it can place it.
const recheckWindow = 40

// AsBuilt reports a file whose content today is what the graph was built
// from, so answers about it hold as built.
func AsBuilt(path string, built Built, files Files) bool {
	info, miss := files.FileInfo(path)
	if miss != nil {
		return false
	}
	want, ok := built.BuiltHash(path)
	if !ok || want != info.Hash {
		return false
	}
	if e, ok := files.(editAware); ok && e.Edited(path) {
		return false
	}
	return true
}

// Recheck keeps the uses of name that still hold today. A use in a file
// unchanged since the build holds as built. A use in a file that changed
// holds only if the file still uses the name where the use was: inside the
// same named definition, which the file index places exactly, or near the
// same line. It then gets today's line. Anything else is dropped: nothing
// stale is returned as fact.
func Recheck(sites []Site, name string, built Built, files Files, src Source) (kept []Site, dropped int) {
	// A line of today's text backs one use: two old calls never map to the
	// one call that is left.
	claimed := map[string]bool{}
	for _, s := range sites {
		if AsBuilt(s.Path, built, files) {
			kept = append(kept, s)
			continue
		}
		if moved, ok := relocate(s, name, files, src, claimed); ok {
			kept = append(kept, moved)
			continue
		}
		dropped++
	}
	return kept, dropped
}

// relocate finds a use in a file that changed since the build.
func relocate(s Site, name string, files Files, src Source, claimed map[string]bool) (Site, bool) {
	if src == nil || name == "" {
		return s, false
	}
	lines := src(s.Path)
	if lines == nil {
		return s, false
	}
	lo, hi, predicted := max(1, s.Line-recheckWindow), min(len(lines), s.Line+recheckWindow), s.Line
	anchor := s.Named()
	if !Anonymous(anchor) && anchor.Kind != "file" {
		now, ok := still(files, anchor)
		if !ok {
			return s, false // the definition the use was in is gone
		}
		predicted = s.Line + now.Start - anchor.Start
		lo, hi = max(1, now.Start), min(len(lines), now.End)
		if anchor.ID == s.In.ID {
			s.In = now
		} else {
			owner := now
			s.Owner = &owner
			s.In.Start += now.Start - anchor.Start
			s.In.End += now.Start - anchor.Start
		}
	}
	line, ok := nearestUse(lines, name, lo, hi, predicted, func(n int) bool { return claimed[s.Path+"\x00"+itoa(n)] })
	if !ok {
		return s, false
	}
	if claimed != nil {
		claimed[s.Path+"\x00"+itoa(line)] = true
	}
	s.Line = line
	return s, true
}

// nearestUse is the line in lo..hi (1-based) nearest to want that uses name
// as a whole word.
func nearestUse(lines []string, name string, lo, hi, want int, taken func(int) bool) (int, bool) {
	best := 0
	for n := lo; n <= hi && n <= len(lines); n++ {
		if taken(n) || !usesWord(lines[n-1], name) {
			continue
		}
		if best == 0 || abs(n-want) < abs(best-want) {
			best = n
		}
	}
	return best, best > 0
}

// usesWord reports name in line as a whole identifier.
func usesWord(line, name string) bool {
	for from := 0; ; {
		i := strings.Index(line[from:], name)
		if i < 0 {
			return false
		}
		i += from
		end := i + len(name)
		if (i == 0 || !identByte(line[i-1])) && (end == len(line) || !identByte(line[end])) {
			return true
		}
		from = i + 1
	}
}

func identByte(b byte) bool {
	return b == '_' || b == '$' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= 0x80
}

// Exact gives a symbol its span from the file index, or false when the file
// index no longer has it (renamed, removed, or the file can't be read).
// Anonymous callbacks aren't in the file index: one in a file unchanged since
// the build holds as built.
func Exact(files Files, s Symbol) (Symbol, bool) { return still(files, s) }

func still(files Files, s Symbol) (Symbol, bool) {
	outline, miss := files.Outline(s.Path)
	if miss != nil {
		return s, false
	}
	best, found := s, false
	for _, sym := range outline.Symbols {
		if sym.Name != s.Name || sym.Kind != s.Kind {
			continue
		}
		// The nearest same-named definition is the one that moved.
		if !found || abs(sym.Start-s.Start) < abs(best.Start-s.Start) {
			best.Start, best.End, found = sym.Start, sym.End, true
		}
	}
	return best, found
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
