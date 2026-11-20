package graph

import (
	"fmt"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
)

// fakeGraph answers like the graph store.
type fakeGraph struct {
	symbols    []Symbol
	callers    map[string][]Site
	tests      map[string][]TestLink
	unresolved map[string]int
	built      map[string]string // path -> hash at build
	incomplete bool
}

func (g *fakeGraph) AsOf() string { return "2026-11-17T10:00:00Z" }
func (g *fakeGraph) BuiltHash(path string) (string, bool) {
	h, ok := g.built[path]
	return h, ok
}
func (g *fakeGraph) Resolve(name string) ([]Symbol, error) {
	var out []Symbol
	for _, s := range g.symbols {
		if s.Name == name {
			out = append(out, s)
		}
	}
	return out, nil
}
func (g *fakeGraph) Callers(id string) ([]Site, error)   { return g.callers[id], nil }
func (g *fakeGraph) Callees(string) ([]Site, error)      { return nil, nil }
func (g *fakeGraph) Tests(id string) ([]TestLink, error) { return g.tests[id], nil }
func (g *fakeGraph) Unresolved(id string) int            { return g.unresolved[id] }
func (g *fakeGraph) Complete() bool                      { return !g.incomplete }

// fakeFiles answers like the file index.
type fakeFiles struct {
	outlines map[string][]index.Symbol
	hashes   map[string]string
	tokens   map[string]int
}

func (f *fakeFiles) Outline(path string) (*index.OutlineAnswer, *index.Miss) {
	s, ok := f.outlines[path]
	if !ok {
		return nil, &index.Miss{Path: path, NotIndexed: "not in the index"}
	}
	return &index.OutlineAnswer{Path: path, Symbols: s}, nil
}
func (f *fakeFiles) FileInfo(path string) (*index.FileInfoAnswer, *index.Miss) {
	h, ok := f.hashes[path]
	if !ok {
		return nil, &index.Miss{Path: path, NotIndexed: "not in the index"}
	}
	return &index.FileInfoAnswer{Path: path, Hash: h, Tokens: f.tokens[path]}, nil
}

func sym(id, name, path string, start, end int, kind string) Symbol {
	return Symbol{ID: id, Name: name, Path: path, Start: start, End: end, Kind: kind, Hash: "h-" + id}
}

// A router: parseRoute is called from two handlers, passed as a value in a
// test callback, and covered by one direct test.
func router() (*fakeGraph, *fakeFiles) {
	parse := sym("n1", "parseRoute", "src/router.ts", 120, 140, "function")
	parse.Exported, parse.Signature = true, "parseRoute(path: string): Route"
	get := sym("n2", "handleGet", "src/get.ts", 10, 30, "function")
	post := sym("n3", "handlePost", "src/post.ts", 5, 25, "function")
	cb := sym("n4", "routes work", "test/router.test.ts", 3, 9, "test")
	g := &fakeGraph{
		symbols: []Symbol{parse, get, post, cb},
		callers: map[string][]Site{"n1": {
			{Path: "src/get.ts", Line: 12, In: get, Kind: Call},
			{Path: "src/get.ts", Line: 20, In: get, Kind: Call},
			{Path: "src/post.ts", Line: 7, In: post, Kind: Call},
			{Path: "test/router.test.ts", Line: 5, In: cb, Kind: Value},
		}},
		tests: map[string][]TestLink{"n1": {{Test: cb, Reach: Direct}}},
		built: map[string]string{"src/router.ts": "a", "src/get.ts": "b", "src/post.ts": "c", "test/router.test.ts": "d"},
	}
	f := &fakeFiles{
		outlines: map[string][]index.Symbol{
			"src/router.ts":       {{Name: "parseRoute", Kind: "function", Start: 120, End: 140}},
			"src/get.ts":          {{Name: "handleGet", Kind: "function", Start: 10, End: 30}},
			"src/post.ts":         {{Name: "handlePost", Kind: "function", Start: 5, End: 25}},
			"test/router.test.ts": {{Name: "routes work", Kind: "test", Start: 3, End: 9}},
		},
		hashes: map[string]string{"src/router.ts": "a", "src/get.ts": "b", "src/post.ts": "c", "test/router.test.ts": "d"},
		tokens: map[string]int{"src/router.ts": 2000, "src/get.ts": 800, "src/post.ts": 700, "test/router.test.ts": 500},
	}
	return g, f
}

func TestSearchCard(t *testing.T) {
	g, f := router()
	c, ok := SearchCard(g, f, "parseRoute", Seen{})
	if !ok {
		t.Fatal("no card")
	}
	want := "`parseRoute(path: string): Route` · src/router.ts:120\ncalled by src/get.ts:12 (handleGet), src/post.ts:7 (handlePost)\ntest: test/router.test.ts:3 (routes work)"
	if c.Text != want {
		t.Fatalf("text:\n%s", c.Text)
	}
	// The test callback passes parseRoute as a value: never shown as a caller.
	if strings.Contains(c.Text, "test/router.test.ts:5") {
		t.Fatal("callback shown as a caller")
	}
	if c.Value != 2000+500+800+700 || c.Tokens == 0 || c.Tokens >= c.Value || c.AsOf == "" {
		t.Fatalf("value %d tokens %d", c.Value, c.Tokens)
	}
	if _, ok := SearchCard(g, f, "parseRoute", Seen{c.Key: true}); ok {
		t.Fatal("repeated in the epoch")
	}
	g.symbols[0].Hash = "changed"
	if _, ok := SearchCard(g, f, "parseRoute", Seen{c.Key: true}); !ok {
		t.Fatal("not sent again after the code changed")
	}
}

func TestSearchCardNoise(t *testing.T) {
	g, f := router()
	g.symbols = append(g.symbols, sym("n9", "parseRoute", "src/legacy.ts", 1, 5, "function"))
	if _, ok := SearchCard(g, f, "parseRoute", Seen{}); ok {
		t.Fatal("a name with two definitions got a card")
	}
	g, f = router()
	f.outlines["src/router.ts"][0].End = 120 + maxSpanLines
	if _, ok := SearchCard(g, f, "parseRoute", Seen{}); ok {
		t.Fatal("a span over 300 lines got a card")
	}
	g, f = router()
	g.unresolved = map[string]int{"n1": 2}
	if c, _ := SearchCard(g, f, "parseRoute", Seen{}); !strings.HasSuffix(c.Text, "+2 dynamic calls not resolved") {
		t.Fatalf("unresolved: %s", c.Text)
	}
}

// "No callers" only when every file is indexed and nothing was dropped.
func TestSearchCardNeverOverclaims(t *testing.T) {
	g, f := router()
	g.callers = nil
	if c, _ := SearchCard(g, f, "parseRoute", Seen{}); !strings.Contains(c.Text, "\nno callers\n") {
		t.Fatalf("complete: %s", c.Text)
	}
	g.incomplete = true
	if c, _ := SearchCard(g, f, "parseRoute", Seen{}); !strings.Contains(c.Text, "\ncallers unknown\n") {
		t.Fatalf("incomplete: %s", c.Text)
	}
	g, f = router()
	g.callers["n1"] = g.callers["n1"][3:] // only the callback
	g.tests = map[string][]TestLink{"n1": {{Test: g.symbols[3], Reach: ViaCaller}}}
	c, _ := SearchCard(g, f, "parseRoute", Seen{})
	if !strings.Contains(c.Text, "no callers") || !strings.Contains(c.Text, "tested only through a caller: test/router.test.ts:3") {
		t.Fatalf("via caller: %s", c.Text)
	}
	g.tests = nil
	if c, _ := SearchCard(g, f, "parseRoute", Seen{}); !strings.HasSuffix(c.Text, "tests: none") {
		t.Fatalf("no tests: %s", c.Text)
	}
}

// A caller in a file changed since the build is re-checked against the file
// index: kept with the new span if its function is still there, dropped if
// not, and then "no callers" can't be said.
func TestRecheckChangedFiles(t *testing.T) {
	g, f := router()
	f.hashes["src/get.ts"] = "edited"
	f.outlines["src/get.ts"] = []index.Symbol{{Name: "handleGet", Kind: "function", Start: 14, End: 34}}
	kept, dropped := Recheck(g.callers["n1"], g, f)
	if dropped != 0 || kept[0].Line != 16 || kept[0].In.Start != 14 {
		t.Fatalf("moved: %+v %d", kept, dropped)
	}
	f.outlines["src/get.ts"] = []index.Symbol{{Name: "handleGetV2", Kind: "function", Start: 10, End: 30}}
	kept, dropped = Recheck(g.callers["n1"], g, f)
	if dropped != 2 || len(kept) != 2 {
		t.Fatalf("removed: %+v %d", kept, dropped)
	}
	delete(f.hashes, "src/post.ts")
	if _, dropped = Recheck(g.callers["n1"], g, f); dropped != 3 {
		t.Fatalf("unreadable file kept: %d", dropped)
	}
	g.callers["n1"] = g.callers["n1"][:2] // only handleGet, now gone
	if c, _ := SearchCard(g, f, "parseRoute", Seen{}); !strings.Contains(c.Text, "callers unknown") {
		t.Fatalf("dropped callers then 'no callers': %s", c.Text)
	}
}

func TestSearchCardFitsIn600Characters(t *testing.T) {
	g, f := router()
	var sites []Site
	for i := 0; i < 5; i++ {
		p := fmt.Sprintf("src/very/long/folder/name/that/goes/on/and/on/handler_%d_%s.ts", i, strings.Repeat("x", 60))
		in := sym(fmt.Sprintf("c%d", i), "handlerWithAVeryLongName"+strings.Repeat("Y", 40), p, 1, 9, "function")
		sites = append(sites, Site{Path: p, Line: 2, In: in, Kind: Call})
		f.hashes[p], g.built[p] = "z", "z"
	}
	g.callers["n1"] = sites
	c, ok := SearchCard(g, f, "parseRoute", Seen{})
	if !ok || len(c.Text) > maxCardChars || !strings.Contains(c.Text, "more") {
		t.Fatalf("%v %d:\n%s", ok, len(c.Text), c.Text)
	}
}

func TestSignatureCard(t *testing.T) {
	g, f := router()
	def := g.symbols[0]
	c, ok := SignatureCard(g, f, def, "parseRoute(path: string): Route | null", 1, Seen{})
	if !ok {
		t.Fatal("no card")
	}
	// The test passes it as a value: that file breaks too.
	want := "`parseRoute(path: string): Route` changed · used by 3 files: src/get.ts:12, src/post.ts:7, test/router.test.ts:5"
	if c.Text != want {
		t.Fatalf("%s", c.Text)
	}
	if _, ok := SignatureCard(g, f, def, "parseRoute(path: string): Route | null", 1, Seen{c.Key: true}); ok {
		t.Fatal("sent twice")
	}
	if _, ok := SignatureCard(g, f, def, def.Signature, 1, Seen{}); ok {
		t.Fatal("unchanged signature")
	}
	def.Exported = false
	if _, ok := SignatureCard(g, f, def, "x", 1, Seen{}); ok {
		t.Fatal("not exported")
	}
}

func TestTestsCard(t *testing.T) {
	g, f := router()
	other := sym("n5", "handled", "test/get.test.ts", 1, 4, "test")
	f.outlines["test/get.test.ts"] = []index.Symbol{{Name: "handled", Kind: "test", Start: 1, End: 4}}
	g.tests["n2"] = []TestLink{{Test: other, Reach: ViaCaller}}
	changed := []Symbol{g.symbols[0], g.symbols[1]}
	c, ok := TestsCard(g, f, changed, "npx vitest run", 9000, Seen{})
	if !ok {
		t.Fatal("no card")
	}
	want := "Tests covering your changes: test/router.test.ts (direct); test/get.test.ts (through a tested caller)\nScoped: `npx vitest run test/router.test.ts test/get.test.ts`"
	if c.Text != want || c.Value != 9000 {
		t.Fatalf("%s", c.Text)
	}
	if c, _ := TestsCard(g, f, changed, "npm test", 9000, Seen{}); strings.Contains(c.Text, "Scoped") {
		t.Fatal("scoped an unknown runner")
	}
	if _, ok := TestsCard(g, f, []Symbol{g.symbols[2]}, "npx vitest run", 9000, Seen{}); ok {
		t.Fatal("card with no tests")
	}
}

func TestScopedCommand(t *testing.T) {
	files := []string{"a.test.ts"}
	cases := map[string]string{
		"npx vitest run":                 "npx vitest run a.test.ts",
		"./node_modules/.bin/jest --ci":  "./node_modules/.bin/jest --ci a.test.ts",
		"python -m pytest -q":            "python -m pytest -q a.test.ts",
		"npx vitest run src/x.test.ts":   "",
		"npm test":                       "",
		"npx vitest run && npm run lint": "",
		"go test ./...":                  "",
	}
	for cmd, want := range cases {
		got, ok := ScopedCommand(cmd, files)
		if got != want || ok != (want != "") {
			t.Errorf("%q: %q %v", cmd, got, ok)
		}
	}
}

func TestNothingAtSessionStart(t *testing.T) {
	if Allowed(contract.SessionStart) || !Allowed(contract.PreTool) || !Allowed(contract.Prompt) {
		t.Fatal("moments")
	}
}
