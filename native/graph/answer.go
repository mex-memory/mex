package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"

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
// when the graph covers every file; otherwise an empty answer is "unknown".
type Verdict string

const (
	Found   Verdict = "found"
	None    Verdict = "none"
	Unknown Verdict = "unknown"
	// Ambiguous: the name names more than one definition; Matches lists them.
	Ambiguous Verdict = "ambiguous"
	// Missing: the name names no definition the graph holds.
	Missing Verdict = "missing"
)

// Answer is one reply to a graph question. Every answer carries AsOf.
type Answer struct {
	Op      Op         `json:"op"`
	Name    string     `json:"name"`
	AsOf    string     `json:"as_of"`
	Verdict Verdict    `json:"verdict"`
	Symbol  *Symbol    `json:"symbol,omitempty"`
	Matches []Symbol   `json:"matches,omitempty"`
	Sites   []Site     `json:"sites,omitempty"`
	Tests   []TestLink `json:"tests,omitempty"`
	// Dropped are sites in files that changed since the build and no longer hold.
	Dropped int `json:"dropped"`
	// Unresolved dynamic uses of the name: callers the graph may not show.
	Unresolved int  `json:"unresolved"`
	Complete   bool `json:"complete"`
}

// impactDepth is how far impact follows callers.
const impactDepth = 2

// Ask answers one question about a name. Sites in files that changed since
// the build are re-checked against the file index and dropped when they no
// longer hold; spans come from the file index.
func Ask(r Reader, files Files, op Op, name string) (Answer, error) {
	a := Answer{Op: op, Name: name, AsOf: r.AsOf(), Complete: r.Complete()}
	defs, err := r.Resolve(name)
	if err != nil {
		return a, err
	}
	switch len(defs) {
	case 0:
		a.Verdict = Missing
		return a, nil
	case 1:
	default:
		a.Verdict = Ambiguous
		for _, d := range defs {
			if exact, ok := Exact(files, d); ok {
				d = exact
			}
			a.Matches = append(a.Matches, d)
		}
		return a, nil
	}
	def := defs[0]
	if exact, ok := Exact(files, def); ok {
		def = exact
	}
	a.Symbol = &def
	a.Unresolved = r.Unresolved(def.ID)

	switch op {
	case OpCallers, OpCallees:
		var sites []Site
		if op == OpCallers {
			sites, err = r.Callers(def.ID)
		} else {
			sites, err = r.Callees(def.ID)
		}
		if err != nil {
			return a, err
		}
		a.Sites, a.Dropped = Recheck(sites, r, files)
	case OpImpact:
		seen := map[string]bool{def.ID: true}
		frontier := []string{def.ID}
		for depth := 0; depth < impactDepth && len(frontier) > 0; depth++ {
			var next []string
			for _, id := range frontier {
				sites, err := r.Callers(id)
				if err != nil {
					return a, err
				}
				kept, dropped := Recheck(sites, r, files)
				a.Dropped += dropped
				for _, s := range kept {
					if s.Kind != Call || seen[s.In.ID] {
						continue
					}
					seen[s.In.ID] = true
					a.Sites = append(a.Sites, s)
					next = append(next, s.In.ID)
				}
			}
			frontier = next
		}
	case OpTests:
		tests, err := r.Tests(def.ID)
		if err != nil {
			return a, err
		}
		for _, t := range tests {
			// A test in a file that changed is kept only while the file index still has it.
			if want, ok := r.BuiltHash(t.Test.Path); ok {
				if info, miss := files.FileInfo(t.Test.Path); miss == nil && info.Hash == want {
					a.Tests = append(a.Tests, t)
					continue
				}
			}
			if exact, ok := Exact(files, t.Test); ok {
				t.Test = exact
				a.Tests = append(a.Tests, t)
			} else {
				a.Dropped++
			}
		}
	}

	found := len(a.Sites) > 0 || len(a.Tests) > 0
	switch {
	case found:
		a.Verdict = Found
	case a.Complete && a.Dropped == 0 && a.Unresolved == 0:
		a.Verdict = None
	default:
		a.Verdict = Unknown
	}
	return a, nil
}

// DiskFiles answers FileInfo from the files themselves, for a checkout with
// no file index. It has no outlines, so a site in a file that changed since
// the build can't be re-checked and is dropped.
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
