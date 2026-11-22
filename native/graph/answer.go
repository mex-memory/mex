package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/index"
)

// Op is one graph question.
type Op string

const (
	OpCallers Op = "callers"
	OpCallees Op = "callees"
	OpImpact  Op = "impact"
	OpTests   Op = "tests"
)

// Verdict says what an empty or partial answer means. "none" is said only
// when the graph covers every file and no file changed since the build uses
// the name; otherwise an empty answer is "unknown".
type Verdict string

const (
	Found   Verdict = "found"
	None    Verdict = "none"
	Unknown Verdict = "unknown"
	// Ambiguous: the query names more than one definition; Matches lists them.
	Ambiguous Verdict = "ambiguous"
	// Missing: the query names no definition the graph holds.
	Missing Verdict = "missing"
)

// Match is one of the definitions an ambiguous query names, with the
// shortest query that names it alone.
type Match struct {
	Symbol
	Query string `json:"query,omitempty"`
}

// Answer is one reply to a graph question. Every answer carries AsOf.
type Answer struct {
	Op      Op      `json:"op"`
	Name    string  `json:"name"`
	AsOf    string  `json:"as_of"`
	Verdict Verdict `json:"verdict"`
	Symbol  *Symbol `json:"symbol,omitempty"`
	Matches []Match `json:"matches,omitempty"`
	// AlsoNamed are the other definitions a plain name could mean, when it
	// was read as the one top-level definition or the one with a body.
	AlsoNamed []Match    `json:"also_named,omitempty"`
	Sites     []Site     `json:"sites,omitempty"`
	Tests     []TestLink `json:"tests,omitempty"`
	// Dropped are uses in files that changed since the build and no longer hold.
	Dropped int `json:"dropped"`
	// Unresolved dynamic uses: callers (or, for callees, calls) the graph may not show.
	Unresolved int `json:"unresolved"`
	// Changed is how many files changed since the build use the name: uses
	// the graph can't show until it is rebuilt. -1 when it couldn't be told.
	Changed  int  `json:"changed"`
	Complete bool `json:"complete"`
}

// impactDepth is how far impact follows callers.
const impactDepth = 2

// maxChangedFiles bounds the files read to tell whether a name is used in
// code that changed since the build; past it, "none" isn't said.
const maxChangedFiles = 64

// Selectors is the optional part of Reader that names one of several
// definitions alone, and picks the one a plain name means when there is one.
type Selectors interface {
	Selector(sym Symbol, matches []Symbol) string
	Preferred(defs []Symbol, q Query) (Symbol, bool)
}

// Ask answers one question about a name. Uses in files that changed since
// the build are re-checked against today's text and dropped when they no
// longer hold; spans come from the file index.
func Ask(r Reader, files Files, src Source, op Op, query string) (Answer, error) {
	files = Cached(files)
	a := Answer{Op: op, Name: query, AsOf: r.AsOf(), Complete: r.Complete(), Changed: -1}
	defs, err := r.Resolve(query)
	if err != nil {
		return a, err
	}
	sel, _ := r.(Selectors)
	if len(defs) > 1 && sel != nil {
		// A plain name means the one top-level definition, or the one with a
		// body; the rest are named by owner and listed as also named.
		if pick, ok := sel.Preferred(defs, ParseQuery(query)); ok {
			for _, d := range defs {
				if d.ID == pick.ID {
					continue
				}
				m := Match{Symbol: d, Query: sel.Selector(d, defs)}
				if exact, ok := Exact(files, d); ok {
					m.Symbol = exact
				}
				a.AlsoNamed = append(a.AlsoNamed, m)
			}
			defs = []Symbol{pick}
		}
	}
	switch len(defs) {
	case 0:
		a.Verdict = Missing
		return a, nil
	case 1:
	default:
		a.Verdict = Ambiguous
		for _, d := range defs {
			m := Match{Symbol: d}
			if sel != nil {
				m.Query = sel.Selector(d, defs)
			}
			if exact, ok := Exact(files, d); ok {
				m.Symbol = exact
			}
			a.Matches = append(a.Matches, m)
		}
		return a, nil
	}
	def := defs[0]
	if exact, ok := Exact(files, def); ok {
		def = exact
	}
	a.Symbol = &def

	switch op {
	case OpCallers:
		a.Unresolved = r.Unresolved(def.ID)
		sites, err := r.Callers(def.ID)
		if err != nil {
			return a, err
		}
		a.Sites, a.Dropped = Recheck(sites, def.Name, r, files, src)
	case OpCallees:
		a.Unresolved = r.UnresolvedIn(def.ID)
		sites, err := r.Callees(def.ID)
		if err != nil {
			return a, err
		}
		// A callee's site is a line in the definition itself: it holds while
		// the definition's file is as built.
		if AsBuilt(def.Path, r, files) {
			a.Sites = sites
		} else if len(sites) > 0 {
			a.Dropped = len(sites)
		}
	case OpImpact:
		a.Unresolved = r.Unresolved(def.ID)
		seen := map[string]bool{def.ID: true}
		frontier := []Symbol{def}
		for depth := 0; depth < impactDepth && len(frontier) > 0; depth++ {
			var next []Symbol
			for _, at := range frontier {
				sites, err := r.Callers(at.ID)
				if err != nil {
					return a, err
				}
				kept, dropped := Recheck(sites, at.Name, r, files, src)
				a.Dropped += dropped
				for _, s := range kept {
					// What a change reaches is the named code it's used in.
					named := s.Named()
					if s.Kind != Call || seen[named.ID] {
						continue
					}
					seen[named.ID] = true
					a.Sites = append(a.Sites, s)
					if !Anonymous(named) {
						next = append(next, named)
					}
				}
			}
			frontier = next
		}
	case OpTests:
		tests, err := r.Tests(def.ID)
		if err != nil {
			return a, err
		}
		a.Tests, a.Dropped = KeepTests(tests, def.Name, r, files, src)
	}

	found := len(a.Sites) > 0 || len(a.Tests) > 0
	if !found && op != OpCallees && a.Complete && a.Dropped == 0 && a.Unresolved == 0 {
		a.Changed = ChangedUses(r, files, src, def.Name)
	}
	switch {
	case found:
		a.Verdict = Found
	case op == OpCallees && a.Complete && a.Dropped == 0 && a.Unresolved == 0:
		// Callees come from the definition's own body, as built.
		a.Verdict = None
	case a.Complete && a.Dropped == 0 && a.Unresolved == 0 && a.Changed == 0:
		a.Verdict = None
	default:
		a.Verdict = Unknown
	}
	return a, nil
}

// KeepTests keeps the tests that still cover a definition: a test in a file
// unchanged since the build, or one whose file still uses the name near the
// call. Spans of named tests come from the file index.
func KeepTests(tests []TestLink, name string, built Built, files Files, src Source) (kept []TestLink, dropped int) {
	for _, t := range tests {
		if AsBuilt(t.Test.Path, built, files) {
			kept = append(kept, t)
			continue
		}
		use := name
		if t.Reach == ViaCaller && t.Via != "" {
			use = t.Via // the test calls the caller, not the symbol
		}
		site, ok := relocate(Site{Path: t.Test.Path, Line: t.Line, In: t.Test}, use, files, src, nil)
		if !ok {
			dropped++
			continue
		}
		t.Test, t.Line = site.In, site.Line
		kept = append(kept, t)
	}
	return kept, dropped
}

// ChangedUses counts the files changed since the build, or added after it,
// that use the name: uses the graph can't show. -1 when that can't be told:
// no file index to list files, or too many changed to read.
func ChangedUses(r Reader, files Files, src Source, name string) int {
	list, ok := files.(Listing)
	if !ok || !canList(files) || src == nil {
		return -1
	}
	indexed, err := list.CodeFiles(true)
	if err != nil {
		return -1
	}
	built := r.BuiltFiles()
	// Only files of a kind the graph builds can hold uses it can't show: a
	// Python file in a TypeScript graph was never left out by a build.
	kinds := map[string]bool{}
	for path := range built {
		kinds[strings.ToLower(filepath.Ext(path))] = true
	}
	var changed []string
	for path, hash := range indexed {
		if want, ok := built[path]; ok && hash != "" && hash == want {
			continue
		}
		if !kinds[strings.ToLower(filepath.Ext(path))] {
			continue
		}
		changed = append(changed, path)
		if len(changed) > maxChangedFiles {
			return -1
		}
	}
	n := 0
	for _, path := range changed {
		lines := src(path)
		if lines == nil {
			return -1
		}
		for _, line := range lines {
			if usesWord(line, name) {
				n++
				break
			}
		}
	}
	return n
}

// DiskFiles answers FileInfo from the files themselves, for a checkout with
// no file index. It has no outlines, so a use in a file that changed since
// the build is found again only near its old line.
type DiskFiles struct{ Root string }

func (d DiskFiles) FileInfo(path string) (*index.FileInfoAnswer, *index.Miss) {
	data, err := os.ReadFile(filepath.Join(d.Root, filepath.FromSlash(path)))
	if err != nil {
		return nil, &index.Miss{Path: path, NotIndexed: "unreadable"}
	}
	sum := sha256.Sum256(data)
	return &index.FileInfoAnswer{Path: path, Hash: hex.EncodeToString(sum[:])[:32]}, nil
}

func (d DiskFiles) Outline(path string) (*index.OutlineAnswer, *index.Miss) {
	return nil, &index.Miss{Path: path, NotIndexed: "no file index"}
}

var errNoListing = errors.New("the files can't be listed")

// maxSourceBytes bounds a file read to re-check uses in it.
const maxSourceBytes = 4 << 20

// DiskSource reads files under root as they are now, once each.
func DiskSource(root string) Source {
	cache := map[string][]string{}
	return func(path string) []string {
		if lines, ok := cache[path]; ok {
			return lines
		}
		var lines []string
		full := filepath.Join(root, filepath.FromSlash(path))
		if info, err := os.Stat(full); err == nil && info.Mode().IsRegular() && info.Size() <= maxSourceBytes {
			if data, err := os.ReadFile(full); err == nil {
				lines = strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
			}
		}
		cache[path] = lines
		return lines
	}
}
