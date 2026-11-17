// Package graph reads the semantic graph (who calls what, which tests cover
// it) and turns answers into cards for delivery. The store behind Reader is
// built in the background; this package never builds or waits, and never
// says more than the graph and the file index can prove.
package graph

import (
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

// Site is one use of a symbol: where it is and the symbol it's inside.
type Site struct {
	Path string   `json:"path"`
	Line int      `json:"line"`
	In   Symbol   `json:"in"`
	Kind EdgeKind `json:"kind"`
}

// Reach says how a test covers a symbol.
type Reach string

const (
	Direct Reach = "direct"
	// ViaCaller: reached only through a tested caller.
	ViaCaller Reach = "via-caller"
)

// TestLink is one test that covers a symbol.
type TestLink struct {
	Test  Symbol `json:"test"`
	Reach Reach  `json:"reach"`
}

// Built is the hash each file had when the graph was built, so a reader can
// tell which answers came from files that changed since.
type Built interface {
	BuiltHash(path string) (string, bool)
}

// Reader is what the graph store answers. Every answer is as of AsOf.
// Callers, Callees and Tests return what the graph holds; Unresolved counts
// dynamic calls into a symbol the graph couldn't resolve.
type Reader interface {
	Built
	AsOf() string
	Resolve(name string) ([]Symbol, error)
	Callers(id string) ([]Site, error)
	Callees(id string) ([]Site, error)
	Tests(id string) ([]TestLink, error)
	Unresolved(id string) int
	// Complete reports that every file the graph would cover is indexed. Only
	// then may "no callers" be said; otherwise it's "callers unknown".
	Complete() bool
}

// Files is the part of the file index reads use.
type Files interface {
	Outline(path string) (*index.OutlineAnswer, *index.Miss)
	FileInfo(path string) (*index.FileInfoAnswer, *index.Miss)
}

// Recheck keeps the sites that still hold today. A site in a file whose hash
// is what the graph was built from holds as built. A site in a file that
// changed since holds only if the file index still has its enclosing symbol;
// its span then comes from the file index. Anything the file index can't
// answer for is dropped: nothing stale is returned as fact.
func Recheck(sites []Site, built Built, files Files) (kept []Site, dropped int) {
	for _, s := range sites {
		info, miss := files.FileInfo(s.Path)
		if miss != nil {
			dropped++
			continue
		}
		if want, ok := built.BuiltHash(s.Path); ok && want == info.Hash {
			kept = append(kept, s)
			continue
		}
		in, ok := still(files, s.In)
		if !ok || s.Line-s.In.Start+in.Start > in.End {
			dropped++
			continue
		}
		s.Line += in.Start - s.In.Start
		s.In = in
		kept = append(kept, s)
	}
	return kept, dropped
}

// Exact gives a symbol its span from the file index, or false when the file
// index no longer has it (renamed, removed, or the file can't be read).
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
